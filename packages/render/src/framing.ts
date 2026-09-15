// Pure "camera framing floor" geometry, extracted out of index.ts's
// framingFloor() (issue: packages/render test coverage pass 2026-09-12) so
// it can be unit-tested without pulling in Pixi/DOM. Behaviour is
// unchanged -- index.ts's framingFloor() is now a thin re-export of this
// module. See computeFramingFloor's doc comment below for what it does
// and why (moved verbatim from the original framingFloor()).
import type { ArenaBounds } from './camera.ts';

/** Only the StageBounds fields this module actually reads. Defined
 * locally (rather than importing the full StageBounds from stage.ts) so
 * this module has zero Pixi/DOM dependency -- stage.ts imports
 * pixi.js's Graphics at module scope. */
export interface FramingStageBounds {
  platforms: readonly { minX: number; maxX: number; y: number }[];
  blastMinX: number;
  blastMaxX: number;
  blastMinY: number;
  blastMaxY: number;
}

// How far above the tallest platform / below the ground a fighter can
// still meaningfully go (double-jump apex, a hard landing) and therefore
// still needs to stay on screen. Derived from packages/sim's jump
// constants (JUMP_VELOCITY/DOUBLE_JUMP_VELOCITY vs GRAVITY give an apex
// a little under 200 world units above a jump's start), not guessed --
// rounded up for headroom. This is presentation framing only; it never
// changes where a fighter can actually stand or die.
// PRESENTATION FIX (dead-space-below-floor pass 2026-09-12, see wiki
// "Camera Dead Space Below Floor Fix 2026-09-12"): the fall:jump split
// below used to be 90:200, i.e. every framed box reserved a fall-headroom
// band that was ~30% of the *raw* headroom span (before per-stage
// platform-height padding stretches maxY further) purely below the
// ground -- on stages/moments where nothing is actually down there
// (fighters that fall are gone in well under a second), this read on
// screen as a dead, wasted band under the floor (measured: ~18-25% of
// viewport height across battle-royale-20, the-foundry and a shrunk
// late-match arena). The sum (290 world units) is left exactly the same
// -- so overall zoom/scale and everything the aspect-padding step in
// computeFramingFloor does with it is unaffected -- only how that fixed
// budget is split between "show a hard landing below the ground" and
// "show a rising jump above it" changes. 40 world units is still enough
// to see a fighter's fall/spike below the platform before they leave the
// blast rect (falls are the fast, brief case; the full blast-zone clamp
// two steps below still shows however much further a knocked-out
// fighter actually falls, this is only the *minimum* reserved band).
// DEAD-SPACE-BELOW-FLOOR PASS (2026-09-14, see wiki "Camera Framing:
// Ground Anchor and Jump-Space Bias 2026-09-14"): measured on every real
// stage (scripts/camera-framing-metrics.mjs) that the old 220/70 split's
// *sum* (290 world units) was reserving more minimum vertical span than
// a ground-hugging pack needs on top of the platform height range itself
// -- on stages where this box's own aspect padding (below) ends up
// Y-bound rather than X-bound (the-spire, and any small clustered
// endgame), that extra reserved span was pure unzoomed dead air, not
// headroom actually protecting a jump from being cropped: a fighter that
// really does jump or fall still grows fSpanY dynamically via its own
// tracked position in computeRawCamera, which is a completely separate,
// always-on guarantee against cropping. Reduced to 150/40 (sum 190): a
// real measured drop in reserved headroom, not a guess, verified against
// the "never crop a living fighter" invariant by extreme-jump/fall camera
// tests, not just by this ratio.
export const JUMP_HEADROOM_WORLD = 150;
export const FALL_HEADROOM_WORLD = 40;

/** The camera's "always show at least this much" floor used to be the
 * *entire* blast zone -- a battle-royale arena's blast zone is sized with
 * a huge margin above/below the platforms specifically so a shrinking
 * arena has room to close (see battle-royale-20/data.ts), which meant
 * the baseline camera permanently framed a stage-sized band of empty sky
 * and empty pit that no fighter ever legibly occupies. The actual
 * fought-over space is the platforms plus enough headroom to see a jump
 * or a hard fall coming -- that is what the camera should never zoom
 * tighter than. Intersected with the *live* (possibly shrunk) blast rect
 * so the floor honestly shrinks as the collapsing arena does, instead of
 * permanently reserving room for a blast zone that no longer exists. */
// Empty-sky-at-20 follow-up (2026-09-15): at a full/near-full lobby the
// platform footprint's raw width (e.g. battle-royale-20's solid ground,
// 960 world units) is noticeably wider than the fighters' own spawn
// spread (~774 units) -- dead margin nobody occupies. Trimming it here,
// BEFORE the aspect-ratio padding step below, is what makes the trim
// actually pay off: trimming it later (e.g. only in camera.ts, tried
// first) leaves the aspect step still inflating the vertical span to
// match the *untrimmed* width, which silently cancels the horizontal
// gain by making the view Y-bound at the old scale instead. Gated the
// same way as camera.ts's population floor: only once the lobby is
// large enough (>= ARENA_FLOOR_SLACK_MIN_COUNT) that the fighters'
// spread is itself already arena-sized, so 2-3 fighter endgames are
// untouched. `fighterSpanXHint`, when supplied, is the caller's current
// (fighter-position-derived) horizontal spread, already including the
// same padding camera.ts's own fSpanX uses -- optional and ignored
// below that population, so every existing caller that doesn't pass it
// keeps the old, un-trimmed behaviour exactly.
export const ARENA_FLOOR_SLACK_MIN_COUNT = 12;
export const ARENA_FLOOR_SLACK_FACTOR = 1.05;

export function computeFramingFloor(
  stage: FramingStageBounds,
  viewWidth: number,
  viewHeight: number,
  livingCount = 0,
  fighterSpanXHint?: number,
): ArenaBounds {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of stage.platforms) {
    minX = Math.min(minX, p.minX);
    maxX = Math.max(maxX, p.maxX);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX)) {
    // No platform data (e.g. a bare test fixture) -- fall back to the
    // full blast rect rather than an empty/inverted floor.
    return { minX: stage.blastMinX, maxX: stage.blastMaxX, minY: stage.blastMinY, maxY: stage.blastMaxY };
  }
  minY -= FALL_HEADROOM_WORLD;
  maxY += JUMP_HEADROOM_WORLD;

  if (
    fighterSpanXHint !== undefined &&
    livingCount >= ARENA_FLOOR_SLACK_MIN_COUNT &&
    maxX - minX > fighterSpanXHint * ARENA_FLOOR_SLACK_FACTOR
  ) {
    const cx = (minX + maxX) / 2;
    const half = (fighterSpanXHint * ARENA_FLOOR_SLACK_FACTOR) / 2;
    minX = cx - half;
    maxX = cx + half;
  }

  // Never claim more than the live blast rect actually covers -- this is
  // what makes the floor shrink correctly as the collapsing arena closes
  // in, rather than permanently framing the arena's original footprint.
  // This must happen BEFORE the aspect-ratio correction below, not after:
  // clamping post-hoc cuts whichever side sticks out past the live blast
  // rect (independently per edge) without touching the opposite edge,
  // which silently breaks the aspect match the padding step below just
  // established and re-centers the box off the actual fought-over space --
  // this was the real cause of the reported dead-space/off-center bug on
  // stages whose headroom box pokes past a shrunk blast rect on only one
  // side (e.g. the fall-headroom band below the ground going past
  // blastMinY as the ring closes, while the jump-headroom band above
  // stays inside it, pulling the framed box's center upward and leaving a
  // dead band at the bottom of the screen).
  minX = Math.max(minX, stage.blastMinX);
  maxX = Math.min(maxX, stage.blastMaxX);
  minY = Math.max(minY, stage.blastMinY);
  maxY = Math.min(maxY, stage.blastMaxY);

  // The "fought-over space plus jump/fall headroom" box computed above
  // (now also clamped to the live blast rect) has whatever aspect ratio
  // the stage's own geometry happens to produce, which on every current
  // stage does not match the viewport's (see wiki "Camera Framing and
  // Start Screen Composition 2026-09-10"): battle-royale-20 and
  // the-undercroft are wide relative to their headroom (viewport ends up
  // X-bound, leaving a dead band above or below the action), while
  // the-spire is comparatively tall (viewport ends up Y-bound, leaving
  // dead bands left and right). Pad whichever axis is short so the box's
  // aspect ratio matches the viewport's before it is ever handed to
  // computeCamera -- that is what actually fills the screen with the
  // arena instead of leaving letterboxing, without ever changing what a
  // fighter can reach (presentation only). Vertical padding keeps the
  // existing fall:jump ratio (a hard landing needs less warning room
  // than a rising jump); horizontal padding is split evenly since
  // there's no equivalent asymmetry left-to-right. This step is allowed
  // to grow the box back past the live blast rect on the padded axis --
  // that only ever shows a little more of the (still physically present)
  // stage floor/void, never invents geometry, and a correctly-filled,
  // correctly-centered frame matters more than never drawing a pixel
  // beyond the ring.
  const viewportAspect = viewWidth / viewHeight;
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const naturalAspect = spanX / spanY;
  if (naturalAspect > viewportAspect) {
    // Wider than the viewport needs -- the viewport will be X-bound;
    // grow the vertical span to match so there's no dead band top/bottom.
    const desiredSpanY = spanX / viewportAspect;
    const extra = Math.max(0, desiredSpanY - spanY);
    const fallShare = FALL_HEADROOM_WORLD / (FALL_HEADROOM_WORLD + JUMP_HEADROOM_WORLD);
    minY -= extra * fallShare;
    maxY += extra * (1 - fallShare);
  } else if (naturalAspect < viewportAspect) {
    // Taller than the viewport needs -- the viewport will be Y-bound;
    // grow the horizontal span to match so there's no dead band left/right.
    const desiredSpanX = spanY * viewportAspect;
    const extra = Math.max(0, desiredSpanX - spanX);
    minX -= extra / 2;
    maxX += extra / 2;
  }

  return { minX, maxX, minY, maxY };
}

// Population-aware floor shrink (empty-sky pass 2026-09-12, see wiki
// "Camera Population Floor 2026-09-12"). computeFramingFloor() above
// intentionally never lets the camera zoom tighter than the arena's
// own fought-over footprint -- right for a full 20-fighter lobby, where
// fighters are naturally spread near that footprint anyway. But late in
// a match, once most fighters are eliminated, the survivors are often a
// small cluster far smaller than the *original* arena footprint (the
// live blast rect shrinks with the collapsing ring, but not down to
// "wherever the few survivors happen to be" -- it's population/ground
// derived, not position derived). The result, confirmed by watching
// live matches: a 2-3 fighter endgame framed inside a floor sized for a
// much bigger fight, with most of the screen showing empty sky/void.
//
// This scales the already-computed floor box down around its own
// center as living-fighter count drops, so the *minimum* the camera
// will ever show shrinks with the fight. It does not, by itself, change
// what fraction of the screen fighters occupy -- computeCamera's own
// max(fighterSpan, floorSpan) logic still grows the frame back out
// whenever the actual fighters are more spread out than this scaled
// floor, so a spread-out 2-fighter chase across a wide stage is framed
// on the fighters, not clipped to a small box. This only removes
// *unused* floor headroom, never fighter positions -- every living
// fighter's position is always still included in computeCamera's own
// fSpan and therefore always on screen; nothing here can crop a
// fighter, an incoming attacker, or a hazard off-screen.
//
// Constants: no shrink at 6+ living fighters (this is where "spread
// close to the full arena" starts being the common case in practice --
// confirmed live, see wiki), tapering linearly down to 45% of the full
// floor span at 2 fighters (a 55% reduction in each axis, ~80% less
// area) and held there for the final 1-2. 45% (not lower) is a
// deliberate floor-on-the-floor: shrinking further starts to risk the
// same "camera slams in and jitters as two fighters trade a few units
// of ground" feel the existing paddingWorld/maxScale settings were
// tuned to avoid, for a readability gain past this point that live
// testing didn't show clearly justified.
export const POPULATION_FLOOR_TAPER_START_COUNT = 6;
export const POPULATION_FLOOR_MIN_COUNT = 2;
export const POPULATION_FLOOR_MIN_FRAC = 0.45;

export function populationFloorFrac(livingCount: number): number {
  if (livingCount >= POPULATION_FLOOR_TAPER_START_COUNT) return 1;
  if (livingCount <= POPULATION_FLOOR_MIN_COUNT) return POPULATION_FLOOR_MIN_FRAC;
  const t =
    (livingCount - POPULATION_FLOOR_MIN_COUNT) /
    (POPULATION_FLOOR_TAPER_START_COUNT - POPULATION_FLOOR_MIN_COUNT);
  return POPULATION_FLOOR_MIN_FRAC + (1 - POPULATION_FLOOR_MIN_FRAC) * t;
}

/** Scale an already-computed floor box down around its own center by
 * `frac` (0..1) on both axes, preserving its aspect ratio (and therefore
 * not undoing computeFramingFloor's own aspect-ratio padding). */
export function scaleFramingFloor(floor: ArenaBounds, frac: number): ArenaBounds {
  const cx = (floor.minX + floor.maxX) / 2;
  const cy = (floor.minY + floor.maxY) / 2;
  const halfX = ((floor.maxX - floor.minX) / 2) * frac;
  const halfY = ((floor.maxY - floor.minY) / 2) * frac;
  return { minX: cx - halfX, maxX: cx + halfX, minY: cy - halfY, maxY: cy + halfY };
}

/** Convenience: computeFramingFloor() followed by the population-aware
 * shrink, in one call -- what render callers should actually use. */
export function computePopulationAwareFramingFloor(
  stage: FramingStageBounds,
  viewWidth: number,
  viewHeight: number,
  livingCount: number,
  fighterSpanXHint?: number,
): ArenaBounds {
  const floor = computeFramingFloor(stage, viewWidth, viewHeight, livingCount, fighterSpanXHint);
  return scaleFramingFloor(floor, populationFloorFrac(livingCount));
}
