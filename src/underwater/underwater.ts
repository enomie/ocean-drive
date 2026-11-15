import { Vector3, type PerspectiveCamera } from 'three';
import type { Node } from 'three/webgpu';
import {
  If, Loop, cameraPosition, cos, dot, exp, float, fract, max, min, mix, normalize, pow, refract, screenCoordinate,
  sin, smoothstep, uniform, vec2, vec3,
} from 'three/tsl';
import { sunDir } from '../core/sun';

/**
 * Unterwasser-Optik (Port von infinity-ocean/src/post.ts), aber im Material statt im Post-Pass:
 * jedes Material kennt seine Distanz und Blickrichtung selbst → keine Tiefentextur, kein Vollbild-Pass,
 * Kanten bleiben MSAA-sauber. Jedes Material, das unter Wasser sichtbar ist, ruft `underwaterColor` auf.
 */
/** Kamera-Faktor: 0 = Bildebene ganz über Wasser, 1 = ganz darunter (für Partikel und CPU-Entscheidungen) */
export const under = uniform(0);
const camDepth = uniform(0); // Meter unter dem Meeresspiegel
const time = uniform(0);
/** Wasseroberfläche an der Kamera als lokale Ebene: (Höhe, dh/dx, dh/dz) */
const surfPlane = uniform(new Vector3());
const camFwd = uniform(new Vector3(0, 0, -1));
const camNear = uniform(0.3);

/**
 * Taucherbrille: Unterwasser-Anteil PRO PIXEL (0…1). Liegt der Punkt dieses Pixels auf der Bildebene (Near-Plane)
 * unter der Wasseroberfläche? So verläuft die Wasserkante quer durchs Bild, statt dass der ganze Bildschirm
 * auf einmal umschaltet. Die Oberfläche ist auf der Bildebene (wenige cm) praktisch eben → Ebene von der CPU.
 * @param rd Blickrichtung (Welt, normalisiert), Kamera → Fragment. Nur im Fragment-Shader verwenden.
 */
export function underAt(rd: Node<'vec3'>) {
  const off = rd.mul(camNear.div(max(dot(rd, camFwd), 1e-3))); // Punkt auf der Bildebene, relativ zur Kamera
  const h = off.y.sub(surfPlane.x.add(surfPlane.y.mul(off.x)).add(surfPlane.z.mul(off.z))); // über der Oberfläche (m)
  return smoothstep(0.003, -0.003, h); // ±3 mm: harte Kante
}

/** Kaustik-Muster: 3 gefaltete Sinus-Lagen */
function caustic(p: Node<'vec2'>, t: Node<'float'>) {
  let q = p;
  let c: Node<'float'> = float(0);
  for (let i = 0; i < 3; i++) {
    q = q.mul(1.7).add(vec2(sin(q.y.mul(1.3).add(t)), cos(q.x.mul(1.1).sub(t))));
    c = c.add(sin(q.x).mul(sin(q.y)).abs());
  }
  return pow(c.div(3).oneMinus(), 6);
}

/** Anteil des Lichts, der nach `dist` Metern Wasser übrig ist (pro Farbkanal; Rot verschwindet zuerst) */
export function waterTransmittance(dist: Node<'float'>) {
  return exp(min(dist, 400).negate().mul(vec3(0.16, 0.04, 0.03)));
}

/** Streulicht des Wasserkörpers in Blickrichtung: heller zum Licht hinauf, Sonnenhof um die gebrochene Sonne */
function waterColor(rd: Node<'vec3'>) {
  const up = rd.y.mul(0.5).add(0.5);
  const sunW = normalize(refract(sunDir.negate(), vec3(0, 1, 0), 1 / 1.33)); // Sonne im Wasser
  return mix(vec3(0.0, 0.03, 0.06), vec3(0.03, 0.26, 0.32), pow(up, 2))
    .mul(exp(camDepth.mul(-0.04)))
    .add(vec3(0.05, 0.28, 0.25).mul(pow(max(dot(rd, sunW.negate()), 0), 5)).mul(0.7));
}

/**
 * Farbe `col` eines Fragments, gesehen durch Wasser (Absorption + Streulicht), ohne Lichtschäfte –
 * billig genug für Partikel und kleine Objekte.
 * @param rd   Blickrichtung (Welt, normalisiert), Kamera → Fragment
 * @param dist Abstand Kamera → Fragment in Metern
 */
export function underwaterFog(col: Node<'vec3'>, rd: Node<'vec3'>, dist: Node<'float'>) {
  return col.mul(waterTransmittance(dist)).add(waterColor(rd).mul(exp(dist.mul(-0.02)).oneMinus()));
}

/** Wie `underwaterFog`, plus Lichtschäfte (8 Schritte entlang des Sehstrahls) – für große Flächen (Himmel, Ozean) */
export function underwaterColor(col: Node<'vec3'>, rd: Node<'vec3'>, dist: Node<'float'>) {
  const uw = underwaterFog(col, rd, dist).toVar();
  const sunW = normalize(refract(sunDir.negate(), vec3(0, 1, 0), 1 / 1.33));
  const rays = float(0).toVar();
  const reach = min(dist, 40);
  const jitter = fract(sin(dot(screenCoordinate, vec2(12.9898, 78.233))).mul(43758.5453));
  Loop(8, ({ i }) => {
    const s = float(i).add(jitter).div(8).mul(reach);
    const p = cameraPosition.add(rd.mul(s));
    If(p.y.lessThan(0), () => {
      const sp = p.xz.sub(sunW.xz.div(sunW.y).mul(p.y));
      rays.addAssign(caustic(sp.mul(0.35), time.mul(0.6)).mul(exp(p.y.mul(0.12))).mul(exp(s.mul(-0.06))));
    });
  });
  uw.addAssign(vec3(0.35, 0.75, 0.7).mul(rays.div(8)).mul(0.8).mul(smoothstep(-0.3, 0.6, rd.y)));
  return uw;
}

/** Ist irgendein Teil der Bildebene unter Wasser? (CPU-Entscheidungen, z. B. Tiefentest der Partikel) */
export const isUnderwater = (): boolean => under.value > 0.001;

/**
 * Pro Frame. `surfaceAt(x, z)` = Wasserhöhe (lokal). Der Kamera-Faktor `under` (für Partikel, CPU-Entscheidungen)
 * gilt, sobald irgendein Teil der Bildebene unter Wasser ist; die Optik selbst entscheidet pro Pixel (`underAt`).
 * `t` = Clock.time
 */
export function updateUnderwater(now: number, camera: PerspectiveCamera, surfaceAt: (x: number, z: number) => number): void {
  time.value = now;
  const p = camera.position;
  const e = 0.05;
  const h = surfaceAt(p.x, p.z);
  const gx = (surfaceAt(p.x + e, p.z) - surfaceAt(p.x - e, p.z)) / (2 * e);
  const gz = (surfaceAt(p.x, p.z + e) - surfaceAt(p.x, p.z - e)) / (2 * e);
  surfPlane.value.set(h - p.y, gx, gz); // Höhe relativ zur Kamera
  camera.getWorldDirection(camFwd.value);
  camNear.value = camera.near;
  // Bildebene reicht ±(near · tan(fov/2) · aspect) um die Kamera: Kamera-Faktor weich über diesen Bereich
  const reach = camera.near * Math.tan((camera.fov * Math.PI) / 360) * Math.max(camera.aspect, 1) * 1.5;
  const t = Math.min(Math.max((p.y - h + reach) / (2 * reach), 0), 1);
  under.value = 1 - t * t * (3 - 2 * t);
  camDepth.value = Math.max(-p.y, 0);
}
