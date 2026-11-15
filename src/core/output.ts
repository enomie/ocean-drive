import { ACESFilmicToneMapping, LinearSRGBColorSpace, NoToneMapping, SRGBColorSpace } from 'three';
import type { Node, WebGPURenderer } from 'three/webgpu';
import { acesFilmicToneMapping, convertColorSpace, float } from 'three/tsl';

/**
 * Wo Tonemapping + Farbraum-Umrechnung stattfinden:
 *  - 'renderer' (`?tm=renderer`): three rendert in einen HDR-MSAA-Zwischenpuffer, löst auf und zeichnet 1 Ausgabe-Quad.
 *  - 'material' (STANDARD): jedes Material beendet mit `finishColor()`, der Renderer schreibt direkt ins Canvas.
 *    Kein Zwischenpuffer, kein Ausgabe-Pass, halbe Bandbreite (8-Bit statt 16-Bit-Samples).
 *    Preis: Alpha-Blending (Partikel) geschieht im Anzeige-Farbraum.
 * Gemessen (M1, 2,6 MP): MSAA aus + Material-Modus senkt die GPU-Zeit von 5,3 auf 2,9 ms.
 */
export type OutputMode = 'renderer' | 'material';

const EXPOSURE = 0.6;
let mode: OutputMode = 'material';

/** Vor dem Erzeugen der Module aufrufen (Materialien lesen den Modus beim Bau) */
export function configureOutput(renderer: WebGPURenderer, m: OutputMode): void {
  mode = m;
  if (m === 'material') {
    renderer.toneMapping = NoToneMapping;
    renderer.outputColorSpace = LinearSRGBColorSpace; // Material liefert schon sRGB
  } else {
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = EXPOSURE;
  }
}

export const outputMode = (): OutputMode => mode;

/** Letzter Schritt jedes Materials: linear-HDR → Ausgabe. Im Modus 'renderer' ein No-op. */
export function finishColor(c: Node<'vec3'>): Node<'vec3'> {
  if (mode === 'renderer') return c;
  return convertColorSpace(acesFilmicToneMapping(c, float(EXPOSURE)), LinearSRGBColorSpace, SRGBColorSpace).rgb;
}
