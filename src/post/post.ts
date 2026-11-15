import type { PerspectiveCamera, Scene } from 'three';
import { RenderPipeline, type Node, type WebGPURenderer } from 'three/webgpu';
import {
  Fn, If, Loop, cameraPosition, cameraProjectionMatrixInverse, cameraWorldMatrix, cos, dot, exp, float, fract,
  getViewPosition, length, max, min, mix, normalize, pass, pow, refract, screenCoordinate, screenUV, select, sin,
  smoothstep, uniform, vec2, vec3, vec4,
} from 'three/tsl';
import { sunDir } from '../sky';

/** Kaustik-Muster (Port von infinity-ocean/src/post.ts): 3 gefaltete Sinus-Lagen */
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
 * Post-Pass: Szene in ein HDR-Target, dann ein Vollbild-Knoten.
 * Über Wasser: nur Vignette. Unter Wasser: Absorption (rot zuerst), Nebel, Lichtschäfte, leichtes Wabern.
 * Tonemapping + Farbraum übernimmt die Pipeline (renderer.toneMapping).
 * Noch nicht enthalten: Wasserlinie/Meniskus pro Pixel (hier: ganze Kamera taucht auf einmal ein), Kaustiken auf Flächen (braucht Meeresboden).
 */
export function createPost(renderer: WebGPURenderer, scene: Scene, camera: PerspectiveCamera) {
  const under = uniform(0); // 0 = über, 1 = unter Wasser
  const camDepth = uniform(0); // Meter unter dem Meeresspiegel
  const time = uniform(0);

  const scenePass = pass(scene, camera);
  const colorTex = scenePass.getTextureNode('output');
  const depthTex = scenePass.getTextureNode('depth');

  const output = Fn(() => {
    // Wabern der Linse unter Wasser
    const wobble = vec2(sin(screenUV.y.mul(40).add(time.mul(2))), cos(screenUV.x.mul(35).add(time.mul(1.7))));
    const uv = screenUV.add(wobble.mul(0.0015).mul(under));
    const col = colorTex.sample(uv).rgb.toVar();

    If(under.greaterThan(0), () => {
      const d = depthTex.sample(uv).r;
      const vp = getViewPosition(uv, d, cameraProjectionMatrixInverse);
      const dist = select(d.greaterThanEqual(0.9999), float(1e4), length(vp));
      const rd = normalize(cameraWorldMatrix.mul(vec4(vp, 0)).xyz);

      // Wasserfarbe hängt davon ab, wie weit wir zum Licht hinaufschauen
      const up = rd.y.mul(0.5).add(0.5);
      const sunW = normalize(refract(sunDir.negate(), vec3(0, 1, 0), 1 / 1.33)); // Sonne im Wasser
      const fogCol = mix(vec3(0.0, 0.03, 0.06), vec3(0.03, 0.26, 0.32), pow(up, 2))
        .mul(exp(camDepth.mul(-0.04)))
        .add(vec3(0.05, 0.28, 0.25).mul(pow(max(dot(rd, sunW.negate()), 0), 5)).mul(0.7));
      const absorb = exp(min(dist, 400).negate().mul(vec3(0.16, 0.04, 0.03)));
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

      col.assign(mix(col, uw, under));
    });

    // Vignette
    const q = screenUV.sub(0.5);
    col.mulAssign(float(1).sub(dot(q, q).mul(0.45)));
    return vec4(col, 1);
  })();

  const pipeline = new RenderPipeline(renderer);
  pipeline.outputNode = output;

  return {
    /** surfaceY = Höhe der Wasseroberfläche direkt über/unter der Kamera */
    update(dt: number, surfaceY: number): void {
      time.value += dt;
      const lens = camera.position.y - surfaceY; // <0: Kamera unter Wasser
      const t = Math.min(Math.max((lens + 0.015) / 0.03, 0), 1);
      under.value = 1 - t * t * (3 - 2 * t);
      camDepth.value = Math.max(-camera.position.y, 0);
    },
    render(): void {
      pipeline.render();
    },
  };
}
