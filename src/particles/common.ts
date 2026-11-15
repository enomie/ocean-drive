import type { Node } from 'three/webgpu';
import { max, min } from 'three/tsl';
import { projY, viewH } from '../core/view';

/**
 * Weltgröße eines Partikels mit Mindestgröße 1,5 px: darunter wird die Größe gehalten und stattdessen
 * die Helligkeit gesenkt (`fade`) – kein Flimmern bei Sub-Pixel-Partikeln.
 */
export function pixelClamp(worldSize: Node<'float'>, dist: Node<'float'>) {
  const d = max(dist, 0.05);
  const px = worldSize.mul(projY).mul(0.5).mul(viewH).div(d);
  const minWorld = d.mul(1.5).div(projY.mul(0.5).mul(viewH));
  return { size: max(worldSize, minWorld), fade: min(px.div(1.5), 1) };
}
