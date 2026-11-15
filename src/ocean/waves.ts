import { If, cos, dot, float, max, mix, oneMinus, positionLocal, sin, smoothstep, sqrt, uniform, vec2, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { ORIGIN } from '../core/origin';
import { LAYERS, RIPPLE_SLOPE, layerNoise, layerSlope, updateDetailLayers } from './detail';

/**
 * Windsee-Spektrum als Gerstner-Wellen (Port von infinity-ocean/src/waves.ts):
 * Wellenlängen log-verteilt 140 m → 2,4 m, Richtungen um den Wind gestreut (breiter für kurze Wellen).
 * Richtung, Amplitude und Länge sind Konstanten im Shader-Graphen; nur die Phase ist ein Uniform.
 */
const WIND = 0.25;
const STEEPNESS = 0.58;
const N = 20;

interface Wave { dx: number; dz: number; amp: number; len: number; phase0: number }

export const WAVES: readonly Wave[] = (() => {
  const out: Wave[] = [];
  let seed = 9001;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < N; i++) {
    const len = 140 * Math.pow(2.4 / 140, i / (N - 1)) * (0.93 + rnd() * 0.14);
    const spread = 0.6 + 0.9 * (i / (N - 1));
    // jede 5. Welle gehört zu einer kreuzenden Dünung → keine dominante Streifenrichtung
    const dir = WIND + (i % 5 === 2 ? 1.1 : 0) + (rnd() * 2 - 1) * spread;
    const steep = 0.028 + 0.02 * Math.sin(Math.PI * Math.min(i / (N * 0.7), 1));
    out.push({ dx: Math.cos(dir), dz: Math.sin(dir), amp: ((steep * len) / (2 * Math.PI)) * 1.1 * (0.8 + rnd() * 0.4), len, phase0: rnd() * 6.283 });
  }
  return out;
})();

/** Kameraposition (xz) – das Gitter folgt der Kamera, die Wellen hängen an Weltkoordinaten */
export const camXZ = uniform(vec2(0, 0));
/** Höhe der Kamera über/unter dem Meeresspiegel (Betrag, m): Abstände zur Ausblendung sind 3D, nicht nur horizontal */
export const camH = uniform(0);
const phase = WAVES.map(() => uniform(0));

/**
 * Phasen in Doppelpräzision auf der CPU wickeln: k·(d·ORIGIN) − ω·t + φ₀ bleibt auch nach Stunden und bei
 * Millionen Metern Abstand exakt. Der Shader addiert nur k·(d·lokal) – lokal ist klein, also float32-genau.
 */
export function updateWavePhases(t: number): void {
  updateDetailLayers(t);
  const TAU = Math.PI * 2;
  WAVES.forEach((w, i) => {
    const k = TAU / w.len;
    const f = k * (w.dx * ORIGIN.x + w.dz * ORIGIN.z - Math.sqrt(9.81 / k) * t) + w.phase0;
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

/**
 * Shading-LOD: Normale PRO PIXEL aus demselben Spektrum (Fragment-Stufe), band-begrenzt nach Pixelgröße.
 * Eine Welle zählt als aufgelöst, wenn sie ≥ ~10 Pixel lang erscheint (voll) und fällt ab ~4 Pixeln weg.
 * Weggelassene Wellen gehen nicht verloren: ihre Steilheit wird als Rauheit `m²` (mittlere quadratische Neigung)
 * zurückgegeben und verbreitert später den Sonnenglanz – aus großer Höhe bleibt das Meer ein Meer statt glatter Flecken.
 * @param base      Weltposition (lokal) des Gitterpunkts, xz
 * @param footprint Pixelgröße am Boden in Metern (Entfernung × Pixelwinkel / Neigung)
 */
export function shadingNormal(base: V2, footprint: F) {
  const nx = float(0).toVar();
  const nz = float(0).toVar();
  const ny = float(1).toVar();
  let roughness: F = float(0);

  // Muster aufbrechen (nur Shading): ein langsames Feld verschiebt die Phase der kurzen Wellen (Streifen biegen sich),
  // ein zweites moduliert deren Amplitude. Lange Wellen (≥ 100 m) werden kaum verschoben → bleiben deckungsgleich zur Geometrie.
  const W = vec2(layerNoise(LAYERS.warpX, base).sub(0.5).mul(48), layerNoise(LAYERS.warpZ, base).sub(0.5).mul(48));
  const nA = layerNoise(LAYERS.ampA, base);
  const nB = layerNoise(LAYERS.ampB, base);

  WAVES.forEach((w, i) => {
    const k = (Math.PI * 2) / w.len;
    const vis = oneMinus(smoothstep(0.1, 0.25, footprint.div(w.len)));
    // nicht aufgelöster Anteil → Rauheit: mittlere quadratische Neigung einer Sinuswelle = ½ (k·A)²
    roughness = roughness.add(oneMinus(vis).mul(0.5 * (k * w.amp) * (k * w.amp)));
    const c = Math.min(1, Math.max(0.35, 10 / w.len)); // Stärke der Phasenverschiebung: 1 für ≤ 10 m, 0,1 für ≥ 100 m
    const ampMod = w.len < 90 ? mix(nA, nB, i / (N - 1)).mul(1.6).add(0.2) : float(1); // Mittel 1
    If(vis.greaterThan(0.002), () => {
      const A = vis.mul(w.amp).mul(ampMod);
      const f = base.x
        .mul(w.dx * k)
        .add(base.y.mul(w.dz * k))
        .add(phase[i]!)
        .add(W.x.mul(w.dx * k * c).add(W.y.mul(w.dz * k * c)));
      const Q = STEEPNESS / (k * w.amp * N);
      const AC = A.mul(cos(f));
      nx.subAssign(AC.mul(k * w.dx));
      nz.subAssign(AC.mul(k * w.dz));
      ny.subAssign(A.mul(sin(f)).mul(Q * k));
    });
  });

  // Kräuselung: drei Oktaven animiertes Noise (Dezimeter bis Meter), nach Pixelgröße band-begrenzt wie die Wellen
  for (const L of [LAYERS.rip0, LAYERS.rip1, LAYERS.rip2, LAYERS.rip3, LAYERS.rip4]) {
    const vis = oneMinus(smoothstep(0.1, 0.25, footprint.div(L.scale)));
    roughness = roughness.add(oneMinus(vis).mul(0.5 * RIPPLE_SLOPE * RIPPLE_SLOPE));
    If(vis.greaterThan(0.002), () => {
      const sl = layerSlope(L, base, RIPPLE_SLOPE).mul(vis).mul(nA.mul(0.8).add(0.6));
      nx.subAssign(sl.x);
      nz.subAssign(sl.y);
    });
  }
  return { normal: vec3(nx, ny, nz).normalize(), roughness: max(roughness, 0) };
}

/** Ozean-Vertex: Gitterpunkt relativ zur Kamera → verschobene Weltposition, Normale, Höhe */
export function gerstner() {
  const base = positionLocal.xz.add(camXZ);
  const w = wavesAt(base, sqrt(dot(positionLocal.xz, positionLocal.xz).add(camH.mul(camH)))); // 3D-Abstand zur Kamera
  return {
    position: vec3(base.x.add(w.dx), w.dy, base.y.add(w.dz)),
    normal: w.normal.normalize(),
    height: w.dy,
    /** Weltposition (lokal) des unverschobenen Gitterpunkts – Eingabe für die Pixel-Normalen */
    base,
  };
}

/**
 * Höhe der Oberfläche über Weltposition xz (GPU-Spiegel von `waveHeight`):
 * Fixpunkt-Iteration über die horizontale Verschiebung. Für Partikel, Fische, später Schiffe auf der GPU.
 */
export function surfaceHeight(xz: V2) {
  const d = xz.sub(camXZ);
  const dist = sqrt(dot(d, d).add(camH.mul(camH)));
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
function displacement(px: number, pz: number, t: number, camX: number, camZ: number, camH: number, ox: number, oz: number): [number, number, number] {
  let dx = 0;
  let dy = 0;
  let dz = 0;
  const dist = Math.hypot(px - camX, pz - camZ, camH); // 3D-Abstand wie auf der GPU
  for (const w of WAVES) {
    const k = (Math.PI * 2) / w.len;
    const A = w.amp * (1 - smooth(w.len * 5, w.len * 13, dist));
    const f = k * (w.dx * (px + ox) + w.dz * (pz + oz) - Math.sqrt(9.81 / k) * t) + w.phase0; // absolute Position, Doppelpräzision
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

/**
 * Höhe der Wasseroberfläche über der LOKALEN Position (x, z): Fixpunkt-Iteration über die horizontale Verschiebung.
 * `ox`/`oz` = Ursprung (Standard: der aktuelle); `camX`/`camZ` = lokale Kameraposition für die Fernausblendung.
 */
export function waveHeight(x: number, z: number, t: number, camX: number, camZ: number, camH: number, ox = ORIGIN.x, oz = ORIGIN.z): number {
  let px = x;
  let pz = z;
  for (let i = 0; i < 4; i++) {
    const d = displacement(px, pz, t, camX, camZ, camH, ox, oz);
    px = x - d[0];
    pz = z - d[2];
  }
  return displacement(px, pz, t, camX, camZ, camH, ox, oz)[1];
}

const PROBE_POINTS: readonly (readonly [number, number])[] = [
  [13.7, -48.2], [-300.1, 152.9], [820.5, -577.3], [-90.2, 640.8],
];

/**
 * Selbstprüfung 1 (Floating Origin): Eine Verschiebung um (640, −384) darf die Wasserhöhe an derselben ABSOLUTEN Stelle
 * nicht ändern. Gibt den größten Unterschied in Metern zurück (soll ~1e-9 sein).
 */
export function shiftInvarianceError(t: number, camX: number, camZ: number, camH: number): number {
  const DX = 640;
  const DZ = -384;
  let err = 0;
  for (const [x, z] of PROBE_POINTS) {
    const a = waveHeight(x, z, t, camX, camZ, camH);
    const b = waveHeight(x - DX, z - DZ, t, camX - DX, camZ - DZ, camH, ORIGIN.x + DX, ORIGIN.z + DZ);
    err = Math.max(err, Math.abs(a - b));
  }
  return err;
}

/**
 * Selbstprüfung 2 (GPU-Spiegel): rechnet die Formel des Shaders (float32: k·(d·lokal) + gewickelte Phase) nach und
 * vergleicht sie mit der CPU-Formel in Doppelpräzision. Fängt falsche Phasen nach Origin-Shifts oder Zeitdrift ab.
 * Muss nach `updateWavePhases(t)` mit demselben t laufen. Gibt den größten Sinus-Unterschied zurück (float32-Rauschen ~1e-4).
 */
export function shaderMirrorError(t: number): number {
  const TAU = Math.PI * 2;
  let err = 0;
  WAVES.forEach((w, i) => {
    const k = TAU / w.len;
    for (const [x, z] of PROBE_POINTS) {
      const gpu = Math.sin(Math.fround(k * (w.dx * x + w.dz * z)) + Math.fround(phase[i]!.value));
      const cpu = Math.sin(k * (w.dx * (x + ORIGIN.x) + w.dz * (z + ORIGIN.z) - Math.sqrt(9.81 / k) * t) + w.phase0);
      err = Math.max(err, Math.abs(gpu - cpu));
    }
  });
  return err;
}

/**
 * CPU-Spiegel der Wellenauswahl im Shading-LOD (`shadingNormal`): wie viele Wellen sind bei dieser Pixelgröße (m) noch
 * aufgelöst, und wie groß ist die Rauheit m² der weggelassenen. Für Selbstprüfung und HUD.
 */
export function shadingLod(footprint: number): { resolved: number; m2: number } {
  let resolved = 0;
  let m2 = 0;
  for (const w of WAVES) {
    const k = (Math.PI * 2) / w.len;
    const vis = 1 - smooth(0.1, 0.25, footprint / w.len);
    if (vis > 0.002) resolved++;
    m2 += (1 - vis) * 0.5 * (k * w.amp) * (k * w.amp);
  }
  return { resolved, m2 };
}
