/**
 * Zentrale Eingabe: ein Ort für alle Listener. Module fragen nur ab (`isDown`, `lookX` …).
 * `press`/`release`/`look` sind öffentlich, damit Benchmark- und Testläufe Eingaben skripten können
 * (gleiche Eingabe → gleicher Lauf), ohne dass ein Modul etwas davon weiß.
 */
export class Input {
  private readonly keys = new Set<string>();
  /** Mausbewegung (px) seit dem letzten Frame, nur während gedrückter Taste */
  lookX = 0;
  lookY = 0;
  /** Mausrad seit dem letzten Frame */
  wheel = 0;

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => {
      if (e.code === 'Space') e.preventDefault();
      this.keys.add(e.code);
    });
    target.addEventListener('keyup', (e) => this.keys.delete(e.code));
    target.addEventListener('blur', () => this.keys.clear());
    target.addEventListener('pointermove', (e) => {
      if (e.buttons === 0) return;
      this.lookX += e.movementX;
      this.lookY += e.movementY;
    });
    target.addEventListener('wheel', (e) => {
      this.wheel += e.deltaY;
    });
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }
  press(code: string): void {
    this.keys.add(code);
  }
  release(code: string): void {
    this.keys.delete(code);
  }

  /** Engine ruft das am Frame-Ende auf */
  endFrame(): void {
    this.lookX = 0;
    this.lookY = 0;
    this.wheel = 0;
  }
}
