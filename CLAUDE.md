# Ocean Drive – Projektkarte

Three.js (**WebGPU**, `three@0.187`, TSL) + Vite + TypeScript. `npm run dev` → http://localhost:9292 (strictPort).
Ziel: **≥ 120 fps** (Chrome, MacBook M1, 120 Hz) und **≤ 100 Draw Calls**. WebGPU ist Pflicht: ohne WebGPU zeigt `main.ts` nur eine Meldung.
Pläne und Architektur: `docs/PLAN.md`, `docs/ARCHITECTURE.md` (zuerst lesen).

## Ordner
| Pfad | Zuständig für |
|---|---|
| `src/main.ts` | nur Verdrahtung: Renderer, Szene, Kamera, Module registrieren |
| `src/core/` | Engine (Game Loop, Registry), Clock, Input, Monitor, `config.ts`, Modul-Vertrag (`module.ts`), Sonne (`sun.ts`) |
| `src/camera/` `sky/` `ocean/` `underwater/` `particles/` | je ein Thema als Modul (`module.ts`, Einstieg `index.ts`) |
| `src/demo/` | temporärer Testinhalt |

## Konventionen
- **Neues Thema = Modul** (`name`, `budget`, `probe` sind Pflicht) + Eintrag in `main.ts`. Reihenfolge ergibt sich aus `deps`.
- **Zeit nur aus `ctx.clock`, Eingabe nur aus `ctx.input`.** Keine eigenen Akkumulatoren/Listener in Modulen.
- **Vorwärts = −Z**, Y oben, Meeresspiegel y = 0, 1 Einheit = 1 m.
- **Koordinaten sind LOKAL, absolut = lokal + `ORIGIN`** (`core/origin.ts`, nur die Engine ändert es). Jedes Modul mit Positionszustand implementiert `shift(dx, dz)`. Nie absolute Koordinaten in float32/Shader geben (Wellenphase: auf der CPU in double wickeln).
- **Alles, was unter Wasser sichtbar ist**, ruft `underwaterColor`/`underwaterFog` (`src/underwater`) im Material auf.
- **Linear-HDR im Shader.** Tonemapping (ACES) + sRGB macht jedes Material selbst: **jedes `colorNode` endet mit `finishColor(...)`** (`core/output.ts`). Standard: kein MSAA, kein Zwischenpuffer, kein Ausgabe-Pass (Messung: 5,3 → 2,9 ms). Alternativen per URL: `?aa=1`, `?tm=renderer`.
- **GPU/CPU-Spiegel** (`ocean/waves.ts`: `gerstner`/`surfaceHeight` ↔ `waveHeight`) müssen synchron bleiben.
- Keine Testdateien: Selbstprüfung per `probe()`, Budgets per Monitor.

## Debug
`F3` Modul-Tabelle · Button „📋 Messung kopieren“ (unten rechts: 5 s messen, Text in die Zwischenablage) · HUD unten links (rot = Verstoß) · Button „🔬 Diagnose“ (GPU-Kosten je Teil) · URL `?y=-5` Starthöhe (negativ = unter Wasser), `?x=2000000&z=-1500000` absolute Startposition (Origin-Test), `?mp=3.3` max. Renderauflösung in Megapixel, `?aa=1` MSAA 4× an, `?tm=renderer` Tonemapping im Renderer (Vergleichsschalter) ·
Konsole (Dev): `__dbg.report`, `__dbg.get('ocean')`, `__dbg.modules`.

## Steuerung
Maus ziehen = umschauen · `W/A/S/D` bewegen · `Space`/`C` hoch/runter · `Shift` 8× schneller · Mausrad = Grundtempo.

## Spender-Projekte
`infinity-ocean` (Ozean, Schiffe, Fauna, WebGL2/GLSL) und `suspension` (LOD-Terrain, Rapier-Fahrzeug-Baukasten, WebGPU). Code wird kopiert, nicht verlinkt.
