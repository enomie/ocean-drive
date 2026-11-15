import type { Context, Module } from '../core/module';
import { createOcean } from './ocean';
import { WAVES } from './waves';

export interface OceanApi {
  /** Höhe der Wasseroberfläche über Weltposition (x, z) in m (CPU-Spiegel der GPU-Wellen) */
  heightAt(x: number, z: number): number;
}

export function oceanModule(): Module<OceanApi> {
  const ocean = createOcean();
  let ctx: Context;
  const maxH = WAVES.reduce((s, w) => s + w.amp, 0);
  return {
    name: 'ocean',
    deps: ['camera'],
    budget: { ms: 0.1, drawCalls: 1 },
    api: {
      heightAt: (x, z) => ocean.heightAt(x, z, ctx.camera.position),
    },
    init(c) {
      ctx = c;
      c.scene.add(ocean.mesh);
    },
    update() {
      ocean.update(ctx.clock.time, ctx.camera.position);
    },
    /** CPU-Wellenhöhe: endlich und innerhalb der Summe aller Amplituden (+ Spielraum für die horizontale Verschiebung) */
    probe() {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < 24; i++) {
        const h = ocean.heightAt(i * 41.3 - 400, i * 17.9 - 200, ctx.camera.position);
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
      const e = ocean.errors(ctx.camera.position);
      const rangeOk = Number.isFinite(lo + hi) && lo >= -maxH * 1.05 && hi <= maxH * 1.05;
      const shiftOk = e.shift < 1e-6; // Origin-Verschiebung ändert die Wasserhöhe nicht
      const mirrorOk = e.mirror < 5e-3; // Shader-Formel (float32) = CPU-Formel (double)
      return {
        ok: rangeOk && shiftOk && mirrorOk,
        info:
          `h ${lo.toFixed(1)}…${hi.toFixed(1)} m · Shift-Δ ${e.shift.toExponential(0)} · Shader-Δ ${e.mirror.toExponential(0)}` +
          `${rangeOk ? '' : ' · Höhe außerhalb Bereich'}${shiftOk ? '' : ' · SHIFT-INVARIANZ VERLETZT'}${mirrorOk ? '' : ' · SHADER≠CPU'}`,
      };
    },
    dispose() {
      ctx.scene.remove(ocean.mesh);
    },
  };
}
