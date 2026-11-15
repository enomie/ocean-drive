import { BufferGeometry, DoubleSide, Float32BufferAttribute, Mesh, type Vector3 } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn, If, abs, cameraPosition, clamp, dot, exp, frontFacing, length, max, mix, normalize, pow, reflect, refract,
  select, smoothstep, varying, vec3, vec4,
} from 'three/tsl';
import { skyBase } from '../sky';
import { SUN_COL, sunDir } from '../core/sun';
import { under, underwaterColor } from '../underwater';
import { finishColor } from '../core/output';
import { camH, camXZ, gerstner, shaderMirrorError, shadingNormal, shiftInvarianceError, updateWavePhases, waveHeight } from './waves';
import { pixelAngle } from '../core/view';

/** Polares Gitter um die Kamera: dicht nah, grob zum Horizont (~40 km) */
function polarGrid(rings: number, segs: number, growth: number): BufferGeometry {
  const pos: number[] = [0, 0, 0];
  const idx: number[] = [];
  for (let i = 1; i <= rings; i++) {
    const r = (0.35 * (Math.pow(growth, i) - 1)) / (growth - 1);
    for (let j = 0; j < segs; j++) {
      const a = (j / segs) * Math.PI * 2;
      pos.push(Math.cos(a) * r, 0, Math.sin(a) * r);
    }
  }
  for (let j = 0; j < segs; j++) idx.push(0, 1 + ((j + 1) % segs), 1 + j);
  for (let i = 0; i < rings - 1; i++) {
    const a0 = 1 + i * segs;
    const b0 = 1 + (i + 1) * segs;
    for (let j = 0; j < segs; j++) {
      const j1 = (j + 1) % segs;
      idx.push(a0 + j, a0 + j1, b0 + j, a0 + j1, b0 + j1, b0 + j);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

/**
 * Minimaler Ozean: Gerstner-Spektrum im Vertex-Knoten, Fresnel + Himmelsspiegelung,
 * Unterwasser-Streulicht an Kämmen, Sonnenglanz, Horizontdunst. 1 Draw Call.
 * Noch nicht enthalten: Schaum, Detail-Wellen, Kielwasser, Flachwasser, Unterseite.
 */
export function createOcean() {
  const g = gerstner();
  const vWorld = varying(g.position, 'vWorld');
  const vBase = varying(g.base, 'vBase');
  const vHeight = varying(g.height, 'vHeight');

  const material = new MeshBasicNodeMaterial({ side: DoubleSide, fog: false });
  material.positionNode = g.position;
  // Alles Fragment-Shading in einem Fn: das Shading-LOD braucht Variablen/Verzweigungen (nur dort erlaubt)
  material.colorNode = Fn(() => {
    const toCam = cameraPosition.sub(vWorld);
    const dist = length(toCam);
    const V = toCam.div(dist);
    const L = sunDir;

    // ── Shading-LOD: Normale pro Pixel, Wellen nach Pixelgröße band-begrenzt, Rest → Rauheit ──
    const footprint = dist.mul(pixelAngle).div(max(V.y.abs(), 0.15)); // Pixelgröße am Boden (m), gedehnt bei flachem Blick
    const sh = shadingNormal(vBase, footprint);
    const N = sh.normal;
    const m2 = sh.roughness.add(0.0006); // mittlere quadratische Neigung: unaufgelöste Wellen + Mikro-Rauheit

    const NdV = max(dot(N, V), 0);
    const fres = pow(NdV.oneMinus(), 5).mul(0.98).add(0.02);
    const R = reflect(V.negate(), N);
    const refl = skyBase(normalize(vec3(R.x, abs(R.y).add(0.01), R.z)));

    // Körperfarbe: gedämpftes, dunkles Petrol-Blau. Streulicht nur an den dünnen, obersten Kammspitzen gegen das Licht,
    // und nur bei flachem Blick (steil von oben bleibt das Wasser dunkel).
    const deep = vec3(0.007, 0.032, 0.05);
    // Türkises Durchscheinen im Sonnenlicht: dünne Kämme gegen die Sonne leuchten, Täler und sonnenabgewandte Seiten bleiben dunkel
    const sss = vec3(0.02, 0.3, 0.27);
    const sunBack = pow(clamp(dot(V.negate(), L).mul(0.5).add(0.5), 0, 1), 3);
    const crest = smoothstep(0.0, 1.0, vHeight.mul(0.8).add(0.3)).mul(smoothstep(0.6, 0.97, N.y).oneMinus().mul(0.5).add(0.5));
    const grazing = pow(NdV.oneMinus(), 2).mul(0.6).add(0.4);
    const sunUp = smoothstep(0.0, 0.3, L.y);
    const body = deep
      .add(sss.mul(sunBack.mul(0.9).add(0.1)).mul(crest).mul(grazing).mul(sunUp).mul(0.45))
      .add(vec3(0.006, 0.026, 0.034).mul(max(L.y, 0)));
    let col = mix(body, refl, fres);

    // Sonnenglanz: Beckmann-Verteilung mit der Rauheit. Nah/aufgelöst: enger, heller Kern (m² ≈ 1e-3).
    // Aus großer Höhe wächst m², der Glanz wird zu einem breiten, schwächeren Glitzerpfad (Energie bleibt erhalten).
    const H = normalize(L.add(V));
    const nh = clamp(dot(N, H), 0.001, 1);
    const nh2 = nh.mul(nh);
    const tan2 = nh2.oneMinus().div(nh2);
    const D = exp(tan2.negate().div(m2)).div(m2.mul(Math.PI).mul(nh2).mul(nh2));
    col = col.add(SUN_COL.mul(D).mul(fres).mul(0.7));

    // Horizontdunst in die Himmelsfarbe am Horizont derselben Himmelsrichtung. Bis 9 km sanft (max. 85 %), ab 15 km
    // vollständig: der Rand des Gitters (~40 km) löst sich restlos auf, auch aus großer Höhe (keine Kante zum Himmel).
    const hz = skyBase(normalize(vec3(V.x.negate(), 0.002, V.z.negate())));
    const fogA = max(smoothstep(600, 9000, dist).mul(0.85), smoothstep(15000, 38000, dist));
    col = mix(col, hz, fogA);

    // ── Ansicht von unten: Snell'sches Fenster + Totalreflexion (Port von infinity-ocean) ──
    const Nd = N.negate();
    const T = refract(V.negate(), Nd, 1.33);
    const Rr = reflect(V.negate(), Nd);
    const tir = mix(vec3(0, 0.025, 0.05), vec3(0.03, 0.22, 0.27), exp(Rr.y.mul(2.5)));
    const cosT = clamp(dot(V, Nd), 0, 1);
    const trans = pow(cosT.oneMinus(), 5).mul(0.9).oneMinus();
    const window = skyBase(normalize(T.add(1e-6))).mul(trans).mul(vec3(0.75, 0.95, 1.0));
    const colBelow = select(dot(T, T).lessThan(0.01), tir, mix(tir, window, smoothstep(0, 0.25, cosT)));

    // Vorderseite = von oben, Rückseite = von unten (dort läuft der Unterwasser-Pfad inkl. Nebel/Lichtschäfte)
    const out = vec3(0).toVar();
    If(frontFacing, () => {
      out.assign(col);
    }).Else(() => {
      out.assign(mix(colBelow, underwaterColor(colBelow, V.negate(), dist), under));
    });
    return vec4(finishColor(out), 1);
  })();

  const mesh = new Mesh(polarGrid(260, 360, 1.032), material);
  mesh.name = 'ocean';
  mesh.frustumCulled = false;

  let time = 0;
  return {
    mesh,
    /** `t` = Clock.time */
    update(t: number, cam: Vector3) {
      time = t;
      updateWavePhases(time);
      camXZ.value.set(cam.x, cam.z);
      camH.value = Math.abs(cam.y);
    },
    /** Höhe der Oberfläche über (x, z); Kamera-Abstand für die Fernausblendung */
    heightAt(x: number, z: number, cam: Vector3): number {
      return waveHeight(x, z, time, cam.x, cam.z, Math.abs(cam.y));
    },
    /** Selbstprüfungen für Floating Origin und GPU-Spiegel (siehe waves.ts) */
    errors(cam: Vector3): { shift: number; mirror: number } {
      return { shift: shiftInvarianceError(time, cam.x, cam.z, Math.abs(cam.y)), mirror: shaderMirrorError(time) };
    },
  };
}
