import { AdditiveBlending, Mesh, PlaneGeometry } from 'three';
import { SpriteNodeMaterial } from 'three/webgpu';
import {
  abs, cameraPosition, cos, exp, float, floor, fract, hash, instanceIndex, length, max, mix, normalize, select, sin,
  smoothstep, uniform, uv, varying, vec3, vec4,
} from 'three/tsl';
import { surfaceHeight } from '../ocean';
import { waterTransmittance } from '../underwater';
import { pixelClamp } from './common';

const BOX = 34; // m, um die Kamera gewickeltes Volumen
const COUNT = 7000;

/**
 * Plankton, Meeresschnee und Krill (Port von infinity-ocean `createDrift`): zustandslos – Position und
 * Eigenschaften folgen nur aus `hash(instanceIndex)` und der Zeit, kein Puffer, keine CPU-Arbeit.
 * Unter der Oberfläche sichtbar, darüber ausgeblendet. 1 Draw Call.
 */
export function createPlankton() {
  const time = uniform(0);
  const id = instanceIndex;
  const r0 = hash(id);
  const r1 = hash(id.add(7919));
  const r2 = hash(id.add(104729));
  const r3 = hash(id.add(1299709));
  const krill = r3.greaterThan(0.82);

  // langsames Treiben; Schnee sinkt; Krill schnellt in kurzen Stößen
  const drift = vec3(
    sin(time.mul(0.11).add(r0.mul(40))),
    time.mul(-0.04).mul(r1.add(0.5)),
    cos(time.mul(0.09).add(r2.mul(40))),
  ).mul(0.6);
  const k = time.mul(r1.mul(0.5).add(0.6)).add(r0.mul(10));
  const burst = floor(k).add(smoothstep(0, 0.25, fract(k)));
  const ang = r2.mul(6.28).add(floor(k).mul(0.7));
  const dir = normalize(vec3(sin(ang), sin(floor(k).mul(1.3)).mul(0.15), cos(ang)));
  const move = drift.add(select(krill, dir.mul(burst).mul(0.35), vec3(0, 0, 0)));

  // um die Kamera wickeln
  const cam = cameraPosition;
  const p = cam.add(vec3(r0, r1, r2).mul(BOX).add(move).sub(cam).mod(BOX)).sub(BOX / 2);
  const d = length(p.sub(cam));
  const air = p.y.greaterThan(surfaceHeight(p.xz).add(0.15));

  const baseSize = select(krill, r1.mul(0.07).add(0.05), r0.mul(r0).mul(0.04).add(0.012));
  const { size, fade } = pixelClamp(baseSize, d);

  const body = select(
    krill,
    mix(vec3(0.9, 0.42, 0.3), vec3(0.95, 0.75, 0.6), r1).mul(0.4),
    vec3(0.55, 0.8, 0.75).mul(r1.mul(0.2).add(0.12)),
  );
  // Licht von oben (nimmt mit der Tiefe ab) + Eigenleuchten: ein fester Anteil bleibt immer,
  // in der Tiefe glimmt ein Teil der Teilchen biolumineszent und pulsiert
  const daylight = exp(p.y.mul(0.06));
  const flicker = sin(time.mul(0.7).add(p.x.mul(0.3)).add(p.z.mul(0.2))).mul(0.3).add(0.7);
  const lit = daylight.mul(0.55).add(0.45).mul(flicker);
  const pulse = sin(time.mul(1.7).add(r0.mul(60))).mul(0.5).add(0.5);
  const glow = vec3(0.1, 0.55, 0.5)
    .mul(daylight.oneMinus())
    .mul(pulse.mul(0.7).add(0.3))
    .mul(select(r2.greaterThan(0.7), float(1), float(0.3)));
  const rel = abs(p.sub(cam)).div(BOX / 2);
  const edge = max(rel.x, max(rel.y, rel.z));
  const alpha = float(1).sub(smoothstep(0.75, 1, edge)).mul(smoothstep(0.15, 0.6, d)).mul(fade);

  const vCol = varying(body.mul(lit).add(glow).mul(waterTransmittance(d)), 'vPlanktonCol');
  const vA = varying(select(air, float(0), alpha), 'vPlanktonA');

  const material = new SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending });
  material.positionNode = p;
  material.scaleNode = select(air, float(0), size);
  const r = length(uv().sub(0.5));
  const a = smoothstep(0.5, 0.15, r).mul(vA);
  material.colorNode = vec4(vCol.mul(float(1).add(smoothstep(0.2, 0, r).mul(1.5))).mul(a), 1);

  const mesh = new Mesh(new PlaneGeometry(1, 1), material);
  mesh.count = COUNT;
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;

  return {
    mesh,
    /** `t` = Clock.time */
    update(t: number): void {
      time.value = t;
    },
  };
}
