import type { Context, Module } from '../core/module';
import { createOcean } from './ocean';
import { shadingLod, WAVES } from './waves';

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
      // Shading-LOD: mit wachsender Pixelgröße nehmen aufgelöste Wellen ab und Rauheit zu (Monotonie), nichts geht verloren
      let lodOk = true;
      let prev = shadingLod(0.01);
      for (const fp of [0.1, 1, 10, 100, 1000, 1e5]) {
        const cur = shadingLod(fp);
        if (cur.resolved > prev.resolved || cur.m2 < prev.m2 - 1e-12) lodOk = false;
        prev = cur;
      }
      const total = WAVES.reduce((a, w) => a + 0.5 * ((6.2831853 / w.len) * w.amp) ** 2, 0);
      lodOk = lodOk && Math.abs(prev.m2 - total) < 1e-9 && shadingLod(0.01).resolved === WAVES.length; // ganz grob: alle Neigung als Rauheit
      const lodMid = shadingLod(10);
      const e = ocean.errors(ctx.camera.position);
      const rangeOk = Number.isFinite(lo + hi) && lo >= -maxH * 1.05 && hi <= maxH * 1.05;
      const shiftOk = e.shift < 1e-6; // Origin-Verschiebung ändert die Wasserhöhe nicht
      const mirrorOk = e.mirror < 5e-3; // Shader-Formel (float32) = CPU-Formel (double)
      return {
        ok: rangeOk && shiftOk && mirrorOk && lodOk,
        info:
          `h ${lo.toFixed(1)}…${hi.toFixed(1)} m · Shift-Δ ${e.shift.toExponential(0)} · Shader-Δ ${e.mirror.toExponential(0)}` +
          ` · LOD @10 m/Pixel: ${lodMid.resolved}/${WAVES.length} Wellen, m² ${lodMid.m2.toFixed(3)}` +
          `${rangeOk ? '' : ' · Höhe außerhalb Bereich'}${shiftOk ? '' : ' · SHIFT-INVARIANZ VERLETZT'}${mirrorOk ? '' : ' · SHADER≠CPU'}${lodOk ? '' : ' · LOD NICHT MONOTON'}`,
      };
    },
    dispose() {
      ctx.scene.remove(ocean.mesh);
    },
  };
}
