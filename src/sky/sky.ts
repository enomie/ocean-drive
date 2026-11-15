import { BackSide, Mesh, SphereGeometry } from 'three';
import { MeshBasicNodeMaterial, type Node } from 'three/webgpu';
import {
  Fn, If, cameraProjectionMatrix, clamp, dot, float, max, mix, modelViewMatrix, normalize, positionLocal, pow,
  select, smoothstep, uniform, vec2, vec3, vec4,
} from 'three/tsl';
import { fbm } from '../core/noise';
import { SUN_COL, SUN_DIR, sunDir } from '../core/sun';
import { under, underAt, underwaterColor } from '../underwater';
import { finishColor } from '../core/output';

export { SUN_COL, SUN_DIR, sunDir };

/** Himmel ohne Wolken und Sonnenscheibe (auch für Spiegelung und Horizontdunst) */
export function skyBase(rd: Node<'vec3'>) {
  const y = rd.y;
  const sd = max(dot(rd, sunDir), 0);
  const zenith = vec3(0.10, 0.26, 0.62);
  const horizon = vec3(0.70, 0.80, 0.90);
  const h = pow(max(y, 0), 0.45);
  let base = mix(horizon, zenith, h);
  base = mix(base, vec3(1.0, 0.78, 0.55), pow(sd, 6).mul(h.oneMinus()).mul(0.55)); // warmer Dunst zur Sonne
  base = base.add(SUN_COL.mul(pow(sd, 18)).mul(0.45)); // Halo
  base = base.add(SUN_COL.mul(pow(sd, 400)).mul(3.0)); // enger Kern
  // Unter dem Horizont: STETIG aus der Horizontfarbe (kein Sprung bei y = 0), erst weit darunter Richtung Tiefblau.
  // Dort sieht man den Himmel aus großer Höhe zwischen mathematischem Horizont und dem Rand des Ozean-Gitters.
  return mix(base, vec3(0.30, 0.42, 0.50), smoothstep(0, 0.4, y.negate()).mul(0.6));
}

/**
 * Analytischer Himmel (Port von infinity-ocean/src/sky.ts):
 * Rayleigh-artiger Verlauf, Mie-Glanz um die Sonne, Sonnenscheibe, geschichtete Wolken.
 * Linear-HDR-Ausgabe, Tonemapping macht der Renderer.
 */
export function createSky() {
  const time = uniform(0);

  const rd = normalize(positionLocal);
  const y = rd.y;

  const base = skyBase(rd);
  const sd = max(dot(rd, sunDir), 0);

  // ── Wolken ─────────────────────────────────────────────
  const p = rd.xz.div(max(y, 0).add(0.06)).mul(1.3).add(vec2(time.mul(0.012), time.mul(0.004)));
  const n = fbm(p.mul(1.1));
  const n2 = fbm(p.mul(3.2).add(n.mul(1.5)));
  const d = smoothstep(0.48, 0.82, n.mul(0.75).add(n2.mul(0.35)));
  // Dickenprobe Richtung Sonne → Selbstschatten
  const ps = p.add(sunDir.xz.mul(0.12));
  const ns = fbm(ps.mul(1.1)).mul(0.75).add(fbm(ps.mul(3.2).add(n.mul(1.5))).mul(0.35));
  const shade = clamp(ns.sub(0.5).mul(2.2).oneMinus(), 0.25, 1.0);
  let lit = mix(vec3(0.55, 0.60, 0.70), vec3(1.05, 1.0, 0.95), shade);
  lit = lit.add(SUN_COL.mul(pow(sd, 10)).mul(d.oneMinus()).mul(1.8)); // Silberrand
  const cloudA = d.mul(smoothstep(0, 0.18, y)).mul(0.92);

  // ── Zusammensetzen ─────────────────────────────────────
  const disk = vec3(40.0, 34.0, 26.0).mul(smoothstep(0.99975, 0.9999, sd));
  const col = mix(base.add(disk), lit, cloudA);

  const material = new MeshBasicNodeMaterial({ side: BackSide, depthWrite: false, fog: false });
  // Himmel liegt auf der Fernebene (Tiefe = 1, „xyww“-Trick) und wird NACH dem Ozean gezeichnet:
  // der Tiefentest verwirft jedes Pixel, das der Ozean schon abdeckt – Wolken werden nur für sichtbaren Himmel berechnet.
  const clip = cameraProjectionMatrix.mul(modelViewMatrix).mul(vec4(positionLocal, 1));
  material.vertexNode = vec4(clip.x, clip.y, clip.w, clip.w);
  // Über Wasser: Himmel. Unter Wasser: nur der Wasserkörper (Wolken-Noise wird dann gar nicht berechnet).
  material.colorNode = Fn(() => {
    const out = vec3(0).toVar();
    const u = select(under.greaterThan(0), underAt(rd), float(0)); // pro Pixel: Wasserkante der Taucherbrille
    If(u.lessThan(0.999), () => {
      out.assign(col);
    });
    If(u.greaterThan(0), () => {
      out.assign(mix(out, underwaterColor(vec3(0), rd, float(1e4)), u));
    });
    return vec4(finishColor(out), 1);
  })();

  const mesh = new Mesh(new SphereGeometry(30000, 48, 24), material);
  mesh.name = 'sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = 10; // nach dem Ozean (renderOrder 0)

  return {
    mesh,
    /** `t` = Clock.time */
    update(t: number) {
      time.value = t;
    },
  };
}
