// Split out from index.ts so this pure function (and its regression test)
// can be imported without dragging in index.ts's full transitive graph
// (which includes spectator-camera.ts's TypeScript parameter-property
// syntax -- unsupported by Node's --experimental-strip-types used by
// scripts/run-tests.mjs). Behaviour and rationale: see the doc comment
// on clampRenderResolution below.

/** Clamps the render resolution (device pixels per CSS pixel) to `max`.
 *  Pixi's own default for an unspecified `resolution` is the raw,
 *  unclamped devicePixelRatio -- fine on desktop (DPR 1-2) but on the
 *  DPR-3 phones seen in production it triples the pixel grid in *each*
 *  dimension, so every pixel-shader invocation (fighters, effects,
 *  stage) runs 9x the samples of DPR1, not 3x. Camera/world math reads
 *  `app.renderer.width/height`, which is CSS-space and resolution
 *  independent (see Renderer.getCanvasPixelSize) -- so this is
 *  fill-rate/GPU cost only, never a coordinate any camera/framing/sim
 *  code depends on. */
export function clampRenderResolution(devicePixelRatio: number, max: number): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(dpr, max);
}
