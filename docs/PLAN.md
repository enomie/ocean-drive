# Ocean Drive – Plan

Zusammenführung von **infinity-ocean** (Ozean, Schiffe, Fauna) und **suspension** (LOD-Terrain, Rapier-Fahrzeug-Baukasten) zu einem neuen, sauber aufgebauten Projekt.
Ob Schiff oder Fahrzeug, wird per Dropdown gewählt. Das Projekt soll später zu einem großen Spiel anwachsen.

Status: **Plan, noch kein Code.** Die beiden Altprojekte bleiben unverändert als Spender; Code wird kopiert (nicht per Submodule). Quell-Commits und Zuordnung Alt → Neu kommen in `docs/PORTING.md`.

## 1. Harte Vorgaben

| Vorgabe | Definition |
|---|---|
| **120 fps, immer** | p99 der Frame-Zeit ≤ 8,3 ms auf einem festgelegten Referenzgerät, gemessen in festen Benchmark-Routen (Küste, Gebirge, Tauchen, Hafen) |
| **≤ 100 Draw Calls** | Summe von `renderer.info.render.calls` über alle Passes eines Frames (Schatten, Post, Simulation, Skycube inklusive). Compute-Dispatches werden getrennt im HUD gezählt |
| **Maximale Performance** | WebGPU als Pflicht-Basis, Compute wo möglich, keine Allokationen im Hot Path |
| **Modular** | Ein Thema = eine Datei bzw. ein Ordner, ein öffentlicher Einstieg je Thema |
| **Code ist der Test** | Selbstprüfung zur Laufzeit statt separater Testdateien (siehe 4) |

Entschieden: WebGPU ist **Pflicht**. Ohne WebGPU zeigt das Spiel als allererste Prüfung beim Start eine klare Meldung und lädt nichts weiter (kein WebGL2-Fallback, daher freie Nutzung von Compute). Die Draw-Call-Definition oben gilt; frühere Erfahrung: mehr Calls machten das Spiel spürbar langsamer.
Referenz (entschieden): **Chrome auf MacBook M1, Display 120 Hz** (ProMotion). Zweites Testsetup: externer Monitor mit 75 Hz. Dort ist 75 fps die Obergrenze des Displays; das Budget (8,3 ms p99) bleibt trotzdem dasselbe.
- Gemessen wird die **Frame-Arbeitszeit** (CPU-Zeit von `update`/Submit plus GPU-Zeit per Timestamp-Query), unabhängig von VSync. Anzeige-fps allein wären auf dem 75-Hz-Monitor irreführend.
- Das Gate gilt auf dem 120-Hz-Display bei fester Renderauflösung (Ziel ~1080p-Äquivalent, `devicePixelRatio` begrenzt; genauer Wert wird in Phase 0 gemessen und in `config.ts` festgelegt).
- Benchmark-Läufe sind headless-reproduzierbar (Playwright mit Chrome); die endgültige Abnahme erfolgt auf dem M1 mit sichtbarem Fenster, da gedrosselte oder versteckte Fenster verfälschen.

## 2. Grundentscheidungen

**Renderer: `WebGPURenderer` mit TSL** (wie Suspension, `three@0.187` oder neuer). Der Ozean aus infinity-ocean ist rohes GLSL und muss nach TSL portiert werden. Das ist die Hauptarbeit und das Hauptrisiko. Logik (Gerstner, Schaum, Snell-Fenster) bleibt, nur Shader-Sprache und Materialanbindung ändern sich. Release-Notes zu TSL, Compute und `BatchedMesh` werden in Phase 0 geprüft.

**Basis ist die Suspension-Kopie, der Ozean wird hineinportiert.** Terrain, Kachel-Worker, Rapier-Worker, Reversed-Z und Floating Origin laufen dort schon.

**Terrain-Höhe für den Ozean:** Eine Höhen-Clipmap als Textur (zwei Stufen, ~4 km fein und ~32 km grob um die Kamera), per Compute aus den Kachel-Höhen gefüllt. Der Ozean-Shader liest sie für Küstendämpfung, Flachwasser, Brandung und Unterwasser. Sie ersetzt `TERRAIN_GLSL` und `updateGpuIslands`.

**Inseln:** Entschieden: Der alte Insel-Generator entfällt, Suspension-Terrain ersetzt ihn (Kontinente, Meeresboden, Gebirge; Zielspanne **−1000 m bis +3000 m**, Suspension liefert aktuell −1500 m bis 3000 m). Inseln sind später höchstens eine weitere Schicht, aber kein Ziel jetzt; Fokus ist Performance. Vegetation, Möwen-Landeplätze, Fisch-Bodenabstand und Schiffs-Grundberührung hängen an der CPU-Funktion `terrainHeight`.

**Zwei Physik-Welten hinter einer Schnittstelle:** `Craft` (Eingabe, Pose, Kamera-Hinweise, `shift()`, `dispose()`).
- `VesselCraft`: Arcade-Schiffsphysik im Haupt-Thread (Wellen-Samples, Segeln, Tauchen).
- `VehicleCraft`: Rapier im Worker, 120 Hz, Heightfield-Collider.
- Beim Wechsel per Dropdown wird das andere Craft entfernt, der Worker pausiert, Collider werden nur im Fahrzeugmodus gestreamt.

**Origin:** Eine Variante für alles: Suspension (Schwelle 1024 m, 64-m-Raster). Wellenphasen bleiben origin-unabhängig.

## 3. Zielstruktur

```
src/
  core/      config (alle Zahlen), origin, Craft-Interface, Modul-Registry, Loop, Eingabe, HUD, Monitor
  terrain/   Generator, tileGeometry, LodTerrain, Kachel-Worker, Höhen-Clipmap, Physik-Collider
  ocean/     waves, ocean, wake, sky, post, particles
  craft/
    vessel/  Arcade-Schiffe (ein File pro Schiff)
    vehicle/ Aufhängungs-Baukasten, Physik-Worker, Visual
  life/      fish, birds, vegetation
  game/      Inhalte, Dropdown, Regeln
docs/        PLAN.md, PORTING.md, je Thema eine Doku (wandert mit dem Code)
```

Abhängigkeitsrichtung: `core ← terrain, ocean, physics ← craft ← life ← game`. Rückwärts-Importe verbietet ein Lint-Regelwerk. Neue Inhalte (Schiff, Fahrzeug, Biom, Tierart) sind Datendateien plus Registrierung, kein Eingriff in den Kern.

## 4. Modul-Vertrag (Code = Test)

Jedes Modul implementiert denselben schmalen Vertrag:

```
init(ctx)           einmalig; deklariert Budget und Abhängigkeiten
update(dt)          Hot Path, keine Allokationen
shift(dx, dz)       Floating Origin
probe(): Report     Selbstprüfung + Messwerte (Pflichtfeld: ohne probe kompiliert das Modul nicht)
dispose()
```

Jedes Modul deklariert sein Budget im Code, z. B. `{ ms: 0.4, drawCalls: 1, memMB: 40 }`. Der Monitor misst pro Modul GPU-Zeit (Timestamp-Queries), CPU-Zeit und Draw Calls. Überschreitung zeigt das Overlay rot und nennt Modul und Datei.

| Risiko | Eingebaute Prüfung |
|---|---|
| CPU/GPU-Spiegel driften (Wellen, Terrain) | `probe()` liest selten und asynchron wenige Punkte von der GPU und vergleicht mit der CPU-Funktion |
| Nicht-deterministischer Generator | Referenzpunkte beim Start gegen eingebaute Golden Values |
| Floating-Origin-Fehler | Invariantenlauf nach jedem Shift: Absolutposition vorher = nachher |
| Terrain-Flackern, Risse | LOD-Modul zählt Kachelwechsel pro Frame und Frames ohne Vollabdeckung |
| Draw Calls > 100 | `renderer.info` pro Frame, harte Warnung |
| Frame-Ausreißer | p99 im gleitenden Fenster, Ausreißer mit Modul-Zeiten protokolliert |
| Physik-Instabilität | Worker meldet Schrittzeit, NaN-/Explosions-Wächter |

Im Dev-Modus laufen die Probes laufend. In der CI startet **ein** Headless-Skript (Playwright) den Browser, fährt feste Routen mit festem Seed und festen Eingaben und liest die Probes aus. Es gibt keinen zweiten Satz Testcode. Reine Mathe-Kerne (Gerstner-Höhe, Noise, Hash) behalten winzige Inline-Prüfungen beim Start.

## 5. Geschwindigkeitsregeln

- Keine Allokation in `update`, nur typisierte Arrays, keine Closures pro Frame, keine `Map`-Zugriffe pro Instanz. Per Lint erzwungen; ein Debug-Zähler meldet Allokationen pro Frame.
- Eine zentrale `config.ts` mit allen Zahlen (Budgets, Distanzen, Auflösungen, Qualitätsstufen). Kein Wert steht zweimal.
- Qualitätsstufen als Daten; der Monitor schaltet bei Überschreitung selbsttätig eine Stufe herunter und meldet es. Die adaptive Auflösung ist nur Sicherung, kein Ersatz fürs Messen.
- Compute statt CPU: Kielwasser, Fisch-Schwärme (heute teuerster CPU-Posten), Partikel, Höhen-Clipmap.
- Strikte TS (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Vite mit Worker-Chunks.
- Terrain-Dreiecke: Suspension liegt bei ~1,3 Mio.; der Ozean braucht schon ~5 ms. Ziel ~400–600k Dreiecke, Sichtweite und Stufen werden gemessen, nicht geraten.

## 5a. Schatten

Jede zusätzliche Shadow-Map rendert alle Caster erneut und zählt gegen die 100 Draw Calls. Cascaded Shadow Maps sind daher die Qualitäts-Variante, nicht die schnellste.
- **Standard: eine** Shadow-Map, folgt dem Craft, ~300 m Reichweite (2048² ≈ 15 cm/Texel), Texel-Snapping in absoluten Koordinaten (Muster: Suspension `SunRig`).
- **2 Kaskaden** (z. B. 0–40 m, 40–300 m) nur, falls die Messung in Phase 0 zeigt, dass Nahschatten zu weich sind und Zeit/Calls es erlauben. Ob three.js in WebGPU/TSL eine fertige CSM-Lösung bietet, wird in Phase 0 geprüft.
- **Jenseits 300 m keine Shadow-Map, sondern eine Sonnen-Schatten-Clipmap (Compute):** gleiche zwei Stufen wie die Höhen-Clipmap (fein ~4 km, grob ~32 km). Pro Texel wird geprüft, ob Gelände zwischen Texel und Sonne liegt. Berg-Schatten reichen so weit wie das Gelände (3000 m Berg bei 10° Sonnenhöhe ≈ 17 km). Im Terrain-Shader ist es 1 Lookup, 0 Draw Calls.
  - Verfahren (Spike entscheidet): Raymarch mit exponentiellen Schritten (einfach, teurer) oder Horizont-Sweep entlang der Sonnenrichtung mit laufendem Maximum (O(N), billiger).
  - Update verteilt über mehrere Frames (z. B. 1/16 pro Frame), nur bei Sonnenbewegung oder Origin-Shift. Fade von Shadow-Map zu Clipmap in den letzten ~50 m (kein Doppel-Abdunkeln, keine Kante).
  - Zweiter Kanal: Schatten auf Meeresspiegel (y = 0), vom Ozean-Shader gelesen, damit Berge auch aufs Wasser Schatten werfen.
  - Ergänzend überall: AO aus Neigung und Krümmung, Himmelslicht, Dunst (alles im Shader, 0 Calls).
  - Ferne Objekte (Bäume, Craft) werfen keine Schatten; per AO-Wert abgedunkelt. Wolkenschatten (gleicher Mechanismus) als späterer Ausbau.
- Ozean wirft und empfängt keine Shadow-Map (eigenes Shading), liest aber die Clipmap für Berg-Schatten.
- Caster: Terrain (nahe Kacheln), Craft über ein vereinfachtes Proxy-Mesh (1–3 Calls), Bäume nahe der Kamera.
- Der Schatten-Pass wird im Monitor als eigener Posten mit Zeit und Calls geführt.

## 6. Draw-Call-Budget (Richtwerte, in Phase 0 messen)

| Posten | Calls |
|---|---|
| Terrain | 1 (max. 2 mit Schatten) |
| Himmel, Ozean, Post | ~3 |
| Wake, Skycube | ~4 |
| Partikel | 2 |
| Fische | ~10 (instanced) |
| Vögel, Vegetation | ~10 (instanced) |
| Craft | ≤ 25 (Meshes beim Bau nach Material zusammenführen; die Schiffe bestehen aus vielen `box`/`cyl`-Teilen, Anzahl noch nicht gezählt) |
| Reserve | ~35 |

## 7. Schrittleiter

Jeder Schritt ist ein Commit, läuft im Browser und besteht sein Gate (fps, Draw Calls, Probes grün). Ab Schritt 5 wird 120 fps / ≤ 100 Calls bei jedem Schritt geprüft.

**Phase 0 – Spikes (entscheiden die Architektur)**
- 0a TSL-Ozean-Ausschnitt (Gerstner-Vertex, Reflexion, Schaum) gegen die heutigen ~5 ms messen.
- 0b Kielwasser als Compute-Shader.
- 0c Post-Kette im Knoten-System (Unterwasser, God-Rays, Kaustiken brauchen Szenen-Tiefe und -Farbe; unklarster Teil).
- 0d Release-Notes TSL / `WebGPURenderer` prüfen.

**Phase 1 – Fundament**
1. Gerüst: Vite, strikte TS, `WebGPURenderer`, leere Szene, Monitor und Overlay
2. Modul-Vertrag und Registry, Budget-Anzeige
3. Floating Origin mit Invariantenprobe
4. Terrain-Generator mit Golden-Probe
5. LOD-Terrain (1 Draw Call)
6. Physik-Worker und Collider
7. Fahrzeug (erste Aufhängung), dann der restliche Baukasten

**Phase 2 – Ozean-Port**
8. Himmel und Noise
9. Ozean-Wellen mit CPU/GPU-Spiegelprobe
10. Ozean-Shading, Küste über Höhen-Clipmap
11. Kielwasser (Compute)
12. Post / Unterwasser

**Phase 3 – Spiel-Gerüst**
13. `Craft`-Interface, Schiffe, Dropdown (Schiff/Fahrzeug, Modell, Aufhängung)
14. Partikel, Fische, Vögel, Vegetation
15. Qualitätsstufen und Selbstregelung

**Phase 4 – Absicherung**
16. Headless-Routen und CI-Gate

**Phase 5 – Ausbau** (nach Wunsch): Fahrzeug im Wasser (Auftrieb, Wattiefe), amphibische Craft, Biome und Einfärbung nach Höhe/Neigung, Kielwasser an Land, Wetter und Tageszeit.

## 8. Risiken

- **TSL-Port** (~2.000 Zeilen GLSL) ist groß; deshalb in kleinen, einzeln messbaren Modulen portieren, nicht in einem Zug.
- **Post-Pass** (Tiefe + Farbe der ganzen Szene) ist der heikelste Teil.
- **Browser-Abdeckung:** WebGPU ist Pflicht (entschieden); Nutzer ohne WebGPU sehen nur die Startmeldung.
- **GPU-Readback** für Spiegelproben ist langsam: nur selten und asynchron, nie im Hot Path.
- **Regressionen ohne Testdateien:** nur so gut wie die Probes und Routen. Routen brauchen festen Seed und feste Eingaben.
- **Fahrzeuge unter Wasser** fahren zunächst auf dem Meeresboden (offen bis Phase 5).
- **Höhen-Clipmap** muss bei Origin-Shift und Kachel-Nachladen konsistent bleiben, sonst blitzt die Küste.
- **Wellen-Spiegel CPU ↔ GPU** muss synchron bleiben (alte Pflichtregel, jetzt durch Probe abgesichert).

## 9. Offene Entscheidungen

Entschieden: WebGPU Pflicht, Draw-Call-Definition (alle Passes), Insel-Generator wird ersetzt, Höhenspanne −1000 … +3000 m.

Referenz für 120 fps: Chrome, MacBook M1, 120 Hz; zusätzlich 75-Hz-Monitor (siehe Abschnitt 1).

Noch offen: Wert für die Renderauflösung (Phase 0).
