import { ACESFilmicToneMapping } from 'three';
import { PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu';
import { createSky } from './sky';
import { createOcean } from './ocean';
import { updateUnderwater } from './underwater';
import { FlyCamera } from './camera/flyCamera';

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

const renderer = new WebGPURenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.6;
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
await renderer.init();

const scene = new Scene();
const camera = new PerspectiveCamera(60, innerWidth / innerHeight, 0.3, 40000);
const sky = createSky();
scene.add(sky.mesh);
const ocean = createOcean();
scene.add(ocean.mesh);
camera.position.set(0, 4, 0);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const fly = new FlyCamera(camera);

const hud = document.getElementById('hud')!;
let last = performance.now();
let acc = 0;
let frames = 0;

renderer.setAnimationLoop((now) => {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  fly.update(dt);
  sky.mesh.position.copy(camera.position); // Kuppel folgt der Kamera
  sky.update(dt);
  ocean.update(dt, camera.position);
  updateUnderwater(dt, camera.position.y, ocean.heightAt(camera.position.x, camera.position.z, camera.position));
  renderer.render(scene, camera);

  acc += dt;
  frames++;
  if (acc >= 0.5) {
    hud.textContent = `${Math.round(frames / acc)} fps · y ${camera.position.y.toFixed(0)} m · ${fly.speed.toFixed(0)} m/s`;
    acc = 0;
    frames = 0;
  }
});
