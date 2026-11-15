import { DataTexture, LinearFilter, RepeatWrapping } from 'three';
import type { Node } from 'three/webgpu';
import { float, floor, fract, texture, vec2 } from 'three/tsl';

/** 256² Zufallsbytes, deterministisch. CPU-Spiegel (Terrain etc.) liest dieselben Daten. */
export const NOISE_DATA = (() => {
  const data = new Uint8Array(256 * 256 * 4);
  let seed = 1337;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    data[i] = seed >>> 24;
  }
  return data;
})();

export const noiseTex = new DataTexture(NOISE_DATA, 256, 256);
noiseTex.wrapS = noiseTex.wrapT = RepeatWrapping;
noiseTex.magFilter = noiseTex.minFilter = LinearFilter;
noiseTex.needsUpdate = true;

type V2 = Node<'vec2'>;

/** Value-Noise: bilinear + smoothstep-Remap aus der Zufallstextur (wie infinity-ocean) */
export function vnoise(p: V2) {
  const i = floor(p);
  const f = fract(p);
  const s = f.mul(f).mul(f.mul(-2).add(3));
  return texture(noiseTex, i.add(s).add(0.5).div(256)).level(float(0)).r;
}

/** Drehung + Stauchung pro Oktave (mat2(1.6, 1.2, -1.2, 1.6)) */
function rot(p: V2) {
  return vec2(p.x.mul(1.6).sub(p.y.mul(1.2)), p.x.mul(1.2).add(p.y.mul(1.6)));
}

/** 5 Oktaven */
export function fbm(p0: V2) {
  let p = p0;
  let a = 0.5;
  let s = vnoise(p).mul(a);
  for (let k = 1; k < 5; k++) {
    p = rot(p);
    a *= 0.5;
    s = s.add(vnoise(p).mul(a));
  }
  return s;
}
