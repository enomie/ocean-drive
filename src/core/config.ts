/**
 * Alle Kernzahlen an EINER Stelle. Kein Wert steht in zwei Dateien.
 * Budget-Zahlen kommen aus docs/PLAN.md (120 fps, ≤ 100 Draw Calls).
 */

/** Fester Simulationstakt (Physik, Fahrzeuge): 120 Hz */
export const FIXED_DT = 1 / 120;
/** Max. Simulationsschritte pro Frame; mehr = Aufholen aufgeben (Schutz vor der Todesspirale) */
export const MAX_FIXED_STEPS = 5;
/** Längster akzeptierter Frame (s): nach Tab-Wechsel / Pause springt die Zeit nicht */
export const MAX_FRAME_DT = 0.1;

/** Ziel: p99 der Frame-ARBEIT (max aus CPU und GPU) in ms. Nicht der Anzeige-Abstand: der hängt vom Monitor ab (75 Hz). */
export const TARGET_WORK_MS = 1000 / 120;
/** Obergrenze Draw Calls pro Frame, über alle Passes (renderer.info.render.drawCalls) */
export const MAX_DRAW_CALLS = 100;

/** Monitor: Fensterlänge in Frames und Auswertungsintervall in s */
export const MONITOR_WINDOW = 240;
export const MONITOR_INTERVAL = 0.5;
/** Selbstprüfungen (`probe`) laufen alle n Sekunden */
export const PROBE_INTERVAL = 2;

/** Die ersten Frames (Pipeline-Aufbau, Shader-Compile) zählen nicht in die Messung */
export const WARMUP_FRAMES = 90;

/**
 * Maximale Renderauflösung in Pixeln (Ziel: ~1080p-Äquivalent plus Reserve). Auf hochauflösenden Displays
 * (z. B. MacBook, DPR 2 ≈ 5,9 MP) wird der Pixel-Ratio so weit gesenkt. URL `?mp=3.3` überschreibt (Megapixel).
 */
export const MAX_RENDER_PIXELS = 2_600_000;

/**
 * Floating Origin: absolut = lokal + ORIGIN. Alles in Szene und Shadern arbeitet in LOKALEN Koordinaten (klein, float32-genau).
 * Überschreitet die Kamera ORIGIN_THRESHOLD m vom lokalen Nullpunkt, wird alles um ein Vielfaches von ORIGIN_GRID verschoben.
 */
export const ORIGIN_THRESHOLD = 1024;
export const ORIGIN_GRID = 64;
