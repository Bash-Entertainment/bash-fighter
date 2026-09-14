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
//   4. The local player's own badge is always placed (never dropped),
//      matching the exemption documented on layoutBadges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBadgePlacements,
  computeLocalPointer,
  LOCAL_POINTER_GAP_PX,
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

function assertNoOverlaps(
  placements: ReturnType<typeof computeBadgePlacements>,
  bodyBoxes: readonly BodyBox[],
) {
  for (const p of placements) {
    for (const body of bodyBoxes) {
      if (body.slot === p.candidate.slot) continue;
      assert.equal(
        boxesOverlap(p.box, body),
        false,
        `slot ${p.candidate.slot}'s badge ("${p.label}") overlaps slot ${body.slot}'s body box`,
      );
    }
  }
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
  const placements = computeBadgePlacements(candidates, bodyBoxes, names);
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
  const placements = computeBadgePlacements(candidates, bodyBoxes, names);
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
  const placements = computeBadgePlacements(candidates, bodyBoxes, names);
  assertNoOverlaps(placements, bodyBoxes);
});

test('a too-wide name that would collide falls back to the numeric slot label', () => {
  // Two fighters close enough together that fighter 0's long real name
  // would overlap fighter 1's body box, but fighter 0's bare slot number
  // ("1") fits clear. The fallback in computeBadgePlacements must
  // actually engage: label degrades from the name to the number rather
  // than the badge being dropped or drawn over fighter 1's body.
  const bodyBoxes: BodyBox[] = [makeBodyBox(0, 500, 400), makeBodyBox(1, 545, 400)];
  const candidates: BadgeCandidate[] = [makeCandidate(0, 500, 400, false), makeCandidate(1, 545, 400, false)];
  const names = ['ExtremelyLongFighterNameThatWontFit', 'B'];
  const placements = computeBadgePlacements(candidates, bodyBoxes, names);
  assertNoOverlaps(placements, bodyBoxes);
  const slot0 = placements.find((p) => p.candidate.slot === 0);
  assert.ok(slot0, 'slot 0 should still get a badge (falls back to its number, not dropped)');
  assert.equal(slot0!.label, '1');
  assert.equal(slot0!.isNameLabel, false);
});

test('the local player badge is never dropped, even packed against neighbours', () => {
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
  const placements = computeBadgePlacements(candidates, bodyBoxes, names);
  const local = placements.find((p) => p.candidate.isLocalPlayer);
  assert.ok(local, 'local player badge must always be placed');
  assertNoOverlaps(placements, bodyBoxes);
});

test('the local player is exempt from being dropped even when truly packed, but still degrades to its number', () => {
  // A crowd so tight that even the shortest possible label for the
  // local player ("1") cannot clear a neighbour's body box. Documents
  // (rather than hides) the one deliberate exception in the algorithm:
  // the local player's own badge is the one identity cue this player
  // needs every frame, so unlike everyone else it is never dropped
  // outright -- but it still tries the name -> number fallback like
  // anyone else, rather than displaying an oversized name untouched.
  const bodyBoxes: BodyBox[] = [makeBodyBox(0, 400, 300), makeBodyBox(1, 415, 300)];
  const candidates: BadgeCandidate[] = [makeCandidate(0, 400, 300, true), makeCandidate(1, 415, 300, false)];
  const names = ['LocalPlayerVeryLongName', 'B'];
  const placements = computeBadgePlacements(candidates, bodyBoxes, names);
  const local = placements.find((p) => p.candidate.isLocalPlayer);
  assert.ok(local, 'local player badge must always be placed, even here');
  assert.equal(local!.label, '1', 'local player still degrades to the number fallback before being kept overlapping');
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
  const placements = computeBadgePlacements(candidates, bodyBoxes, names);
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
  const placements = computeBadgePlacements(candidates, bodyBoxes, names);
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
  const placements = computeBadgePlacements(candidates, bodyBoxes, names);
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
