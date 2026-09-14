// Unit tests for packages/render/src/camera.ts's computeCamera aspect-ratio
// framing math (issue #18). Pure math over plain numbers, no Pixi/DOM --
// matches the node:test + node:assert style of palette.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCamera,
  computeRawCamera,
  setCameraReducedMotion,
  isCameraReducedMotion,
  type ArenaBounds,
  type CameraConfig,
} from '../src/camera.ts';

const EPS = 1e-6;

function cfg(overrides: Partial<CameraConfig> = {}): CameraConfig {
  return {
    viewWidth: 1280,
    viewHeight: 720,
    minScale: 1,
    maxScale: 50,
    paddingWorld: 20,
    arena: { minX: -200, maxX: 200, minY: 0, maxY: 200 },
    ...overrides,
  };
}

function aspectRatioOfSpan(c: CameraConfig, cam: { scale: number }): number {
  // The frame's world-space span on each axis is view / scale; its ratio
  // should match the viewport's own aspect ratio within epsilon.
  const spanX = c.viewWidth / cam.scale;
  const spanY = c.viewHeight / cam.scale;
  return spanX / spanY;
}

test('wide-flat arena (the-undercroft-like): frame aspect ratio matches the viewport', () => {
  const c = cfg({ arena: { minX: -600, maxX: 600, minY: 0, maxY: 150 } });
  const cam = computeCamera([{ x: 0, y: 50 }], c);
  const viewportAR = c.viewWidth / c.viewHeight;
  const frameAR = aspectRatioOfSpan(c, cam);
  assert.ok(Math.abs(frameAR - viewportAR) < 1e-3, `frameAR=${frameAR} viewportAR=${viewportAR}`);
});

test('tall-narrow arena (the-spire-like): frame aspect ratio matches the viewport', () => {
  const c = cfg({ arena: { minX: -80, maxX: 80, minY: 0, maxY: 900 } });
  const cam = computeCamera([{ x: 0, y: 400 }], c);
  const viewportAR = c.viewWidth / c.viewHeight;
  const frameAR = aspectRatioOfSpan(c, cam);
  assert.ok(Math.abs(frameAR - viewportAR) < 1e-3, `frameAR=${frameAR} viewportAR=${viewportAR}`);
});

test('near-square arena: frame aspect ratio still matches the viewport', () => {
  const c = cfg({ arena: { minX: -150, maxX: 150, minY: 0, maxY: 300 }, viewWidth: 800, viewHeight: 800 });
  const cam = computeCamera([{ x: 10, y: 120 }, { x: -30, y: 200 }], c);
  const frameAR = aspectRatioOfSpan(c, cam);
  assert.ok(Math.abs(frameAR - 1) < 1e-3, `frameAR=${frameAR}`);
});

test('a couple of fighters standing close together never zooms tighter than the arena floor', () => {
  const c = cfg();
  const cam = computeCamera(
    [{ x: 0, y: 50 }, { x: 5, y: 50 }],
    c,
  );
  const arenaSpanX = c.arena.maxX - c.arena.minX;
  const arenaSpanY = c.arena.maxY - c.arena.minY;
  const arenaFitScale = Math.min(c.viewWidth / arenaSpanX, c.viewHeight / arenaSpanY);
  // scale should not exceed what's needed to fit the whole arena -- i.e.
  // the view is at least as wide (in world units) as the arena itself.
  assert.ok(cam.scale <= arenaFitScale + EPS, `scale=${cam.scale} arenaFitScale=${arenaFitScale}`);
});

test('fighters spread wider than the arena footprint zoom out to fit them (still clamped by maxScale/minScale)', () => {
  const c = cfg({ arena: { minX: -100, maxX: 100, minY: 0, maxY: 100 } });
  const tight = computeCamera([{ x: 0, y: 50 }], c);
  const spread = computeCamera([{ x: -500, y: 50 }, { x: 500, y: 50 }], c);
  assert.ok(spread.scale < tight.scale, 'spreading fighters apart should zoom out (lower scale)');
});

test('scale is clamped between minScale and maxScale', () => {
  const c = cfg({ minScale: 2, maxScale: 3, arena: { minX: -50, maxX: 50, minY: 0, maxY: 50 } });
  // Single fighter, tiny arena -- would otherwise want to zoom in past maxScale.
  const cam = computeCamera([{ x: 0, y: 25 }], c);
  assert.ok(cam.scale <= c.maxScale + EPS);
  assert.ok(cam.scale >= Math.min(c.minScale, c.viewWidth / 100, c.viewHeight / 100) - EPS);
});

test('clamped correctly once the live blast rect (arena) is smaller than the natural floor: frame never exceeds the arena footprint scale', () => {
  // Simulates a collapsing arena: the live blast rect shrinks well below
  // any reasonable "natural minimum" footprint. The camera must still
  // frame at most the arena's own span (not zoom in tighter than what
  // the shrunk arena's fit-scale allows), i.e. respect the live bounds.
  const shrunkArena: ArenaBounds = { minX: -20, maxX: 20, minY: 0, maxY: 20 };
  const c = cfg({ arena: shrunkArena, minScale: 1, maxScale: 100 });
  const cam = computeCamera([{ x: 0, y: 10 }], c);
  const arenaFitScale = Math.min(c.viewWidth / 40, c.viewHeight / 20);
  assert.ok(cam.scale <= arenaFitScale + EPS, `scale=${cam.scale} should not exceed arena fit scale=${arenaFitScale}`);
});

test('empty fighter list falls back to framing the whole arena', () => {
  const c = cfg({ arena: { minX: -300, maxX: 300, minY: 0, maxY: 150 } });
  const cam = computeCamera([], c);
  assert.equal(cam.centerX, 0);
  assert.equal(cam.centerY, 75);
  const viewportAR = c.viewWidth / c.viewHeight;
  const frameAR = aspectRatioOfSpan(c, cam);
  assert.ok(Math.abs(frameAR - viewportAR) < 1e-3);
});

test('center clamps to stay within arena bounds when a fighter sits near the edge', () => {
  const c = cfg({ arena: { minX: -1000, maxX: 1000, minY: 0, maxY: 400 }, minScale: 5, maxScale: 5 });
  // Force scale=5 via min=max, fighter far to one side.
  const cam = computeCamera([{ x: 950, y: 50 }], c);
  const halfViewWorldX = c.viewWidth / 2 / cam.scale;
  assert.ok(cam.centerX <= c.arena.maxX - halfViewWorldX + EPS);
  assert.ok(cam.centerX >= c.arena.minX + halfViewWorldX - EPS);
});

// Reduced-motion camera damping (issue #24): the "Reduce screen shake"
// setting is extended to also clamp the camera's own rate of pan/zoom
// change, since computeCamera() by itself just jumps straight to a
// fresh target every call with no memory of the previous frame.
test('reduced motion off (default): computeCamera jumps straight to the raw target, unchanged from before', () => {
  assert.equal(isCameraReducedMotion(), false);
  const c = cfg();
  const raw = computeRawCamera([{ x: 100, y: 50 }], c);
  const cam = computeCamera([{ x: 100, y: 50 }], c);
  assert.equal(cam.centerX, raw.centerX);
  assert.equal(cam.centerY, raw.centerY);
  assert.equal(cam.scale, raw.scale);
});

test('reduced motion on: a big jump in the framing target is damped, not applied all at once', () => {
  // The camera frames the arena, so its motion comes from the arena box
  // changing (the collapsing ring), not from fighters moving inside a
  // fixed box -- so that is what this drives.
  const wide = cfg({ arena: { minX: -2000, maxX: 2000, minY: 0, maxY: 800 } });
  const shrunk = cfg({ arena: { minX: 1000, maxX: 1400, minY: 0, maxY: 800 } });
  try {
    setCameraReducedMotion(true);
    assert.equal(isCameraReducedMotion(), true);
    const start = computeCamera([{ x: 0, y: 50 }], wide);
    const rawTarget = computeRawCamera([{ x: 1200, y: 50 }], shrunk);
    const damped = computeCamera([{ x: 1200, y: 50 }], shrunk);
    assert.ok(
      Math.abs(rawTarget.centerX - start.centerX) > 1,
      'test setup: the two arena boxes must frame to different centres',
    );
    const startDist = Math.abs(rawTarget.centerX - start.centerX);
    const dampedDist = Math.abs(rawTarget.centerX - damped.centerX);
    assert.ok(dampedDist > EPS, 'damped camera should not have snapped exactly to the raw target');
    assert.ok(dampedDist < startDist, 'damped camera should have moved partway toward the raw target');
  } finally {
    setCameraReducedMotion(false);
  }
});

test('reduced motion on: repeatedly calling computeCamera with a fixed target converges to it', () => {
  const c = cfg();
  try {
    setCameraReducedMotion(true);
    computeCamera([{ x: 0, y: 50 }], c); // seed the initial smoothed state
    let last = computeCamera([{ x: 500, y: 50 }], c);
    for (let i = 0; i < 200; i++) {
      last = computeCamera([{ x: 500, y: 50 }], c);
    }
    const raw = computeRawCamera([{ x: 500, y: 50 }], c);
    assert.ok(Math.abs(last.centerX - raw.centerX) < 1e-3, `did not converge: last=${last.centerX} raw=${raw.centerX}`);
  } finally {
    setCameraReducedMotion(false);
  }
});

test('turning reduced motion off resumes jumping straight to target (no leftover damping state)', () => {
  const c = cfg();
  setCameraReducedMotion(true);
  computeCamera([{ x: 0, y: 50 }], c);
  computeCamera([{ x: 900, y: 50 }], c); // mid-damping, far from target
  setCameraReducedMotion(false);
  const raw = computeRawCamera([{ x: 900, y: 50 }], c);
  const cam = computeCamera([{ x: 900, y: 50 }], c);
  assert.equal(cam.centerX, raw.centerX);
});

// Regression test for the "ants on a line" ground-anchor bug (see wiki
// "Camera Ground Anchor Fix 2026-09-14"): on a wide, short arena, the
// padded/aspect-corrected floor box's own vertical midpoint sits well
// above the ground fighters actually stand on, so clamping the camera's
// center to that floor box (instead of the true world/blast edges) used
// to pin a ground-hugging crowd to the bottom sliver of the screen even
// though the fighters' own centroid is right at y=0. clampBounds fixes
// this by clamping to the true blast rect instead.
test('clampBounds lets the camera center follow ground-level fighters instead of the padded floor midpoint', () => {
  // A battle-royale-20-shaped floor: wide and short, so the aspect-ratio
  // correction in framing.ts stretches its vertical span well above the
  // ground with much more headroom above than below (jump vs fall split).
  // Exact battle-royale-20 population-floor bounds at 1280x720 (see
  // computePopulationAwareFramingFloor in framing.ts): the aspect-ratio
  // correction stretches the floor's vertical span to exactly match the
  // viewport, which is precisely what makes the pre-fix collapse-to-
  // midpoint clamp trigger below.
  const arena: ArenaBounds = { minX: -480, maxX: 480, minY: -91.72413793103448, maxY: 448.27586206896547 };
  const clampBounds: ArenaBounds = { minX: -620, maxX: 620, minY: -260, maxY: 520 };
  // 20 fighters spread across nearly the full ground width, as in a real
  // battle-royale-20 opening scatter.
  const positions = Array.from({ length: 20 }, (_, i) => ({ x: -439 + i * 46, y: 0 }));

  const withoutClamp = computeRawCamera(positions, cfg({ arena, minScale: 1.6, maxScale: 5.5 }));
  const withClamp = computeRawCamera(positions, cfg({ arena, clampBounds, minScale: 1.6, maxScale: 5.5 }));

  // Ground (y=0) screen position: viewHeight/2 - (0 - centerY) * scale.
  const groundScreenY = (cam: { centerY: number; scale: number }) =>
    720 / 2 + cam.centerY * cam.scale;

  const beforeFrac = groundScreenY(withoutClamp) / 720;
  const afterFrac = groundScreenY(withClamp) / 720;

  // Before the fix, the ground line sits in the bottom ~15-20% of the
  // screen (pinned near the edge). After, it should be much closer to
  // the middle of the viewport, where the fighters actually are.
  assert.ok(beforeFrac > 0.75, `expected pre-fix ground line pinned near bottom, got ${beforeFrac}`);
  assert.ok(afterFrac > 0.35 && afterFrac < 0.65, `expected post-fix ground line near mid-screen, got ${afterFrac}`);
});

test('clampBounds still prevents the camera from showing dead space beyond the true world edges', () => {
  const arena: ArenaBounds = { minX: -480, maxX: 480, minY: -91.7, maxY: 448.1 };
  const clampBounds: ArenaBounds = { minX: -620, maxX: 620, minY: -260, maxY: 520 };
  // A single fighter standing right at the world's edge.
  const positions = [{ x: 610, y: 0 }];
  const cam = computeCamera(positions, cfg({ arena, clampBounds, minScale: 1, maxScale: 1.2 }));
  const halfViewWorldX = cfg().viewWidth / 2 / cam.scale;
  // The frame must never extend past the true blast rect on the right.
  assert.ok(cam.centerX + halfViewWorldX <= clampBounds.maxX + 1e-6);
});

test('clampBounds defaults to arena bounds when omitted (unchanged behaviour for existing callers)', () => {
  const arena: ArenaBounds = { minX: -200, maxX: 200, minY: 0, maxY: 200 };
  const positions = [{ x: 0, y: 50 }];
  const withField = computeRawCamera(positions, cfg({ arena }));
  const explicitSame = computeRawCamera(positions, cfg({ arena, clampBounds: arena }));
  assert.deepEqual(withField, explicitSame);
});
