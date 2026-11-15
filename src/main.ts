import { PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu';
import { Engine } from './core/engine';
import { configureOutput } from './core/output';
import { ORIGIN } from './core/origin';
import { ORIGIN_GRID } from './core/config';
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
// Standard (Messung 15.11., M1, 2,6 MP: 5,3 → 2,9 ms): kein MSAA, Tonemapping im Material → kein Zwischenpuffer, kein Ausgabe-Pass.
// Zurückschalten per URL: ?aa=1 (MSAA 4×) · ?tm=renderer (Tonemapping im Renderer)
const renderer = new WebGPURenderer({ antialias: params.get('aa') === '1', powerPreference: 'high-performance', trackTimestamp: true });
configureOutput(renderer, params.get('tm') === 'renderer' ? 'renderer' : 'material');
document.body.appendChild(renderer.domElement);
await renderer.init();

const scene = new Scene();
const camera = new PerspectiveCamera(60, innerWidth / innerHeight, 0.3, 40000);
// Testparameter: ?y=<Starthöhe in m> (negativ = unter Wasser) · ?x=&z=<absolute Startposition in m>, z. B. x=2000000
const startX = Number(params.get('x') ?? 0);
const startZ = Number(params.get('z') ?? 0);
ORIGIN.x = Math.round(startX / ORIGIN_GRID) * ORIGIN_GRID;
ORIGIN.z = Math.round(startZ / ORIGIN_GRID) * ORIGIN_GRID;
camera.position.set(startX - ORIGIN.x, Number(params.get('y') ?? 4), startZ - ORIGIN.z);

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
