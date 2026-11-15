import type { PerspectiveCamera } from 'three';

/**
 * Freie Kamera: Maus ziehen = umschauen, WASD = bewegen (in Blickrichtung / seitlich),
 * Space / C = hoch / runter, Shift = schnell, Mausrad = Grundgeschwindigkeit.
 * Tasten über `code` (layoutunabhängig). Eingabe wird nur gesammelt, bewegt wird in update(dt).
 */
export class FlyCamera {
  yaw = 0.6;
  pitch = 0.35;
  /** Grundgeschwindigkeit m/s */
  speed = 25;
  /** Mindesthöhe über y = 0 (Meeresspiegel) */
  minY = 1;

  private readonly keys = new Set<string>();

  constructor(private readonly camera: PerspectiveCamera, target: HTMLElement | Window = window) {
    target.addEventListener('keydown', (e) => {
      const k = (e as KeyboardEvent).code;
      if (k === 'Space') e.preventDefault();
      this.keys.add(k);
    });
    target.addEventListener('keyup', (e) => this.keys.delete((e as KeyboardEvent).code));
    addEventListener('blur', () => this.keys.clear());
    target.addEventListener('pointermove', (e) => {
      const p = e as PointerEvent;
      if (p.buttons === 0) return;
      this.yaw -= p.movementX * 0.004;
      this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - p.movementY * 0.004));
    });
    target.addEventListener('wheel', (e) => {
      this.speed = Math.max(1, Math.min(2000, this.speed * Math.exp(-(e as WheelEvent).deltaY * 0.001)));
    });
  }

  update(dt: number): void {
    const cam = this.camera;
    cam.rotation.set(this.pitch, this.yaw, 0, 'YXZ');

    const k = this.keys;
    const fwd = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    const right = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const up = (k.has('Space') ? 1 : 0) - (k.has('KeyC') ? 1 : 0);
    if (fwd === 0 && right === 0 && up === 0) return;

    const step = this.speed * (k.has('ShiftLeft') || k.has('ShiftRight') ? 8 : 1) * dt;
    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    const cp = Math.cos(this.pitch);
    // Blickrichtung (−Z vorwärts) und rechts, beides aus yaw/pitch
    cam.position.x += (-sy * cp * fwd + cy * right) * step;
    cam.position.y += (Math.sin(this.pitch) * fwd + up) * step;
    cam.position.z += (-cy * cp * fwd - sy * right) * step;
    if (cam.position.y < this.minY) cam.position.y = this.minY;
  }
}
