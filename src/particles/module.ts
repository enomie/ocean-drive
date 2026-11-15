import type { Context, Module } from '../core/module';
import { ORIGIN } from '../core/origin';
import { isUnderwater } from '../underwater';
import { BubbleSystem } from './bubbles';
import { updateParticleView } from './common';
import { createPlankton } from './plankton';

/** gemeinsame Sichtparameter für Partikel (Mindestgröße in px) */
export function particlesModule(): Module {
  let ctx: Context;
  return {
    name: 'particles',
    deps: ['camera'],
    budget: { ms: 0.02 },
    init(c) {
      ctx = c;
    },
    update() {
      updateParticleView(ctx.renderer, ctx.camera);
    },
    probe() {
      return { ok: ctx.renderer.domElement.height > 0 };
    },
  };
}

export function planktonModule(): Module {
  const plankton = createPlankton();
  let ctx: Context;
  return {
    name: 'plankton',
    deps: ['particles', 'underwater', 'ocean'],
    budget: { ms: 0.05, drawCalls: 1 },
    init(c) {
      ctx = c;
      c.scene.add(plankton.mesh);
    },
    update() {
      plankton.mesh.visible = isUnderwater(); // über Wasser verdeckt die Oberfläche alles: gar nicht zeichnen
      plankton.update(ctx.clock.time, ORIGIN.x, ORIGIN.z);
    },
    probe() {
      return { ok: plankton.mesh.count > 0, info: `${plankton.mesh.count} Teilchen${plankton.mesh.visible ? '' : ' (aus)'}` };
    },
    dispose() {
      ctx.scene.remove(plankton.mesh);
    },
  };
}

export interface BubblesApi {
  /** Ein Bläschen erzeugen (Weltkoordinaten; v m/s; Durchmesser m; Lebensdauer s) */
  spawn: BubbleSystem['spawn'];
}

export function bubblesModule(): Module<BubblesApi> {
  let system: BubbleSystem;
  let ctx: Context;
  let lastDropped = 0;
  return {
    name: 'bubbles',
    deps: ['particles', 'ocean', 'underwater'],
    budget: { ms: 0.3, drawCalls: 1 },
    get api() {
      return { spawn: system.spawn.bind(system) };
    },
    init(c) {
      ctx = c;
      system = new BubbleSystem(c.renderer);
      c.scene.add(system.mesh);
    },
    /** Floating Origin: alle lebenden Bläschen im GPU-Puffer verschieben (läuft in compute(), vor dem Einfügen neuer) */
    shift(dx, dz) {
      system.shift(dx, dz);
    },
    /** Spawns aller Emitter liegen jetzt vor (Emitter laufen in update, davor): einfügen + simulieren */
    compute() {
      system.update(ctx.clock.dt);
    },
    probe() {
      const d = system.dropped - lastDropped;
      lastDropped = system.dropped;
      return { ok: d === 0, info: d === 0 ? `${system.spawned} erzeugt · ${system.shifts} Origin-Shifts` : `${d} Spawns verworfen (Puffer voll)` };
    },
    dispose() {
      ctx.scene.remove(system.mesh);
    },
  };
}
