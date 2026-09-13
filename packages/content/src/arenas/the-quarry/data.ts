// The Quarry: a single wide, unbroken ground floor (like Bash Colosseum
// and The Foundry -- no chasm, no chamber walls) topped with a symmetric
// four-tier stepped ziggurat rising toward one small central apex. Where
// Colosseum scatters its platforms loosely and Foundry hides ground
// level behind full walls, The Quarry's silhouette is a single
// unmistakable stacked pyramid seen from any zoom -- distinct from every
// shipped stage and legible at 20-fighter scale because the whole
// vertical structure is centred and symmetric rather than scattered.
// Every tier is a pass-through platform (see [[Surface and Collision
// Primitives: Pass-Through Platforms and Walls 2026-09-09]]), so a
// fighter can always bail straight down through the stack instead of
// only sideways -- deliberately avoiding Foundry's "must clear the wall
// top or go around" trap. The ground floor is one continuous solid slab
// spanning the whole stage, exactly like Colosseum and Foundry, so the
// collapsing ring's ground-derived safe extents (see [[Arena Shrink
// Rework: Ground-Derived Safe Extents 2026-09-09]]) always have solid
// footing to shrink toward -- there is no split floor or chasm for the
// endgame ring to strand survivors on either side of.
import * as fx from '../../../../sim/src/math/fixed.ts';
import type { ArenaData } from '../../../../sim/src/arena/types.ts';

export const THE_QUARRY_ARENA: ArenaData = {
  name: 'The Quarry',
  // Cool slate-blue-green, distinct from Colosseum's neutral grey,
  // Spire's violet, Undercroft's cold blue, Foundry's ember orange and
  // Atoll's sandy tan, and well clear of the orange/amber hazard band in
  // PALETTE (packages/render/src/palette.ts).
  accentColor: 0x4d7a72,
  platforms: [
    // One unbroken solid ground floor -- same span as Bash Colosseum's,
    // wide enough alone to hold all 20 spawns under the fully-shrunk
    // endgame rectangle with no chasm or wall to strand anyone.
    { minX: fx.fromInt(-480), maxX: fx.fromInt(480), y: fx.fromInt(0) },
    // Tier 1 (lowest step), symmetric pair, pass-through.
    { minX: fx.fromInt(-380), maxX: fx.fromInt(-220), y: fx.fromInt(70), kind: 'pass-through' },
    { minX: fx.fromInt(220), maxX: fx.fromInt(380), y: fx.fromInt(70), kind: 'pass-through' },
    // Tier 2, symmetric pair, pass-through -- set back from tier 1 so
    // climbing the ziggurat is a series of short hops, not one long walk.
    { minX: fx.fromInt(-260), maxX: fx.fromInt(-140), y: fx.fromInt(140), kind: 'pass-through' },
    { minX: fx.fromInt(140), maxX: fx.fromInt(260), y: fx.fromInt(140), kind: 'pass-through' },
    // Apex: one small king-of-the-hill perch, pass-through so it can
    // never be camped safely -- always escapable straight down.
    { minX: fx.fromInt(-60), maxX: fx.fromInt(60), y: fx.fromInt(210), kind: 'pass-through' },
  ],
  blastMinX: fx.fromInt(-600),
  blastMaxX: fx.fromInt(600),
  blastMinY: fx.fromInt(-260),
  blastMaxY: fx.fromInt(580),
  // 20 ground spawns using the same verified alternating-sides, outer-
  // edge-for-low-index formula as Bash Colosseum (same 480-unit ground
  // half-extent, same roster, so the same spacing clears the
  // spawn-clearance safety factors -- verified directly by
  // scripts/spawn-clearance-audit.mjs below rather than assumed).
  // Human seats always get the lowest fighter indices
  // (server/src/rooms.ts), so index 0/1 land at the outer edge of the
  // spread, the least crowded point on the floor at tick 0 -- see
  // "Bot Difficulty Correction and Human-Survival Fix 2026-09-10".
  spawnPoints: Array.from({ length: 20 }, (_, i) => {
    const slot = 9 - Math.floor(i / 2);
    const side = i % 2 === 0 ? 1 : -1;
    const x = side * fx.fromInt(34 + slot * 37);
    return { x, y: fx.fromInt(0) };
  }),
};
