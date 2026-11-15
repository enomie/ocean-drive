import type { PerspectiveCamera } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { float, uniform } from 'three/tsl';

/**
 * Sichtparameter für alles, was Pixelgrößen braucht (Partikel-Mindestgröße, Ozean-Shading-LOD).
 * Die Engine aktualisiert sie jeden Frame – kein Modul muss das selbst tun.
 */
export const viewH = uniform(1080); // Höhe des Drawing-Buffers in px
export const projY = uniform(1.7); // 1 / tan(fov / 2)

/** Winkel eines Pixels (rad) – mal Entfernung = Pixelgröße in Metern an dieser Stelle */
export const pixelAngle = float(2).div(projY.mul(viewH));

export function updateView(renderer: WebGPURenderer, camera: PerspectiveCamera): void {
  viewH.value = renderer.domElement.height;
  projY.value = 1 / Math.tan((camera.fov * Math.PI) / 360);
}
