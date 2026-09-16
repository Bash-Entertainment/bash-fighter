// Regression test for the 2026-09-15 spawn-overlap fix (see wiki
// "Spawn Overlap Fix 2026-09-15"): production play on battle-royale-20
// showed 6-8 fighters visibly piled into one indistinguishable clump at
// match start, because the 22/24-unit spawn spacing (tightened for
// camera zoom) put neighbouring spawns closer together than a fighter's
// own rendered body box. This pins "no two fighters overlap on screen at
// match start on battle-royale-20" through the *real* spawnPoints ->
// framing.ts -> camera.ts -> worldToScreen pipeline (the same body-box
// formula index.ts uses for its own name-label overlap avoidance), at
// both the desktop reference viewport and the true phone viewport, and
// pins that the camera zoom gain (scale) was not given back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BATTLE_ROYALE_20_ARENA } from '@bash-fighter/content';
import { fixed as fx } from '@bash-fighter/sim';
import {
  computeCamera,
  resetCameraSmoothing,
  worldToScreen,
  type CameraConfig,
} from '../src/camera.ts';
import { arenaDataToStageBounds } from '../src/arena-adapter.ts';
import { computePopulationAwareFramingFloor } from '../src/framing.ts';
import { BODY_WIDTH, BODY_HEIGHT, HEAD_RADIUS } from '../src/fighter-shape-placeholder.ts';

// Mirrors packages/render/src/index.ts's own body-box formula (search
// "BODY_WIDTH * 1.3" there) -- the production definition of a fighter's
// on-screen footprint used for its name-label overlap avoidance.
const BODY_HALF_WIDTH_WORLD = BODY_WIDTH * 1.3;
const BODY_TOP_WORLD = BODY_HEIGHT + HEAD_RADIUS * 2;

function screenBoxes(viewWidth: number, viewHeight: number) {
  resetCameraSmoothing();
  const positions = BATTLE_ROYALE_20_ARENA.spawnPoints.map((p) => ({
    x: fx.toFloat(p.x),
    y: fx.toFloat(p.y),
  }));
  const stage = arenaDataToStageBounds(BATTLE_ROYALE_20_ARENA);
  const livingCount = positions.length;
  const cfg: CameraConfig = {
    viewWidth,
    viewHeight,
    minScale: 1.6,
    maxScale: 5.5,
    paddingWorld: 20,
    // Pass the real fighter x-span hint, exactly as index.ts's cameraConfig()
    // does in production. Omitting it measures the un-capped arena floor and
    // therefore a lower zoom than the game actually renders -- which would let
    // an overlap regression at the real (higher) zoom pass unnoticed.
    arena: computePopulationAwareFramingFloor(
      stage,
      viewWidth,
      viewHeight,
      livingCount,
      Math.max(...positions.map((p) => p.x)) - Math.min(...positions.map((p) => p.x)),
    ),
    clampBounds: {
      minX: stage.blastMinX,
      maxX: stage.blastMaxX,
      minY: stage.blastMinY,
      maxY: stage.blastMaxY,
    },
  };
  const cam = computeCamera(positions, cfg);
  const halfW = BODY_HALF_WIDTH_WORLD * cam.scale;
  const topH = BODY_TOP_WORLD * cam.scale;
  const boxes = positions.map((p) => {
    const s = worldToScreen(p.x, p.y, cam, viewWidth, viewHeight);
    return { left: s.x - halfW, right: s.x + halfW, top: s.y - topH, bottom: s.y };
  });
  return { boxes, cam, viewWidth, viewHeight };
}

function countOverlaps(boxes: { left: number; right: number; top: number; bottom: number }[]) {
  let pairs = 0;
  const involved = new Set<number>();
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      const xOverlap = a.left < b.right && b.left < a.right;
      const yOverlap = a.top < b.bottom && b.top < a.bottom;
      if (xOverlap && yOverlap) {
        pairs++;
        involved.add(i);
        involved.add(j);
      }
    }
  }
  return { pairs, involved: involved.size };
}

for (const [label, vw, vh] of [
  ['desktop 1280x720', 1280, 720],
  ['phone 390x844', 390, 844],
] as const) {
  test(`battle-royale-20: no two fighters overlap on screen at match start (${label})`, () => {
    const { boxes } = screenBoxes(vw, vh);
    assert.equal(boxes.length, 20);
    const { pairs, involved } = countOverlaps(boxes);
    assert.equal(pairs, 0, `expected no overlapping screen pairs, got ${pairs} (${involved} fighters involved)`);
  });

  test(`battle-royale-20: all 20 fighters stay on screen at match start (${label})`, () => {
    const { boxes } = screenBoxes(vw, vh);
    for (const b of boxes) {
      assert.ok(b.right > 0 && b.left < vw, 'fighter cropped off left/right edge');
      assert.ok(b.bottom > 0 && b.top < vh, 'fighter cropped off top/bottom edge');
    }
  });
}

test('battle-royale-20: desktop camera zoom gain was not given back by the spawn-overlap fix', () => {
  const { cam } = screenBoxes(1280, 720);
  // Pinned against the real production camera scale at match start (2.057
  // on this viewport, with the arena-floor slack cap applied): the fix must
  // not force the camera to zoom back out.
  assert.ok(cam.scale >= 2.05, `camera scale regressed to ${cam.scale}, expected >= 2.05`);
});
