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
export const under = uniform(0); // 0 = Kamera über Wasser, 1 = darunter
const camDepth = uniform(0); // Meter unter dem Meeresspiegel
const time = uniform(0);

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

/**
 * Farbe `col` eines Fragments, gesehen durch Wasser.
 * @param rd   Blickrichtung (Welt, normalisiert), Kamera → Fragment
 * @param dist Abstand Kamera → Fragment in Metern
 */
/** Anteil des Lichts, der nach `dist` Metern Wasser übrig ist (pro Farbkanal; Rot verschwindet zuerst) */
export function waterTransmittance(dist: Node<'float'>) {
  return exp(min(dist, 400).negate().mul(vec3(0.16, 0.04, 0.03)));
}

/** Wie `underwaterColor`, aber ohne Lichtschäfte – billig genug für Partikel und kleine Objekte */
export function underwaterFog(col: Node<'vec3'>, rd: Node<'vec3'>, dist: Node<'float'>) {
  const up = rd.y.mul(0.5).add(0.5);
  const sunW = normalize(refract(sunDir.negate(), vec3(0, 1, 0), 1 / 1.33));
  const fogCol = mix(vec3(0.0, 0.03, 0.06), vec3(0.03, 0.26, 0.32), pow(up, 2))
    .mul(exp(camDepth.mul(-0.04)))
    .add(vec3(0.05, 0.28, 0.25).mul(pow(max(dot(rd, sunW.negate()), 0), 5)).mul(0.7));
  return col.mul(waterTransmittance(dist)).add(fogCol.mul(exp(dist.mul(-0.02)).oneMinus()));
}

export function underwaterColor(col: Node<'vec3'>, rd: Node<'vec3'>, dist: Node<'float'>) {
  // Wasserfarbe hängt davon ab, wie weit wir zum Licht hinaufschauen
  const up = rd.y.mul(0.5).add(0.5);
  const sunW = normalize(refract(sunDir.negate(), vec3(0, 1, 0), 1 / 1.33)); // Sonne im Wasser
  const fogCol = mix(vec3(0.0, 0.03, 0.06), vec3(0.03, 0.26, 0.32), pow(up, 2))
    .mul(exp(camDepth.mul(-0.04)))
    .add(vec3(0.05, 0.28, 0.25).mul(pow(max(dot(rd, sunW.negate()), 0), 5)).mul(0.7));
  const absorb = exp(min(dist, 400).negate().mul(vec3(0.16, 0.04, 0.03))); // Rot verschwindet zuerst
  const fogF = exp(dist.mul(-0.02)).oneMinus();
  const uw = col.mul(absorb).add(fogCol.mul(fogF)).toVar();

  // Lichtschäfte: Sehstrahl marschieren, Kaustik-Muster entlang der Sonnenrichtung von der Oberfläche
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

/** Kamera unter Wasser? (z. B. um Unterwasser-Objekte über Wasser gar nicht zu zeichnen) */
export const isUnderwater = (): boolean => under.value > 0.001;

/** pro Frame: Kameraposition relativ zur Wasseroberfläche (surfaceY = Höhe direkt über/unter der Kamera) */
/** `t` = Clock.time */
export function updateUnderwater(now: number, camY: number, surfaceY: number): void {
  time.value = now;
  const t = Math.min(Math.max((camY - surfaceY + 0.015) / 0.03, 0), 1);
  under.value = 1 - t * t * (3 - 2 * t);
  camDepth.value = Math.max(-camY, 0);
}
