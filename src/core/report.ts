import { MAX_DRAW_CALLS, TARGET_WORK_MS } from './config';
import type { Engine } from './engine';
import type { CaptureStats } from './monitor';

const CAPTURE_SECONDS = 5;

const f = (v: number, d = 1): string => v.toFixed(d);

/** Gerät/Browser als Text. Nutzt nur, was der Browser selbst meldet. */
async function deviceInfo(engine: Engine): Promise<string> {
  const gpu = (navigator as { gpu?: { requestAdapter(): Promise<{ info?: Record<string, string> } | null> } }).gpu;
  let adapter = 'unbekannt';
  try {
    const info = (await gpu?.requestAdapter())?.info;
    if (info) adapter = [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' ') || adapter;
  } catch {
    /* Adapter-Info nicht verfügbar */
  }
  const chrome = /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1];
  const c = engine.renderer.domElement;
  return (
    `GPU: ${adapter}\n` +
    `Browser: ${chrome ? `Chrome ${chrome}` : navigator.userAgent} · Canvas ${c.width}×${c.height} = ${f((c.width * c.height) / 1e6, 2)} MP ` +
    `(Display-DPR ${devicePixelRatio}, Render-Ratio ${f(engine.pixelRatio, 2)})`
  );
}

function format(engine: Engine, s: CaptureStats, device: string): string {
  const cam = engine.camera.position;
  const report = engine.report;
  const lines: string[] = [];
  lines.push(`Ocean Drive Messung · ${s.frames} Frames / ${f(s.seconds)} s · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
  lines.push(device);
  lines.push(`URL: ${location.pathname}${location.search} · Kamera x ${f(cam.x, 0)} y ${f(cam.y, 1)} z ${f(cam.z, 0)}`);
  lines.push('');
  lines.push(`FPS ${f(s.fps, 0)} · Anzeige-Abstand p99 ${f(s.intervalP99)} ms`);
  lines.push(
    `Arbeit p50 ${f(s.workP50)} / p99 ${f(s.workP99)} / max ${f(s.workMax)} ms (Ziel p99 ≤ ${f(TARGET_WORK_MS)})` +
      `  ${s.workP99 <= TARGET_WORK_MS ? '✓' : '✗'}`,
  );
  lines.push(`CPU Ø ${f(s.cpuMs, 2)} ms · GPU Ø ${s.gpuMs === null ? 'n/a (keine Timestamp-Query)' : `${f(s.gpuMs, 2)} ms`}`);
  const declared = report?.declaredCalls ?? 0;
  lines.push(
    `Draw Calls ${s.drawCallsMax} (deklariert ${declared}, Limit ${MAX_DRAW_CALLS}, davon Engine ${engine.monitor.engineCalls})` +
      `  ${s.drawCallsMax <= MAX_DRAW_CALLS ? '✓' : '✗'}`,
  );
  lines.push(
    `Dreiecke Ø ${f(s.trianglesAvg / 1000, 0)}k · Compute-Calls ${s.computeCalls} · ` +
      `Sim-Schritte/Frame ${f(s.stepsPerFrame, 2)} · verworfen ${s.droppedSteps}`,
  );
  lines.push('');
  lines.push('Module (ms Ø / Spitze / Budget · Calls · Probe):');
  const probes = report?.modules ?? [];
  for (const m of s.modules) {
    const p = probes.find((x) => x.name === m.name)?.probe;
    const over = m.budget.ms !== undefined && m.avg > m.budget.ms;
    lines.push(
      ` ${p && !p.ok ? '✗' : over ? '!' : '✓'} ${m.name.padEnd(12)} ${f(m.avg, 2).padStart(5)} / ${f(m.peak, 2).padStart(5)}` +
        ` / ${m.budget.ms !== undefined ? f(m.budget.ms, 2) : '–'}` +
        ` · ${m.budget.drawCalls ?? 0}` +
        `${p?.info ? ` · ${p.info}` : ''}`,
    );
  }
  lines.push('');
  const v = report?.violations ?? [];
  lines.push(v.length === 0 ? 'Verstöße: keine' : `Verstöße:\n${v.map((x) => ` ! ${x}`).join('\n')}`);
  return lines.join('\n');
}

/** Notnagel, falls die Zwischenablage gesperrt ist: Text zum Markieren und Kopieren anzeigen */
function showFallback(text: string): void {
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;inset:10% 10%;z-index:10;background:#111e;color:#fff;padding:12px;border-radius:8px;display:flex;flex-direction:column;gap:8px';
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.readOnly = true;
  ta.style.cssText = 'flex:1;background:#000;color:#9f9;font:12px ui-monospace,monospace;border:0;padding:8px';
  const close = document.createElement('button');
  close.textContent = 'Schließen';
  close.onclick = () => box.remove();
  box.append(ta, close);
  document.body.append(box);
  ta.focus();
  ta.select();
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function makeButton(text: string, bottom: number): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.tabIndex = -1; // Space/WASD sollen nie einen Button auslösen
  btn.textContent = text;
  btn.style.cssText =
    `position:fixed;right:8px;bottom:${bottom}px;z-index:5;font:12px system-ui,sans-serif;padding:6px 10px;border-radius:6px;` +
    'border:1px solid #fff4;background:#000a;color:#fff;cursor:pointer';
  document.body.append(btn);
  return btn;
}

async function deliver(btn: HTMLButtonElement, idleText: string, text: string, release: () => void): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = '✓ kopiert – jetzt im Chat einfügen';
  } catch {
    btn.textContent = 'Kopieren gesperrt – Text unten markieren';
    showFallback(text);
  }
  console.log(text);
  setTimeout(() => {
    btn.textContent = idleText;
    release();
  }, 2500);
}

/** Stresslast: so oft wird die Szene pro Frame gerendert, damit die GPU voll ausgelastet ist (konstanter Takt, kein VSync-Leerlauf) */
const STRESS = 6;

/**
 * Varianten der Diagnose. Kosten = GPU(Variante) − GPU(leer). Die Zeile „alles, normal (1×)“ ist die Gegenprobe:
 * ihre GPU-Zeit muss zur Zeile „alles“ (Stresslast, durch die Wiederholungen geteilt) passen, sonst taugt die Messung nicht.
 */
const VARIANTS: { name: string; hide: string[]; scale: number; repeat: number }[] = [
  { name: 'alles, normal (1×)', hide: [], scale: 1, repeat: 1 },
  { name: 'leer (Ausgabe + MSAA)', hide: ['sky', 'ocean', 'plankton', 'bubbles'], scale: 1, repeat: STRESS },
  { name: 'nur Himmel', hide: ['ocean', 'plankton', 'bubbles'], scale: 1, repeat: STRESS },
  { name: 'nur Ozean', hide: ['sky', 'plankton', 'bubbles'], scale: 1, repeat: STRESS },
  { name: 'nur Partikel', hide: ['sky', 'ocean'], scale: 1, repeat: STRESS },
  { name: 'alles', hide: [], scale: 1, repeat: STRESS },
  { name: 'alles bei 50 % Auflösung', hide: [], scale: 0.5, repeat: STRESS },
];

async function runDiagnose(engine: Engine, btn: HTMLButtonElement): Promise<string> {
  const rows: { name: string; gpu: number | null; p50: number; calls: number; mp: number; repeat: number }[] = [];
  const c = engine.renderer.domElement;
  for (let i = 0; i < VARIANTS.length; i++) {
    const v = VARIANTS[i]!;
    btn.textContent = `Diagnose ${i + 1}/${VARIANTS.length}: ${v.name} …`;
    engine.setHidden(v.hide);
    engine.renderScale = v.scale;
    engine.renderRepeat = v.repeat;
    engine.applyResolution();
    await wait(1500); // einschwingen (Pipelines, Taktfrequenz)
    engine.monitor.startCapture();
    await wait(3000);
    const st = engine.monitor.finishCapture();
    rows.push({
      name: v.name,
      gpu: st?.gpuMs ?? null,
      p50: st?.workP50 ?? 0,
      calls: st?.drawCallsMax ?? 0,
      mp: (c.width * c.height) / 1e6,
      repeat: v.repeat,
    });
  }
  engine.setHidden([]);
  engine.renderScale = 1;
  engine.renderRepeat = 1;
  engine.applyResolution();

  const byName = (n: string) => rows.find((r) => r.name === n);
  const empty = byName('leer (Ausgabe + MSAA)')?.gpu ?? 0; // „leer“ liefert evtl. keine Zeit: dann 0
  const cam = engine.camera.position;
  const lines = [
    `Ocean Drive Diagnose · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    await deviceInfo(engine),
    `URL: ${location.pathname}${location.search} · Kamera y ${f(cam.y, 1)} ${cam.y < 0 ? '(unter Wasser)' : '(über Wasser)'}`,
    `Stresslast: ${STRESS}× Rendern pro Frame, GPU-Zeit ist durch ${STRESS} geteilt (= ein Durchgang)`,
    '',
    'Variante                      GPU/Durchgang   Calls    MP    Kosten (− leer)',
  ];
  for (const r of rows) {
    const cost = r.name.startsWith('nur ') && r.gpu !== null ? `${f(r.gpu - empty, 2)} ms` : '';
    lines.push(
      `${r.name.padEnd(28)} ${(r.gpu === null ? 'n/a' : f(r.gpu, 2) + ' ms').padStart(12)}   ${String(r.calls).padStart(4)}   ${f(r.mp, 1).padStart(4)}   ${cost}`,
    );
  }
  // eingebaute Gegenproben
  const normal = byName('alles, normal (1×)')?.gpu;
  const all = byName('alles')?.gpu;
  const half = byName('alles bei 50 % Auflösung')?.gpu;
  const parts = ['nur Himmel', 'nur Ozean', 'nur Partikel'].map((n) => byName(n)?.gpu);
  lines.push('');
  if (normal != null && all != null) {
    const ratio = normal / all;
    lines.push(`Gegenprobe 1 (normal vs. Stress): ${f(normal, 2)} vs. ${f(all, 2)} ms → Verhältnis ${f(ratio, 2)} ${ratio > 0.7 && ratio < 1.4 ? '✓ konsistent' : '✗ NICHT konsistent (VSync/Takt verfälscht Normalbetrieb oder Timestamps summieren nicht)'}`);
  }
  if (all != null && parts.every((p) => p != null)) {
    const sum = (parts as number[]).reduce((a, b) => a + (b - empty), 0) + empty;
    lines.push(`Gegenprobe 2 (Summe der Teile vs. alles): ${f(sum, 2)} vs. ${f(all, 2)} ms (Differenz = Überlappung, z. B. Himmel hinter dem Ozean per Tiefentest verworfen)`);
  }
  if (all != null && half != null) lines.push(`Gegenprobe 3 (Pixel): halbe Auflösung kostet ${f((half / all) * 100, 0)} % (≈ 50 % = pixelgebunden)`);
  return lines.join('\n');
}

/**
 * Zwei Buttons unten rechts:
 *  - „Messung kopieren“: 5 s messen, Gerät + Frame-Zeiten + Draw Calls + Module als Text kopieren.
 *  - „Diagnose“: ~25 s, schaltet Himmel/Ozean/Partikel/Auflösung einzeln um und misst die GPU-Kosten.
 */
export function installReportButton(engine: Engine): void {
  let busy = false;
  const idle1 = '📋 Messung kopieren';
  const idle2 = '🔬 Diagnose (≈ 35 s)';
  const b1 = makeButton(idle1, 8);
  const b2 = makeButton(idle2, 44);

  b1.addEventListener('click', async () => {
    b1.blur();
    if (busy) return;
    busy = true;
    engine.monitor.startCapture();
    for (let s = CAPTURE_SECONDS; s > 0; s--) {
      b1.textContent = `misst … ${s} s (nicht den Tab wechseln)`;
      await wait(1000);
    }
    const stats = engine.monitor.finishCapture();
    const text = stats ? format(engine, stats, await deviceInfo(engine)) : 'Keine Frames gemessen – war der Tab im Hintergrund?';
    await deliver(b1, idle1, text, () => (busy = false));
  });

  b2.addEventListener('click', async () => {
    b2.blur();
    if (busy) return;
    busy = true;
    const text = await runDiagnose(engine, b2);
    await deliver(b2, idle2, text, () => (busy = false));
  });
}
