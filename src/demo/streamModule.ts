import type { Context, Module } from '../core/module';
import { StreamEmitter, type BubblesApi } from '../particles';

/**
 * TEMPORÄR: fester Bläschenstrom zum Ansehen. Zeigt, wie ein Emitter ein Modul ist: er hängt sich per
 * `deps` an `bubbles` und ruft nur `spawn` auf. Ein Propeller ist dasselbe, mit Pose vom Schiff.
 */
export function demoStreamModule(): Module {
  const stream = new StreamEmitter();
  stream.origin.set(0, -6, -12);
  let ctx: Context;
  let bubbles: BubblesApi;
  return {
    name: 'demo-stream',
    deps: ['bubbles'],
    budget: { ms: 0.05 },
    init(c) {
      ctx = c;
      bubbles = c.get<BubblesApi>('bubbles');
    },
    /** Emitter-Position ist lokaler Zustand: beim Origin-Shift mitschieben (bleibt an derselben Stelle in der Welt) */
    shift(dx, dz) {
      stream.origin.x -= dx;
      stream.origin.z -= dz;
    },
    update() {
      stream.update(ctx.clock.dt, bubbles);
    },
    probe() {
      return { ok: stream.rate > 0, info: `${stream.rate} /s` };
    },
  };
}
