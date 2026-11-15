import { ORIGIN_GRID, ORIGIN_THRESHOLD } from './config';
import type { Context, Module } from './module';

/**
 * Floating Origin. Absolute Weltposition = lokale Position + ORIGIN.
 * ORIGIN ändert NUR die Engine (siehe `applyOriginShift`); alle anderen lesen es nur.
 * Werte sind Vielfache von ORIGIN_GRID (Ausnahme: Start-URL ?x=&z=, dort ebenfalls gerastert).
 */
export const ORIGIN = { x: 0, z: 0 };

/** Verschiebung, die nötig ist, damit die Kamera wieder nahe am lokalen Nullpunkt liegt (null = keine nötig) */
export function originShiftFor(camX: number, camZ: number): { dx: number; dz: number } | null {
  if (Math.abs(camX) <= ORIGIN_THRESHOLD && Math.abs(camZ) <= ORIGIN_THRESHOLD) return null;
  return { dx: Math.round(camX / ORIGIN_GRID) * ORIGIN_GRID, dz: Math.round(camZ / ORIGIN_GRID) * ORIGIN_GRID };
}

export interface OriginApi {
  readonly shifts: number;
}

/**
 * Eingebautes Modul (die Engine registriert es selbst). Seine Selbstprüfung ist die Invariante des Floating Origin:
 * die absolute Kameraposition ändert sich durch eine Verschiebung nicht, und die Kamera bleibt nahe am Nullpunkt.
 */
export function originModule(): Module<OriginApi> & { recordShift(absErr: number): void } {
  let ctx: Context;
  let shifts = 0;
  let worstErr = 0;
  return {
    name: 'origin',
    budget: {},
    get api() {
      return { shifts };
    },
    init(c) {
      ctx = c;
    },
    recordShift(absErr: number) {
      shifts++;
      worstErr = Math.max(worstErr, absErr);
    },
    probe() {
      const p = ctx.camera.position;
      const near = Math.abs(p.x) < ORIGIN_THRESHOLD + 10 * ORIGIN_GRID && Math.abs(p.z) < ORIGIN_THRESHOLD + 10 * ORIGIN_GRID;
      const grid = ORIGIN.x % ORIGIN_GRID === 0 && ORIGIN.z % ORIGIN_GRID === 0;
      const exact = worstErr < 1e-6;
      return {
        ok: near && grid && exact,
        info:
          `abs x ${(p.x + ORIGIN.x).toFixed(0)} z ${(p.z + ORIGIN.z).toFixed(0)} · ${shifts} Verschiebungen` +
          `${exact ? '' : ` · Drift ${worstErr.toExponential(1)} m`}${near ? '' : ' · Kamera zu weit vom Nullpunkt'}${grid ? '' : ' · Ursprung nicht gerastert'}`,
      };
    },
  };
}
