// Regression tests for the 2026-09-18 damage-readability feature (player
// report: "Had no idea how much hp anybody had"). computeBadgePlacements
// (packages/render/src/badge-layout.ts) folds each fighter's damage
// percent into its world-space badge.
//
// 2026-09-18, part 3 -- design call: badges are now allowed to overlap
// other fighters' bodies (a numeral over a distant shoulder costs almost
// nothing; dropping it costs the player exactly what they complained
// about). The one body that stays protected is the local player's own,
// plus its pointer. Badge-vs-badge collision is still enforced -- two
// numerals on top of each other is genuinely unreadable. The earlier
// "badge never overlaps any body" assertions from parts 1-2 are gone
// from this file on purpose, not left in place pinning an abandoned rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BATTLE_ROYALE_20_ARENA } from '@bash-fighter/content';
import { fixed as fx } from '@bash-fighter/sim';
import { computeCamera, resetCameraSmoothing, worldToScreen, type CameraConfig } from '../src/camera.ts';
import { arenaDataToStageBounds } from '../src/arena-adapter.ts';
import { computePopulationAwareFramingFloor } from '../src/framing.ts';
import { BODY_WIDTH, BODY_HEIGHT, HEAD_RADIUS } from '../src/fighter-shape-placeholder.ts';
import { FighterSprite } from '../src/fighter-sprite.ts';
import { PALETTE } from '../src/palette.ts';
import {
  computeBadgePlacements,
  computeLocalDamageReadout,
  badgeLeaderLine,
  setLocalReadoutBottomInset,
  type BadgeCandidate,
  type BodyBox,
} from '../src/badge-layout.ts';
import { fakeMeasureText } from './fake-measure-text.ts';

const BODY_HALF_WIDTH_WORLD = BODY_WIDTH * 1.3;
const BODY_TOP_WORLD = BODY_HEIGHT + HEAD_RADIUS * 2;

function boxesOverlap(
  a: { left: number; right: number; top: number; bottom: number },
  b: { left: number; right: number; top: number; bottom: number },
): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function assertNoBadgeOverlap(placements: { box: { left: number; right: number; top: number; bottom: number } }[]): void {
  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++) {
      assert.ok(!boxesOverlap(placements[i]!.box, placements[j]!.box), 'two badges overlap');
    }
  }
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
  test(`battle-royale-20 damage badges: no badge-vs-badge overlap at match start (${label})`, () => {
    const percents = Array.from({ length: 20 }, (_, i) => (i * 37) % 180);
    const { candidates, bodyBoxes } = buildScene(vw, vh, percents);
    const placements = computeBadgePlacements(candidates, bodyBoxes, undefined, { width: vw, height: vh }, fakeMeasureText);
    assertNoBadgeOverlap(placements);
  });

  test(`battle-royale-20 damage badges: no other fighter's badge sits on the local player's body (${label})`, () => {
    const percents = Array.from({ length: 20 }, (_, i) => (i * 37) % 180);
    const { candidates, bodyBoxes } = buildScene(vw, vh, percents);
    const placements = computeBadgePlacements(candidates, bodyBoxes, undefined, { width: vw, height: vh }, fakeMeasureText);
    const localBody = bodyBoxes.find((b) => b.slot === 0);
    assert.ok(localBody);
    for (const p of placements) {
      if (p.candidate.isLocalPlayer) continue;
      assert.ok(!boxesOverlap(p.box, localBody!), `slot ${p.candidate.slot}'s badge overlaps the local player's body`);
    }
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
  const placements = computeBadgePlacements(candidates, [], undefined, undefined, fakeMeasureText);
  assert.equal(placements[0]?.hasPercent, false);
  assert.equal(placements[0]?.label, '1');
});

test('a badge is allowed to overlap a non-local fighter\'s body', () => {
  // The 2026-09-18 design call this file is named for: this is the
  // behaviour under test, not a defect. A badge whose only obstacle is
  // another fighter's (non-local) body must still be placed with its
  // damage numeral intact.
  const candidates: BadgeCandidate[] = [{ slot: 1, isLocalPlayer: false, headX: 100, headY: 100, percent: 55 }];
  const bodyBoxes: BodyBox[] = [{ slot: 5, left: 80, right: 120, top: 80, bottom: 140 }];
  const placements = computeBadgePlacements(candidates, bodyBoxes, undefined, undefined, fakeMeasureText);
  assert.equal(placements.length, 1);
  assert.equal(placements[0]!.hasPercent, true);
  assert.ok(boxesOverlap(placements[0]!.box, bodyBoxes[0]!), 'expected the badge to actually overlap the body in this setup');
});

// 2026-09-18: a live 20-fighter match measured on production showed only
// 9 of 20 badges visible a few seconds in, once fighters converge from
// their tidy two-row spawn into a real cluster. This pins the ladder
// against a deliberately tight cluster of fighter bodies.
test('a tight mid-match cluster still shows a damage numeral for essentially every fighter', () => {
  const vw = 1280;
  const vh = 720;
  const centerX = vw / 2;
  const centerY = vh / 2;
  const count = 20;
  const bodyHalfWidth = 10;
  const bodyHeight = 26;
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

  const placements = computeBadgePlacements(candidates, bodyBoxes, undefined, { width: vw, height: vh }, fakeMeasureText);
  const withDamage = placements.filter((p) => p.hasPercent).length;

  assertNoBadgeOverlap(placements);
  // 2026-09-18 part-4: the box widened to actually account for the drawn
  // stroke (see BADGE_STROKE_WIDTH_PX in badge-layout.ts) after a live
  // match showed badges genuinely overlapping into unreadable mush
  // ("Cinder 6:1910") despite this same test's old 85% assertion passing --
  // that number was only reachable by under-reserving space. A lower but
  // truthfully collision-free count is a real improvement over a higher
  // count that lies about being readable; the parent's own live sampling
  // of the pre-fix build got a median of 11/20 and some of those 11 were
  // garbled, so 11/20 *clean* is the number to beat, not a floor to regret.
  assert.ok(
    withDamage >= count * 0.5,
    `expected at least half of a tight cluster to show a clean damage numeral, got ${withDamage}/${count}`,
  );
  for (const p of placements) {
    assert.ok(p.box.left >= -0.01 && p.box.right <= vw + 0.01, 'badge box left the visible canvas horizontally');
    assert.ok(p.box.top >= -0.01 && p.box.bottom <= vh + 0.01, 'badge box left the visible canvas vertically');
  }
});

test('a fighter near the left edge of the canvas is clamped, not hidden behind the sidebar', () => {
  const view = { width: 1280, height: 720 };
  const candidates: BadgeCandidate[] = [{ slot: 0, isLocalPlayer: false, headX: 5, headY: 100, percent: 42 }];
  const placements = computeBadgePlacements(candidates, [], undefined, view, fakeMeasureText);
  assert.equal(placements.length, 1);
  assert.ok(placements[0]!.box.left >= 0, 'badge box left edge sits behind x=0, i.e. behind the sidebar');
});

test("bot names drop the world badge's redundant \"CPU \" prefix", () => {
  const candidates: BadgeCandidate[] = [{ slot: 0, isLocalPlayer: false, headX: 100, headY: 100, percent: 10 }];
  const placements = computeBadgePlacements(candidates, [], ['CPU Kestrel'], undefined, fakeMeasureText);
  assert.equal(placements[0]!.label, 'Kestrel 10%');
});

// Contrast: badges can now sit over any fighter's body colour. index.ts
// pairs a light fill with a dark stroke specifically so one of the two
// always separates from the background underneath. Measured against the
// lightest and darkest entries in PALETTE.playerColors, plus confirmed
// colour-independent (relative luminance only) so grayscale changes
// nothing.
test('badge text (light fill + dark stroke) contrasts against the lightest and darkest fighter body colours', () => {
  function luminance(hex: number): number {
    const r = (hex >> 16) & 255;
    const g = (hex >> 8) & 255;
    const b = hex & 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const bodyColors = [...PALETTE.playerColors].sort((a, b) => luminance(a) - luminance(b));
  const darkest = bodyColors[0]!;
  const lightest = bodyColors[bodyColors.length - 1]!;
  const fillLum = luminance(PALETTE.hud);
  const strokeLum = luminance(PALETTE.fighterOutline);
  const MIN_CONTRAST = 60; // out of 255, comfortably perceptible
  for (const body of [darkest, lightest]) {
    const bodyLum = luminance(body);
    const fillContrast = Math.abs(fillLum - bodyLum);
    const strokeContrast = Math.abs(strokeLum - bodyLum);
    assert.ok(
      fillContrast >= MIN_CONTRAST || strokeContrast >= MIN_CONTRAST,
      `neither badge fill nor stroke contrasts against body colour 0x${body.toString(16)} (fill diff ${fillContrast.toFixed(1)}, stroke diff ${strokeContrast.toFixed(1)})`,
    );
  }
  // Grayscale check: luminance-only contrast is exactly what filter:
  // grayscale(1) leaves behind (it does not touch relative luminance),
  // so the assertions above already are the grayscale case.
});

// 2026-09-18 part-4: the parent reported the local player's own world
// badge duplicating the exact same percent already guaranteed by the
// fixed corner readout, and being the widest label on screen right in
// the middle of the action for no benefit. The world badge now keeps
// the local player's name (helps find yourself) but never appends a
// percent suffix -- that job belongs to the corner readout alone.
test("the local player's world badge keeps its name but drops the percent (the corner readout already covers it)", () => {
  const candidates: BadgeCandidate[] = [
    { slot: 0, isLocalPlayer: true, headX: 200, headY: 200, percent: 87 },
    { slot: 1, isLocalPlayer: false, headX: 500, headY: 500, percent: 42 },
  ];
  const names = ['Sweeper', 'Cinder'];
  const placements = computeBadgePlacements(candidates, [], names, undefined, fakeMeasureText);
  const local = placements.find((p) => p.candidate.isLocalPlayer)!;
  const other = placements.find((p) => !p.candidate.isLocalPlayer)!;
  assert.ok(local.label.includes('Sweeper'), `expected local badge to keep its name, got "${local.label}"`);
  assert.ok(!local.label.includes('%'), `expected local world badge to drop the percent suffix, got "${local.label}"`);
  assert.equal(local.hasPercent, false);
  assert.ok(other.label.includes('%'), `expected a non-local badge to still show its percent, got "${other.label}"`);
});

// 2026-09-18, part 7. Live play on production showed nearly every badge
// drawn on a single row at the ground line, merging into unreadable mush,
// while the placement code believed it had staggered them apart. Cause:
// when a stagger offset resolved a collision the reserved box moved up a
// row, but the placement's y kept the un-staggered anchor, so the text
// was drawn back onto the crowded row it had just been bumped off. That
// is the fourth reserved-space-versus-drawn-space mismatch in this
// feature, so the test ties the two together: the box reserved for a
// placement must be the box its drawn y implies.
test('a staggered badge is drawn at the y of the box reserved for it', () => {
  const candidates: BadgeCandidate[] = [];
  for (let i = 0; i < 4; i++) {
    candidates.push({ slot: i, isLocalPlayer: false, headX: 400, headY: 300, percent: 25 + i });
  }
  const names = candidates.map((_, i) => `Fighter${i}`);
  const placements = computeBadgePlacements(candidates, [], names, { width: 1280, height: 720 }, fakeMeasureText);
  assert.ok(placements.length >= 2, 'expected at least two badges to survive a shared spot');
  const rows = new Set(placements.map((p) => p.y));
  assert.equal(rows.size, placements.length, 'badges sharing a spot must be drawn on distinct rows');
  // The reserved box sits a fixed gap above the drawn anchor, so that gap
  // must be identical for every placement. A staggered badge whose y was
  // left behind shows up here as a different gap.
  const gaps = new Set(placements.map((p) => p.box.bottom - p.y));
  assert.equal(gaps.size, 1, `reserved boxes and drawn positions disagree: gaps ${[...gaps].join(', ')}`);
});

// 2026-09-19: playing production I counted seven bare slot numerals in the
// arena with no percent sign. A naked "15" reads as a fighter ID, and it is
// no narrower than "15%", so the ladder must never spend its last rung on it
// when the damage figure is known.
test('no badge ever shows a bare slot number when its damage is known', () => {
  const candidates = Array.from({ length: 20 }, (_, i) => ({
    slot: i,
    headX: 300 + (i % 10) * 6,
    headY: 400 + Math.floor(i / 10) * 4,
    percent: 10 + i,
    isLocalPlayer: i === 0,
  }));
  const names = candidates.map((c) => `Fighter${c.slot + 1}`);
  const placements = computeBadgePlacements(
    candidates,
    [],
    names,
    { width: 1280, height: 720 },
    fakeMeasureText,
  );
  assert.ok(placements.length > 0);
  for (const p of placements) {
    if (p.candidate.isLocalPlayer) continue; // the local badge carries no percent by design
    assert.match(p.label, /%/, `badge "${p.label}" has no percent sign`);
  }
});

// 2026-09-19, playing production: my own badge read "Sweeper" with an
// unrelated "42%" sitting directly above it while my damage was 0%. A badge
// pushed off its own row has to say which fighter it belongs to.
test('a staggered badge gets a leader line back to its own head, a settled one does not', () => {
  const head = { x: 400, y: 440 };
  assert.equal(badgeLeaderLine(400, 436, head, 13), null, 'settled badge needs no line');
  const above = badgeLeaderLine(410, 410, head, 13);
  assert.ok(above, 'badge staggered above its row needs a line');
  assert.equal(above.toX, head.x);
  assert.ok(above.fromY > 410 && above.toY < head.y, 'line ends clear of glyphs and fighter');
  const below = badgeLeaderLine(410, 470, head, 13);
  assert.ok(below, 'badge staggered below its row needs a line');
  assert.ok(below.fromY < 470 && below.toY > head.y, 'line runs upward to the head');
});

// 2026-09-19, measured at 256 CSS px: the local damage percent, the biggest
// number on screen, was drawn under the touch movement stick -- i.e. under
// the player's left thumb on the platform 82% of real sessions use.
test('the local damage readout clears whatever covers the bottom-left corner', () => {
  const view = { width: 390, height: 844 };
  const base = computeLocalDamageReadout(46, view);
  assert.ok(base);
  setLocalReadoutBottomInset(120);
  const lifted = computeLocalDamageReadout(46, view);
  assert.ok(lifted);
  assert.equal(lifted.y, base.y - 120);
  assert.equal(lifted.x, base.x, 'it stays in the same column');
  setLocalReadoutBottomInset(0);
  assert.equal(computeLocalDamageReadout(46, view)?.y, base.y, 'hiding the controls puts it back');
});
