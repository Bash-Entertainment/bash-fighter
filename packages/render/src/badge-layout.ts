// Pure fighter name/slot badge placement geometry, kept dependency-free
// (no Pixi, no DOM) so it can be unit-tested directly -- see
// test/badge-layout.test.ts (issue #29: badges overlapping in-world).
// index.ts's Renderer.layoutBadges is a thin wrapper around
// computeBadgePlacements() below that hands the result to its pooled
// Pixi Text objects.

export interface BadgeCandidate {
  slot: number;
  isLocalPlayer: boolean;
  headX: number;
  headY: number;
  /** Rounded damage percent (0-999), or undefined when this candidate
   * carries no damage-readout upgrade (e.g. attract mode ghosts). See
   * computeBadgePlacements' doc comment for how this is folded into the
   * label with its own fallback tier, on top of the existing name/number
   * fallback -- damage readability (the 2026-09-17 player report "had no
   * idea how much hp anybody had") must never be the reason a badge is
   * dropped or overlaps a neighbour. */
  percent?: number;
}

/** Screen-space box a fighter's own body+head occupies, used so a name
 * badge dropped above one fighter can be checked against every *other*
 * fighter's actual silhouette too, not just against other badges. A
 * bunched-up crowd routinely has fighters standing closer together than
 * a name label is wide, so a label placed with no other badge nearby
 * could still visually sit on top of a neighbour's sprite -- the
 * badge-vs-badge check alone never saw that collision. */
export interface BodyBox {
  slot: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface BadgeBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function boxesOverlap(a: BadgeBox, b: BadgeBox): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export interface BadgePlacement {
  candidate: BadgeCandidate;
  label: string;
  box: BadgeBox;
  /** Draw anchor -- equal to candidate.headX/headY unless clampBoxToView
   * had to slide the box back onto the visible canvas, in which case
   * this is the shifted position and `box` matches it. Renderers must
   * draw at (x, y), never at candidate.headX/headY directly. */
  x: number;
  y: number;
  isNameLabel: boolean;
  /** True when `label` ends with the damage-percent suffix -- i.e. the
   * richer tier was reachable without colliding with anything. Lets the
   * renderer know whether it actually got to show damage this frame, and
   * drive the danger-colour threshold from the same percent value it
   * already had rather than re-deriving it from the label string. */
  hasPercent: boolean;
  /** Rounded percent for colour purposes only when hasPercent is true;
   * mirrors candidate.percent. */
  percent?: number;
}

/** Pure placement algorithm, extracted from Renderer.layoutBadges so it
 * can be exercised without Pixi/DOM (issue #29): given this frame's
 * badge candidates and every fighter's body box, decide which badges get
 * placed, in what order, with which label (name vs numeric fallback),
 * and where -- without touching any Pixi Text object. Renderer.layoutBadges
 * is now a thin wrapper that hands the result to the Text pool. See the
 * doc comment on layoutBadges (and on BodyBox above) for *why* this
 * exists: a name label must never visually collide with another
 * fighter's badge OR body sprite, and degrades to the shorter slot
 * number, then to nothing, rather than overlap. */
export function computeBadgePlacements(
  candidates: readonly BadgeCandidate[],
  bodyBoxes: readonly BodyBox[],
  names: readonly string[] | undefined,
  view?: { width: number; height: number },
): BadgePlacement[] {
  const local = candidates.find((c) => c.isLocalPlayer);
  const ordered = [...candidates].sort((a, b) => {
    if (a.isLocalPlayer !== b.isLocalPlayer) return a.isLocalPlayer ? -1 : 1;
    const da = local ? Math.hypot(a.headX - local.headX, a.headY - local.headY) : 0;
    const db = local ? Math.hypot(b.headX - local.headX, b.headY - local.headY) : 0;
    return da - db;
  });

  // 2026-09-18 design call: a badge is allowed to overlap another
  // fighter's body. A number drawn over a distant shoulder costs almost
  // nothing (the silhouette underneath is still a distinct shape), while
  // dropping the badge to avoid that overlap costs the player exactly
  // the information they said they were missing -- see the mid-match
  // measurement in damage-badge-legibility.test.ts that this replaced.
  // The one body that stays protected is the local player's own: no
  // other fighter's badge may sit on it or on the local pointer above it
  // (finding yourself in a crowd of twenty was itself a fixed player
  // complaint -- see computeLocalPointer). Badge-vs-badge collision is
  // still checked for everyone, because two numerals on top of each
  // other really is unreadable.
  const localBody = local ? bodyBoxes.find((b) => b.slot === local.slot) : undefined;
  const localExclusionZone: BadgeBox | undefined = localBody
    ? { left: localBody.left, right: localBody.right, top: localBody.top - LOCAL_EXCLUSION_MARGIN_PX, bottom: localBody.bottom }
    : undefined;
  const placedBoxes: BadgeBox[] = [];
  const placements: BadgePlacement[] = [];
  for (const c of ordered) {
    const numberLabel = String(c.slot + 1);
    // Only the local player's own body/pointer area is a collision
    // target now; everyone else's badge is free to overlap any other
    // fighter's body (but never the local player's).
    const bodyGuard: BadgeBox[] = !c.isLocalPlayer && localExclusionZone ? [localExclusionZone] : [];
    // Prefer the chosen name over the bare slot number -- it's what
    // makes a fighter "Rook" instead of "#7" at a glance -- but a name
    // is longer and more likely to collide with a neighbour at
    // 20-fighter density. Try the name's box first; if it would
    // overlap another badge OR another fighter's own sprite, retry
    // with the shorter numeric label before giving up on this badge
    // entirely, so a name that merely doesn't fit still degrades to
    // the number rather than vanishing or drawing over someone else.
    // The local player's own badge is exempt from being dropped
    // outright -- it is the one identity cue this player actually needs
    // every frame -- but it still goes through the same name-vs-number
    // fallback as everyone else: a local name too wide to fit degrades
    // to the local player's own number rather than being drawn on top of
    // a neighbour at full width forever (checking this fallback only
    // decided whether to *place* a badge, never whether to keep it once
    // placed, so it costs the local player nothing to run it too).
    const rawName = names?.[c.slot];
    // World badges drop the "CPU " prefix bots carry in their full name
    // (packages/sim/src/ai/bot.ts's nameFor): the sidebar chip grid
    // already marks bots separately (see hud-text.ts's chipDisplayName,
    // which does the same strip for the same reason), and in the world
    // those four characters are exactly the width the damage numeral
    // needs to survive a mid-match cluster.
    const name = rawName?.startsWith('CPU ') ? rawName.slice(4) : rawName;
    const nameLabel = name && name.length > 0 ? name : undefined;
    // The local player already has a guaranteed, always-visible damage
    // number in the fixed corner readout (computeLocalDamageReadout).
    // Repeating it on the world badge over their own fighter -- the
    // single widest label on screen, sitting right where the action is
    // -- duplicates information without adding any, so the world badge
    // keeps just the name/number that helps a player find themselves.
    const pct = !c.isLocalPlayer && c.percent !== undefined ? Math.max(0, Math.round(c.percent)) : undefined;
    const pctSuffix = pct !== undefined ? ` ${pct}%` : '';
    const pctOnly = pct !== undefined ? `${pct}%` : undefined;

    // Damage readability tiers, richest first, but with the damage
    // numeral itself as the most durable element rather than the first
    // casualty (2026-09-18 live-match measurement: nine of twenty badges
    // visible mid-match, because the old ladder dropped straight from
    // "name+%" to "number+%" to "name" to "number" to nothing -- the same
    // width budget kept getting spent on identity, which a real cluster
    // usually cannot afford, instead of on the two-or-three-character
    // percent a cluster almost always can). Order: name+%, number+%,
    // percent alone (very little width, should fit even in a tight
    // cluster), then -- and only then -- identity with no percent at
    // all, and the bare number as the absolute last non-empty rung.
    const tiers: { label: string; hasPercent: boolean }[] = [];
    if (nameLabel) tiers.push({ label: nameLabel + pctSuffix, hasPercent: pct !== undefined });
    tiers.push({ label: numberLabel + pctSuffix, hasPercent: pct !== undefined });
    if (pctOnly) tiers.push({ label: pctOnly, hasPercent: true });
    if (nameLabel) tiers.push({ label: nameLabel, hasPercent: false });
    tiers.push({ label: numberLabel, hasPercent: false });

    // Clamp the anchor itself, before any tier/collision math, using the
    // widest tier this candidate could possibly draw -- every narrower
    // tier then automatically fits inside the same clamped anchor. This
    // must happen before collision checks, not after (clamping only the
    // final chosen box, once collision-free, could shift it straight
    // into a neighbour that was placed assuming the pre-clamp position:
    // exactly the class of reserved-space-vs-drawn-space bug this
    // feature has hit twice already).
    let anchorX = c.headX;
    let anchorY = c.headY;
    if (view) {
      const widest = tiers[0] as { label: string; hasPercent: boolean };
      const worstCaseBox = badgeBox(c.headX, c.headY, widest.label.length, c.isLocalPlayer, widest.hasPercent);
      const anchorClamp = clampBoxToView(worstCaseBox, view);
      anchorX = c.headX + anchorClamp.dx;
      anchorY = c.headY + anchorClamp.dy;
    }

    let chosen = tiers[0] as { label: string; hasPercent: boolean };
    let box = badgeBox(anchorX, anchorY, chosen.label.length, c.isLocalPlayer, chosen.hasPercent);
    let collides = placedBoxes.some((p) => boxesOverlap(p, box)) || bodyGuard.some((b) => boxesOverlap(b, box));
    let tierIndex = 0;
    while (collides && tierIndex < tiers.length - 1) {
      tierIndex += 1;
      chosen = tiers[tierIndex] as { label: string; hasPercent: boolean };
      box = badgeBox(anchorX, anchorY, chosen.label.length, c.isLocalPlayer, chosen.hasPercent);
      collides = placedBoxes.some((p) => boxesOverlap(p, box)) || bodyGuard.some((b) => boxesOverlap(b, box));
    }
    // Even the percent-only rung can collide in a truly packed cluster.
    // Before dropping the badge entirely (or, for the local player, who
    // is exempt from being dropped, before drawing it wherever it lands),
    // try stacking it one row higher -- the way nameplates stack in many
    // other games -- and only fall further if that still collides.
    if (collides) {
      // Try a small ladder of stagger offsets -- one row up (the common
      // case: a badge's own row is crowded but the row above it, over a
      // neighbour's head, is clear), then one row down, then two rows up
      // -- before giving up. A real cluster is a blob, not a symmetric
      // ring, so in practice one offset is almost always enough; trying a
      // few costs nothing and rescues the cases a single offset cannot.
      for (const offset of STAGGER_OFFSETS) {
        const staggered = badgeBox(anchorX, anchorY + offset, chosen.label.length, c.isLocalPlayer, chosen.hasPercent);
        const staggerCollides =
          placedBoxes.some((p) => boxesOverlap(p, staggered)) || bodyGuard.some((b) => boxesOverlap(b, staggered));
        if (!staggerCollides) {
          box = staggered;
          collides = false;
          break;
        }
      }
    }
    if (collides && !c.isLocalPlayer) continue;
    placedBoxes.push(box);
    placements.push({
      candidate: c,
      label: chosen.label,
      box,
      x: anchorX,
      y: anchorY,
      isNameLabel: chosen.label !== numberLabel && chosen.label !== numberLabel + pctSuffix,
      hasPercent: chosen.hasPercent,
      percent: pct,
    });
  }
  return placements;
}

// How far up, in px, a colliding badge is stacked before it is dropped
// entirely -- see the stagger step above. Slightly more than one badge
// row so a staggered badge never touches the row it was bumped from.
const BADGE_ROW_STAGGER_PX = 15;
// How far above the local player's own body box stays protected from
// other fighters' badges, to also cover the local pointer that floats
// just above the local badge (see computeLocalPointer: pointer height is
// at most ~16px on screen, plus its own small gap -- this margin covers
// that with room to spare, except during the transient intro-emphasis
// scale-up in the first ~1s of a match, which is a spawn-row moment, not
// a clustered one, so is out of scope here).
const LOCAL_EXCLUSION_MARGIN_PX = 26;
// Ladder of vertical offsets tried, in order, before a badge is dropped
// entirely (or, for the exempt local player, placed wherever it lands).
// A real mid-match huddle is dense enough that a single row of slack
// often is not enough headroom to seat every damage numeral -- widening
// this ladder is cheap (no extra text, no smaller font) and measurably
// raises how many fighters keep a visible numeral in a tight cluster;
// see scripts/damage-badge-midmatch-metrics.mjs.
const STAGGER_OFFSETS = [-1, 1, -2, 2, -3, 3].map((n) => n * BADGE_ROW_STAGGER_PX);

/** Slides a box (and the (dx,dy) its anchor moved by) fully inside the
 * visible canvas, the same idea as computeLocalPointer's off-screen
 * clamp: `view` here is already the canvas's own size (see index.ts's
 * viewSize, which excludes the HUD sidebar), so a box that pokes past
 * its left/top/right/bottom edge is a box that would otherwise render
 * underneath the sidebar DOM element or off the far edge -- both places
 * a player near the edge of a cluster genuinely stood in a live match. */
function clampBoxToView(box: BadgeBox, view: { width: number; height: number }): { box: BadgeBox; dx: number; dy: number } {
  let dx = 0;
  let dy = 0;
  if (box.left < 0) dx = -box.left;
  else if (box.right > view.width) dx = view.width - box.right;
  if (box.top < 0) dy = -box.top;
  else if (box.bottom > view.height) dy = view.height - box.bottom;
  if (dx === 0 && dy === 0) return { box, dx, dy };
  return {
    box: { left: box.left + dx, right: box.right + dx, top: box.top + dy, bottom: box.bottom + dy },
    dx,
    dy,
  };
}

/** Fixed screen-space gap, in pixels, between the top of the local
 * player's own badge box and the bottom tip of the local-player pointer
 * (see computeLocalPointer below). Kept separate from BADGE_BOX_MARGIN_PX
 * so the pointer never visually touches the badge it sits above. */
export const LOCAL_POINTER_GAP_PX = 4;

/** Where to draw the one persistent "this is you" pointer, given this
 * frame's badge placements. Screen-space and constant-size by design
 * (see index.ts's drawLocalPointer): the old approach drew a marker in
 * *world* space on the fighter itself, so it was scaled down by the
 * camera zoom exactly like the fighter's own body -- at true 20-fighter
 * zoom on a wide stage that shrank it to a few pixels, which is the
 * actual defect a real player reported ("which one is me"). Anchoring
 * off the local player's own badge placement (rather than recomputing
 * head position independently) guarantees the pointer only ever appears
 * when the local player has a real, placed badge to sit above -- so it
 * can never appear with no local player (attract mode) and never floats
 * disconnected from the identity cue it's reinforcing. Returns null when
 * there is no local-player placement this frame. */
export function computeLocalPointer(
  placements: readonly BadgePlacement[],
  view?: { width: number; height: number },
): LocalPointer | null {
  const local = placements.find((p) => p.candidate.isLocalPlayer);
  if (!local) return null;
  const x = local.x ?? local.candidate.headX;
  const y = local.box.top - LOCAL_POINTER_GAP_PX;
  if (!view) return { x, y, offScreen: false, angle: 0 };
  // A fighter can genuinely be outside the frame: launched toward a blast
  // zone, or momentarily beyond the edge while the camera's follow damping
  // catches up. That is exactly the moment a player most needs to know
  // where they are, and until now the pointer simply went with them and
  // vanished. Clamp it to the edge of the view and record the direction it
  // was pushed from, so it can be drawn pointing off-screen at the fighter
  // rather than down at empty air.
  const inset = OFF_SCREEN_POINTER_INSET_PX;
  const cx = Math.min(Math.max(x, inset), Math.max(inset, view.width - inset));
  const cy = Math.min(Math.max(y, inset), Math.max(inset, view.height - inset));
  const offScreen = cx !== x || cy !== y;
  return {
    x: cx,
    y: cy,
    offScreen,
    // Screen space: 0 points down, matching the resting pointer.
    angle: offScreen ? Math.atan2(x - cx, cy - y) : 0,
  };
}

export interface LocalPointer {
  x: number;
  y: number;
  /** True when the local fighter is outside the view and this pointer has
   *  been clamped to the edge, pointing at them. */
  offScreen: boolean;
  /** Radians to rotate the pointer by, 0 being its resting downward
   *  orientation. Always 0 when the fighter is on screen. */
  angle: number;
}

/** How far inside the view edge a clamped off-screen pointer sits, in
 *  pixels -- far enough in that the whole triangle is visible. */
export const OFF_SCREEN_POINTER_INSET_PX = 16;


/** Fixed screen-space corner readout for the local player's own damage --
 * decoupled entirely from the in-world badge collision system above.
 * The 20-fighter phone-density case can legitimately force the local
 * player's world badge to drop its damage suffix (see
 * damage-badge-legibility.test.ts, phone viewport): the in-world badge is
 * a bonus when it fits, this corner readout is the guarantee. Always
 * present whenever there is a local player with a known percent, exactly
 * like computeLocalPointer never depends on anything overlapping. Fixed
 * pixel position and size, same reasoning as the local pointer: it must
 * read the same whether the local player is alone on screen or one of
 * twenty, and it must survive a 390px-wide phone viewport where a
 * fighter's own sprite is only ~26px tall. */
export interface LocalDamageReadout {
  x: number;
  y: number;
  text: string;
  /** True at/above kill percent (mirrors the HUD sidebar's own threshold) --
   * the one place colour is used here, and only as a second channel: the
   * numeral itself already carries the value under grayscale. */
  danger: boolean;
}

export const LOCAL_DAMAGE_READOUT_MARGIN_PX = 16;
export const LOCAL_DAMAGE_READOUT_FONT_SIZE = 28;
/** Kill-percent threshold, mirrored from hud.ts's own `pct >= 100` check
 * so the two damage readouts never disagree about when a fighter is in
 * danger. */
const DANGER_PERCENT_THRESHOLD = 100;

export function computeLocalDamageReadout(
  percent: number | undefined,
  view: { width: number; height: number },
): LocalDamageReadout | null {
  if (percent === undefined) return null;
  const pct = Math.max(0, Math.round(percent));
  const m = LOCAL_DAMAGE_READOUT_MARGIN_PX;
  return {
    x: m,
    y: view.height - m,
    text: `${pct}%`,
    danger: pct >= DANGER_PERCENT_THRESHOLD,
  };
}

export const BADGE_FONT_SIZE = 13;
// How many extra px, on top of the existing local-player +3 badge
// bonus, the local player's badge gets when it includes a damage
// readout -- makes the local player's own percent the single most
// prominent damage number on screen, per the 2026-09-18 design
// direction. 3 (name/number bonus) + 4 here = +7 total over everyone
// else's plain badge.
export const LOCAL_DAMAGE_FONT_BONUS = 7;
// Rough monospace glyph width at BADGE_FONT_SIZE, used only to build an
// approximate collision box -- no need for exact text metrics here.
// Bumped from 8 -- live-match garbling (2026-09-18, "Cinder 6:1910",
// "Squa14 64%") showed the reserved box was narrower than what actually
// draws: this is an approximation, not real text metrics (there is no
// canvas/GL context available in this test run, see
// character-icon-shared-context.test.ts for the same constraint), so it
// is padded generously rather than tuned to the edge.
const BADGE_CHAR_WIDTH_PX = 9.5;
const BADGE_BOX_HEIGHT_PX = 16;
const BADGE_BOX_MARGIN_PX = 3;
// The world badge text now draws with a stroke (see index.ts) so it
// stays legible over any fighter body colour -- a stroke visually
// widens and heightens the glyphs beyond their fill-only bounds, which
// the reserved box must account for or two badges placed edge-to-edge
// will visually merge exactly like the live-match report. index.ts's
// stroke width must match this constant.
export const BADGE_STROKE_WIDTH_PX = 3;

function badgeBox(x: number, y: number, digits: number, isLocalPlayer = false, hasPercent = false): BadgeBox {
  // The local player's badge renders BADGE_FONT_SIZE + 3px larger (see
  // layoutBadges) so it's the one badge a player can find at a glance --
  // but this box used to always assume the default font size, so the
  // space it reserved for the local badge was smaller than what actually
  // got drawn. A neighbouring badge could then be placed just outside
  // the (too-small) reserved box and still visually collide with the
  // bigger local badge actually on screen -- the local player's own
  // badge, exempt from ever being dropped, was the one most likely to
  // still show an illegible overlap in a tight cluster. Scale the
  // reserved box by the same ratio the font grows by so it actually
  // matches what gets drawn.
  // Must mirror the actual font-size bonus index.ts's layoutBadges
  // applies (BADGE_FONT_SIZE + localBonus there): reserving less space
  // than what actually gets drawn is exactly the earlier '1714 6' bug
  // pattern -- a neighbour placed just outside a too-small reserved box
  // that still visually collides with the bigger text really on screen.
  const localBonusPx = isLocalPlayer ? (hasPercent ? LOCAL_DAMAGE_FONT_BONUS : 3) : 0;
  const sizeScale = (BADGE_FONT_SIZE + localBonusPx) / BADGE_FONT_SIZE;
  const halfWidth = (digits * BADGE_CHAR_WIDTH_PX * sizeScale) / 2 + BADGE_BOX_MARGIN_PX + BADGE_STROKE_WIDTH_PX;
  const boxHeight = BADGE_BOX_HEIGHT_PX * sizeScale + BADGE_STROKE_WIDTH_PX;
  return {
    left: x - halfWidth,
    right: x + halfWidth,
    top: y - boxHeight - BADGE_BOX_MARGIN_PX,
    bottom: y + BADGE_BOX_MARGIN_PX,
  };
}

