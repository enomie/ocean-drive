/**
 * Die EINE Uhr. Alle Module lesen Zeit von hier (nie eigene Akkumulatoren).
 * `time` ist ein double (JS-number): auch nach Stunden exakt; GPU-Uniforms bekommen daraus gewickelte Werte.
 */
export class Clock {
  /** Sekunden seit Start (nach MAX_FRAME_DT-Begrenzung) */
  time = 0;
  /** Dauer des aktuellen Frames (s) */
  dt = 0;
  /** Frame-Zähler */
  frame = 0;
  /** feste Simulationszeit (s), wächst in FIXED_DT-Schritten */
  fixedTime = 0;

  advance(dt: number): void {
    this.dt = dt;
    this.time += dt;
    this.frame++;
  }
}
