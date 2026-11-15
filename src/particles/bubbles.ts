import { Mesh, PlaneGeometry, StorageInstancedBufferAttribute } from 'three/webgpu';
import { SpriteNodeMaterial, type ComputeNode, type WebGPURenderer } from 'three/webgpu';
import {
  Fn, If, cameraPosition, dot, exp, float, hash, instancedArray, instanceIndex, length, max, mix, normalize, pow,
  select, sin, cos, smoothstep, sqrt, storage, uint, uniform, uv, varying, vec2, vec3, vec4,
} from 'three/tsl';
import { surfaceHeight } from '../ocean';
import { under, underwaterFog } from '../underwater';
import { pixelClamp } from './common';

const COUNT = 6000; // Ringpuffer
const MAX_SPAWN = 512; // pro Frame

/**
 * Aufsteigende Luftbläschen als GPU-Partikel (Ringpuffer, Compute).
 * Allgemein gehalten: jeder Emitter (Test-Strom, später Propeller, Bugwelle, Torpedo …) ruft nur `spawn()` auf.
 *  - Aufbau auf der CPU: wenige Dutzend `spawn()` pro Frame (Position, Anfangsgeschwindigkeit, Größe, Lebensdauer)
 *  - Simulation auf der GPU: Strahl klingt ab → Auftrieb (größer = schneller) + Taumeln, platzt an der Oberfläche
 *  - Darstellung: 1 Draw Call, Kugel-Shading (Totalreflexion am Rand + Glanzpunkt), Unterwasser-Nebel
 */
export class BubbleSystem {
  readonly mesh: Mesh;
  private readonly spawnNode: ComputeNode;
  private readonly updateNode: ComputeNode;
  private readonly spawnA = new StorageInstancedBufferAttribute(new Float32Array(MAX_SPAWN * 4), 4); // xyz, Größe
  private readonly spawnB = new StorageInstancedBufferAttribute(new Float32Array(MAX_SPAWN * 4), 4); // vxyz, Lebensdauer
  private readonly headU = uniform(0, 'uint');
  private readonly countU = uniform(0, 'uint');
  private readonly dtU = uniform(0);
  private head = 0;
  private pending = 0;
  /** Spawns, die wegen voller Frame-Warteschlange verworfen wurden (Probe prüft das) */
  dropped = 0;
  /** Bläschen, die seit dem Start erzeugt wurden */
  spawned = 0;

  constructor(private readonly renderer: WebGPURenderer) {
    const pos = instancedArray(COUNT, 'vec3');
    const vel = instancedArray(COUNT, 'vec3');
    const life = instancedArray(COUNT, 'vec2'); // Alter, Lebensdauer; Nullpuffer = alle tot
    const size = instancedArray(COUNT, 'float');
    const sA = storage(this.spawnA, 'vec4', MAX_SPAWN);
    const sB = storage(this.spawnB, 'vec4', MAX_SPAWN);

    // ── Pass 1: neue Partikel in den Ringpuffer schreiben ──────────────
    this.spawnNode = Fn(() => {
      const k = instanceIndex;
      If(k.lessThan(this.countU), () => {
        const slot = this.headU.add(k).mod(uint(COUNT));
        const a = sA.element(k);
        const b = sB.element(k);
        pos.element(slot).assign(a.xyz);
        size.element(slot).assign(a.w);
        vel.element(slot).assign(b.xyz);
        life.element(slot).assign(vec2(0, b.w));
      });
    })().compute(MAX_SPAWN);

    // ── Pass 2: alle lebenden Partikel integrieren ─────────────────────
    this.updateNode = Fn(() => {
      const i = instanceIndex;
      const age = life.element(i).x;
      const maxAge = life.element(i).y;
      If(age.lessThan(maxAge), () => {
        const p = pos.element(i);
        const v = vel.element(i);
        const seed = hash(i);
        const rise = size.element(i).mul(8).add(0.18); // m/s: größere Bläschen steigen schneller
        const wobble = vec3(sin(age.mul(6).add(seed.mul(40))), 0, cos(age.mul(5.3).add(seed.mul(70)))).mul(0.08);
        const target = vec3(0, rise, 0).add(wobble);
        v.addAssign(target.sub(v).mul(float(1).sub(exp(this.dtU.mul(-1.5))))); // Anfangsstrahl klingt ab
        p.addAssign(v.mul(this.dtU));
        life.element(i).x.assign(age.add(this.dtU));
        // platzt an der Wasseroberfläche
        If(p.y.greaterThan(surfaceHeight(p.xz)), () => {
          life.element(i).x.assign(maxAge);
        });
      });
    })().compute(COUNT);

    // ── Darstellung ────────────────────────────────────────────────────
    const P = pos.toAttribute();
    const L = life.toAttribute();
    const S = size.toAttribute();
    const t = L.x.div(max(L.y, 1e-3));
    const alive = L.x.lessThan(L.y).and(S.greaterThan(0));
    const dist = length(P.sub(cameraPosition));
    const { size: worldSize, fade } = pixelClamp(S.mul(t.mul(0.8).add(0.7)), dist); // wachsen beim Aufsteigen
    const life01 = smoothstep(0, 0.05, t).mul(t.mul(t).oneMinus());
    const vA = varying(select(alive, life01.mul(fade).mul(smoothstep(0.8, 2.5, dist)), float(0)), 'vBubbleA');
    const vRd = varying(normalize(P.sub(cameraPosition)), 'vBubbleRd');
    const vDist = varying(dist, 'vBubbleDist');

    const material = new SpriteNodeMaterial({ transparent: true, depthWrite: false });
    material.positionNode = P;
    material.scaleNode = select(alive, worldSize, float(0));

    // Kugel: Luft im Wasser → Totalreflexion am Rand + Glanzpunkt oben
    const c = uv().sub(0.5).mul(2);
    const r2 = dot(c, c);
    const n = vec3(c.x, c.y, sqrt(max(float(1).sub(r2), 0)));
    const rim = pow(float(1).sub(n.z), 2.5);
    const glint = pow(max(dot(n, normalize(vec3(-0.35, 0.7, 0.6))), 0), 40).mul(3);
    const a = select(r2.lessThan(1), rim.mul(0.85).add(glint).add(0.04).mul(vA), float(0));
    const body = vec3(0.75, 0.93, 0.97).mul(glint.add(0.7));
    material.colorNode = vec4(mix(body, underwaterFog(body, vRd, vDist), under), a.min(1));

    this.mesh = new Mesh(new PlaneGeometry(1, 1), material);
    this.mesh.count = COUNT;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
  }

  /** Ein Bläschen erzeugen (Weltkoordinaten; v = Anfangsgeschwindigkeit m/s; size = Durchmesser m; maxAge s) */
  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, maxAge: number): void {
    if (this.pending >= MAX_SPAWN) {
      this.dropped++;
      return;
    }
    this.spawned++;
    const a = this.spawnA.array as Float32Array;
    const b = this.spawnB.array as Float32Array;
    const o = this.pending * 4;
    a[o] = x; a[o + 1] = y; a[o + 2] = z; a[o + 3] = size;
    b[o] = vx; b[o + 1] = vy; b[o + 2] = vz; b[o + 3] = maxAge;
    this.pending++;
  }

  /** pro Frame, vor dem Rendern: neue Partikel einfügen, dann simulieren */
  update(dt: number): void {
    if (this.pending > 0) {
      this.spawnA.needsUpdate = true;
      this.spawnB.needsUpdate = true;
      this.countU.value = this.pending;
      this.headU.value = this.head;
      this.renderer.compute(this.spawnNode);
      this.head = (this.head + this.pending) % COUNT;
      this.pending = 0;
    }
    this.dtU.value = Math.min(dt, 0.05);
    this.renderer.compute(this.updateNode);
  }
}
