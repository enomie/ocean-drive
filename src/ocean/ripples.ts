import { float, floor, fract, texture, uniform, vec2 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { noiseTex } from '../core/noise';
import { ORIGIN } from '../core/origin';

type F = Node<'float'>;
type V2 = Node<'vec2'>;

/**
 * Kräuselung (nur Shading): Gradient-Noise (Perlin) mit ANALYTISCHER Ableitung, mehrere gedrehte Oktaven.
 * - Quintische Interpolation → Ableitung ist C1-stetig: keine Zellkanten, keine Differenzen-Stufen (alte Value-Noise-„Waffel“).
 * - Kein Sinus: Summen gerader oder verbogener Sinuswellen zeigen immer ein Muster (Rauten, Kreise).
 * - Gradienten aus der 256²-Zufallstextur (Kanäle r, g) an Texelmitten → exakt, periodisch alle 256 Zellen.
 *   Ursprung in Doppelpräzision modulo 256 Zellen auf der CPU → beim Origin-Shift springt nichts.
 */
interface Octave { scale: number; c: number; s: number; drift: readonly [number, number]; slope: number; offset: ReturnType<typeof makeOffset> }
const makeOffset = () => uniform(vec2(0, 0));
const oct = (scale: number, angle: number, drift: readonly [number, number], slope: number): Octave =>
  ({ scale, c: Math.cos(angle), s: Math.sin(angle), drift, slope, offset: makeOffset() });

/** Meter pro Zelle (≈ Kräusel-Wellenlänge), Drehung, Drift (Zellen/s), Neigungsstärke */
const OCTAVES: readonly Octave[] = [
  oct(2.3, 0.4, [0.05, 0.02], 0.07),
  oct(1.21, 1.7, [-0.04, 0.09], 0.06),
  oct(0.63, 2.9, [0.14, -0.05], 0.05),
  oct(0.34, 4.4, [-0.1, -0.2], 0.04),
  oct(0.19, 5.6, [0.3, 0.15], 0.03),
];

/**
 * Shading-LOD, gemeinsam für Wellen und Kräuselung: Anteil, mit dem ein Detail der Länge `len` (m) bei der Pixelgröße
 * `footprint` (m) noch gezeichnet wird. Voll ab ~16 Pixeln pro Länge, weg unter ~6 Pixeln (darunter: Rauheit).
 */
export const LOD_BAND = [0.06, 0.16] as const;
export const lodVisibility = (footprint: F, len: number): F => footprint.div(len).smoothstep(LOD_BAND[0], LOD_BAND[1]).oneMinus();

const PERIOD = 256;
const mod = (a: number) => ((a % PERIOD) + PERIOD) % PERIOD;

/** Pro Frame: Ursprung (Doppelpräzision) und Drift in kleine Offsets modulo 256 Zellen umrechnen */
export function updateRipples(t: number): void {
  for (const o of OCTAVES) {
    const rx = o.c * ORIGIN.x - o.s * ORIGIN.z;
    const rz = o.s * ORIGIN.x + o.c * ORIGIN.z;
    o.offset.value.set(mod(rx / o.scale + o.drift[0] * t), mod(rz / o.scale + o.drift[1] * t));
  }
}

/** Zufallsgradient (−1…1)² an der ganzzahligen Zelle `i` */
function grad(i: V2): V2 {
  const t = texture(noiseTex, i.add(0.5).div(PERIOD)).level(float(0));
  return vec2(t.r, t.g).mul(2).sub(1) as unknown as V2;
}

/** Gradient-Noise mit Ableitung: liefert d(noise)/dp (vec2) */
function noiseDeriv(p: V2): V2 {
  const i = floor(p);
  const f = fract(p);
  const u = f.mul(f).mul(f).mul(f.mul(f.mul(6).sub(15)).add(10));
  const du = f.mul(f).mul(30).mul(f.mul(f.sub(2)).add(1));
  const ga = grad(i);
  const gb = grad(i.add(vec2(1, 0)) as unknown as V2);
  const gc = grad(i.add(vec2(0, 1)) as unknown as V2);
  const gd = grad(i.add(vec2(1, 1)) as unknown as V2);
  const va = ga.dot(f);
  const vb = gb.dot(f.sub(vec2(1, 0)));
  const vc = gc.dot(f.sub(vec2(0, 1)));
  const vd = gd.dot(f.sub(vec2(1, 1)));
  const k = va.sub(vb).sub(vc).add(vd);
  return ga
    .add(gb.sub(ga).mul(u.x))
    .add(gc.sub(ga).mul(u.y))
    .add(ga.sub(gb).sub(gc).add(gd).mul(u.x.mul(u.y)))
    .add(du.mul(vec2(u.y.mul(k).add(vb.sub(va)), u.x.mul(k).add(vc.sub(va))))) as unknown as V2;
}

/**
 * Neigung (dh/dx, dh/dz) der Kräuselung an der lokalen Position `base`, band-begrenzt nach Pixelgröße.
 * Nicht aufgelöste Oktaven → `roughness` (mittlere quadratische Neigung) für den Sonnenglanz.
 */
export function rippleSlope(base: V2, footprint: F) {
  let slope: Node<'vec2'> = vec2(0, 0);
  let roughness: F = float(0);
  for (const o of OCTAVES) {
    const vis = lodVisibility(footprint, o.scale);
    roughness = roughness.add(vis.oneMinus().mul(0.5 * o.slope * o.slope));
    const p = vec2(
      base.x.mul(o.c / o.scale).sub(base.y.mul(o.s / o.scale)),
      base.x.mul(o.s / o.scale).add(base.y.mul(o.c / o.scale)),
    ).add(o.offset) as unknown as V2;
    const d = noiseDeriv(p).mul(vis.mul(o.slope));
    // zurück in Weltachsen drehen
    slope = slope.add(vec2(d.x.mul(o.c).add(d.y.mul(o.s)), d.x.mul(-o.s).add(d.y.mul(o.c))));
  }
  return { slope, roughness };
}
