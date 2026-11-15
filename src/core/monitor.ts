import type { WebGPURenderer } from 'three/webgpu';
import { MAX_DRAW_CALLS, MONITOR_INTERVAL, MONITOR_WINDOW, TARGET_WORK_MS, WARMUP_FRAMES } from './config';
import type { Budget, ProbeResult } from './module';

export interface ModuleStat {
  name: string;
  /** gleitender Mittelwert (ms) */
  ms: number;
  peak: number;
  budget: Budget;
  probe: ProbeResult;
}

export interface Report {
  fps: number;
  workP50: number;
  workP99: number;
  intervalP99: number;
  cpuMs: number;
  gpuMs: number | null;
  drawCalls: number;
  declaredCalls: number;
  computeCalls: number;
  triangles: number;
  stepsPerFrame: number;
  droppedSteps: number;
  modules: ModuleStat[];
  /** aktive Verstöße gegen Budgets / Selbstprüfungen (leer = alles grün) */
  violations: string[];
}

/** Ergebnis einer längeren Messung (Button „Messung kopieren“) */
export interface CaptureStats {
  frames: number;
  seconds: number;
  fps: number;
  workP50: number;
  workP99: number;
  workMax: number;
  intervalP99: number;
  cpuMs: number;
  gpuMs: number | null;
  /** GPU-Zeit nur der Render-Durchgänge / nur der Compute-Pässe (ms, null = nicht gemessen) */
  gpuRenderMs: number | null;
  gpuComputeMs: number | null;
  drawCallsMax: number;
  trianglesAvg: number;
  computeCalls: number;
  stepsPerFrame: number;
  droppedSteps: number;
  modules: { name: string; avg: number; peak: number; budget: Budget }[];
}

const CAPTURE_MAX = 6000; // Frames (reicht für 10 s bei 600 fps)

function pct(sorted: Float32Array, p: number): number {
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

const esc = (s: string): string => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));

/**
 * Misst jeden Frame und jedes Modul, vergleicht mit den deklarierten Budgets und zeigt das Ergebnis.
 * Gemessen wird die ARBEIT (CPU-Zeit bzw. GPU-Zeit, was größer ist), nicht der Anzeigeabstand:
 * der hängt vom Monitor ab (120 Hz / 75 Hz) und sagt nichts über Reserve.
 */
export class Monitor {
  private readonly work = new Float32Array(MONITOR_WINDOW);
  private readonly interval = new Float32Array(MONITOR_WINDOW);
  private readonly cpu = new Float32Array(MONITOR_WINDOW);
  private readonly gpu = new Float32Array(MONITOR_WINDOW);
  private n = 0;
  private i = 0;
  private readonly acc: Float64Array;
  private readonly ema: Float64Array;
  private readonly peak: Float64Array;
  private lastTick = 0;
  private steps = 0;
  private tickFrames = 0;
  private frameNo = 0;
  private dropped = 0;
  private droppedWindow = 0;
  private drawCalls = 0;
  private computeCalls = 0;
  private triangles = 0;
  private readonly active = new Set<string>();
  detailed = false;
  last: Report | null = null;

  // ── Messung über mehrere Sekunden (allokiert nur hier, nicht im normalen Betrieb) ──
  private cap: {
    work: Float32Array; cpu: Float32Array; gpu: Float32Array; interval: Float32Array;
    n: number; calls: number; tris: number; compute: number; steps: number; dropped: number; gpuR: number; gpuC: number;
    modSum: Float64Array; modPeak: Float64Array; t0: number;
  } | null = null;

  constructor(
    private readonly names: readonly string[],
    private readonly budgets: readonly Budget[],
    private readonly renderer: WebGPURenderer,
    private readonly hud: HTMLElement,
    private readonly dev: boolean,
    /** Draw Calls, die der Engine-Kern selbst macht (z. B. Ausgabe-Quad für Tonemapping) */
    private readonly baseCalls: number,
  ) {
    this.acc = new Float64Array(names.length);
    this.ema = new Float64Array(names.length);
    this.peak = new Float64Array(names.length);
  }

  /** CPU-Zeit eines Moduls in diesem Frame hinzufügen */
  addModule(index: number, ms: number): void {
    this.acc[index] = this.acc[index]! + ms;
  }

  endFrame(intervalMs: number, cpuMs: number, steps: number, droppedSteps: number, renderRepeat = 1): void {
    if (this.frameNo++ < WARMUP_FRAMES) {
      this.acc.fill(0);
      return;
    }
    const info = this.renderer.info;
    // GPU-Zeit des vorigen Frames (asynchron aufgelöst; 0 = nicht verfügbar)
    // bei Diagnose-Stresslast wird mehrfach gerendert: Render-Zeit ist dann die Summe, auf EINEN Durchgang zurückrechnen
    const gpuRender = info.render.timestamp / renderRepeat;
    const gpuMs = gpuRender + info.compute.timestamp;
    this.drawCalls = info.render.drawCalls / renderRepeat; // Calls/Dreiecke zählen alle Wiederholungen: auf einen Durchgang zurück
    this.triangles = info.render.triangles / renderRepeat;
    this.computeCalls = info.compute.frameCalls;

    const k = this.i;
    this.cpu[k] = cpuMs;
    this.gpu[k] = gpuMs;
    this.work[k] = Math.max(cpuMs, gpuMs);
    this.interval[k] = intervalMs;
    const c = this.cap;
    if (c && c.n < CAPTURE_MAX) {
      const j = c.n++;
      c.cpu[j] = cpuMs;
      c.gpu[j] = gpuMs;
      c.work[j] = Math.max(cpuMs, gpuMs);
      c.interval[j] = intervalMs;
      c.gpuR += gpuRender;
      c.gpuC += info.compute.timestamp;
      c.calls = Math.max(c.calls, this.drawCalls);
      c.tris += this.triangles;
      c.compute = Math.max(c.compute, this.computeCalls);
      c.steps += steps;
      c.dropped += droppedSteps;
      for (let m = 0; m < this.names.length; m++) {
        const a = this.acc[m]!;
        c.modSum[m] = c.modSum[m]! + a;
        c.modPeak[m] = Math.max(c.modPeak[m]!, a);
      }
    }
    this.i = (k + 1) % MONITOR_WINDOW;
    this.n = Math.min(this.n + 1, MONITOR_WINDOW);
    this.steps += steps;
    this.tickFrames++;
    this.dropped += droppedSteps;
    this.droppedWindow += droppedSteps;

    for (let m = 0; m < this.names.length; m++) {
      const a = this.acc[m]!;
      this.ema[m] = this.ema[m]! + (a - this.ema[m]!) * 0.05;
      this.peak[m] = Math.max(a, this.peak[m]! * 0.995);
      this.acc[m] = 0;
    }
  }

  /** alle MONITOR_INTERVAL s: Auswerten, Verstöße melden, HUD aktualisieren */
  tick(nowSec: number, probes: readonly ProbeResult[]): void {
    if (nowSec - this.lastTick < MONITOR_INTERVAL || this.n === 0) return;
    this.lastTick = nowSec;

    const w = this.work.slice(0, this.n).sort();
    const iv = this.interval.slice(0, this.n).sort();
    let cpuSum = 0;
    let gpuSum = 0;
    let ivSum = 0;
    for (let k = 0; k < this.n; k++) {
      cpuSum += this.cpu[k]!;
      gpuSum += this.gpu[k]!;
      ivSum += this.interval[k]!;
    }
    const gpuAvg = gpuSum / this.n;
    const declared = this.baseCalls + this.budgets.reduce((s, b) => s + (b.drawCalls ?? 0), 0);

    const modules: ModuleStat[] = this.names.map((name, m) => ({
      name,
      ms: this.ema[m]!,
      peak: this.peak[m]!,
      budget: this.budgets[m]!,
      probe: probes[m] ?? { ok: true },
    }));

    const report: Report = {
      fps: ivSum > 0 ? (1000 * this.n) / ivSum : 0,
      workP50: pct(w, 0.5),
      workP99: pct(w, 0.99),
      intervalP99: pct(iv, 0.99),
      cpuMs: cpuSum / this.n,
      gpuMs: gpuAvg > 0 ? gpuAvg : null,
      drawCalls: this.drawCalls,
      declaredCalls: declared,
      computeCalls: this.computeCalls,
      triangles: this.triangles,
      stepsPerFrame: this.steps / Math.max(1, this.tickFrames),
      droppedSteps: this.dropped,
      modules,
      violations: [],
    };

    const v = report.violations;
    if (report.workP99 > TARGET_WORK_MS) v.push(`Frame-Arbeit p99 ${report.workP99.toFixed(1)} ms > ${TARGET_WORK_MS.toFixed(1)} ms`);
    if (report.drawCalls > MAX_DRAW_CALLS) v.push(`Draw Calls ${report.drawCalls} > ${MAX_DRAW_CALLS}`);
    if (report.drawCalls === 0 && declared > this.baseCalls) v.push('Es wird nichts gezeichnet (0 Draw Calls) – GPU verloren oder Renderer hängt?');
    if (report.drawCalls > declared) v.push(`Draw Calls ungezählt: gemessen ${report.drawCalls}, deklariert ${declared} (davon ${this.baseCalls} Engine-Ausgabe)`);
    if (this.droppedWindow > 0) v.push(`${this.droppedWindow} Simulationsschritte verworfen (Aufholen aufgegeben)`);
    for (const m of modules) {
      if (m.budget.ms !== undefined && m.ms > m.budget.ms) v.push(`${m.name}: ${m.ms.toFixed(2)} ms > Budget ${m.budget.ms} ms`);
      if (!m.probe.ok) v.push(`${m.name}: Selbstprüfung fehlgeschlagen${m.probe.info ? ` (${m.probe.info})` : ''}`);
    }
    this.droppedWindow = 0;
    this.steps = 0;
    this.tickFrames = 0;

    // neue Verstöße einmalig in die Konsole (Dev), erledigte wieder freigeben
    const now = new Set(v);
    if (this.dev) for (const x of now) if (!this.active.has(x)) console.warn(`[budget] ${x}`);
    this.active.clear();
    for (const x of now) this.active.add(x);

    this.last = report;
    this.render(report);
  }

  /** Messung starten (ersetzt eine laufende) */
  startCapture(): void {
    const m = this.names.length;
    this.cap = {
      work: new Float32Array(CAPTURE_MAX), cpu: new Float32Array(CAPTURE_MAX), gpu: new Float32Array(CAPTURE_MAX),
      interval: new Float32Array(CAPTURE_MAX), n: 0, calls: 0, tris: 0, compute: 0, steps: 0, dropped: 0, gpuR: 0, gpuC: 0,
      modSum: new Float64Array(m), modPeak: new Float64Array(m), t0: performance.now(),
    };
  }

  /** Messung beenden und auswerten (null = keine Frames, z. B. Tab im Hintergrund) */
  finishCapture(): CaptureStats | null {
    const c = this.cap;
    this.cap = null;
    if (!c || c.n === 0) return null;
    const n = c.n;
    const sorted = (a: Float32Array) => a.slice(0, n).sort();
    const w = sorted(c.work);
    const iv = sorted(c.interval);
    let cpu = 0;
    let gpu = 0;
    let ivSum = 0;
    for (let k = 0; k < n; k++) {
      cpu += c.cpu[k]!;
      gpu += c.gpu[k]!;
      ivSum += c.interval[k]!;
    }
    return {
      frames: n,
      seconds: ivSum / 1000,
      fps: ivSum > 0 ? (1000 * n) / ivSum : 0,
      workP50: pct(w, 0.5),
      workP99: pct(w, 0.99),
      workMax: w[n - 1]!,
      intervalP99: pct(iv, 0.99),
      cpuMs: cpu / n,
      gpuMs: gpu > 0 ? gpu / n : null,
      gpuRenderMs: c.gpuR > 0 ? c.gpuR / n : null,
      gpuComputeMs: c.gpuC > 0 ? c.gpuC / n : null,
      drawCallsMax: c.calls,
      trianglesAvg: c.tris / n,
      computeCalls: c.compute,
      stepsPerFrame: c.steps / n,
      droppedSteps: c.dropped,
      modules: this.names.map((name, m) => ({ name, avg: c.modSum[m]! / n, peak: c.modPeak[m]!, budget: this.budgets[m]! })),
    };
  }

  /** Anzahl Draw Calls, die der Engine-Kern selbst macht */
  get engineCalls(): number {
    return this.baseCalls;
  }

  /** HUD neu zeichnen (z. B. nach F3), ohne die Auswertung zu verschieben */
  refresh(): void {
    if (this.last) this.render(this.last);
  }

  private render(r: Report): void {
    const ok = r.violations.length === 0;
    const gpu = r.gpuMs === null ? 'n/a' : `${r.gpuMs.toFixed(1)}`;
    let html =
      `<b style="color:${ok ? '#7f7' : '#f66'}">${ok ? '●' : '✖'}</b> ${r.fps.toFixed(0)} fps · ` +
      `Arbeit ${r.workP50.toFixed(1)} / p99 ${r.workP99.toFixed(1)} ms (Ziel ${TARGET_WORK_MS.toFixed(1)}) · ` +
      `CPU ${r.cpuMs.toFixed(1)} · GPU ${gpu} · Calls ${r.drawCalls}/${MAX_DRAW_CALLS}`;
    if (this.detailed) {
      html += ` · Dreiecke ${(r.triangles / 1000).toFixed(0)}k · Compute ${r.computeCalls} · Schritte/Frame ${r.stepsPerFrame.toFixed(2)}`;
      for (const m of r.modules) {
        const over = m.budget.ms !== undefined && m.ms > m.budget.ms;
        const col = !m.probe.ok || over ? '#f66' : '#aaa';
        html +=
          `\n<span style="color:${col}">${m.probe.ok ? '✓' : '✗'} ${m.name.padEnd(12)} ${m.ms.toFixed(2).padStart(5)} ms` +
          `${m.budget.ms !== undefined ? ` / ${m.budget.ms}` : ''}` +
          `${m.budget.drawCalls ? `  ${m.budget.drawCalls} call` : ''}` +
          `${m.probe.info ? `  ${esc(m.probe.info)}` : ''}</span>`;
      }
    }
    if (!ok) html += '\n' + r.violations.map((x) => `<span style="color:#f66">! ${esc(x)}</span>`).join('\n');
    html += this.detailed ? '' : '\n<span style="color:#888">F3 = Module</span>';
    this.hud.innerHTML = html;
  }
}
