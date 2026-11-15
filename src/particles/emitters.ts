import { Vector3 } from 'three';
import type { BubbleSystem } from './bubbles';

/**
 * Bläschen-Strom aus einer Kreisscheibe (Achse `dir`). Generisch: für einen Propeller setzt man pro Frame
 * `origin`/`dir` aus der Schiffs-Pose, `radius` = Blattkreis, `speed` = Strahl, `rate` nach Drehzahl.
 */
export class StreamEmitter {
  readonly origin = new Vector3();
  readonly dir = new Vector3(0, 1, 0);
  radius = 0.25; // m, Scheibenradius
  speed = 1.2; // m/s entlang `dir`
  spread = 0.35; // m/s zufällige Seitengeschwindigkeit
  rate = 150; // Bläschen pro Sekunde
  sizeMin = 0.006;
  sizeMax = 0.03;
  /** Zusatzgeschwindigkeit des Trägers (Schiff), damit der Strahl mitläuft */
  readonly carrierVel = new Vector3();

  private acc = 0;
  private readonly u = new Vector3();
  private readonly w = new Vector3();

  update(dt: number, sys: BubbleSystem): void {
    this.acc += this.rate * dt;
    if (this.acc < 1) return;
    // Orthonormalbasis zur Achse
    const d = this.dir;
    this.u.set(0, 1, 0).cross(d);
    if (this.u.lengthSq() < 1e-4) this.u.set(1, 0, 0).cross(d);
    this.u.normalize();
    this.w.crossVectors(d, this.u);
    while (this.acc >= 1) {
      this.acc -= 1;
      const th = Math.random() * Math.PI * 2;
      const r = this.radius * Math.sqrt(Math.random());
      const cu = Math.cos(th);
      const cw = Math.sin(th);
      const s = this.speed * (0.7 + 0.6 * Math.random());
      const sp = this.spread;
      sys.spawn(
        this.origin.x + (this.u.x * cu + this.w.x * cw) * r,
        this.origin.y + (this.u.y * cu + this.w.y * cw) * r,
        this.origin.z + (this.u.z * cu + this.w.z * cw) * r,
        d.x * s + this.carrierVel.x + (Math.random() - 0.5) * sp,
        d.y * s + this.carrierVel.y + (Math.random() - 0.5) * sp,
        d.z * s + this.carrierVel.z + (Math.random() - 0.5) * sp,
        this.sizeMin + (this.sizeMax - this.sizeMin) * Math.random() ** 2,
        10 + 8 * Math.random(),
      );
    }
  }
}
