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
    `Browser: ${chrome ? `Chrome ${chrome}` : navigator.userAgent} · Canvas ${c.width}×${c.height} (DPR ${devicePixelRatio})`
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

/**
 * Button unten rechts: misst 5 s, fasst Gerät + Frame-Zeiten + Draw Calls + Module zusammen und kopiert den Text.
 * Lässt sich direkt in den Chat einfügen.
 */
export function installReportButton(engine: Engine): void {
  const btn = document.createElement('button');
  btn.id = 'copy-report';
  btn.tabIndex = -1; // Space/WASD sollen nie den Button auslösen
  btn.textContent = '📋 Messung kopieren';
  btn.style.cssText =
    'position:fixed;right:8px;bottom:8px;z-index:5;font:12px system-ui,sans-serif;padding:6px 10px;border-radius:6px;' +
    'border:1px solid #fff4;background:#000a;color:#fff;cursor:pointer';
  document.body.append(btn);

  let busy = false;
  btn.addEventListener('click', async () => {
    btn.blur();
    if (busy) return;
    busy = true;
    engine.monitor.startCapture();
    for (let s = CAPTURE_SECONDS; s > 0; s--) {
      btn.textContent = `misst … ${s} s (nicht den Tab wechseln)`;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const stats = engine.monitor.finishCapture();
    let text: string;
    if (!stats) {
      text = 'Keine Frames gemessen – war der Tab im Hintergrund?';
    } else {
      text = format(engine, stats, await deviceInfo(engine));
    }
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = '✓ kopiert – jetzt im Chat einfügen';
    } catch {
      btn.textContent = 'Kopieren gesperrt – Text unten markieren';
      showFallback(text);
    }
    console.log(text);
    setTimeout(() => {
      btn.textContent = '📋 Messung kopieren';
      busy = false;
    }, 2500);
  });
}
