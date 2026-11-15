# Performance-Messung – Anleitung zum Einbauen

Für alle, die diese Messung in ein anderes three.js-WebGPU-Projekt übernehmen wollen (getestet mit `three@0.187`, Chrome, MacBook M1).
Der Code dazu liegt in `src/core/` (`monitor.ts`, `report.ts`, `engine.ts`, `config.ts`); diese Datei erklärt das Prinzip, die Fallen und den kürzesten Weg.

## 1. Kurzfassung

1. **Gemessen wird die Arbeit pro Frame, nicht der Abstand zwischen Frames:** `max(CPU-Zeit, GPU-Zeit)`. Der Abstand hängt vom Monitor ab (75 Hz = 13,3 ms) und sagt nichts über Reserve.
2. **GPU-Zeit kommt aus Timestamp-Queries** (`trackTimestamp: true` + `renderer.resolveTimestampsAsync`), nicht aus `performance.now()`.
3. **Ziel ist p99, nicht der Mittelwert** (Ausreißer sind das, was man als Ruckeln sieht): p99 der Arbeit ≤ 8,3 ms für 120 fps.
4. **Draw Calls pro Frame** aus `renderer.info.render.drawCalls`, verglichen mit den Calls, die jedes Modul vorab *deklariert*. Weicht es ab, meldet der Monitor die Lücke.
5. **Messen allein reicht nicht, man muss die Kosten zuordnen können.** Dafür gibt es eine **Diagnose unter Stresslast** (Szene mehrfach pro Frame rendern, Teile einzeln ausblenden). Ohne sie waren unsere Zahlen irreführend (siehe Abschnitt 5).

## 2. Was gemessen wird

| Größe | Quelle | Anmerkung |
|---|---|---|
| CPU-Zeit | `performance.now()` um die Frame-Arbeit (Updates + `renderer.render`) | nur das Absenden der Befehle, die GPU läuft danach asynchron |
| GPU-Zeit Render | `renderer.info.render.timestamp` (nach `resolveTimestampsAsync('render')`) | gehört zum **vorigen** Frame (asynchron aufgelöst), 0 = nicht verfügbar |
| GPU-Zeit Compute | `renderer.info.compute.timestamp` (nach `resolveTimestampsAsync('compute')`) | getrennt halten, sonst steckt sie in jeder Render-Variante |
| Draw Calls | `renderer.info.render.drawCalls` | nach `render()` lesen; `autoReset` ist standardmäßig an |
| Dreiecke | `renderer.info.render.triangles` | |
| CPU je Modul | `performance.now()` um jeden Hook (`update`, `compute` …) | wenige Mikrosekunden Overhead |
| fps | Abstand der `requestAnimationFrame`-Zeiten | **nur zur Anzeige**, nicht als Maßstab |

**Arbeit** = `max(cpuMs, gpuMs)` pro Frame, in einem Ringpuffer über die letzten 240 Frames; daraus p50 / p99 / max.

## 3. Der kürzeste Weg (ca. 30 Minuten)

### 3.1 Renderer
```ts
const renderer = new WebGPURenderer({ trackTimestamp: true /* … */ });
await renderer.init();
```
Ohne das Feature `timestamp-query` (Chrome hat es, andere Browser teils nicht) bleibt die GPU-Zeit 0: dann „n/a“ anzeigen, nicht 0 ms.

### 3.2 Der Monitor (komplett kopierbar, kompiliert gegen three 0.187)
```ts
import { TimestampQuery, type WebGPURenderer } from 'three/webgpu';

export interface PerfReport {
  fps: number;
  workP50: number;
  workP99: number;
  cpuMs: number;
  gpuMs: number | null; // null = GPU-Zeit nicht verfügbar
  drawCalls: number;
}

/**
 * Minimaler Monitor: misst die ARBEIT pro Frame (max aus CPU- und GPU-Zeit), nicht den Anzeigeabstand.
 * Benutzung:   perf.beginFrame();  renderer.render(scene, camera);  perf.endFrame();   // einmal pro Frame
 */
export class PerfMonitor {
  private readonly W = 240; // Fenster in Frames
  private readonly work = new Float32Array(this.W);
  private readonly cpu = new Float32Array(this.W);
  private readonly gpu = new Float32Array(this.W);
  private readonly gap = new Float32Array(this.W);
  private n = 0;
  private i = 0;
  private frameNo = 0;
  private t0 = 0;
  private tPrev = 0;
  private calls = 0;

  constructor(
    private readonly renderer: WebGPURenderer, // MUSS mit { trackTimestamp: true } erzeugt sein
    private readonly warmupFrames = 90,
  ) {}

  beginFrame(): void {
    this.t0 = performance.now();
  }

  /** `repeat` = wie oft die Szene in diesem Frame gerendert wurde (normal 1, Diagnose-Stresslast > 1) */
  endFrame(repeat = 1): void {
    const now = performance.now();
    const cpuMs = now - this.t0; // CPU-Zeit bis zum Absenden der Befehle
    const gap = this.tPrev === 0 ? 0 : now - this.tPrev; // Abstand der Frames (nur zur Anzeige der fps)
    this.tPrev = now;

    // GPU-Zeit: asynchron auflösen; der Wert gehört zum VORIGEN Frame und steht danach in renderer.info
    void this.renderer.resolveTimestampsAsync(TimestampQuery.RENDER);
    void this.renderer.resolveTimestampsAsync(TimestampQuery.COMPUTE);
    if (this.frameNo++ < this.warmupFrames) return; // Pipeline-Aufbau/Shader-Compile nicht mitmessen

    const info = this.renderer.info;
    const gpuMs = info.render.timestamp / repeat + info.compute.timestamp; // 0 = nicht verfügbar
    this.calls = info.render.drawCalls / repeat; // zählt alle Render-Aufrufe des Frames → auf einen Durchgang zurück

    const k = this.i;
    this.cpu[k] = cpuMs;
    this.gpu[k] = gpuMs;
    this.work[k] = Math.max(cpuMs, gpuMs);
    this.gap[k] = gap;
    this.i = (k + 1) % this.W;
    this.n = Math.min(this.n + 1, this.W);
  }

  /** z. B. alle 0,5 s aufrufen */
  report(): PerfReport | null {
    if (this.n === 0) return null;
    const sorted = this.work.slice(0, this.n).sort();
    const avg = (a: Float32Array): number => a.slice(0, this.n).reduce((s, v) => s + v, 0) / this.n;
    const gpuAvg = avg(this.gpu);
    const gapAvg = avg(this.gap);
    return {
      fps: gapAvg > 0 ? 1000 / gapAvg : 0,
      workP50: sorted[Math.floor(this.n * 0.5)]!,
      workP99: sorted[Math.min(this.n - 1, Math.floor(this.n * 0.99))]!,
      cpuMs: avg(this.cpu),
      gpuMs: gpuAvg > 0 ? gpuAvg : null,
      drawCalls: this.calls,
    };
  }
}
```

Einbau in den Loop:
```ts
const perf = new PerfMonitor(renderer);
renderer.setAnimationLoop(() => {
  perf.beginFrame();
  update();                       // Eure Frame-Arbeit
  renderer.render(scene, camera);
  perf.endFrame();
});
setInterval(() => console.table(perf.report()), 500);
```

### 3.3 Wichtige Regeln
- **Vor dem Start:** `await renderer.compileAsync(scene, camera)`, dazu die ersten ~90 Frames nicht mitmessen (`warmupFrames`). Sonst verfälscht der Shader-Compile (100+ ms) p99.
- **Auf dem Zielgerät mit sichtbarem Fenster messen.** Hintergrund-Tabs liefern keine Frames, versteckte Panes werden gedrosselt.
- **Auflösung festhalten und im Bericht mit ausgeben** (Canvas-Pixel, DPR). Ein Retina-Display rendert bei DPR 2 fast doppelt so viele Pixel; wir begrenzen auf 2,6 MP (`MAX_RENDER_PIXELS`, `Engine.pixelRatio`).
- **Draw-Call-Budget:** Jedes Feature deklariert seine Calls (`budget: { drawCalls: 1 }`), der Monitor vergleicht die Summe mit dem Gemessenen. Der Renderer macht manchmal selbst einen Call (Ausgabe-Quad bei Tonemapping/Farbraum, siehe 6.1): `renderer.needsFrameBufferTarget ? 1 : 0` als Engine-Anteil mitzählen.
- **Leerer Frame:** `drawCalls === 0` bei deklarierten Calls bedeutet „es wird nichts gezeichnet“ (GPU verloren). Das als Verstoß melden, sonst steht ein grünes Häkchen bei einem schwarzen Bild.

## 4. Berichte und Verstöße

`Monitor.tick()` (alle 0,5 s) prüft:

| Prüfung | Grenze |
|---|---|
| Frame-Arbeit p99 | ≤ 8,3 ms (`TARGET_WORK_MS`) |
| Draw Calls | ≤ 100 (`MAX_DRAW_CALLS`) und ≤ deklarierte Summe |
| Modul-CPU-Zeit (gleitender Mittelwert) | ≤ `budget.ms` des Moduls |
| Selbstprüfungen (`probe()`) | alle `ok` |
| Leerer Frame | `drawCalls > 0` |

Verstöße erscheinen rot im HUD und einmalig als `console.warn('[budget] …')`.

**Button „📋 Messung kopieren“** (`report.ts`): misst 5 s in einem eigenen Puffer (`startCapture`/`finishCapture`), formatiert Gerät, Frame-Zeiten, Draw Calls, Module und Verstöße als Text und legt ihn in die Zwischenablage (Fallback: Textfeld zum Markieren). So lassen sich Messungen einfach in einen Chat posten.

## 5. Zuordnen: die Diagnose unter Stresslast

Nur zu wissen „die GPU braucht 5 ms“ hilft nicht. Wir wollten wissen, **welcher Teil** wie viel kostet. Der naive Weg (Teile abschalten und vergleichen) hat bei uns **falsche** Zahlen geliefert:

| Variante | GPU (naiv, 75-Hz-Monitor) |
|---|---|
| alles | 5,11 ms |
| ohne Ozean (weniger Arbeit!) | **10,00 ms** |
| ohne Partikel (weniger Arbeit!) | **10,44 ms** |

Weniger Arbeit, aber doppelte Zeit: Das ist kein echter Kostenunterschied. Bei VSync-Leerlauf regelt der Apple-Chip seinen Takt herunter und die gemessene Zeit hängt davon ab (so unsere Erklärung, nicht nachgewiesen). Die Lösung:

1. **Stresslast:** Die Szene wird pro Frame **N-mal gerendert** (`Engine.renderRepeat = 6`). Die GPU ist dann voll ausgelastet, der Takt konstant, VSync spielt keine Rolle.
2. **Alles durch N teilen:** `info.render.timestamp`, `drawCalls` und `triangles` summieren sich über alle Render-Aufrufe des Frames. Compute lief nur einmal pro Frame und wird **nicht** geteilt (`gpuRender = timestamp / repeat`, `gpuCompute` unverändert).
3. **Teile einzeln einschalten**, nicht abschalten: „leer“, „nur Himmel“, „nur Ozean“, „nur Partikel“, „alles“, „alles bei 50 % Auflösung“. Dazu müssen die Objekte benannt sein (`mesh.name`) und die Engine blendet sie per Name aus (`Engine.setHidden`, jeden Frame vor dem Rendern).
4. **Render und Compute getrennt ausweisen.** Sonst steckt die Compute-Zeit in jeder Zeile und verfälscht die Rechnung.
5. **Drei eingebaute Gegenproben**, damit die Messung sich selbst prüft:
   - *normal gegen Stress* (Render + Compute): Verhältnis zwischen 0,7 und 1,4, sonst taugt die Messung nicht (bei uns 0,76–0,88 ✓).
   - *Summe der Teile gegen alles*: der Unterschied ist die Überlappung, z. B. Himmel hinter dem Ozean per Tiefentest verworfen. Zusätzlich lässt sich daraus der **feste Anteil F** ableiten: Jede „nur X“-Zeile enthält ihn einmal, „alles“ nur einmal, also `F ≈ (Σ nur − alles) / 2`.
   - *halbe Auflösung*: kostet es ≈ 50 %, ist man pixelgebunden (Fragment-Arbeit oder Bandbreite), kostet es viel weniger, liegt es an Vertices/CPU/Draw Calls.

Code: `report.ts` (`runDiagnose`, `VARIANTS`), `engine.ts` (`renderRepeat`, `setHidden`, `renderScale`).

## 6. Was wir damit gefunden haben (Beispiel für die Wirkung)

Messung auf MacBook M1, 120 Hz, 2,6 MP, über Wasser:

| | Basis | nach Änderung |
|---|---|---|
| GPU „alles“ unter Stresslast | 5,31 ms | **2,94 ms** (−45 %) |
| GPU im Normalbetrieb | 4,10 ms | **2,54 ms** (−38 %) |
| Draw Calls | 4 | 3 |

Aus der Diagnose: Ozean ≈ 0,4 ms, Himmel bei vollem Bildschirm ≈ 1,8 ms, Partikel ≈ 0, Compute 0,05–0,1 ms, aber ein **fester, pixelgebundener Anteil F ≈ 3 ms = 56 % der Frame-Zeit**. Das war weder Shader noch Geometrie.

### 6.1 Die Ursache: der Zwischenpuffer des Renderers
Sobald `renderer.toneMapping !== NoToneMapping` **oder** der Ausgabe-Farbraum vom Arbeitsfarbraum abweicht (`renderer.needsFrameBufferTarget`), rendert three in einen **HDR-Zwischenpuffer** (16 Bit pro Kanal, bei `antialias: true` 4× MSAA), löst auf und zeichnet danach **1 Vollbild-Quad** zur Ausgabe. Das kostet Speicherbandbreite proportional zur Pixelzahl. Gegenmaßnahme: MSAA aus und Tonemapping + sRGB im Material (`finishColor()` am Ende jedes `colorNode`), Renderer auf `NoToneMapping` und `outputColorSpace = LinearSRGBColorSpace`. Ergebnis siehe Tabelle. Ohne die Diagnose hätten wir Shader optimiert, die nur 0,4 ms kosteten.

## 7. Stolperfallen (alle bei uns aufgetreten)

- **VSync/GPU-Takt:** Zeiten auf einem 75-Hz-Monitor waren 1,5–2× zu hoch und nicht additiv. Auf dem 120-Hz-Display und unter Stresslast stimmten sie. Immer auf dem Referenz-Display messen.
- **Summierung über mehrere Render-Aufrufe:** `drawCalls`, `triangles` und `timestamp` zählen alle `renderer.render()` des Frames. Bei Mehrfach-Rendern (Diagnose, Mehrere Kameras, Spiegel) durch die Anzahl teilen.
- **Der Ausgabe-Quad** zählt als Draw Call, ohne dass ihn ein Modul zeichnet (Abschnitt 6.1).
- **Headless-/Software-WebGPU** (SwiftShader) ist für Zeiten unbrauchbar: keine Timestamp-Query, die GPU-Instanz geht verloren, Bilder bleiben leer. Dort lassen sich nur CPU-Selbstprüfungen testen, nie Performance.
- **Hintergrund-Tab:** liefert keine Frames; der Bericht meldet „keine Frames gemessen“.
- **Erste Frames:** Pipeline-Aufbau kostet 100+ ms; überspringen und vorher `compileAsync`.
- **`resolveTimestampsAsync` jeden Frame aufrufen** (nicht awaiten). Ohne das Feature gibt es eine einmalige three-Warnung und der Wert bleibt 0.

## 8. Was sich 1:1 übernehmen lässt

| Datei | Inhalt | Abhängigkeiten |
|---|---|---|
| `src/core/monitor.ts` | Ringpuffer, p50/p99, Modul-EMA, Verstöße, HUD, `startCapture`/`finishCapture` | `three/webgpu` (nur Typen), `config.ts`, `module.ts` (nur `Budget`, `ProbeResult`) |
| `src/core/report.ts` | Kopier-Button, Diagnose (`VARIANTS`, Gegenproben), Textformat | `Engine` (`monitor`, `setHidden`, `renderRepeat`, `renderScale`, `applyResolution`) |
| `src/core/config.ts` | Konstanten (Ziel 8,3 ms, 100 Calls, Fenster, Warmup, max. Pixel) | – |
| `src/core/engine.ts` | Loop-Teile: Zeitmessung um jeden Hook, `resolveTimestampsAsync`, `renderRepeat`, `setHidden` | `module.ts` |

Wer **keinen** Modul-Vertrag hat, nimmt nur den `PerfMonitor` aus 3.2 und baut Kopier-Button und Diagnose später nach (die Diagnose braucht nur: Objekte mit Namen, ein `renderRepeat` im Loop und die Division durch N).

## 9. Nicht geprüft

- Andere Browser/GPUs als Chrome auf Apple M1 (Timestamp-Query-Verfügbarkeit kann abweichen).
- Ob `resolveTimestampsAsync` über sehr viele Render-Aufrufe pro Frame genauso summiert wie bei 6 Wiederholungen: bei uns bestätigt die Gegenprobe „normal gegen Stress“ (0,76–0,88) die Rechnung, bewiesen ist es nicht.
- Die Erklärung „GPU-Takt/VSync“ für die falschen 75-Hz-Zahlen ist eine Schlussfolgerung, kein Beweis.
