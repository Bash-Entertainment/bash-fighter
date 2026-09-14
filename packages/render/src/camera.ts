// Frames the arena. The baseline view always shows the whole arena
// (derived from whatever StageBounds/blast-zone data it is given, never a
// hardcoded size) so a match reads as "a fight in an arena" even when
// fighters are standing still near center; it only zooms in tighter when
// fighters spread further apart than the arena's own footprint, and never
// zooms out past maxScale even if a fighter is flying toward the blast
// zone. Same function will frame 2 fighters on today's stage or 20 on a
// much bigger one — it only ever reads positions + bounds, no fighter
// count or stage size baked in.
export interface CameraView {
  centerX: number;
  centerY: number;
  scale: number; // pixels per world unit
}

export interface ArenaBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface CameraConfig {
  viewWidth: number;
  viewHeight: number;
  minScale: number;
  maxScale: number;
  paddingWorld: number;
  /** Full arena footprint (typically the blast zone) — the camera never
   * frames tighter than this by default. */
  arena: ArenaBounds;
  /** True world edges the camera must never show dead space beyond
   * (normally the live blast rect). Defaults to `arena` when omitted, so
   * existing callers/tests keep their exact old behaviour.
   *
   * `arena` above is a *minimum zoom* floor -- on stages where the
   * jump/fall headroom padding and the aspect-ratio correction in
   * framing.ts's computeFramingFloor() make that floor's own box taller
   * (or wider) than the fighters actually need, using `arena` for the
   * *centering* clamp too forces the frame's center onto the padded
   * floor box's own midpoint instead of following the fighters -- on a
   * wide, short arena
   * (e.g. battle-royale-20) this pins a ground-hugging 20-fighter pack
   * to the bottom few percent of the screen, because the floor's
   * vertical midpoint sits well above the ground where nothing is
   * happening. Clamping against the true blast rect instead only ever
   * prevents the frame from wandering past where a fighter could
   * actually be, never forces it toward empty headroom. */
  clampBounds?: ArenaBounds;
}

// Reduced-motion camera damping (issue #24). The existing "Reduce screen
// shake" setting (packages/render/src/effects.ts) only suppressed hit
// shake; it never touched the camera's own pan/zoom motion as the
// collapsing arena shrinks or the framing box grows/shrinks with the
// fighter spread, which can still be a fast, disorienting move for
// motion-sensitive players. computeCamera() is called fresh every
// render frame with no memory of the previous frame's view (it is a
// pure function of the current positions/bounds), so damping has to
// live here as module state: when enabled, each call is blended toward
// the freshly computed "raw" target by a fixed fraction instead of
// jumping straight to it, clamping the *rate* of pan/zoom change rather
// than the value itself. This is a client-side rendering/easing change
// only -- it never reads or writes any Sim state, so it cannot affect
// determinism.
let cameraReducedMotion = false;
let smoothedView: CameraView | null = null;

/** How much of the remaining distance to the freshly computed camera
 * target is closed per render call while reduced motion is on. Lower =
 * calmer/slower to follow the arena shrink or fighter spread, higher =
 * snappier. 1 (or reduced motion off) means "jump straight to target",
 * matching the previous, undamped behaviour exactly. */
const REDUCED_MOTION_SMOOTHING = 0.12;

export function setCameraReducedMotion(reduced: boolean): void {
  cameraReducedMotion = reduced;
  // Drop any in-progress smoothing state so re-enabling later starts
  // fresh from wherever the camera actually is, rather than blending
  // from a stale, possibly far-away point.
  smoothedView = null;
}

export function isCameraReducedMotion(): boolean {
  return cameraReducedMotion;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function computeCamera(
  positions: readonly { x: number; y: number }[],
  cfg: CameraConfig,
): CameraView {
  const raw = computeRawCamera(positions, cfg);
  if (!cameraReducedMotion) {
    smoothedView = null;
    return raw;
  }
  if (smoothedView === null) {
    smoothedView = raw;
    return raw;
  }
  smoothedView = {
    centerX: lerp(smoothedView.centerX, raw.centerX, REDUCED_MOTION_SMOOTHING),
    centerY: lerp(smoothedView.centerY, raw.centerY, REDUCED_MOTION_SMOOTHING),
    scale: lerp(smoothedView.scale, raw.scale, REDUCED_MOTION_SMOOTHING),
  };
  return smoothedView;
}

/** The un-damped camera computation (previous `computeCamera` body,
 * unchanged). Always call through `computeCamera` in render code so
 * reduced-motion damping applies; this is exported only so tests can
 * assert the raw target camera separately from the damped output. */
export function computeRawCamera(
  positions: readonly { x: number; y: number }[],
  cfg: CameraConfig,
): CameraView {
  // Fighter-only bounding box (with padding). This — not a blend with the
  // arena bounds — is what the camera centers on. Blending fighter
  // positions into the arena's own min/max (the old approach) meant a
  // single fighter near one edge only ever pushed that one side out,
  // while the untouched side stayed pinned to the arena bound: the
  // resulting center was dragged off the fighters' actual middle,
  // producing an asymmetric, off-center frame on any stage where the
  // arena itself isn't symmetric around the fighters (see the-spire).
  let fMinX = Infinity;
  let fMaxX = -Infinity;
  let fMinY = Infinity;
  let fMaxY = -Infinity;
  for (const p of positions) {
    fMinX = Math.min(fMinX, p.x - cfg.paddingWorld);
    fMaxX = Math.max(fMaxX, p.x + cfg.paddingWorld);
    fMinY = Math.min(fMinY, p.y - cfg.paddingWorld);
    fMaxY = Math.max(fMaxY, p.y + cfg.paddingWorld * 1.5); // headroom for jumps
  }
  if (positions.length === 0) {
    fMinX = cfg.arena.minX;
    fMaxX = cfg.arena.maxX;
    fMinY = cfg.arena.minY;
    fMaxY = cfg.arena.maxY;
  }

  const fCenterX = (fMinX + fMaxX) / 2;
  const fCenterY = (fMinY + fMaxY) / 2;
  const fSpanX = Math.max(1, fMaxX - fMinX);
  const fSpanY = Math.max(1, fMaxY - fMinY);

  const arenaSpanX = Math.max(1, cfg.arena.maxX - cfg.arena.minX);
  const arenaSpanY = Math.max(1, cfg.arena.maxY - cfg.arena.minY);
  // The view must never be *smaller* than what the arena floor needs, so
  // a couple of fighters standing close together still read as "a fight
  // in an arena" rather than a tight, disorienting zoom. This is a size
  // floor only — it does not pull the center toward the arena's own
  // midpoint.
  const spanX = Math.max(fSpanX, arenaSpanX);
  const spanY = Math.max(fSpanY, arenaSpanY);

  const scaleX = cfg.viewWidth / spanX;
  const scaleY = cfg.viewHeight / spanY;
  let scale = Math.min(scaleX, scaleY);
  const arenaFitScale = Math.min(cfg.viewWidth / arenaSpanX, cfg.viewHeight / arenaSpanY);
  const floor = Math.min(cfg.minScale, arenaFitScale);
  scale = Math.max(floor, Math.min(cfg.maxScale, scale));

  // Center on the fighters, then clamp so the frame doesn't wander past
  // the arena bounds and show dead space beyond them (e.g. show empty
  // blast zone past the edge when the fighters are clustered near it).
  const halfViewWorldX = cfg.viewWidth / 2 / scale;
  const halfViewWorldY = cfg.viewHeight / 2 / scale;
  let centerX = fCenterX;
  // Vertical framing is deliberately NOT centered on the fighters' own
  // midpoint. A platform fighter's action lives mostly above the floor
  // (jump arcs, aerials, knockback, recoveries) -- only the pit below
  // the floor matters, and only as somewhere fighters fall into, not
  // somewhere play happens. Centering equally split the viewport and
  // read as a big void below the fighters and (after the ground-anchor
  // fix above) a merely-adequate amount of jump room above -- see
  // GROUND_BIAS below.
  //
  // GROUND_BIAS pulls the center toward the *top* of the range that
  // still keeps every fighter on screen, anchored on the lowest fighter
  // (fMinY, i.e. the floor these fighters are standing/falling near)
  // rather than the fighters' vertical midpoint. At GROUND_BIAS=0.4 the
  // floor lands at roughly 70% down the viewport when the fighters are
  // a ground-hugging pack with plenty of vertical slack to spare
  // (derivation: groundFraction = 0.5 + GROUND_BIAS). The clamp two
  // lines down into [fMaxY - halfViewWorldY, fMinY + halfViewWorldY] is
  // exactly the same "never crop a living fighter" range the old
  // fCenterY-based code used (that range's own midpoint IS fCenterY) --
  // biasing only changes *where inside that always-safe range* the
  // center sits, so it can never re-introduce the bottom-pinning bug
  // (which came from a completely different clamp, against cfg.arena's
  // own midpoint) and it automatically yields to full centering as
  // fSpanY grows toward filling the viewport, because the safe range
  // itself shrinks toward that single fCenterY point.
  const GROUND_BIAS = 0.5;
  // With no fighters at all (e.g. a spectator view before anyone has
  // spawned) fMinY/fMaxY fall back to the whole arena above, and the
  // "whole arena" framing should stay plainly centered rather than
  // biased -- there is no ground-hugging pack to bias toward.
  let centerY: number;
  if (positions.length === 0) {
    centerY = fCenterY;
  } else {
    const groundAnchoredCenterY = fMinY + GROUND_BIAS * halfViewWorldY;
    centerY = Math.min(Math.max(groundAnchoredCenterY, fMaxY - halfViewWorldY), fMinY + halfViewWorldY);
  }
  // Only pull the center away from the fighters when the arena is
  // actually too small to let it sit freely (the view would otherwise
  // show dead space beyond the arena edge). When the arena fits inside
  // the view on an axis, keep centering on the fighters themselves --
  // forcing the center to the arena's own midpoint here (the previous
  // behaviour) is what produced a large empty band on stages whose
  // floor is wider than it is tall relative to the screen: the X axis
  // picks the binding scale, which leaves Y with slack, and snapping
  // to the arena's vertical midpoint then frames empty sky above a
  // field of fighters clustered on the ground instead of the ground
  // itself.
  // Use >= (not strictly >) here: when the arena's own span exactly
  // matches what the view can show (the common "camera holds the whole
  // arena, no zoom-in" case -- e.g. a few fighters standing near the
  // ground on a stage whose asymmetric fall/jump headroom box is exactly
  // the view's own size), the valid center range collapses to a single
  // point: the arena box's own center. With a strict >, that boundary
  // case fell through to raw fighter-centroid centering instead, which
  // ignores the asymmetric fall:jump headroom split framingFloor()
  // deliberately built (arena boxes lean toward jump headroom above the
  // ground, since jumps need more warning room than falls) and instead
  // centers on the fighters' own (near-ground) mean position -- showing
  // far more empty space below the ground than above it. This is what
  // produced the "empty bottom third" dead-space defect on stages like
  // the-foundry: the ground-hugging fighter cluster's centroid sits well
  // below the arena box's own vertical middle.
  const clamp = cfg.clampBounds ?? cfg.arena;
  if (clamp.maxX - clamp.minX >= halfViewWorldX * 2) {
    centerX = Math.min(Math.max(centerX, clamp.minX + halfViewWorldX), clamp.maxX - halfViewWorldX);
  }
  if (clamp.maxY - clamp.minY >= halfViewWorldY * 2) {
    centerY = Math.min(Math.max(centerY, clamp.minY + halfViewWorldY), clamp.maxY - halfViewWorldY);
  }

  return { centerX, centerY, scale };
}

/** Convert a world point (Y-up) to screen pixels (Y-down) given a camera
 * and the render surface size. */
export function worldToScreen(
  x: number,
  y: number,
  cam: CameraView,
  viewWidth: number,
  viewHeight: number,
): { x: number; y: number } {
  return {
    x: viewWidth / 2 + (x - cam.centerX) * cam.scale,
    y: viewHeight / 2 - (y - cam.centerY) * cam.scale,
  };
}
