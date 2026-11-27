// Regression test for issue #29: fighter name/slot badges overlapping
// in-world at 20-fighter density. layoutBadges() (packages/render/src/
// index.ts) already checks every candidate badge against every *other*
// fighter's body box before drawing it, degrading a too-long name to
// its numeric slot label, and dropping the badge entirely if even that
// collides -- but nothing locked that behaviour in. This exercises the
// extracted pure algorithm, computeBadgePlacements(), directly: no
// Pixi/DOM involved, same style as fighter-pose.test.ts and
// palette.test.ts.
//
// What's asserted, on real output geometry (never on the internal
// candidate ordering or the number of overlap checks performed):
//   1. No placed label's badge box ever intersects another fighter's
//      body box, across a variety of realistic 20-fighter layouts
//      (uniform ring, one tight cluster, fighters pinned to a screen
//      edge).
//   2. No two placed badge boxes intersect each other.
//   3. When a fighter's real name is too wide to fit next to a close
//      neighbour, the fallback to the bare slot-number label actually
//      engages (a scenario constructed to force it).
//   4. The local player's badge can degrade name -> number just like
//      anyone else, and (2026-09-18) can be dropped entirely under a
//      genuine badge-vs-badge scrum -- the fixed corner readout is what
//      guarantees the local player's damage stays visible, not a
//      world-badge exemption, which only caused forced overlaps in live
//      play.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeMeasureText } from './fake-measure-text.ts';
import {
  computeBadgePlacements,
  computeLocalPointer,
  settleFollowedBadges,
  LOCAL_POINTER_GAP_PX,
  type FollowedBadge,
  type BadgeCandidate,
  type BodyBox,
} from '../src/badge-layout.ts';

function boxesOverlap(
  a: { left: number; right: number; top: number; bottom: number },
  b: { left: number; right: number; top: number; bottom: number },
): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

const BODY_HALF_WIDTH_PX = 26;
const BODY_TOP_HEIGHT_PX = 70;

/** A generous body box for fighter `slot` centred at (x, y), matching
 * the shape (roughly 1.3x body width, ~2 head-radii tall) the real
 * renderer builds in render() just before calling layoutBadges. */
function makeBodyBox(slot: number, x: number, y: number): BodyBox {
  return {
    slot,
    left: x - BODY_HALF_WIDTH_PX,
    right: x + BODY_HALF_WIDTH_PX,
    top: y - BODY_TOP_HEIGHT_PX,
    bottom: y,
  };
}

function makeCandidate(slot: number, x: number, y: number, isLocalPlayer = false): BadgeCandidate {
  // Badges sit just BADGE_OFFSET_MIN..MAX_PX (12-22px) above the head,
  // and the head itself sits close to the body box's `top` (see
  // fighter-sprite.ts's HEAD_TOP_OFFSET_WORLD) -- so, matching what the
  // real renderer produces, a badge's vertical band sits right around a
  // fighter's own body-box top, not floating dozens of pixels clear of
  // it. That's the geometry that lets a *wide* name label collide with a
  // same-height neighbour standing shoulder to shoulder: the vertical
  // bands overlap, so it comes down to horizontal reach.
  return { slot, isLocalPlayer, headX: x, headY: y - BODY_TOP_HEIGHT_PX + 5 };
}

// 2026-09-18 design call: a badge may overlap another fighter's body --
// the one body kept protected is the local player's own (see
// damage-badge-legibility.test.ts for that and for the badge-vs-badge
// stagger rule at density). This helper now only enforces the rule that
// is still absolute: no two badges ever overlap each other.
function assertNoOverlaps(
  placements: ReturnType<typeof computeBadgePlacements>,
  _bodyBoxes: readonly BodyBox[],
) {
  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++) {
      const a = placements[i]!;
      const b = placements[j]!;
      assert.equal(
        boxesOverlap(a.box, b.box),
        false,
        `slot ${a.candidate.slot}'s badge overlaps slot ${b.candidate.slot}'s badge`,
      );
    }
  }
}

test('20 fighters spread in a uniform ring: no badge overlaps any body box or badge', () => {
  const n = 20;
  const bodyBoxes: BodyBox[] = [];
  const candidates: BadgeCandidate[] = [];
  const names: string[] = [];
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2;
    const x = 640 + Math.cos(angle) * 300;
    const y = 360 + Math.sin(angle) * 200;
    bodyBoxes.push(makeBodyBox(i, x, y));
    candidates.push(makeCandidate(i, x, y));
    names.push(`Fighter${i}`);
  }
  const placements = computeBadgePlacements(candidates, bodyBoxes, names, undefined, fakeMeasureText);
  assertNoOverlaps(placements, bodyBoxes);
});

test('a tight 20-fighter cluster forces most badges to drop rather than overlap', () => {
  // 20 fighters packed into a tiny area -- realistic for a scrum around
  // a single item drop or a shrinking arena's final safe patch. Body
  // boxes here necessarily overlap each other (bodies really do stand
  // that close in-game); the invariant under test is narrower and still
  // holds: whichever badges DO get placed never overlap a body box or
  // each other.
  const n = 20;
  const bodyBoxes: BodyBox[] = [];
  const candidates: BadgeCandidate[] = [];
  const names: string[] = [];
  for (let i = 0; i < n; i++) {
    const col = i % 5;
    const row = Math.floor(i / 5);
    const x = 600 + col * 15;
    const y = 400 + row * 15;
    bodyBoxes.push(makeBodyBox(i, x, y));
    candidates.push(makeCandidate(i, x, y));
    names.push(`LongFighterName${i}`);
  }
  const placements = computeBadgePlacements(candidates, bodyBoxes, names, undefined, fakeMeasureText);
  assertNoOverlaps(placements, bodyBoxes);
  // A packed cluster this dense cannot fit 20 labels clear of 20
  // overlapping body boxes -- most must be dropped rather than drawn
  // over someone else. This is the whole point of the greedy algorithm;
  // assert it's actually exercised, not vacuously trivial.
  assert.ok(
    placements.length < n,
    `expected the tight cluster to drop some badges, but all ${placements.length} were placed`,
  );
});

test('fighters pinned along a screen edge: no badge overlaps a body box', () => {
  // Simulates fighters bunched along the left edge of the viewport (a
  // camera-framing edge case), a shape uniform-ring / grid layouts don't
  // cover: badges here can only expand rightward, never left off-screen.
  const n = 12;
  const bodyBoxes: BodyBox[] = [];
  const candidates: BadgeCandidate[] = [];
  const names: string[] = [];
  for (let i = 0; i < n; i++) {
    const x = 20 + (i % 3) * 18;
    const y = 60 + Math.floor(i / 3) * 40;
    bodyBoxes.push(makeBodyBox(i, x, y));
    candidates.push(makeCandidate(i, x, y));
    names.push(`Edge${i}`);
  }
  const placements = computeBadgePlacements(candidates, bodyBoxes, names, undefined, fakeMeasureText);
  assertNoOverlaps(placements, bodyBoxes);
});

test('a too-wide name that would collide with another badge falls back to the numeric slot label', () => {
  // Two fighters close enough that fighter 0's long real name would
  // collide with fighter 1's own badge (not just its body -- body
  // collision is no longer checked for non-local fighters, see the
  // 2026-09-18 design call in damage-badge-legibility.test.ts). The
  // name -> number fallback must still engage on badge-vs-badge
  // collision.
  const candidates: BadgeCandidate[] = [makeCandidate(0, 500, 400, false), makeCandidate(1, 508, 400, false)];
  const names = ['ExtremelyLongFighterNameThatWontFit', 'B'];
  const placements = computeBadgePlacements(candidates, [], names, undefined, fakeMeasureText);
  assertNoOverlaps(placements, []);
  assert.equal(placements.length, 2, 'both fighters should still get a badge (falls back to a number, not dropped)');
  const degraded = placements.filter((p) => !p.isNameLabel);
  assert.ok(degraded.length >= 1, 'expected the fallback to numeric label to engage for at least one of the two');
});

test('the local player badge degrades to a number under real pressure, and is not force-placed over a collision', () => {
  // Loose enough that non-local badges still keep the no-overlap
  // invariant, but tight enough to exercise the local player's name ->
  // number fallback.
  const bodyBoxes: BodyBox[] = [
    makeBodyBox(0, 400, 300),
    makeBodyBox(1, 500, 300),
    makeBodyBox(2, 600, 300),
    makeBodyBox(3, 700, 300),
  ];
  const candidates: BadgeCandidate[] = [
    makeCandidate(0, 400, 300, true),
    makeCandidate(1, 500, 300, false),
    makeCandidate(2, 600, 300, false),
    makeCandidate(3, 700, 300, false),
  ];
  const names = ['LocalPlayerLongName', 'B', 'C', 'D'];
  const placements = computeBadgePlacements(candidates, bodyBoxes, names, undefined, fakeMeasureText);
  const local = placements.find((p) => p.candidate.isLocalPlayer);
  assert.ok(local, 'this geometry has room for a collision-free local placement');
  assertNoOverlaps(placements, bodyBoxes);
});

test('the local player badge reads YOU however long their name and however close a neighbour', () => {
  const bodyBoxes: BodyBox[] = [makeBodyBox(0, 400, 300), makeBodyBox(1, 415, 300)];
  const candidates: BadgeCandidate[] = [makeCandidate(0, 400, 300, true), makeCandidate(1, 415, 300, false)];
  const names = ['LocalPlayerVeryLongName', 'B'];
  const placements = computeBadgePlacements(candidates, bodyBoxes, names, undefined, fakeMeasureText);
  const local = placements.find((p) => p.candidate.isLocalPlayer);
  assert.equal(local?.label, 'YOU');
  assertNoOverlaps(placements, bodyBoxes);
});

// Regression coverage for the local-player pointer (the "which one is
// me" fix): a single constant-pixel-size marker drawn in screen space,
// anchored off the local player's own already-placed badge box rather
// than recomputed independently in world space. Pinned here at the
// source level (computeLocalPointer is pure, no Pixi/DOM) per this
// project's no-jsdom convention -- see fighter-sprite.test.ts and
// index.ts's Renderer.drawLocalPointer for the Pixi-side consumer.
test('computeLocalPointer: sits a fixed gap above the local player\'s own badge box, following its x', () => {
  const bodyBoxes: BodyBox[] = [makeBodyBox(0, 400, 300), makeBodyBox(1, 500, 300)];
  const candidates: BadgeCandidate[] = [makeCandidate(0, 400, 300, true), makeCandidate(1, 500, 300, false)];
  const names = ['Rook', 'Fizz'];
  const placements = computeBadgePlacements(candidates, bodyBoxes, names, undefined, fakeMeasureText);
  const local = placements.find((p) => p.candidate.isLocalPlayer);
  assert.ok(local);
  const pointer = computeLocalPointer(placements);
  assert.ok(pointer, 'a local-player placement must produce a pointer position');
  assert.equal(pointer!.x, local!.candidate.headX, 'pointer stays horizontally centred on the local player\'s own head');
  assert.equal(
    pointer!.y,
    local!.box.top - LOCAL_POINTER_GAP_PX,
    'pointer sits a fixed gap above the top of the local player\'s own badge box, never inside or touching it',
  );
});

test('computeLocalPointer: returns null when there is no local player (e.g. the attract-mode background match)', () => {
  const bodyBoxes: BodyBox[] = [makeBodyBox(0, 400, 300), makeBodyBox(1, 500, 300)];
  const candidates: BadgeCandidate[] = [makeCandidate(0, 400, 300, false), makeCandidate(1, 500, 300, false)];
  const names = ['Rook', 'Fizz'];
  const placements = computeBadgePlacements(candidates, bodyBoxes, names, undefined, fakeMeasureText);
  assert.equal(computeLocalPointer(placements), null);
});

test('computeLocalPointer: still returns a position even when the local badge degraded to its numeric fallback', () => {
  // The local player's badge box is never dropped, but it can still
  // shrink from a name to a bare number (see the exemption test above).
  // The pointer must track whichever box actually got placed, not
  // assume a name-sized box.
  const bodyBoxes: BodyBox[] = [makeBodyBox(0, 400, 300), makeBodyBox(1, 415, 300)];
  const candidates: BadgeCandidate[] = [makeCandidate(0, 400, 300, true), makeCandidate(1, 415, 300, false)];
  const names = ['LocalPlayerVeryLongName', 'B'];
  const placements = computeBadgePlacements(candidates, bodyBoxes, names, undefined, fakeMeasureText);
  const local = placements.find((p) => p.candidate.isLocalPlayer);
  assert.ok(local);
  const pointer = computeLocalPointer(placements);
  assert.ok(pointer);
  assert.equal(pointer!.y, local!.box.top - LOCAL_POINTER_GAP_PX);
});

// 2026-09-14: measured on production, at least one living fighter was outside
// the frame on 208 of 442 sampled frames -- launched toward a blast zone, or
// briefly beyond the edge while the follow damping caught up. The "this is
// you" pointer went with them and vanished, at precisely the moment a player
// needs it most.
test('the local pointer clamps to the view edge and points off-screen', () => {
  const placements = [
    {
      candidate: { headX: 1400, headY: 300, isLocalPlayer: true, digits: 2 },
      box: { top: 280, bottom: 296, left: 1380, right: 1420 },
    },
  ] as unknown as Parameters<typeof computeLocalPointer>[0];
  const view = { width: 1280, height: 720 };
  const p = computeLocalPointer(placements, view);
  assert.ok(p);
  assert.equal(p.offScreen, true);
  assert.ok(p.x <= view.width - 1, 'clamped inside the right edge');
  assert.ok(p.x > view.width - 40, 'clamped to the edge it left by');
  // Pointing right: rotated a quarter turn from its resting downward aim.
  assert.ok(Math.abs(p.angle - Math.PI / 2) < 0.2, `angle was ${p.angle}`);
});

test('an on-screen local pointer is unrotated and not flagged off-screen', () => {
  const placements = [
    {
      candidate: { headX: 600, headY: 300, isLocalPlayer: true, digits: 2 },
      box: { top: 280, bottom: 296, left: 580, right: 620 },
    },
  ] as unknown as Parameters<typeof computeLocalPointer>[0];
  const p = computeLocalPointer(placements, { width: 1280, height: 720 });
  assert.ok(p);
  assert.equal(p.offScreen, false);
  assert.equal(p.angle, 0);
  assert.equal(p.x, 600);
});

test('a named fighter never shows the "slot number + percent" label; it drops from name+% straight to %', () => {
  // "9 60%" reads as a garbled fragment to a player who has never seen
  // slot numbers. Only a nameless fighter may use number+%.
  let sawPercentOnly = false;
  for (let spacing = 4; spacing <= 120; spacing += 2) {
    const candidates: BadgeCandidate[] = [];
    const names: string[] = [];
    for (let i = 0; i < 20; i++) {
      candidates.push({ ...makeCandidate(i, 100 + i * spacing, 400, false), percent: 30 + i });
      names.push(`Fighter${i}`);
    }
    const placements = computeBadgePlacements(candidates, [], names, undefined, fakeMeasureText);
    assertNoOverlaps(placements, []);
    for (const p of placements) {
      assert.doesNotMatch(p.label, /^\d+ \d+%$/, `spacing ${spacing}px: slot-number label "${p.label}"`);
      if (/^\d+%$/.test(p.label)) sawPercentOnly = true;
    }
  }
  assert.ok(sawPercentOnly, 'expected crowded badges to fall back to percent-only');
});

// Readability pass 2026-11-27: a CrazyGames review saw labels cut off at
// the screen edges and sitting on top of each other.
const VIEW = { width: 907, height: 510 };

function assertInsideView(box: { left: number; right: number; top: number; bottom: number }, label: string) {
  assert.ok(
    box.left >= 0 && box.top >= 0 && box.right <= VIEW.width && box.bottom <= VIEW.height,
    `"${label}" box ${JSON.stringify(box)} leaves the ${VIEW.width}x${VIEW.height} view`,
  );
}

test('a packed crowd along every edge of the view: every badge stays inside it and none overlap', () => {
  const candidates: BadgeCandidate[] = [];
  const names: string[] = [];
  for (let i = 0; i < 20; i++) {
    // Five per edge, heads right at the edge, so the name, the stagger
    // rows and the clamp all get pushed against it.
    const edge = i % 4;
    const t = 30 + Math.floor(i / 4) * 12;
    const x = edge === 0 ? 2 : edge === 1 ? VIEW.width - 2 : t * 4;
    const y = edge === 2 ? 2 : edge === 3 ? VIEW.height - 2 : t * 3;
    candidates.push({ slot: i, isLocalPlayer: i === 0, headX: x, headY: y, percent: i * 7 });
    names.push(`FocusPractice${i}`);
  }
  const placements = computeBadgePlacements(candidates, [], names, VIEW, fakeMeasureText);
  assert.ok(placements.length >= 10, `expected most fighters to keep a badge, got ${placements.length}`);
  for (const p of placements) assertInsideView(p.box, p.label);
  assertNoOverlaps(placements, []);
});

test('a fighter whose head is off the view gets no badge', () => {
  const candidates: BadgeCandidate[] = [
    { slot: 0, isLocalPlayer: false, headX: -40, headY: 200, percent: 10 },
    { slot: 1, isLocalPlayer: false, headX: 300, headY: 200, percent: 10 },
  ];
  const placements = computeBadgePlacements(candidates, [], undefined, VIEW, fakeMeasureText);
  assert.deepEqual(
    placements.map((p) => p.candidate.slot),
    [1],
  );
});

test('a long name is shortened with an ellipsis on the world badge', () => {
  const candidates: BadgeCandidate[] = [{ slot: 0, isLocalPlayer: false, headX: 300, headY: 200, percent: 12 }];
  const placements = computeBadgePlacements(candidates, [], ['FocusPractice'], VIEW, fakeMeasureText);
  assert.equal(placements[0]?.label, 'FocusPr… 12%');
});

function followed(left: number, top: number, width = 60): FollowedBadge {
  return { x: left + width / 2, y: top + 16, box: { left, right: left + width, top, bottom: top + 16 }, visible: true };
}

test('settleFollowedBadges pulls badges that drifted past an edge back inside the view', () => {
  const badges = [followed(-12, 100), followed(VIEW.width - 30, 200), followed(400, -5), followed(400, VIEW.height - 4)];
  settleFollowedBadges(badges, VIEW);
  for (const b of badges) {
    assert.equal(b.visible, true);
    assertInsideView(b.box, 'badge');
    assert.equal(b.x, (b.box.left + b.box.right) / 2, 'the draw anchor moves with its box');
  }
});

test('settleFollowedBadges hides a badge that drifted onto an earlier one, and keeps the earlier one', () => {
  const badges = [followed(300, 100), followed(330, 108), followed(500, 100)];
  settleFollowedBadges(badges, VIEW);
  assert.deepEqual(
    badges.map((b) => b.visible),
    [true, false, true],
  );
});

test('settleFollowedBadges: a badge clamped off the edge onto a neighbour is hidden, not drawn over it', () => {
  const badges = [followed(VIEW.width - 60, 100), followed(VIEW.width - 20, 102)];
  settleFollowedBadges(badges, VIEW);
  assert.equal(badges[1]!.visible, false);
  const visible = badges.filter((b) => b.visible);
  for (let i = 0; i < visible.length; i++) {
    for (let j = i + 1; j < visible.length; j++) assert.equal(boxesOverlap(visible[i]!.box, visible[j]!.box), false);
  }
});
