import type { Material } from 'three';
import type { Context, Module } from '../core/module';
import { ORIGIN } from '../core/origin';
import { isUnderwater } from '../underwater';
import { BubbleSystem } from './bubbles';
import { createPlankton } from './plankton';

export function planktonModule(): Module {
  const plankton = createPlankton();
  let ctx: Context;
  return {
    name: 'plankton',
    deps: ['underwater', 'ocean'],
    budget: { ms: 0.05, drawCalls: 1 },
    init(c) {
      ctx = c;
      c.scene.add(plankton.mesh);
    },
    update() {
      // über Wasser nur ganz nah an der Oberfläche: dann leicht durch die Oberfläche sichtbar (ohne Tiefentest)
      const uw = isUnderwater();
      plankton.mesh.visible = uw || ctx.camera.position.y < 9;
      setDepthTest(plankton.mesh.material as Material, uw);
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
    deps: ['ocean', 'underwater'],
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
      setDepthTest(system.mesh.material as Material, isUnderwater()); // über Wasser: durch die Oberfläche (throughSurface)
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

/** Tiefentest nur bei Änderung umschalten (neue Pipeline) */
function setDepthTest(m: Material, on: boolean): void {
  if (m.depthTest === on) return;
  m.depthTest = on;
  m.needsUpdate = true;
}
