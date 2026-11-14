import { cos, float, length, oneMinus, positionLocal, sin, smoothstep, uniform, vec2, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';

/**
 * Windsee-Spektrum als Gerstner-Wellen (Port von infinity-ocean/src/waves.ts):
 * Wellenlängen log-verteilt 140 m → 2,4 m, Richtungen um den Wind gestreut (breiter für kurze Wellen).
 * Richtung, Amplitude und Länge sind Konstanten im Shader-Graphen; nur die Phase ist ein Uniform.
 */
const WIND = 0.25;
const STEEPNESS = 0.58;
const N = 16;

interface Wave { dx: number; dz: number; amp: number; len: number; phase0: number }

export const WAVES: readonly Wave[] = (() => {
  const out: Wave[] = [];
  let seed = 9001;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < N; i++) {
    const len = 140 * Math.pow(2.4 / 140, i / (N - 1)) * (0.93 + rnd() * 0.14);
    const spread = 0.35 + 0.9 * (i / (N - 1));
    const dir = WIND + (rnd() * 2 - 1) * spread;
    const steep = 0.028 + 0.02 * Math.sin(Math.PI * Math.min(i / (N * 0.7), 1));
    out.push({ dx: Math.cos(dir), dz: Math.sin(dir), amp: ((steep * len) / (2 * Math.PI)) * 1.1, len, phase0: rnd() * 6.283 });
  }
  return out;
})();

/** Kameraposition (xz) – das Gitter folgt der Kamera, die Wellen hängen an Weltkoordinaten */
export const camXZ = uniform(vec2(0, 0));
const phase = WAVES.map(() => uniform(0));

/** Phasen in Doppelpräzision auf der CPU wickeln: ω·t bleibt auch nach Stunden genau */
export function updateWavePhases(t: number): void {
  const TAU = Math.PI * 2;
  WAVES.forEach((w, i) => {
    const k = TAU / w.len;
    const f = w.phase0 - Math.sqrt(9.81 * k) * t;
    phase[i]!.value = f - Math.floor(f / TAU) * TAU;
  });
}

/** Verschiebung + analytische Normale am unverschobenen Gitterpunkt (Vertex-Stufe) */
export function gerstner() {
  const base = positionLocal.xz.add(camXZ); // Weltposition vor der Verschiebung
  const dist = length(positionLocal.xz); // Abstand zur Kamera
  let dx: Node<'float'> = float(0);
  let dz: Node<'float'> = float(0);
  let dy: Node<'float'> = float(0);
  let nx: Node<'float'> = float(0);
  let nz: Node<'float'> = float(0);
  let ny: Node<'float'> = float(1);
  WAVES.forEach((w, i) => {
    const k = (Math.PI * 2) / w.len;
    // ferne Wellen ausblenden, die das Gitter nicht mehr auflösen kann
    const A = oneMinus(smoothstep(w.len * 5, w.len * 13, dist)).mul(w.amp);
    const f = base.x.mul(w.dx * k).add(base.y.mul(w.dz * k)).add(phase[i]!);
    const Q = STEEPNESS / (k * w.amp * N);
    const S = sin(f);
    const C = cos(f);
    const AC = A.mul(C);
    dx = dx.add(AC.mul(Q * w.dx));
    dz = dz.add(AC.mul(Q * w.dz));
    dy = dy.add(A.mul(S));
    nx = nx.sub(AC.mul(k * w.dx));
    nz = nz.sub(AC.mul(k * w.dz));
    ny = ny.sub(A.mul(S).mul(Q * k));
  });
  return {
    position: vec3(base.x.add(dx), dy, base.y.add(dz)),
    normal: vec3(nx, ny, nz).normalize(),
    height: dy,
  };
}
