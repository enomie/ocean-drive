import type { PerspectiveCamera } from 'three';
import type { WebGPURenderer, Node } from 'three/webgpu';
import { max, min, uniform } from 'three/tsl';

/** Sichtparameter für pixelgenaue Mindestgröße (pro Frame aktualisieren) */
const viewH = uniform(1080); // Höhe des Drawing-Buffers in px
const projY = uniform(1.7); // 1 / tan(fov / 2)

export function updateParticleView(renderer: WebGPURenderer, camera: PerspectiveCamera): void {
  viewH.value = renderer.domElement.height;
  projY.value = 1 / Math.tan((camera.fov * Math.PI) / 360);
}

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
