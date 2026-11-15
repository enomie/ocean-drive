import type { Context, Module } from '../core/module';
import { sunDir } from '../core/sun';
import { createSky } from './sky';

export function skyModule(): Module {
  const sky = createSky();
  let ctx: Context;
  return {
    name: 'sky',
    deps: ['camera'],
    budget: { ms: 0.05, drawCalls: 1 },
    init(c) {
      ctx = c;
      c.scene.add(sky.mesh);
    },
    update() {
      sky.mesh.position.copy(ctx.camera.position); // Kuppel folgt der Kamera
      sky.update(ctx.clock.time);
    },
    probe() {
      const len = sunDir.value.length();
      return { ok: Math.abs(len - 1) < 1e-3, info: `Sonne ${(Math.asin(sunDir.value.y) * 57.3).toFixed(0)}°` };
    },
    dispose() {
      ctx.scene.remove(sky.mesh);
    },
  };
}
