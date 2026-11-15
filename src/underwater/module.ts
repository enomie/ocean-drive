import type { Context, Module } from '../core/module';
import type { OceanApi } from '../ocean/module';
import { isUnderwater, under, updateUnderwater } from './underwater';

/** Setzt pro Frame die Unterwasser-Uniforms (Kamera relativ zur Wellenoberfläche). Die Optik selbst steckt in den Materialien. */
export function underwaterModule(): Module {
  let ctx: Context;
  let ocean: OceanApi;
  return {
    name: 'underwater',
    deps: ['camera', 'ocean'],
    budget: { ms: 0.05 },
    init(c) {
      ctx = c;
      ocean = c.get<OceanApi>('ocean');
    },
    update() {
      updateUnderwater(ctx.clock.time, ctx.camera, (x, z) => ocean.heightAt(x, z));
    },
    /** Konsistenz: Faktor in [0,1]; deutlich über/unter der Oberfläche muss er eindeutig 0/1 sein */
    probe() {
      const p = ctx.camera.position;
      const lens = p.y - ocean.heightAt(p.x, p.z);
      const u = under.value;
      const ok = u >= 0 && u <= 1 && (lens > 0.5 ? u === 0 : true) && (lens < -0.5 ? u === 1 : true);
      return { ok, info: isUnderwater() ? `unter Wasser ${(-p.y).toFixed(0)} m` : 'über Wasser' };
    },
  };
}
