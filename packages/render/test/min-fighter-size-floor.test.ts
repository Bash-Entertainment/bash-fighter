// Unit tests for the min-fighter-size legibility floor in
// packages/render/src/camera.ts (computeRawCamera/applyMinFighterSizeFloor).
// Ground truth: scripts/camera-framing-metrics.mjs measured a fighter
// rendered only 12.5-17.6px tall on a 390x844 phone viewport with 20
// fighters spread across the arena; desktop 1280x720 measured 41-58px on
// the same stages and stays untouched by this floor. See wiki "Real Player
// Measurements 2026-09-14: Phones Are the Primary Platform".
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  computeRawCamera,
  computeFitEveryoneCamera,
  resetCameraSmoothing,
  setCameraReducedMotion,
  type CameraConfig,
} from '../src/camera.ts';
import { FIGHTER_WORLD_HEIGHT, MIN_FIGHTER_PX } from '../src/fighter-scale.ts';

beforeEach(() => {
  resetCameraSmoothing();
  setCameraReducedMotion(false);
});

function cfg(overrides: Partial<CameraConfig> = {}): CameraConfig {
  return {
    viewWidth: 1280,
    viewHeight: 720,
    minScale: 1.6,
    maxScale: 5.5,
    paddingWorld: 20,
    arena: { minX: -600, maxX: 600, minY: 0, maxY: 300 },
    clampBounds: { minX: -700, maxX: 700, minY: -100, maxY: 400 },
    ...overrides,
  };
}

function spreadPositions(count: number, minX: number, maxX: number) {
  const positions: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    positions.push({ x: minX + t * (maxX - minX), y: i % 3 === 0 ? 0 : 4 });
  }
  return positions;
}

const MIN_SIZE_SCALE = MIN_FIGHTER_PX / FIGHTER_WORLD_HEIGHT;

test('desktop 1280x720 with 20 spread fighters is unchanged by the floor', () => {
  const c = cfg();
  const positions = spreadPositions(20, -580, 580);
  const fit = computeFitEveryoneCamera(positions, c);
  const cam = computeRawCamera(positions, c, positions[0]);
  assert.ok(fit.scale >= MIN_SIZE_SCALE, 'desktop fit-everyone scale should already clear the floor');
  assert.equal(cam.scale, fit.scale);
  assert.equal(cam.centerX, fit.centerX);
  assert.equal(cam.centerY, fit.centerY);
  assert.ok(!cam.minSizeFollow);
});

test('390x844 phone viewport yields an apparent fighter height of at least 26px', () => {
  const c = cfg({ viewWidth: 390, viewHeight: 844 });
  const positions = spreadPositions(20, -580, 580);
  const cam = computeRawCamera(positions, c, positions[0]);
  const fighterPx = FIGHTER_WORLD_HEIGHT * cam.scale;
  assert.ok(cam.minSizeFollow, 'expected the min-size-follow path to trigger on a narrow phone viewport');
  assert.ok(fighterPx >= MIN_FIGHTER_PX - 1e-9, `fighterPx=${fighterPx} should be >= ${MIN_FIGHTER_PX}`);
  assert.equal(cam.scale, MIN_SIZE_SCALE);
});

test('the raised-scale view never extends beyond the stage blast rect', () => {
  const c = cfg({ viewWidth: 390, viewHeight: 844 });
  const positions = spreadPositions(20, -580, 580);
  // Local player pinned right at the stage's edge, which is exactly the
  // case that would push the frame outside the blast rect if unclamped.
  const localPlayerPos = { x: 690, y: 0 };
  const cam = computeRawCamera(positions, c, localPlayerPos);
  assert.ok(cam.minSizeFollow);
  const halfW = c.viewWidth / 2 / cam.scale;
  const halfH = c.viewHeight / 2 / cam.scale;
  const clamp = c.clampBounds!;
  // On an axis where the view fits inside the clamp region, the centre
  // must be pulled back so the whole view stays within it. On an axis
  // where the view is wider/taller than the clamp region itself (the
  // phone viewport here, on Y), there is no centre that keeps the view
  // fully inside it -- the best the clamp can do, and what it does, is
  // center on the clamp region itself.
  if (clamp.maxX - clamp.minX >= halfW * 2) {
    assert.ok(cam.centerX - halfW >= clamp.minX - 1e-6);
    assert.ok(cam.centerX + halfW <= clamp.maxX + 1e-6);
  } else {
    assert.ok(Math.abs(cam.centerX - (clamp.minX + clamp.maxX) / 2) < 1e-6);
  }
  if (clamp.maxY - clamp.minY >= halfH * 2) {
    assert.ok(cam.centerY - halfH >= clamp.minY - 1e-6);
    assert.ok(cam.centerY + halfH <= clamp.maxY + 1e-6);
  } else {
    assert.ok(Math.abs(cam.centerY - (clamp.minY + clamp.maxY) / 2) < 1e-6);
  }
});

test('spectating (no local player) centres the min-size follow on the living centroid', () => {
  const c = cfg({ viewWidth: 390, viewHeight: 844 });
  const positions = spreadPositions(20, -580, 580);
  const cam = computeRawCamera(positions, c, null);
  assert.ok(cam.minSizeFollow);
  const sum = positions.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  const centroidX = sum.x / positions.length;
  const centroidY = sum.y / positions.length;
  // X has plenty of clamp room around the centroid, so it should land
  // exactly there; Y is checked only for being clamp-consistent since the
  // phone viewport's tall half-extent can exceed the clamp region on that
  // axis (see the blast-rect test above for that case).
  assert.ok(Math.abs(cam.centerX - centroidX) < 1e-6);
  const halfH = c.viewHeight / 2 / cam.scale;
  const clamp = c.clampBounds!;
  if (clamp.maxY - clamp.minY >= halfH * 2) {
    assert.ok(Math.abs(cam.centerY - centroidY) < 1e-6);
  } else {
    assert.ok(Math.abs(cam.centerY - (clamp.minY + clamp.maxY) / 2) < 1e-6);
  }
});

// Source-level pin (no jsdom in this repo): the floor is useless if the
// renderer never tells the camera which fighter is ours -- it would then
// centre on the living centroid even for a player who is alive, i.e.
// follow nobody. 2026-09-19: the first implementation did exactly that.
test('the renderer passes the local living fighter to computeCamera', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(src, /localLivingFighter\s*\?\s*\{\s*x:\s*localLivingFighter\.x/);
  assert.match(src, /localCandidate && !localCandidate\.eliminated/);
});
