// Unit tests for packages/render/src/camera.ts's computeCamera aspect-ratio
// framing math (issue #18). Pure math over plain numbers, no Pixi/DOM --
// matches the node:test + node:assert style of palette.test.ts.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCamera,
  computeRawCamera,
  resetCameraSmoothing,
  setCameraReducedMotion,
  isCameraReducedMotion,
  type ArenaBounds,
  type CameraConfig,
} from '../src/camera.ts';

const EPS = 1e-6;

// computeCamera now damps every frame, not only under reduced motion, so
// it carries state between calls. Each test starts from a clean camera:
// the first call after a reset returns the raw target exactly.
beforeEach(() => {
  resetCameraSmoothing();
  setCameraReducedMotion(false);
});

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
  // screen (pinned near the edge). After, the deliberate ground-anchor
  // bias (GROUND_BIAS in camera.ts, retuned to 0.35 in the
  // empty-sky-at-20 follow-up 2026-09-15, down from 0.75 set in the
  // dead-space-below-floor pass 2026-09-14 -- see wiki "Camera Framing:
  // Ground Anchor and Jump-Space Bias 2026-09-14" and the GROUND_BIAS
  // comment in camera.ts) should put it at roughly 60-68% down the
  // viewport -- more room above the ground than below it (jumps go up,
  // not down), without pinning the action to either edge.
  assert.ok(beforeFrac > 0.75, `expected pre-fix ground line pinned near bottom, got ${beforeFrac}`);
  assert.ok(afterFrac > 0.60 && afterFrac < 0.68, `expected post-fix ground line at ~60-68% down, got ${afterFrac}`);
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

// Regression test for the second production report on this framing work:
// the ground-anchor fix above (clampBounds) was correct but overcorrected
// to dead-center the fighters (~50% down), leaving a big band of empty
// pit below them. A platform fighter's action is mostly *above* the
// floor, so the frame should be biased to put the ground below center.
//
// EMPTY-SKY-AT-20 FOLLOW-UP (2026-09-15): the 80-88% value this test used
// to pin was itself later found to overcorrect the other way once
// fighters were big enough to read the composition by -- GROUND_BIAS was
// retuned from 0.75 to 0.35, moving the ground line to ~62-66% down
// instead. See the GROUND_BIAS comment in camera.ts for the full
// before/after reasoning.
test('GROUND_BIAS puts a ground-hugging pack at ~60-68% down the viewport, on multiple stage shapes', () => {
  const stages: Array<{ name: string; arena: ArenaBounds; clampBounds: ArenaBounds }> = [
    {
      name: 'battle-royale-20-shaped (wide, short)',
      arena: { minX: -480, maxX: 480, minY: -91.72413793103448, maxY: 448.27586206896547 },
      clampBounds: { minX: -620, maxX: 620, minY: -260, maxY: 520 },
    },
    {
      name: 'the-foundry-shaped (the stage the original arena-midpoint clamp was added for)',
      arena: { minX: -440, maxX: 440, minY: -70, maxY: 430 },
      clampBounds: { minX: -520, maxX: 520, minY: -260, maxY: 560 },
    },
  ];
  const positions = Array.from({ length: 20 }, (_, i) => ({ x: -400 + i * 42, y: 0 }));
  for (const { name, arena, clampBounds } of stages) {
    const cam = computeRawCamera(positions, cfg({ arena, clampBounds, minScale: 1.2, maxScale: 5.5 }));
    const groundScreenY = 720 / 2 + cam.centerY * cam.scale;
    const frac = groundScreenY / 720;
    assert.ok(frac > 0.60 && frac < 0.68, `${name}: expected ground line at ~60-68% down, got ${frac}`);
  }
});

test('GROUND_BIAS yields to full coverage when fighters are genuinely spread vertically', () => {
  const arena: ArenaBounds = { minX: -480, maxX: 480, minY: -91.72413793103448, maxY: 448.27586206896547 };
  const clampBounds: ArenaBounds = { minX: -620, maxX: 620, minY: -260, maxY: 520 };
  // One fighter high on a platform, one on the ground, one fallen below the floor.
  const positions = [{ x: -20, y: 0 }, { x: 0, y: 200 }, { x: 20, y: -150 }];
  const cam = computeCamera(positions, cfg({ arena, clampBounds, minScale: 1.2, maxScale: 5.5 }));
  const halfViewWorldY = cfg().viewHeight / 2 / cam.scale;
  const viewTop = cam.centerY + halfViewWorldY;
  const viewBottom = cam.centerY - halfViewWorldY;
  const fMaxY = 200 + 20 * 1.5;
  const fMinY = -150 - 20;
  assert.ok(viewTop >= fMaxY - 1e-6, `top fighter cropped: viewTop=${viewTop} fMaxY=${fMaxY}`);
  assert.ok(viewBottom <= fMinY + 1e-6, `bottom fighter cropped: viewBottom=${viewBottom} fMinY=${fMinY}`);
});

test('GROUND_BIAS falls back to plain arena centering when there are no fighters at all', () => {
  const arena: ArenaBounds = { minX: -200, maxX: 200, minY: -50, maxY: 250 };
  const cam = computeRawCamera([], cfg({ arena, minScale: 1, maxScale: 5.5 }));
  assert.equal(cam.centerY, (arena.minY + arena.maxY) / 2);
});

// The camera's centre only has room to move when the fighters are spread
// wider than the arena box, so that the clamp against the arena edges is
// not what decides the centre. These two spreads differ only in where
// their midpoint sits: 0, then 200.
const SPREAD_A = [
  { x: -1000, y: 50 },
  { x: 1000, y: 50 },
];
const SPREAD_B = [
  { x: -1000, y: 50 },
  { x: 1400, y: 50 },
];

test('the camera damps its follow for every player, not only reduced motion', () => {
  const c = cfg({ arena: { minX: -600, maxX: 600, minY: 0, maxY: 200 } });
  const first = computeCamera(SPREAD_A, c, 16.7);
  const target = computeRawCamera(SPREAD_B, c);
  const second = computeCamera(SPREAD_B, c, 16.7);
  assert.ok(
    second.centerX > first.centerX,
    'the camera should move toward the fighters',
  );
  assert.ok(
    second.centerX < target.centerX - EPS,
    'but must not arrive in a single frame -- that is the jerk players reported',
  );
});

test('damping closes the same distance per unit of wall-clock time, not per frame', () => {
  const c = cfg({ arena: { minX: -600, maxX: 600, minY: 0, maxY: 200 } });
  computeCamera(SPREAD_A, c, 16.7);
  const oneLongFrame = computeCamera(SPREAD_B, c, 66.8).centerX;

  resetCameraSmoothing();
  computeCamera(SPREAD_A, c, 16.7);
  let fourShortFrames = 0;
  for (let i = 0; i < 4; i += 1) {
    fourShortFrames = computeCamera(SPREAD_B, c, 16.7).centerX;
  }
  assert.ok(
    Math.abs(oneLongFrame - fourShortFrames) < 1,
    `one 66.8ms frame (${oneLongFrame}) should land where four 16.7ms frames do (${fourShortFrames})`,
  );
});

test('reduced motion is calmer than the default follow, not the only damping', () => {
  const c = cfg({ arena: { minX: -600, maxX: 600, minY: 0, maxY: 200 } });
  computeCamera(SPREAD_A, c, 16.7);
  const normal = computeCamera(SPREAD_B, c, 16.7).centerX;

  resetCameraSmoothing();
  setCameraReducedMotion(true);
  computeCamera(SPREAD_A, c, 16.7);
  const reduced = computeCamera(SPREAD_B, c, 16.7).centerX;
  assert.ok(reduced < normal, 'reduced motion should trail further behind the target');
});

test('a cut, not a move: a huge jump is taken instantly', () => {
  const c = cfg({ arena: { minX: -100000, maxX: 100000, minY: 0, maxY: 200 } });
  computeCamera(SPREAD_A, c, 16.7);
  const target = computeRawCamera([{ x: 90000, y: 50 }], c);
  const jumped = computeCamera([{ x: 90000, y: 50 }], c, 16.7);
  assert.ok(Math.abs(jumped.centerX - target.centerX) < EPS);
});

test('resetting smoothing lands exactly on the target again', () => {
  const c = cfg({ arena: { minX: -600, maxX: 600, minY: 0, maxY: 200 } });
  computeCamera(SPREAD_A, c, 16.7);
  computeCamera(SPREAD_B, c, 16.7);
  resetCameraSmoothing();
  const after = computeCamera(SPREAD_B, c, 16.7);
  const raw = computeRawCamera(SPREAD_B, c);
  assert.ok(Math.abs(after.centerX - raw.centerX) < EPS);
});

// 2026-09-14, found by playing production: with follow damping in flight the
// eased frame is not the frame the fight needs, and a fighter -- in the case I
// saw, the local player, name label clipped -- can sit outside the screen
// edge. Smoothing is allowed to lag; it is not allowed to hide anybody.
test('a mid-ease camera still contains every fighter the raw frame contains', () => {
  const wide = cfg({
    minScale: 0.1,
    arena: { minX: -600, maxX: 600, minY: -400, maxY: 400 },
  });
  // Settle far to the left, then teleport the spread far right by less than
  // the snap threshold, so the camera eases rather than cuts.
  computeCamera([{ x: -900, y: 0 }, { x: -700, y: 0 }], wide);
  for (let i = 0; i < 3; i++) {
    const fighters = [{ x: 300, y: 0 }, { x: 900, y: 0 }];
    const view = computeCamera(fighters, wide, 1000 / 60);
    const halfW = wide.viewWidth / 2 / view.scale;
    const halfH = wide.viewHeight / 2 / view.scale;
    for (const f of fighters) {
      assert.ok(
        f.x >= view.centerX - halfW && f.x <= view.centerX + halfW,
        `fighter at x=${f.x} outside frame on frame ${i}`,
      );
      assert.ok(
        f.y >= view.centerY - halfH && f.y <= view.centerY + halfH,
        `fighter at y=${f.y} outside frame on frame ${i}`,
      );
    }
  }
});

// Regression (2026-09-14): containFighters's scale floor must match
// computeRawCamera's own floor -- min(cfg.minScale, arenaFitScale) -- not
// bare cfg.minScale. On a wide arena where the whole-arena fit needs a
// scale below cfg.minScale, computeRawCamera correctly zooms out past
// minScale for exactly one reason: showing the whole arena. Before this
// fix, every damped frame after the first re-clamped scale back up to
// cfg.minScale, discarding that wider fit and pinning the composition
// into a tight band near the bottom edge in production. See wiki "Camera
// Framing: Ground Anchor and Jump-Space Bias 2026-09-14".
test('damped steady-state scale matches raw scale on a wide arena that needs to zoom out past minScale', () => {
  const arena: ArenaBounds = { minX: -480, maxX: 480, minY: -100, maxY: 540 };
  const c = cfg({
    viewWidth: 1080,
    viewHeight: 720,
    minScale: 1.6,
    maxScale: 5.5,
    arena,
    clampBounds: { minX: -620, maxX: 620, minY: -260, maxY: 520 },
  });
  const positions = Array.from({ length: 20 }, (_, i) => ({
    x: -373 + (i / 19) * 761,
    y: 0,
  }));
  const raw = computeRawCamera(positions, c);
  let damped = raw;
  for (let i = 0; i < 120; i++) {
    damped = computeCamera(positions, c, 1000 / 60);
  }
  assert.ok(
    Math.abs(damped.scale - raw.scale) < 0.01,
    `damped scale ${damped.scale} should settle to raw scale ${raw.scale}, not re-clamp to cfg.minScale ${c.minScale}`,
  );
});

// Regression (empty-sky-at-20 pass, 2026-09-15): a large, tightly-spread
// lobby (>= ARENA_FLOOR_SLACK_MIN_COUNT fighters) must be able to zoom
// tighter than the raw arena/platform footprint when the fighters
// themselves occupy noticeably less width than that footprint -- the
// floor exists for small, clustered endgames, not to permanently reserve
// unused ground margin at full population. See
// "Camera Framing: Ground Anchor and Jump-Space Bias" wiki history and
// scripts/camera-framing-metrics.mjs.
test('a large, tightly-spread lobby zooms in past the raw arena footprint, never past cfg.maxScale, and still contains everyone', () => {
  // minY/maxY sized to a realistic jump/fall headroom band (like a real
  // stage's framing floor, not an arbitrary wide box) so this test
  // isolates the X-axis cap under test rather than accidentally binding
  // on Y, which production's aspect-correction step (framing.ts) would
  // ordinarily have already shrunk to match.
  const arena: ArenaBounds = { minX: -480, maxX: 480, minY: -40, maxY: 150 };
  const c = cfg({
    viewWidth: 1280,
    viewHeight: 720,
    minScale: 1.6,
    maxScale: 5.5,
    arena,
    clampBounds: { minX: -620, maxX: 620, minY: -260, maxY: 520 },
  });
  // 20 fighters spread across only ~774 world units (matching
  // battle-royale-20's real spawn spread), well inside the 960-unit
  // arena footprint above.
  const positions = Array.from({ length: 20 }, (_, i) => ({
    x: -367 + (i / 19) * 734,
    y: 0,
  }));
  const arenaFootprintScale = Math.min(
    c.viewWidth / (arena.maxX - arena.minX),
    c.viewHeight / (arena.maxY - arena.minY),
  );
  const view = computeRawCamera(positions, c);
  assert.ok(
    view.scale > arenaFootprintScale,
    `scale ${view.scale} should exceed the raw arena-footprint scale ${arenaFootprintScale} once the lobby is large but its spread is tighter than the footprint`,
  );
  const halfW = c.viewWidth / 2 / view.scale;
  for (const f of positions) {
    assert.ok(
      f.x >= view.centerX - halfW && f.x <= view.centerX + halfW,
      `fighter at x=${f.x} outside frame`,
    );
  }
});

// Regression: a small cluster (below the slack-cap population threshold)
// keeps the full, un-slacked arena floor -- the "still looks like an
// arena" behaviour for 2-3 fighter endgames must be unaffected.
test('a small cluster below the slack-cap threshold still gets the full arena floor', () => {
  const arena: ArenaBounds = { minX: -480, maxX: 480, minY: -100, maxY: 540 };
  const c = cfg({
    viewWidth: 1280,
    viewHeight: 720,
    minScale: 1.6,
    maxScale: 5.5,
    arena,
    clampBounds: { minX: -620, maxX: 620, minY: -260, maxY: 520 },
  });
  const positions = [{ x: -10, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }];
  const arenaFootprintScale = Math.min(
    c.viewWidth / (arena.maxX - arena.minX),
    c.viewHeight / (arena.maxY - arena.minY),
  );
  const view = computeRawCamera(positions, c);
  assert.ok(
    Math.abs(view.scale - arenaFootprintScale) < 0.01,
    `small cluster should be framed at the raw arena-footprint scale ${arenaFootprintScale}, got ${view.scale}`,
  );
});

