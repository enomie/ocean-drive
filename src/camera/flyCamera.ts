import type { Module } from '../core/module';
import type { Context } from '../core/module';

/**
 * Freie Kamera: Maus ziehen = umschauen, WASD = bewegen (in Blickrichtung / seitlich),
 * Space / C = hoch / runter, Shift = schnell, Mausrad = Grundgeschwindigkeit.
 * Liest nur `ctx.input`; bewegt wird in update(dt), unabhängig von der Framerate.
 */
export function flyCameraModule(): Module {
  let ctx: Context;
  let yaw = 0.6;
  let pitch = 0.35;
  let speed = 25; // m/s Grundgeschwindigkeit
  const minY = -300; // später: Meeresboden / Terrain

  return {
    name: 'camera',
    budget: { ms: 0.05 },

    init(c) {
      ctx = c;
    },

    update(dt) {
      const { camera: cam, input } = ctx;
      yaw -= input.lookX * 0.004;
      pitch = Math.max(-1.5, Math.min(1.5, pitch - input.lookY * 0.004));
      if (input.wheel !== 0) speed = Math.max(1, Math.min(2000, speed * Math.exp(-input.wheel * 0.001)));
      cam.rotation.set(pitch, yaw, 0, 'YXZ');

      const fwd = (input.isDown('KeyW') ? 1 : 0) - (input.isDown('KeyS') ? 1 : 0);
      const right = (input.isDown('KeyD') ? 1 : 0) - (input.isDown('KeyA') ? 1 : 0);
      const up = (input.isDown('Space') ? 1 : 0) - (input.isDown('KeyC') ? 1 : 0);
      if (fwd === 0 && right === 0 && up === 0) return;

      const fast = input.isDown('ShiftLeft') || input.isDown('ShiftRight');
      const step = speed * (fast ? 8 : 1) * dt;
      const sy = Math.sin(yaw);
      const cy = Math.cos(yaw);
      const cp = Math.cos(pitch);
      // Blickrichtung (−Z vorwärts) und rechts, beides aus yaw/pitch
      cam.position.x += (-sy * cp * fwd + cy * right) * step;
      cam.position.y += (Math.sin(pitch) * fwd + up) * step;
      cam.position.z += (-cy * cp * fwd - sy * right) * step;
      if (cam.position.y < minY) cam.position.y = minY;
    },

    probe() {
      const p = ctx.camera.position;
      const ok = Number.isFinite(p.x + p.y + p.z) && Number.isFinite(yaw + pitch + speed);
      return { ok, info: `${speed.toFixed(0)} m/s` };
    },
  };
}
