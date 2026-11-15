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

type F = Node<'float'>;
type V2 = Node<'vec2'>;

/** Verschiebung + analytische Normale am unverschobenen Punkt `base` (Weltkoordinaten xz), `dist` = Abstand zur Kamera */
function wavesAt(base: V2, dist: F) {
  let dx: F = float(0);
  let dz: F = float(0);
  let dy: F = float(0);
  let nx: F = float(0);
  let nz: F = float(0);
  let ny: F = float(1);
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
  return { dx, dy, dz, normal: vec3(nx, ny, nz) };
}

/** Ozean-Vertex: Gitterpunkt relativ zur Kamera → verschobene Weltposition, Normale, Höhe */
export function gerstner() {
  const base = positionLocal.xz.add(camXZ);
  const w = wavesAt(base, length(positionLocal.xz));
  return {
    position: vec3(base.x.add(w.dx), w.dy, base.y.add(w.dz)),
    normal: w.normal.normalize(),
    height: w.dy,
  };
}

/**
 * Höhe der Oberfläche über Weltposition xz (GPU-Spiegel von `waveHeight`):
 * Fixpunkt-Iteration über die horizontale Verschiebung. Für Partikel, Fische, später Schiffe auf der GPU.
 */
export function surfaceHeight(xz: V2) {
  const dist = length(xz.sub(camXZ));
  let p: V2 = xz;
  for (let i = 0; i < 3; i++) {
    const w = wavesAt(p, dist);
    p = xz.sub(vec2(w.dx, w.dz));
  }
  return wavesAt(p, dist).dy;
}

// ── CPU-Spiegel (muss zur GPU-Funktion oben passen; Basis für Wasserlinie und später Schiffsauftrieb) ──
const _d: [number, number, number] = [0, 0, 0];

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

/** Verschiebung am unverschobenen Punkt (px, pz) – dieselbe Mathematik wie `gerstner()` */
function displacement(px: number, pz: number, t: number, camX: number, camZ: number): [number, number, number] {
  let dx = 0;
  let dy = 0;
  let dz = 0;
  const dist = Math.hypot(px - camX, pz - camZ);
  for (const w of WAVES) {
    const k = (Math.PI * 2) / w.len;
    const A = w.amp * (1 - smooth(w.len * 5, w.len * 13, dist));
    const f = k * (w.dx * px + w.dz * pz - Math.sqrt(9.81 / k) * t) + w.phase0; // Doppelpräzision: exakt in jeder Entfernung
    const Q = STEEPNESS / (k * w.amp * N);
    const C = Math.cos(f);
    dx += Q * A * w.dx * C;
    dz += Q * A * w.dz * C;
    dy += A * Math.sin(f);
  }
  _d[0] = dx;
  _d[1] = dy;
  _d[2] = dz;
  return _d;
}

/** Höhe der Wasseroberfläche über Weltposition (x, z): Fixpunkt-Iteration über die horizontale Verschiebung */
export function waveHeight(x: number, z: number, t: number, camX: number, camZ: number): number {
  let px = x;
  let pz = z;
  for (let i = 0; i < 4; i++) {
    const d = displacement(px, pz, t, camX, camZ);
    px = x - d[0];
    pz = z - d[2];
  }
  return displacement(px, pz, t, camX, camZ)[1];
}
