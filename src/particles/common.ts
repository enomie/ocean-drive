import type { Node } from 'three/webgpu';
import { exp, max, min, mix, smoothstep } from 'three/tsl';
import { under } from '../underwater';
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

/**
 * Sichtbarkeit eines Unterwasser-Teilchens. Unter Wasser: 1. Über Wasser schaut man nur ganz nah
 * leicht durch die Oberfläche: schwach, nimmt mit der Tiefe unter der Oberfläche und mit dem Abstand schnell ab.
 * (Die Teilchen werden dann ohne Tiefentest über die Oberfläche gezeichnet, siehe `particles/module.ts`.)
 * @param depth Tiefe unter der Oberfläche (m, ≥ 0)
 */
export function throughSurface(depth: Node<'float'>, dist: Node<'float'>) {
  const window = exp(depth.mul(-0.3)).mul(smoothstep(10, 3, dist)).mul(1.2);
  return mix(window, 1, under);
}
