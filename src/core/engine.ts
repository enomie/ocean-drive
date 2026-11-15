import type { PerspectiveCamera, Scene } from 'three';
import { TimestampQuery, type WebGPURenderer } from 'three/webgpu';
import { Clock } from './clock';
import { FIXED_DT, MAX_FIXED_STEPS, MAX_FRAME_DT, MAX_RENDER_PIXELS, PROBE_INTERVAL } from './config';
import { Input } from './input';
import type { Context, Module, ProbeResult } from './module';
import { Monitor, type Report } from './monitor';
import { installReportButton } from './report';

/**
 * Der Game Loop und die Modul-Registry.
 *
 * Pro Frame, in dieser festen Reihenfolge:
 *   1. Zeit       Clock.advance(dt)            – dt auf MAX_FRAME_DT begrenzt
 *   2. Simulation fixedUpdate(FIXED_DT) × n    – Akkumulator, max. MAX_FIXED_STEPS, Rest wird verworfen und gezählt
 *   3. Visuals    update(dt, alpha)            – alpha = Anteil bis zum nächsten festen Schritt (Interpolation)
 *   4. GPU-Arbeit compute()                    – Compute-Dispatches
 *   5. Render     renderer.render(scene, camera)
 *   6. Messen     Monitor (CPU je Modul, GPU-Zeit, Draw Calls), Selbstprüfungen, HUD
 * In jeder Phase laufen die Module in Abhängigkeitsreihenfolge (`deps`, topologisch sortiert).
 */
export class Engine implements Context {
  readonly clock = new Clock();
  readonly input = new Input();
  monitor!: Monitor;

  private modules: Module[] = [];
  private readonly byName = new Map<string, Module>();
  private probes: ProbeResult[] = [];
  private last = 0;
  private acc = 0;
  private lastProbe = -Infinity;
  private started = false;
  private running = false;

  /** Diagnose: Skala auf die Renderauflösung (1 = normal) */
  renderScale = 1;
  /** Diagnose: Szene n-mal pro Frame rendern (Stresslast → GPU voll ausgelastet, Takt konstant). Normal: 1 */
  renderRepeat = 1;
  /** Diagnose: Objekte (nach Name) ausblenden, um ihre GPU-Kosten einzeln zu messen */
  private hidden = new Set<string>();
  private readonly maxPixels: number;
  readonly dev: boolean;

  constructor(
    readonly renderer: WebGPURenderer,
    readonly scene: Scene,
    readonly camera: PerspectiveCamera,
    opts: { maxPixels?: number; dev?: boolean } = {},
  ) {
    this.maxPixels = opts.maxPixels ?? MAX_RENDER_PIXELS;
    this.dev = opts.dev ?? import.meta.env.DEV;
  }

  /** Renderauflösung: Pixel-Ratio des Displays, begrenzt auf maxPixels, mal Diagnose-Skala */
  get pixelRatio(): number {
    const cap = Math.sqrt(this.maxPixels / (innerWidth * innerHeight));
    return Math.min(devicePixelRatio, 2, cap) * this.renderScale;
  }

  /** Diagnose: genau diese benannten Objekte ausblenden (alle anderen wieder einblenden) */
  setHidden(names: readonly string[]): void {
    for (const old of this.hidden) {
      if (!names.includes(old)) {
        const o = this.scene.getObjectByName(old);
        if (o) o.visible = true;
      }
    }
    this.hidden = new Set(names);
  }

  /** Auflösung neu anwenden (nach Änderung von renderScale) */
  applyResolution(): void {
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(innerWidth, innerHeight);
  }

  add(m: Module): this {
    if (this.started) throw new Error(`Modul "${m.name}" nach dem Start hinzugefügt`);
    if (this.byName.has(m.name)) throw new Error(`Modul "${m.name}" doppelt registriert`);
    this.byName.set(m.name, m);
    this.modules.push(m);
    return this;
  }

  get<T>(name: string): T {
    const m = this.byName.get(name);
    if (!m) throw new Error(`Modul "${name}" nicht registriert`);
    if (m.api === undefined) throw new Error(`Modul "${name}" hat keine api`);
    return m.api as T;
  }

  /** letzter Messbericht (für Konsole und Headless-Läufe) */
  get report(): Report | null {
    return this.monitor?.last ?? null;
  }

  /** Reihenfolge nach `deps` festlegen; fehlende/zyklische Abhängigkeiten sofort melden */
  private sort(): void {
    const order: Module[] = [];
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (m: Module, path: string[]): void => {
      const s = state.get(m.name);
      if (s === 'done') return;
      if (s === 'visiting') throw new Error(`Zyklische Modul-Abhängigkeit: ${[...path, m.name].join(' → ')}`);
      state.set(m.name, 'visiting');
      for (const d of m.deps ?? []) {
        const dep = this.byName.get(d);
        if (!dep) throw new Error(`Modul "${m.name}": unbekannte Abhängigkeit "${d}"`);
        visit(dep, [...path, m.name]);
      }
      state.set(m.name, 'done');
      order.push(m);
    };
    for (const m of this.modules) visit(m, []);
    this.modules = order;
  }

  async start(): Promise<void> {
    this.started = true;
    this.resize(); // Auflösung vor dem Pipeline-Aufbau festlegen
    this.sort();
    for (const m of this.modules) await m.init?.(this);

    // Pipelines vor dem ersten Frame bauen, sonst ruckelt der Start
    try {
      await this.renderer.compileAsync(this.scene, this.camera);
    } catch (e) {
      console.warn('[engine] compileAsync fehlgeschlagen:', e);
    }

    this.probes = this.modules.map(() => ({ ok: true }));
    this.runProbes();
    const hud = document.getElementById('hud')!;
    this.monitor = new Monitor(
      this.modules.map((m) => m.name),
      this.modules.map((m) => m.budget),
      this.renderer,
      hud,
      this.dev,
      // Tonemapping/Farbraum: three rendert in einen Zwischenpuffer und zeichnet 1 Vollbild-Quad zur Ausgabe
      this.renderer.needsFrameBufferTarget ? 1 : 0,
    );

    addEventListener('keydown', (e) => {
      if (e.code === 'F3') {
        e.preventDefault();
        this.monitor.detailed = !this.monitor.detailed;
        this.monitor.refresh();
      }
    });
    installReportButton(this);
    addEventListener('resize', () => this.resize());

    this.last = performance.now();
    this.running = true;
    this.renderer.setAnimationLoop(this.frame);
  }

  stop(): void {
    this.running = false;
    this.renderer.setAnimationLoop(null);
    for (const m of [...this.modules].reverse()) m.dispose?.();
  }

  private resize(): void {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.applyResolution();
  }

  private runProbes(): void {
    this.modules.forEach((m, i) => {
      try {
        this.probes[i] = m.probe();
      } catch (e) {
        this.probes[i] = { ok: false, info: String(e) };
      }
    });
  }

  private readonly frame = (now: number): void => {
    if (!this.running) return;
    const t0 = performance.now();
    const rawDt = Math.max(0, (now - this.last) / 1000);
    this.last = now;
    const dt = Math.min(rawDt, MAX_FRAME_DT);
    this.clock.advance(dt);
    const mon = this.monitor;
    const mods = this.modules;

    // 2. feste Schritte
    this.acc += dt;
    let steps = 0;
    let dropped = 0;
    while (this.acc >= FIXED_DT) {
      if (steps >= MAX_FIXED_STEPS) {
        dropped = Math.floor(this.acc / FIXED_DT);
        this.acc = 0;
        break;
      }
      for (let i = 0; i < mods.length; i++) {
        const m = mods[i]!;
        if (!m.fixedUpdate) continue;
        const a = performance.now();
        m.fixedUpdate(FIXED_DT);
        mon.addModule(i, performance.now() - a);
      }
      this.clock.fixedTime += FIXED_DT;
      this.acc -= FIXED_DT;
      steps++;
    }
    const alpha = this.acc / FIXED_DT;

    // 3. Visuals
    for (let i = 0; i < mods.length; i++) {
      const m = mods[i]!;
      if (!m.update) continue;
      const a = performance.now();
      m.update(dt, alpha);
      mon.addModule(i, performance.now() - a);
    }
    if (this.hidden.size > 0) for (const n of this.hidden) { const o = this.scene.getObjectByName(n); if (o) o.visible = false; }
    // 4. Compute
    for (let i = 0; i < mods.length; i++) {
      const m = mods[i]!;
      if (!m.compute) continue;
      const a = performance.now();
      m.compute();
      mon.addModule(i, performance.now() - a);
    }
    // 5. Render
    for (let r = 0; r < this.renderRepeat; r++) this.renderer.render(this.scene, this.camera);
    // GPU-Zeiten asynchron auflösen (wirken im nächsten Frame; ohne Feature bleibt es bei 0)
    void this.renderer.resolveTimestampsAsync(TimestampQuery.RENDER);
    void this.renderer.resolveTimestampsAsync(TimestampQuery.COMPUTE);
    this.input.endFrame();

    // 6. Messen
    mon.endFrame(rawDt * 1000, performance.now() - t0, steps, dropped, this.renderRepeat);
    const nowSec = this.clock.time;
    if (nowSec - this.lastProbe >= PROBE_INTERVAL) {
      this.lastProbe = nowSec;
      this.runProbes();
    }
    mon.tick(nowSec, this.probes);
  };
}
