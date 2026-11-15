import type { PerspectiveCamera, Scene } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import type { Clock } from './clock';
import type { Input } from './input';

/** Was ein Modul pro Frame höchstens verbrauchen darf. Der Monitor misst dagegen und meldet Überschreitungen. */
export interface Budget {
  /** CPU-Zeit aller Hooks (fixedUpdate + update + compute) in ms pro Frame, gleitender Mittelwert */
  ms?: number;
  /** Draw Calls, die dieses Modul zum Frame beiträgt (Summe wird mit dem Gemessenen verglichen) */
  drawCalls?: number;
}

export interface ProbeResult {
  ok: boolean;
  /** kurzer Messwert-Text fürs HUD, z. B. "h=−1.2…2.4 m" */
  info?: string;
}

/** Was ein Modul von der Engine sieht. */
export interface Context {
  readonly renderer: WebGPURenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly clock: Clock;
  readonly input: Input;
  readonly dev: boolean;
  /** Öffentliche Schnittstelle (`api`) eines anderen Moduls. Das Modul muss in `deps` stehen. */
  get<T>(name: string): T;
}

/**
 * Der Modul-Vertrag. Ein Thema = ein Modul. Alles ist optional außer Name, Budget und `probe`:
 * ein Modul ohne Budget und Selbstprüfung kompiliert nicht.
 *
 * Reihenfolge pro Frame (siehe docs/ARCHITECTURE.md):
 *   Eingabe → fixedUpdate* (120 Hz) → update → compute → render → Monitor
 * Innerhalb einer Phase laufen die Module in Abhängigkeitsreihenfolge (`deps`).
 */
export interface Module<Api = unknown> {
  readonly name: string;
  /** Namen der Module, die vor diesem laufen müssen und deren `api` es benutzt */
  readonly deps?: readonly string[];
  readonly budget: Budget;
  /** Öffentliche Schnittstelle für andere Module */
  readonly api?: Api;

  init?(ctx: Context): void | Promise<void>;
  /** fester Takt (FIXED_DT): Simulation, deterministisch */
  fixedUpdate?(dt: number): void;
  /** einmal pro Frame, variabel: Visuals, Kamera, Uniforms. `alpha` = Anteil bis zum nächsten festen Schritt (Interpolation) */
  update?(dt: number, alpha: number): void;
  /** GPU-Compute-Dispatches, nach allen update() und vor dem Rendern */
  compute?(): void;
  /** Selbstprüfung: läuft beim Start und alle PROBE_INTERVAL s. Muss billig sein und darf nichts allozieren, was wächst. */
  probe(): ProbeResult;
  dispose?(): void;
}
