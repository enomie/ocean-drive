import { ACESFilmicToneMapping } from 'three';
import { PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu';
import { Engine } from './core/engine';
import { flyCameraModule } from './camera';
import { skyModule } from './sky';
import { oceanModule } from './ocean';
import { underwaterModule } from './underwater';
import { bubblesModule, particlesModule, planktonModule } from './particles';
import { demoStreamModule } from './demo/streamModule';

/** Erste Prüfung: ohne WebGPU wird nichts geladen. */
async function requireWebGPU(): Promise<void> {
  const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  const ok = gpu !== undefined && (await gpu.requestAdapter()) !== null;
  if (ok) return;
  const msg = document.getElementById('msg')!;
  msg.style.display = 'grid';
  msg.textContent = 'Ocean Drive braucht WebGPU (aktuelles Chrome / Edge).';
  throw new Error('WebGPU nicht verfügbar');
}

await requireWebGPU();

const renderer = new WebGPURenderer({ antialias: true, powerPreference: 'high-performance', trackTimestamp: true });
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.6;
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);
await renderer.init();

const params = new URLSearchParams(location.search);
const scene = new Scene();
const camera = new PerspectiveCamera(60, innerWidth / innerHeight, 0.3, 40000);
// Testparameter: ?y=<Starthöhe in m> (negativ = unter Wasser)
camera.position.set(0, Number(params.get('y') ?? 4), 0);

/*
 * Verdrahtung: nur registrieren. Reihenfolge ergibt sich aus `deps` der Module.
 * Neues Thema = neues Modul hier eintragen, sonst nichts anfassen.
 */
const engine = new Engine(renderer, scene, camera)
  .add(flyCameraModule())
  .add(skyModule())
  .add(oceanModule())
  .add(underwaterModule())
  .add(particlesModule())
  .add(planktonModule())
  .add(bubblesModule())
  .add(demoStreamModule());

await engine.start();

// Dev-Zugriff (Konsole / Headless-Läufe): __dbg.report, __dbg.get('ocean') …
if (import.meta.env.DEV) Object.assign(window, { __dbg: engine });
