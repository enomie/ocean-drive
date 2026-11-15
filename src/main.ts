import { PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu';
import { Engine } from './core/engine';
import { configureOutput } from './core/output';
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

const params = new URLSearchParams(location.search);
// Diagnose-Schalter: ?aa=0 (MSAA aus) · ?tm=material (Tonemapping im Material statt im Renderer)
const renderer = new WebGPURenderer({ antialias: params.get('aa') !== '0', powerPreference: 'high-performance', trackTimestamp: true });
configureOutput(renderer, params.get('tm') === 'material' ? 'material' : 'renderer');
document.body.appendChild(renderer.domElement);
await renderer.init();

const scene = new Scene();
const camera = new PerspectiveCamera(60, innerWidth / innerHeight, 0.3, 40000);
// Testparameter: ?y=<Starthöhe in m> (negativ = unter Wasser)
camera.position.set(0, Number(params.get('y') ?? 4), 0);

/*
 * Verdrahtung: nur registrieren. Reihenfolge ergibt sich aus `deps` der Module.
 * Neues Thema = neues Modul hier eintragen, sonst nichts anfassen.
 */
// ?mp=<Megapixel> überschreibt die maximale Renderauflösung (Standard siehe core/config.ts)
const engine = new Engine(renderer, scene, camera, params.has('mp') ? { maxPixels: Number(params.get('mp')) * 1e6 } : {})
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
