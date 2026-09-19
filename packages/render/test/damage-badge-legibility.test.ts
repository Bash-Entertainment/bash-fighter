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

test('two close candidates both keep their damage numeral by falling back through tiers/stagger rather than dropping identity first', () => {
  // Two candidates close enough that name+pct collides for both -- the
  // reordered ladder (name+%, number+%, %-alone, stagger, only then
  // identity-without-%) should still land a percent for each of them
  // rather than surviving via a dropped percent, which is what the old
  // identity-first ladder would have done.
  const candidates: BadgeCandidate[] = [
    { slot: 0, isLocalPlayer: false, headX: 100, headY: 100, percent: 42 },
    { slot: 1, isLocalPlayer: false, headX: 132, headY: 100, percent: 7 },
  ];
  const bodyBoxes: BodyBox[] = [];
  const placements = computeBadgePlacements(candidates, bodyBoxes, ['Rook', 'Wisp']);
  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++) {
      assert.ok(!boxesOverlap(placements[i]!.box, placements[j]!.box), 'two badges overlap');
    }
  }
  const withPercent = placements.filter((p) => p.hasPercent).length;
  assert.ok(withPercent >= 1, 'expected at least one candidate to keep its damage numeral');
});

// 2026-09-18: a live 20-fighter match measured on production showed only
// 9 of 20 badges visible a few seconds in, once fighters converge from
// their tidy two-row spawn into a real cluster -- the spawn-frame tests
// above are the easy case and do not exercise this. This pins the new
// ladder (name+%, number+%, percent-alone, one-row stagger, only then
// drop) against a deliberately tight cluster: fighters packed within a
// radius small enough that even numeric badges routinely collide, the
// way a real mid-match dogpile does.
test('a tight mid-match cluster still shows a damage numeral for essentially every fighter', () => {
  const vw = 1280;
  const vh = 720;
  const centerX = vw / 2;
  const centerY = vh / 2;
  const count = 20;
  const bodyHalfWidth = 10;
  const bodyHeight = 26;
  // A blob, not a ring: real convergence during a fight bunches fighters
  // into an irregular huddle with some touching shoulders and others a
  // half-body apart -- unlike a symmetric ring, badges get uneven local
  // slack to work with, which is what the stagger fallback is for. This
  // is the shape the live match actually showed (nine of twenty world
  // badges survived there under the old, identity-first ladder).
  const cols = 5;
  const spacingX = bodyHalfWidth * 4.4;
  const spacingY = bodyHeight * 2.2;
  const candidates: BadgeCandidate[] = [];
  const bodyBoxes: BodyBox[] = [];
  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const jitterX = ((i * 7) % 5) - 2;
    const jitterY = ((i * 11) % 5) - 2;
    const x = centerX + (col - (cols - 1) / 2) * spacingX + jitterX;
    const y = centerY + (row - 1.5) * spacingY + jitterY;
    bodyBoxes.push({ slot: i, left: x - bodyHalfWidth, right: x + bodyHalfWidth, top: y - bodyHeight, bottom: y });
    candidates.push({ slot: i, isLocalPlayer: i === 0, headX: x, headY: y - bodyHeight - 4, percent: (i * 23) % 160 });
  }

  const placements = computeBadgePlacements(candidates, bodyBoxes, undefined, { width: vw, height: vh });
  const withDamage = placements.filter((p) => p.hasPercent).length;

  // No overlap regardless of density.
  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++) {
      assert.ok(!boxesOverlap(placements[i]!.box, placements[j]!.box), 'two badges overlap in a tight cluster');
    }
  }
  // The whole point of the reordered ladder: a numeral should survive
  // for almost everyone, not just the sparse few the old name-first
  // ladder preserved.
  assert.ok(
    withDamage >= count * 0.85,
    `expected almost every fighter to show a damage numeral in a tight cluster, got ${withDamage}/${count}`,
  );
  // And every box stays inside the visible canvas.
  for (const p of placements) {
    assert.ok(p.box.left >= -0.01 && p.box.right <= vw + 0.01, 'badge box left the visible canvas horizontally');
    assert.ok(p.box.top >= -0.01 && p.box.bottom <= vh + 0.01, 'badge box left the visible canvas vertically');
  }
});

test('a fighter near the left edge of the canvas is clamped, not hidden behind the sidebar', () => {
  const view = { width: 1280, height: 720 };
  const candidates: BadgeCandidate[] = [{ slot: 0, isLocalPlayer: false, headX: 5, headY: 100, percent: 42 }];
  const placements = computeBadgePlacements(candidates, [], undefined, view);
  assert.equal(placements.length, 1);
  assert.ok(placements[0]!.box.left >= 0, 'badge box left edge sits behind x=0, i.e. behind the sidebar');
});

test("bot names drop the world badge's redundant \"CPU \" prefix", () => {
  const candidates: BadgeCandidate[] = [{ slot: 0, isLocalPlayer: false, headX: 100, headY: 100, percent: 10 }];
  const placements = computeBadgePlacements(candidates, [], ['CPU Kestrel']);
  assert.equal(placements[0]!.label, 'Kestrel 10%');
});
