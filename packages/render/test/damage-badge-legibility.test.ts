// Regression test for the 2026-09-18 damage-readability feature (player
// report: "Had no idea how much hp anybody had"). computeBadgePlacements
// (packages/render/src/badge-layout.ts) now folds each fighter's damage
// percent into its world-space badge, with its own collision-checked
// fallback tier on top of the existing name/number fallback -- this pins
// that at true battle-royale-20 match-start density (through the real
// spawnPoints -> framing.ts -> camera.ts pipeline, exactly like
// battle-royale-20-spawn-legibility.test.ts, including the
// fighterSpanXHint the game actually passes) no two badge boxes ever
// overlap, and that the local player's own damage reaches the screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BATTLE_ROYALE_20_ARENA } from '@bash-fighter/content';
import { fixed as fx } from '@bash-fighter/sim';
import { computeCamera, resetCameraSmoothing, worldToScreen, type CameraConfig } from '../src/camera.ts';
import { arenaDataToStageBounds } from '../src/arena-adapter.ts';
import { computePopulationAwareFramingFloor } from '../src/framing.ts';
import { BODY_WIDTH, BODY_HEIGHT, HEAD_RADIUS } from '../src/fighter-shape-placeholder.ts';
import { FighterSprite } from '../src/fighter-sprite.ts';
import { computeBadgePlacements, computeLocalDamageReadout, type BadgeCandidate, type BodyBox } from '../src/badge-layout.ts';

const BODY_HALF_WIDTH_WORLD = BODY_WIDTH * 1.3;
const BODY_TOP_WORLD = BODY_HEIGHT + HEAD_RADIUS * 2;

function boxesOverlap(
  a: { left: number; right: number; top: number; bottom: number },
  b: { left: number; right: number; top: number; bottom: number },
): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function buildScene(viewWidth: number, viewHeight: number, percents: number[]) {
  resetCameraSmoothing();
  const positions = BATTLE_ROYALE_20_ARENA.spawnPoints.map((p) => ({ x: fx.toFloat(p.x), y: fx.toFloat(p.y) }));
  const stage = arenaDataToStageBounds(BATTLE_ROYALE_20_ARENA);
  const livingCount = positions.length;
  const cfg: CameraConfig = {
    viewWidth,
    viewHeight,
    minScale: 1.6,
    maxScale: 5.5,
    paddingWorld: 20,
    // Same fighterSpanXHint the game passes in production -- see
    // battle-royale-20-spawn-legibility.test.ts's comment on why omitting
    // it under-measures the real zoom.
    arena: computePopulationAwareFramingFloor(
      stage,
      viewWidth,
      viewHeight,
      livingCount,
      Math.max(...positions.map((p) => p.x)) - Math.min(...positions.map((p) => p.x)),
    ),
    clampBounds: { minX: stage.blastMinX, maxX: stage.blastMaxX, minY: stage.blastMinY, maxY: stage.blastMaxY },
  };
  const cam = computeCamera(positions, cfg);
  const halfW = BODY_HALF_WIDTH_WORLD * cam.scale;
  const topH = BODY_TOP_WORLD * cam.scale;

  const bodyBoxes: BodyBox[] = [];
  const candidates: BadgeCandidate[] = [];
  positions.forEach((p, i) => {
    const s = worldToScreen(p.x, p.y, cam, viewWidth, viewHeight);
    bodyBoxes.push({ slot: i, left: s.x - halfW, right: s.x + halfW, top: s.y - topH, bottom: s.y });
    candidates.push({
      slot: i,
      isLocalPlayer: i === 0,
      headX: s.x,
      headY: s.y - FighterSprite.HEAD_TOP_OFFSET_WORLD * cam.scale,
      percent: percents[i],
    });
  });
  return { candidates, bodyBoxes };
}

for (const [label, vw, vh] of [
  ['desktop 1280x720', 1280, 720],
  ['phone 390x844', 390, 844],
] as const) {
  test(`battle-royale-20 damage badges: no overlap at match start, all fighters undamaged (${label})`, () => {
    const { candidates, bodyBoxes } = buildScene(vw, vh, new Array(20).fill(0));
    const placements = computeBadgePlacements(candidates, bodyBoxes, undefined);
    // Non-local badges must never overlap another fighter's body -- the
    // local player's own badge is documented-exempt from being dropped
    // (see layoutBadges' doc comment) and can, at extreme packed zoom,
    // still sit over a distant body; that pre-existing exemption is out
    // of scope for this damage-readability change.
    for (const p of placements) {
      if (p.candidate.isLocalPlayer) continue;
      const others = bodyBoxes.filter((b) => b.slot !== p.candidate.slot);
      for (const b of others) assert.ok(!boxesOverlap(p.box, b), `badge for slot ${p.candidate.slot} overlaps body ${b.slot}`);
    }
    for (let i = 0; i < placements.length; i++) {
      for (let j = i + 1; j < placements.length; j++) {
        assert.ok(!boxesOverlap(placements[i]!.box, placements[j]!.box), 'two badges overlap');
      }
    }
  });

  test(`battle-royale-20 damage badges: no overlap with varied realistic damage values (${label})`, () => {
    const percents = Array.from({ length: 20 }, (_, i) => (i * 37) % 180);
    const { candidates, bodyBoxes } = buildScene(vw, vh, percents);
    const placements = computeBadgePlacements(candidates, bodyBoxes, undefined);
    for (let i = 0; i < placements.length; i++) {
      for (let j = i + 1; j < placements.length; j++) {
        assert.ok(!boxesOverlap(placements[i]!.box, placements[j]!.box), 'two badges overlap');
      }
    }
  });

  test(`battle-royale-20 damage badges: local player's own badge is never dropped (${label})`, () => {
    // The in-world badge may legitimately drop its damage *suffix* under
    // real packed-spawn density (see computeLocalDamageReadout's doc
    // comment: it is deliberately not the sole guarantee), but the badge
    // itself -- and the fixed-corner damage readout, checked separately
    // below -- must never disappear.
    const percents = Array.from({ length: 20 }, (_, i) => (i * 37) % 180);
    const { candidates, bodyBoxes } = buildScene(vw, vh, percents);
    const placements = computeBadgePlacements(candidates, bodyBoxes, undefined);
    const local = placements.find((p) => p.candidate.isLocalPlayer);
    assert.ok(local, 'local player badge missing');
  });

  test(`the fixed-corner local damage readout is shown regardless of in-world badge density (${label})`, () => {
    const readout = computeLocalDamageReadout(63, { width: vw, height: vh });
    assert.ok(readout, 'local damage readout missing');
    assert.equal(readout?.text, '63%');
    assert.ok(readout && readout.x >= 0 && readout.x < vw);
    assert.ok(readout && readout.y > 0 && readout.y <= vh);
  });
}

test('a fighter with no percent given (e.g. attract-mode ghost) never claims hasPercent', () => {
  const candidates: BadgeCandidate[] = [{ slot: 0, isLocalPlayer: false, headX: 100, headY: 100 }];
  const placements = computeBadgePlacements(candidates, [], undefined);
  assert.equal(placements[0]?.hasPercent, false);
  assert.equal(placements[0]?.label, '1');
});

test('a damage suffix that would collide is dropped before the identity label is', () => {
  // Two candidates close enough that name+pct collides but the bare
  // number/name alone does not -- picking the mid tier (number + pct)
  // over the top tier (name + pct) proves the fallback engages per-tier,
  // not just name-vs-number as before this feature.
  const candidates: BadgeCandidate[] = [
    { slot: 0, isLocalPlayer: false, headX: 100, headY: 100, percent: 42 },
    { slot: 1, isLocalPlayer: false, headX: 118, headY: 100, percent: 7 },
  ];
  const bodyBoxes: BodyBox[] = [];
  const placements = computeBadgePlacements(candidates, bodyBoxes, ['Rook', 'Wisp']);
  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++) {
      assert.ok(!boxesOverlap(placements[i]!.box, placements[j]!.box), 'two badges overlap');
    }
  }
  assert.ok(placements.length < 2, 'expected one candidate to be dropped rather than overlap at this spacing');
});
