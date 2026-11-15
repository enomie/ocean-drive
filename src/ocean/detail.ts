import { uniform, vec2 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { vnoise } from '../core/noise';
import { ORIGIN } from '../core/origin';

type V2 = Node<'vec2'>;

/**
 * Noise-Lagen für das Ozean-Shading (nur Fragment, die Geometrie bleibt reines Gerstner-Spektrum → CPU-Spiegel exakt).
 * Jede Lage ist Value-Noise aus der gemeinsamen 256²-Textur, gedreht und skaliert. Die Koordinaten sind ABSOLUT
 * (Ursprung in Doppelpräzision auf der CPU als Offset modulo 256) → beim Origin-Shift springt nichts.
 *  - warp*: Phasenverschiebung der kurzen Wellen → Streifen biegen sich (bricht das „Wellblech“ aus reinen Sinuswellen)
 *  - amp*:  Amplitudenmodulation der kurzen Wellen → mal stärker, mal schwächer
 *  - rip*:  Kräuselung (Dezimeter bis Meter), animiert
 */
export interface Layer {
  /** Meter pro Noise-Zelle */
  scale: number;
  c: number;
  s: number;
  /** Drift in Zellen pro Sekunde */
  drift: readonly [number, number];
  offset: ReturnType<typeof makeOffset>;
}

const makeOffset = () => uniform(vec2(0, 0));

function layer(scale: number, angle: number, drift: readonly [number, number] = [0, 0]): Layer {
  return { scale, c: Math.cos(angle), s: Math.sin(angle), drift, offset: makeOffset() };
}

export const LAYERS = {
  warpX: layer(37, 0.3),
  warpZ: layer(41, 1.9),
  ampA: layer(13, 0.9, [0.02, 0.01]),
  ampB: layer(29, 2.4, [-0.01, 0.015]),
  rip1: layer(1.0, 0.5, [0.35, 0.12]),
  rip2: layer(0.45, 2.1, [-0.1, 0.5]),
  rip3: layer(0.2, 4.0, [0.6, -0.3]),
} as const;

/** Neigungsstärke der Kräuselungs-Oktaven (≈ 4°) */
export const RIPPLE_SLOPE = 0.07;

const PERIOD = 256; // Kantenlänge der Noise-Textur in Zellen
const mod = (a: number): number => ((a % PERIOD) + PERIOD) % PERIOD;

/** Pro Frame: Ursprung und Zeit in Doppelpräzision in kleine Offsets umrechnen */
export function updateDetailLayers(t: number): void {
  for (const L of Object.values(LAYERS)) {
    const rx = L.c * ORIGIN.x - L.s * ORIGIN.z;
    const rz = L.s * ORIGIN.x + L.c * ORIGIN.z;
    L.offset.value.set(mod(rx / L.scale + L.drift[0] * t), mod(rz / L.scale + L.drift[1] * t));
  }
}

/** Noise-Koordinate (Zellen) einer Lage an der lokalen Position `base` */
function layerCoord(L: Layer, base: V2): V2 {
  return vec2(
    base.x.mul(L.c / L.scale).sub(base.y.mul(L.s / L.scale)),
    base.x.mul(L.s / L.scale).add(base.y.mul(L.c / L.scale)),
  ).add(L.offset) as unknown as V2;
}

/** Noise-Wert 0…1 */
export function layerNoise(L: Layer, base: V2) {
  return vnoise(layerCoord(L, base));
}

/** Neigungsvektor (Welt) einer Kräuselungs-Lage: Differenz des Noise entlang der gedrehten Achsen, zurückgedreht */
export function layerSlope(L: Layer, base: V2, strength: number) {
  const p = layerCoord(L, base);
  const v0 = vnoise(p);
  const gx = vnoise(p.add(vec2(0.15, 0)) as unknown as V2).sub(v0).mul(strength / 0.15);
  const gz = vnoise(p.add(vec2(0, 0.15)) as unknown as V2).sub(v0).mul(strength / 0.15);
  return vec2(gx.mul(L.c).add(gz.mul(L.s)), gx.mul(-L.s).add(gz.mul(L.c)));
}

/**
 * Selbstprüfung (Floating Origin): dieselbe ABSOLUTE Stelle muss vor und nach einer Verschiebung dieselbe Noise-Koordinate
 * (modulo 256 Zellen) ergeben. Gibt die größte Abweichung in Zellen zurück (soll ~1e-9 sein).
 */
export function detailShiftError(t: number): number {
  const DX = 640;
  const DZ = -384;
  const pts: readonly (readonly [number, number])[] = [[13.7, -48.2], [-300.1, 152.9], [820.5, -577.3]];
  let err = 0;
  for (const L of Object.values(LAYERS)) {
    const coord = (x: number, z: number, ox: number, oz: number): [number, number] => {
      const rx = L.c * ox - L.s * oz;
      const rz = L.s * ox + L.c * oz;
      return [
        mod((L.c * x - L.s * z) / L.scale + mod(rx / L.scale + L.drift[0] * t)),
        mod((L.s * x + L.c * z) / L.scale + mod(rz / L.scale + L.drift[1] * t)),
      ];
    };
    for (const [x, z] of pts) {
      const a = coord(x, z, ORIGIN.x, ORIGIN.z);
      const b = coord(x - DX, z - DZ, ORIGIN.x + DX, ORIGIN.z + DZ);
      for (let k = 0; k < 2; k++) {
        const d = Math.abs(((a[k]! - b[k]! + PERIOD / 2 + PERIOD) % PERIOD) - PERIOD / 2);
        err = Math.max(err, d);
      }
    }
  }
  return err;
}
