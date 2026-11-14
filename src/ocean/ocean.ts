import { BufferGeometry, DoubleSide, Float32BufferAttribute, Mesh, type Vector3 } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  abs, cameraPosition, clamp, dot, length, max, mix, normalize, pow, reflect, smoothstep, varying, vec3,
} from 'three/tsl';
import { SUN_COL, skyBase, sunDir } from '../sky';
import { camXZ, gerstner, updateWavePhases } from './waves';

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
  const vNormal = varying(g.normal, 'vNormal');
  const vHeight = varying(g.height, 'vHeight');

  const toCam = cameraPosition.sub(vWorld);
  const dist = length(toCam);
  const V = toCam.div(dist);
  const L = sunDir;
  // Normale zum Horizont hin glätten (verhindert Glitzern/Aliasing in der Ferne)
  const N = normalize(mix(normalize(vNormal), vec3(0, 1, 0), smoothstep(400, 5000, dist).mul(0.6)));

  const NdV = max(dot(N, V), 0);
  const fres = pow(NdV.oneMinus(), 5).mul(0.98).add(0.02);
  const R = reflect(V.negate(), N);
  const refl = skyBase(normalize(vec3(R.x, abs(R.y).add(0.01), R.z)));

  // Körperfarbe + Streulicht in dünnen, besonnten Kämmen
  const deep = vec3(0.004, 0.032, 0.062);
  const sss = vec3(0.02, 0.32, 0.29);
  const sunBack = pow(clamp(dot(V.negate(), L).mul(0.5).add(0.5), 0, 1), 3);
  const crest = clamp(vHeight.mul(0.8).add(0.35), 0, 1.6);
  const lit = max(dot(N, L), 0).mul(0.6).add(0.4);
  const body = deep
    .add(sss.mul(sunBack.add(0.2)).mul(crest).mul(lit))
    .add(vec3(0.01, 0.045, 0.055).mul(max(L.y, 0)));

  let col = mix(body, refl, fres);

  // Sonnenglanz (enger Kern + breiter Hof)
  const H = normalize(L.add(V));
  const nh = max(dot(N, H), 0);
  col = col.add(SUN_COL.mul(pow(nh, 1200).mul(70).add(pow(nh, 140))).mul(fres).mul(4));

  // Horizontdunst
  const hz = skyBase(normalize(vec3(V.x.negate(), 0.02, V.z.negate())));
  col = mix(col, hz, smoothstep(600, 9000, dist).mul(0.85));

  const material = new MeshBasicNodeMaterial({ side: DoubleSide, fog: false });
  material.positionNode = g.position;
  material.colorNode = col;

  const mesh = new Mesh(polarGrid(260, 360, 1.032), material);
  mesh.frustumCulled = false;

  let time = 0;
  return {
    mesh,
    update(dt: number, cam: Vector3) {
      time += dt;
      updateWavePhases(time);
      camXZ.value.set(cam.x, cam.z);
    },
  };
}
