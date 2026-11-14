import { BackSide, Mesh, SphereGeometry, Vector3 } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  dot, float, max, mix, mx_fractal_noise_float, normalize, positionLocal, pow, smoothstep, uniform, vec3,
} from 'three/tsl';

/**
 * Einfacher Himmel: Farbverlauf, Sonnenscheibe + Halo, Wolken aus fraktalem Noise.
 * Alles in einem Fragment-Knoten auf einer Kuppel um die Kamera: 1 Draw Call.
 */
export function createSky() {
  const sunDir = uniform(new Vector3(0, 0.5, -1).normalize());
  const time = uniform(0);

  const dir = normalize(positionLocal);
  const up = max(dir.y, 0);
  const sunDot = max(dot(dir, sunDir), 0);

  // Himmel: Zenit blau, Horizont hell; Sonnennähe wärmer
  const zenith = vec3(0.12, 0.28, 0.62);
  const horizon = vec3(0.62, 0.74, 0.88);
  const base = mix(horizon, zenith, pow(up, 0.55));
  const glow = pow(sunDot, 6).mul(0.25).add(pow(sunDot, 64).mul(0.6));
  const disc = smoothstep(0.9996, 0.9999, sunDot).mul(20);
  const sky = base.add(vec3(1.0, 0.85, 0.6).mul(glow)).add(vec3(1.0, 0.95, 0.85).mul(disc));

  // Wolken: auf eine Ebene in 2 km Höhe projiziert, driften mit der Zeit
  const t = dir.y.max(0.02);
  const p = dir.xz.div(t).mul(0.00035).add(vec3(time.mul(0.004), 0, 0).xz);
  const n = mx_fractal_noise_float(vec3(p.x, p.y, time.mul(0.003)), 5, 2.0, 0.5).mul(0.5).add(0.5);
  const cover = smoothstep(0.5, 0.78, n).mul(smoothstep(0.0, 0.12, dir.y)); // am Horizont ausblenden
  const lit = float(0.65).add(pow(sunDot, 3).mul(0.5)); // Wolken zur Sonne hin heller
  const cloud = mix(vec3(0.55, 0.6, 0.7), vec3(1.0, 0.98, 0.95), n).mul(lit);

  const material = new MeshBasicNodeMaterial({ side: BackSide, depthWrite: false, fog: false });
  material.colorNode = mix(sky, cloud, cover.mul(0.92));

  const mesh = new Mesh(new SphereGeometry(30000, 48, 24), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;

  let clock = 0;
  return {
    mesh,
    sunElevation: () => Math.asin(sunDir.value.y),
    update(dt: number) {
      clock += dt;
      time.value = clock;
      // Sonne wandert langsam (Platzhalter für später: Tageszeit-System)
      const a = 0.35 + 0.3 * Math.sin(clock * 0.05);
      sunDir.value.set(Math.cos(a) * 0.5, Math.sin(a), -Math.cos(a) * 0.85).normalize();
    },
  };
}
