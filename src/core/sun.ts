import { Vector3 } from 'three';
import { uniform, vec3 } from 'three/tsl';

/** Sonnenrichtung (wie infinity-ocean) – globaler Zustand für Himmel, Ozean, Unterwasser */
export const SUN_DIR = new Vector3(-0.55, 0.22, -0.8).normalize();
export const SUN_COL = vec3(1.0, 0.86, 0.68);
export const sunDir = uniform(SUN_DIR.clone());
