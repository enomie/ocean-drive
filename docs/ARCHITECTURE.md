# Architektur

Ziel: ein Spiel, das groß werden darf und trotzdem **≥ 120 fps** und **≤ 100 Draw Calls** hält. Dafür gilt:
Der Code prüft sich selbst (Budget-Monitor + Selbstprüfungen), statt dass wir Testdateien pflegen.

## Schichten

```
src/
  core/        Engine (Game Loop, Registry), Clock, Input, Monitor, config, Modul-Vertrag, sun
  camera/      Freie Kamera (Modul)
  sky/         Himmel, Wolken, Noise (Modul)
  ocean/       Wellen (GPU + CPU-Spiegel), Ozean-Mesh/-Shader (Modul)
  underwater/  Unterwasser-Optik: Funktionen für Materialien + Uniforms (Modul)
  particles/   Plankton (zustandslos), Bläschen (GPU-Compute), Emitter (Module)
  demo/        TEMPORÄRER Testinhalt (Bläschenstrom)
  main.ts      Verdrahtung: Renderer, Szene, Kamera, Module registrieren, start()
```

Abhängigkeitsrichtung: `core ← sky, ocean, underwater ← particles ← (craft, life, game)`. `core` kennt keine Fachmodule.
Jedes Thema hat einen öffentlichen Einstieg (`index.ts`); andere Module importieren nur daraus.

## Game Loop (`core/engine.ts`)

Pro Frame, immer in dieser Reihenfolge:

| # | Phase | Was | Zeit |
|---|---|---|---|
| 1 | Zeit | `Clock.advance(dt)`, `dt` auf `MAX_FRAME_DT` (0,1 s) begrenzt | – |
| 1b | Origin-Shift | Kamera > 1024 m vom lokalen Nullpunkt → alles um ein Vielfaches von 64 m verschieben, `shift(dx, dz)` an alle Module | – |
| 2 | Simulation | `fixedUpdate(1/120)` so oft wie der Akkumulator hergibt, max. `MAX_FIXED_STEPS` (5), Rest wird verworfen und gezählt | fest |
| 3 | Visuals | `update(dt, alpha)`; `alpha` = Anteil bis zum nächsten festen Schritt (für Interpolation) | variabel |
| 4 | GPU-Arbeit | `compute()` (Compute-Dispatches, nach allen `update`) | – |
| 5 | Render | `renderer.render(scene, camera)` + GPU-Zeit auflösen | – |
| 6 | Messen | Monitor, Selbstprüfungen, HUD | – |

- **Eine Uhr:** Alle Module lesen Zeit aus `ctx.clock`, keiner führt eigene Akkumulatoren. `time` ist ein double; GPU-Uniforms bekommen daraus gewickelte Werte (Wellenphasen).
- **Feste Schritte:** Simulation (später Fahrzeug-Physik) läuft deterministisch mit 120 Hz, unabhängig von der Bildrate. Die Todesspirale wird abgefangen (`MAX_FIXED_STEPS`).
- **Reihenfolge der Module:** topologisch nach `deps`. Fehlende oder zyklische Abhängigkeiten werfen beim Start einen Fehler mit dem Pfad.
- **Start:** Module `init` → Pipelines vorkompilieren (`compileAsync`) → erste Selbstprüfung → Loop. Die ersten 90 Frames zählen nicht in die Messung.

## Modul-Vertrag (`core/module.ts`)

```ts
interface Module<Api> {
  name; deps?; budget; api?;     // name, budget: Pflicht
  init?(ctx); shift?(dx, dz); fixedUpdate?(dt); update?(dt, alpha); compute?(); dispose?();
  probe(): { ok, info? };        // Pflicht: ohne Selbstprüfung kompiliert das Modul nicht
}
```

- **`budget`**: `{ ms, drawCalls }`. `ms` = CPU-Zeit aller Hooks pro Frame (gleitender Mittelwert), `drawCalls` = Beitrag zum Frame.
- **`probe`**: billige Selbstprüfung, läuft beim Start und alle 2 s. Beispiele: Wellenhöhe endlich und innerhalb der Amplitudensumme; Unterwasser-Faktor passt zur Kamera; Bläschen-Spawns nicht verworfen.
- **`api`**: öffentliche Schnittstelle für andere Module. Zugriff über `ctx.get<T>('name')`, das Modul muss in `deps` stehen.
- Neues Thema = neues Modul (`src/<thema>/module.ts`, Export im `index.ts`) + eine Zeile in `main.ts`.

## Monitor und Budgets (`core/monitor.ts`, Zahlen in `core/config.ts`)

Gemessen wird die **Arbeit**, nicht der Anzeigeabstand: `max(CPU-Zeit, GPU-Zeit)` pro Frame. Der Abstand hängt vom Monitor ab (75 Hz extern ⇒ 13,3 ms) und sagt nichts über Reserve.

| Prüfung | Grenze | Meldung |
|---|---|---|
| Frame-Arbeit p99 | 8,3 ms | `Frame-Arbeit p99 … > 8.3 ms` |
| Draw Calls | ≤ 100 | `Draw Calls n > 100` |
| Draw Calls ungezählt | gemessen ≤ deklariert | `gemessen 5, deklariert 4` – ein Modul zeichnet mehr, als es deklariert hat |
| Modul-Zeit | `budget.ms` | `<modul>: x ms > Budget y ms` |
| Selbstprüfung | `probe().ok` | `<modul>: Selbstprüfung fehlgeschlagen (…)` |
| Simulation | keine verworfenen Schritte | `n Simulationsschritte verworfen` |
| Leerer Frame | Draw Calls > 0 | `Es wird nichts gezeichnet (0 Draw Calls)` – z. B. GPU verloren |

- Verstöße erscheinen rot im HUD (unten links) und einmalig als `console.warn('[budget] …')`.
- **F3** zeigt die Modul-Tabelle (ms, Budget, Calls, Probe-Info).
- **Button „📋 Messung kopieren“** (unten rechts): misst 5 s, fasst Gerät, Frame-Zeiten (p50/p99/max), Draw Calls, Module und Verstöße als Text zusammen und kopiert ihn in die Zwischenablage (`core/report.ts`). Bei gesperrter Zwischenablage erscheint der Text zum Markieren.
- `__dbg.report` (Dev) liefert den letzten Bericht als Objekt – Grundlage für Headless-Läufe.
- **Button „🔬 Diagnose“:** rendert nacheinander „leer / nur Himmel / nur Ozean / nur Partikel / alles / halbe Auflösung“ unter **Stresslast** (`Engine.renderRepeat`: Szene 6× pro Frame, damit die GPU voll ausgelastet ist – im Normalbetrieb verfälschen VSync-Leerlauf und GPU-Takt die Zeiten, siehe Messung vom 15.11.). Drei eingebaute Gegenproben prüfen die Messung selbst (normal vs. Stress, Summe der Teile, Pixel-Skalierung).
- **Renderauflösung:** `MAX_RENDER_PIXELS` (2,6 MP) begrenzt den Pixel-Ratio auf hochauflösenden Displays; `?mp=3.3` überschreibt.
- **Ausgabe (`core/output.ts`):** Standard ist Tonemapping im Material (`finishColor`), kein MSAA: der Renderer schreibt direkt ins Canvas. Mit `?tm=renderer` rendert three dagegen in einen HDR-Zwischenpuffer und zeichnet 1 Vollbild-Quad; dieser Call wird automatisch mitgezählt (`needsFrameBufferTarget`).
  Messung 15.11. (M1, 120 Hz, 2,6 MP, über Wasser): MSAA 4× + Renderer-Tonemapping = 5,3 ms GPU, MSAA aus + Material = 2,9 ms. Der feste Anteil (Zwischenpuffer, MSAA, Ausgabe) war mit ~3 ms mehr als die Hälfte der Frame-Zeit. Bei Terrain mit vielen Geometriekanten Anti-Aliasing neu entscheiden (MSAA 2×, FXAA, Auflösung).
- GPU-Zeit kommt über `trackTimestamp` (Timestamp-Query); ohne Feature steht im HUD „GPU n/a“.
- **Die deklarierten Budgets sind Schätzungen**, bis sie auf dem Referenzgerät (Chrome, MacBook M1, 120 Hz) gemessen wurden. Der Monitor zeigt dann, was nachgezogen werden muss.

## Ozean-LOD (`ocean/waves.ts`, `ocean/ocean.ts`)

Zwei getrennte LODs, beide höhenbewusst:

- **Geometrie** (Vertex): Die Wellen blenden nach dem **3D-Abstand** zur Kamera aus (5·L … 13·L), nicht nach dem horizontalen. Aus großer Höhe ist die Verschiebung daher flach (kein Aliasing durch Wellen, die kleiner als ein Pixel sind). Das Gitter selbst ist polar um die Kamera (dicht nah, grob fern, ~40 km); an seinem Rand geht der Dunst ab 15 km vollständig in die Horizontfarbe über.
- **Shading** (Fragment): Die Normale wird **pro Pixel** aus demselben 16-Wellen-Spektrum berechnet (`shadingNormal`). Eine Welle zählt als aufgelöst, wenn sie ≥ ~10 Pixel lang erscheint, und fällt ab ~4 Pixeln weg (Pixelgröße = Entfernung × Pixelwinkel / Neigung, `core/view.ts`). **Weggelassene Wellen gehen nicht verloren:** ihre mittlere quadratische Neigung ½·(k·A)² wird zur Rauheit m², die den Sonnenglanz (Beckmann-Verteilung) verbreitert. Nah: enger, heller Kern (m² ≈ 1e-3); aus großer Höhe: breiter, schwächerer Glitzerpfad. So bleibt das Meer aus jeder Höhe ein Meer statt glatter Flecken.
- **Selbstprüfung** (`ocean`-Probe): bei wachsender Pixelgröße nehmen aufgelöste Wellen nie zu und die Rauheit nie ab; bei „unendlich“ ist die ganze Neigung Rauheit. Das HUD zeigt z. B. `LOD @10 m/Pixel: 5/16 Wellen, m² 0.011`.
- **Kosten:** Das Fragment-Shading wertet pro Pixel bis zu 16 Wellen (sin/cos) aus, aufgelöste nur; Messung steht aus.
- **Noch nicht enthalten:** Schaum (Jacobi), Detail-Kräuselung (Noise) im Nahbereich, Wasserfarbe nach Tiefe.

## Floating Origin (`core/origin.ts`)

**Absolut = lokal + `ORIGIN`.** Szene, Shader und Physik arbeiten in LOKALEN Koordinaten (klein, float32-genau); `ORIGIN` ist ein double und wird nur von der Engine geändert. Ab 1024 m Kameraabstand zum Nullpunkt verschiebt die Engine Kamera und `ORIGIN` um ein Vielfaches von 64 m und ruft `shift(dx, dz)` an jedem Modul auf (am Frame-Anfang, vor allen Updates).

- **Jedes Modul schiebt seinen eigenen Positionszustand mit** (Emitter, GPU-Puffer, Caches). Szene-Objekte, die ihre Position nur aus der Kamera ableiten (Himmelskuppel, Ozean-Gitter), brauchen nichts.
- **Wellen:** Die Phase `k·(d·ORIGIN) − ω·t + φ₀` wird in Doppelpräzision auf der CPU gewickelt; der Shader addiert nur `k·(d·lokal)`. Der CPU-Spiegel `waveHeight` nimmt die absolute Position.
- **Plankton:** Wrap-Box in Weltkoordinaten über `ORIGIN mod BOX` (Uniform) → bleibt beim Shift an seinem Platz.
- **Bläschen:** Compute-Pass „shift“ zieht den Verschiebungsvektor von allen lebenden Partikeln ab, VOR dem Einfügen neuer (die schon im neuen System liegen).
- **Selbstprüfungen:** `origin` (absolute Kameraposition unverändert, Kamera nahe am Nullpunkt, Ursprung gerastert), `ocean` (Wasserhöhe unter einer Verschiebung unverändert: Δ ~1e-15 m; Shader-Formel = CPU-Formel: Δ ~5e-5).
- **Testen:** `?x=2000000&z=-1500000` startet weit draußen; im Dev-Modus `__dbg.camera.position.x += 1500` löst eine Verschiebung aus, `__dbg.get('origin').shifts` zählt sie.
- **Bekannte Grenze:** Das Kaustik-/Lichtschaft-Muster unter Wasser (`underwater.ts`) ist an lokale Koordinaten gebunden und springt bei einer Verschiebung einmalig. Selten (≥ 1 km Flug) und nur unter Wasser sichtbar.

## Regeln

- **Hot Path:** keine Allokation in `update`/`fixedUpdate`/`compute`, keine Closures pro Frame, typisierte Arrays.
- **Zeit nur aus `ctx.clock`**, Eingabe nur aus `ctx.input` (macht skriptbare, reproduzierbare Läufe möglich: `input.press('KeyW')`).
- **Zahlen nur in `config.ts`** (oder als benannte Konstante im Modul, wenn sie nur dort gelten).
- **GPU/CPU-Spiegel** (Wellenhöhe, später Terrain) existieren zweimal und müssen synchron bleiben; die Probe prüft die CPU-Seite, ein GPU-Readback-Vergleich ist offen.
- **Alles, was unter Wasser sichtbar ist,** ruft `underwaterColor` / `underwaterFog` im Material auf.

## Offen (nächste Schritte, in dieser Reihenfolge)

1. **Terrain** aus suspension (LOD, Höhen-Clipmap für den Ozean, Schatten-Clipmap).
2. **`Craft`-Schnittstelle** + Fahrzeug (Rapier im Worker, `fixedUpdate`) und Schiffe, Dropdown.
3. **Headless-Läufe** mit festem Seed und skriptbarer Eingabe → CI-Gate auf `report.violations`.
4. **Qualitätsstufen**, die der Monitor selbsttätig schaltet.
