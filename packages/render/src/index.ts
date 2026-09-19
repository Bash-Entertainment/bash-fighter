// packages/render: PixiJS/WebGL2 renderer. Reads sim state (already
// interpolated by the caller) and draws it; never mutates sim state.
// Built for N fighters — the sim milestone is fixed at 2, but nothing
// here hardcodes that so the renderer isn't what blocks 20-player FFA.
import { Application, Container, Graphics, Text } from 'pixi.js';
import { fixed as fx, FighterStateId, findMove, windowAtFrame, type CharacterData, type FighterStateValue } from '@bash-fighter/sim';
import { PALETTE, FONT_FAMILY } from './palette.ts';
import { clampRenderResolution } from './resolution.ts';
import {
  computeCamera,
  resetCameraSmoothing,
  worldToScreen,
  type ArenaBounds,
  type CameraConfig,
  type CameraView,
} from './camera.ts';
import { drawStage, type StageBounds } from './stage.ts';
import { isCameraReducedMotion } from './camera.ts';
import { FighterSprite } from './fighter-sprite.ts';
import { BODY_WIDTH, BODY_HEIGHT, HEAD_RADIUS } from './fighter-shape-placeholder.ts';
import { ItemSprite } from './item-sprite.ts';
import { HazardSprite } from './hazard-sprite.ts';
import { drawDebugBoxes, makeDebugText, formatDebugText, type DebugFighterInput } from './debug-overlay.ts';
import { EffectsLayer } from './effects.ts';
import { resolveAnimation } from '@bash-fighter/content';
import {
  computeBadgePlacements,
  computeLocalPointer,
  computeLocalDamageReadout,
  LOCAL_DAMAGE_READOUT_FONT_SIZE,
  BADGE_FONT_SIZE,
  LOCAL_DAMAGE_FONT_BONUS,
  type BadgeCandidate,
  type BodyBox,
} from './badge-layout.ts';
import { computePopulationAwareFramingFloor } from './framing.ts';

export { RenderItemTypeId } from './item-sprite.ts';
export { EffectsLayer, type HitEffectInput, setReducedMotion, isReducedMotion } from './effects.ts';

export type { StageBounds, StagePlatform } from './stage.ts';
export { arenaDataToStageBounds } from './arena-adapter.ts';
export { type BackdropId } from './backdrop.ts';
export type { ArenaBounds, CameraView, CameraConfig } from './camera.ts';
export { computeCamera, resetCameraSmoothing, worldToScreen } from './camera.ts';
export { computeFollowCamera, computeOverviewCamera, SmoothedCamera, type FollowConfig } from './spectator-camera.ts';
export { PALETTE, FONT_FAMILY, UI_FONT_FAMILY } from './palette.ts';
export { clampRenderResolution } from './resolution.ts';
export { renderCharacterIcon } from './character-icon.ts';

/** One fighter's render-ready state: world-space floats, already
 * interpolated between the two most recent sim ticks by the app layer. */
export interface RenderFighterState {
  x: number;
  y: number;
  facing: 1 | -1;
  state: FighterStateValue;
  moveId: number;
  moveFrame: number;
  percent: number; // Fixed
  stocks: number;
  shieldHealth: number; // Fixed
  hitstun: number;
  /** Match-level elimination (battle-royale "out"), distinct from the
   * sim's per-life DEAD state. An eliminated fighter is never drawn. */
  eliminated?: boolean;
  /** Taking ring (out-of-bounds) damage this tick -- the 2026-09-10 pressure
   * redesign. Drives the red pulse overlay in drawFighters. */
  inRingDanger?: boolean;
}

/** One item's render-ready state: world-space floats, already read from
 * sim.getItem(slot) by the app layer. `active: false` slots are skipped
 * by the renderer (pool entry hidden), same convention as fighters. */
export interface RenderItemState {
  active: boolean;
  typeId: number;
  x: number;
  y: number;
  held: boolean;
  holderFacing: 1 | -1;
  armed: boolean;
  fuseTicks: number;
}

/** One hazard's render-ready state, from sim.getHazard(slot). halfWidth
 * is a stylized world-unit marker size chosen by the app layer for
 * legibility, same convention as FighterSprite's BODY_WIDTH (not a
 * pixel-exact readout of the sim's hazard hitbox). */
export interface RenderHazardState {
  active: boolean;
  x: number;
  y: number;
  halfWidth: number;
}

/** A hit/elimination the app layer observed this tick, queued for the
 * renderer to translate from world to screen space using this frame's own
 * camera (the app layer does not know the camera, on purpose -- the
 * renderer stays the only thing that computes it). Presentation-only:
 * consumed once per render() call and never fed back into the sim. */
export interface PendingHitEffect {
  fighterIndex: number;
  worldX: number;
  worldY: number;
  dirX: number; // world-space direction (Y-up), need not be normalized
  dirY: number;
  strength: number; // 0..1
  strong: boolean; // true = heavy hit, drives longer flash + optional freeze
}

export interface PendingEliminationEffect {
  worldX: number;
  worldY: number;
}

export interface RenderFrame {
  fighters: readonly RenderFighterState[];
  characters: readonly CharacterData[];
  items?: readonly RenderItemState[];
  hazards?: readonly RenderHazardState[];
  tick: number;
  hash: string;
  /** Live arena bounds (e.g. a shrinking battle-royale blast zone) to
   * draw and frame instead of the static stage bounds. Falls back to the
   * Renderer's static StageBounds-derived arena when omitted. */
  liveArenaBounds?: ArenaBounds;
  /** Where the blast-zone boundary will be at a fixed lookahead (app
   * layer decides how far ahead -- see PREVIEW_LOOKAHEAD_TICKS in
   * packages/app). Drawn as a fainter amber preview line/band so a
   * player can see the boundary they need to react to, not just the one
   * they're already at. Omit or null when the mode has no shrink, or
   * once the shrink has already fully closed. */
  previewArenaBounds?: ArenaBounds | null;
  /** When set, the renderer paints with this exact camera instead of
   * computing its own fit-everyone camera. This is how the app layer's
   * spectator camera (follow / overview / smoothed) takes over — the
   * renderer stays a dumb painter and never decides spectate policy. */
  cameraOverride?: CameraView;
  /** Hit/block/elimination effects observed since the last render() call. */
  hitEffects?: readonly PendingHitEffect[];
  eliminationEffects?: readonly PendingEliminationEffect[];
  /** Index into `fighters` of this client's own fighter, if any (absent
   * while spectating). Draws a persistent above-head marker so the local
   * player stays findable in a 20-fighter crowd. Presentation-only. */
  localPlayerIndex?: number;
  /** Per-slot display names, index-aligned with `fighters`, for the
   * above-head badge. Presentation-only, sourced from the server's
   * per-connection metadata -- never simulation state, never hashed.
   * Empty string (or a missing/absent array) means "no chosen name for
   * this slot"; layoutBadges falls back to the slot number, and the
   * slot number remains available as a second fallback if the name
   * itself doesn't fit -- see layoutBadges for exactly how. */
  names?: readonly string[];
  /** Wall-clock ms to hold the previous frame's drawing before applying
   * new positions this call -- a presentation-only "freeze frame" on a
   * strong hit. Renderer decides internally how long based on strength;
   * the app layer only tells it a strong hit happened via hitEffects. */
}

// Camera framing-floor geometry lives in framing.ts (extracted so it can be
// unit-tested without pulling in Pixi/DOM -- see test/framing.test.ts). The
// old framingFloor() adapter here was dropped once the population-aware
// variant became the only caller.

// Fighters spread by roughly a screen-width during normal play; a
// paddingWorld a bit smaller than the arena keeps the baseline "whole
// fought-over space" framing as the default rather than the exception.
// minScale keeps fighters legible even on a wide arena; maxScale stops
// the camera slamming in when fighters stand still.
//
// `livingCount` shrinks the arena floor itself as fighters are
// eliminated (framing.ts's computePopulationAwareFramingFloor, empty-sky
// pass 2026-09-12) -- see that function's doc comment for why this can
// never crop a living fighter off-screen. Defaults to a count high
// enough to never shrink (full-floor behaviour unchanged) for any
// caller that doesn't pass one.
function cameraConfig(
  stage: StageBounds,
  viewWidth: number,
  viewHeight: number,
  livingCount = 20,
  fighterSpanXHint?: number,
): CameraConfig {
  return {
    viewWidth,
    viewHeight,
    minScale: 1.6,
    maxScale: 5.5,
    paddingWorld: 20,
    arena: computePopulationAwareFramingFloor(stage, viewWidth, viewHeight, livingCount, fighterSpanXHint),
    // Clamp centering to the true (live, possibly-shrunk) blast rect, not
    // the padded/aspect-corrected floor box above -- see camera.ts's
    // CameraConfig.clampBounds doc comment for why using the floor here
    // pins a ground-hugging crowd to the bottom of the screen.
    clampBounds: {
      minX: stage.blastMinX,
      maxX: stage.blastMaxX,
      minY: stage.blastMinY,
      maxY: stage.blastMaxY,
    },
  };
}

// Attract mode's framing (see Renderer.setAttractFraming): the demo on
// the start screen is a small window meant to show recognisable
// fighters trading blows, not "a fight somewhere in a big arena" the
// way a real match's framing.ts floor deliberately guarantees. Real
// matches never call this -- JUMP_HEADROOM_WORLD/FALL_HEADROOM_WORLD
// and the population-aware floor in framing.ts are untouched.
//
// The "arena" handed to computeCamera() here is just a padded box
// around the fighters themselves, clamped to the live blast rect so it
// can never invent space beyond the stage (that clamp is also what
// keeps the outer-blast-zone wash off-screen without needing
// suppressOuterWash to do all the work by itself): computeCamera()
// takes max(fighterSpan, arenaSpan) per axis, so an arena this close to
// the fighters' own span acts as almost no floor at all, letting the
// camera zoom in on the cluster instead of holding the whole stage.
const ATTRACT_FIGHTER_PADDING_WORLD = 130;

function attractCameraConfig(
  stage: StageBounds,
  viewWidth: number,
  viewHeight: number,
  positions: readonly { x: number; y: number }[],
): CameraConfig {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of positions) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX)) {
    // No living fighters to frame (freeze-frame after the match resolved,
    // about to be torn down and respawned) -- fall back to the stage's
    // own blast rect rather than an inverted/empty box.
    minX = stage.blastMinX;
    maxX = stage.blastMaxX;
    minY = stage.blastMinY;
    maxY = stage.blastMaxY;
  }
  const arena: ArenaBounds = {
    minX: Math.max(minX - ATTRACT_FIGHTER_PADDING_WORLD, stage.blastMinX),
    maxX: Math.min(maxX + ATTRACT_FIGHTER_PADDING_WORLD, stage.blastMaxX),
    // Downward (fall) padding is deliberately small: this is scenery,
    // not a real match, so the frame doesn't need to warn a visitor a
    // fighter is about to fall offstage the way real framing does --
    // just enough that a knocked-down fighter is briefly visible below
    // the ground line rather than a hard crop at the floor. The height
    // that padding gives up goes to jump headroom above instead (see
    // ATTRACT_FIGHTER_PADDING_WORLD * 1.6 below), where the fighters and
    // platforms actually are, closing the empty band that used to sit
    // below the ground line.
    minY: Math.max(minY - ATTRACT_FIGHTER_PADDING_WORLD * 0.15, stage.blastMinY),
    maxY: Math.min(maxY + ATTRACT_FIGHTER_PADDING_WORLD * 1.6, stage.blastMaxY),
  };
  return {
    viewWidth,
    viewHeight,
    minScale: 1.6,
    maxScale: 5.5,
    paddingWorld: 20,
    arena,
  };
}

function mainGroundY(stage: StageBounds): number {
  return stage.platforms[0]?.y ?? 0;
}

/** A badge's screen-space vertical offset above its fighter's head
 * scales with camera zoom (so it still reads as "attached" whether the
 * camera is pulled back for a 20-fighter spread or zoomed in for a
 * final-two showdown), but is clamped so it can never balloon into the
 * "floating 50-60px above everyone, disconnected from any body" defect
 * this replaces. */
const BADGE_OFFSET_MIN_PX = 12;
const BADGE_OFFSET_MAX_PX = 22;
function clampHeadOffsetPx(px: number): number {
  return Math.min(BADGE_OFFSET_MAX_PX, Math.max(BADGE_OFFSET_MIN_PX, px));
}

const PLAYER_COLOR_COUNT = PALETTE.playerColors.length;

// How far inside the current blast-zone boundary the local player's own
// edge-danger ring (fighter-sprite.ts's drawEdgeWarning) starts ramping
// up. World units, not pixels, so it scales correctly as the boundary
// shrinks. Picked against the default arena's ~260/120-unit half-extents
// and the ~55%-of-original final shrink size (packages/sim/src/
// arena-shrink.ts's FINAL_SHRINK_FRACTION): 55 units is close enough to
// the edge that it doesn't fire mid-stage, but far enough to give a
// player time to react even once the arena has mostly closed.
const EDGE_WARN_DISTANCE_WORLD = 55;

/** 0 = comfortably inside the boundary, 1 = at or past it. Distance is to
 * the *nearest* edge of the current (not preview) blast rect, since a
 * player standing near a corner is close to two edges. Cheap: four
 * subtractions and a min/max, called once per frame for the local
 * player only (never for the other 19 fighters). */
export function computeEdgeDangerFrac(x: number, y: number, stage: StageBounds): number {
  const distLeft = x - stage.blastMinX;
  const distRight = stage.blastMaxX - x;
  const distBottom = y - stage.blastMinY;
  const distTop = stage.blastMaxY - y;
  const nearest = Math.min(distLeft, distRight, distBottom, distTop);
  if (nearest <= 0) return 1; // already outside on at least one axis
  return Math.max(0, 1 - nearest / EDGE_WARN_DISTANCE_WORLD);
}

export class Renderer {
  readonly app = new Application();
  private ready = false;
  private debugOn = false;
  // WebGL context loss (2026-09-14): a lost context is a normal thing a
  // real browser does -- GPU switch, phone backgrounding the tab, driver
  // reset, too many live WebGL contexts -- not an error worth throwing
  // over. PixiJS's own GlContextSystem already calls preventDefault() and
  // rebinds GPU resources on `webglcontextrestored`, but nothing upstream
  // of it stops US from calling into a renderer with no live GL context
  // in between: that produced the "this.app.renderer is null" flood seen
  // live (see wiki). These two flags make render()/viewSize fail safe
  // instead, and let callers (match.ts/net-match.ts) show/hide an honest
  // message instead of leaving a silent black canvas.
  private contextLost = false;
  /** Set by the owner (Match/NetMatch) right after construction. Fired
   * once per loss/restore; never thrown from inside a browser event
   * handler into caller code, so a handler that throws cannot re-break
   * the render loop it's trying to protect. */
  /** Watches the canvas's container so the drawing surface always matches
   * the space the player can actually see -- see `init`. */
  private parentResizeObserver: ResizeObserver | null = null;
  onContextLost: (() => void) | null = null;
  onContextRestored: (() => void) | null = null;
  // 2026-09-14 follow-up: a lost context we never got the event for (see
  // the race documented on `init` below) leaves `contextLost` false
  // forever while nothing is ever actually drawn -- production hit this
  // exact state after a couple of match restarts in one browser session:
  // black canvas, isContextLost() false, canvas stuck at Pixi's 800x600
  // default. `framesPresented` is the ground truth callers should watch
  // instead of trusting our own flag: it only increments once per frame
  // that (a) our own render() actually ran a full draw pass, not a bail,
  // and (b) the browser's own WebGL context -- not our event listener's
  // opinion of it -- confirms it was alive at that moment. A watchdog
  // that sees this stay at 0 for several seconds after a match starts
  // knows the renderer is dead regardless of which internal flag missed
  // the actual cause.
  private framesPresented = 0;

  private readonly world = new Container();
  private readonly stageLayer = new Graphics();
  private readonly debugLayer = new Graphics();
  private readonly sprites: FighterSprite[] = [];
  private readonly spriteContainer = new Container();
  private readonly itemSprites: ItemSprite[] = [];
  private readonly itemContainer = new Container();
  private readonly hazardSprites: HazardSprite[] = [];
  private readonly hazardContainer = new Container();
  // Slot-number badges live in screen space, as direct children of
  // app.stage rather than `world` -- world-space text scales with camera
  // zoom (unreadably tiny zoomed out, absurdly offset zoomed in) and
  // cannot be selectively hidden to avoid overlap without knowing final
  // screen positions first. See layoutBadges() below.
  private readonly badgeContainer = new Container();
  private readonly badgeTexts: Text[] = [];
  // The one persistent "this is you" pointer: a single Graphics object
  // (not pooled per-fighter -- there is only ever at most one local
  // player) living in screen space alongside the badges, so it renders
  // at a constant pixel size regardless of camera zoom. See
  // computeLocalPointer in badge-layout.ts for why this replaced the old
  // world-space marker drawn on the fighter itself.
  private readonly localPointer = new Graphics();
  // Fixed screen-space corner readout of the local player's own damage --
  // see computeLocalDamageReadout in badge-layout.ts for why this exists
  // separately from the in-world badge: at true 20-fighter phone density
  // the in-world badge can legitimately be forced to drop its damage
  // suffix, and the player's own damage is required to be the single
  // most prominent damage number on screen regardless.
  private readonly localDamageText = new Text({
    text: '',
    style: { fontFamily: 'monospace', fontSize: LOCAL_DAMAGE_READOUT_FONT_SIZE, fill: PALETTE.hud, fontWeight: 'bold' },
  });
  private readonly debugText = makeDebugText();
  private stageBounds: StageBounds;
  private readonly effects = new EffectsLayer();
  private lastFrameTimeMs: number | null = null;
  // Slow-frame attribution counters (2026-09-15, see
  // docs/MEASUREMENT.md "Slow-frame attribution"): recomputed every
  // render() call from data already being iterated for sprite placement
  // below, so reading them back costs nothing extra on the hot path --
  // only the app layer's SlowFrameTracker decides, after the fact,
  // whether a given frame's numbers are worth accumulating.
  private lastFrameFightersAlive = 0;
  private lastFrameFightersOnScreen = 0;
  // Freeze-frame state, now used *only* by the dev-only debug hooks
  // (__debugFreezeOnNextEffect / __debugFreezeOnAttackActive) below, for
  // holding a rendered frame still long enough to screenshot it. The
  // real per-hit impact freeze is sim-side now (Sim's HITSTOP_TICKS,
  // packages/sim/src/knockback.ts) -- both attacker and defender's
  // simulated position genuinely stop advancing for a few ticks, so the
  // renderer displays it for free by just drawing whatever the sim
  // reports, with no render-side timer of its own. A render-side "hold
  // the picture on a strong hit" used to live here as a stand-in before
  // the sim grew a real one; keeping it too would have stacked an extra,
  // untuned wall-clock freeze on top of the deterministic one this was
  // designed to replace, so it was removed rather than left to double up.
  private freezeRemainingMs = 0;

  // Local-fighter intro emphasis (2026-09-15): two real players
  // independently said they could not find their own fighter in the
  // opening seconds even with the screen-space pointer shipped
  // 2026-09-13 -- a small persistent arrow works once you know to look
  // for it, and is useless the first time you have never seen the game.
  // `announceLocalPlayer()` is called once, from the app layer, at the
  // moment a match actually begins for this client (fresh join or a
  // mid-match join alike -- see main.ts). For INTRO_EMPHASIS_MS every
  // OTHER fighter is dimmed and the local pointer is drawn oversized,
  // both easing back to normal on the same wall-clock curve as the
  // camera damping above -- never a fixed frame count, so it reads the
  // same on a slow phone as on a fast desktop. Presentation only: reads
  // performance.now() and this frame's already-computed isLocalPlayer
  // flag, writes nothing back into the sim, and does not touch which
  // frames replay-hash fixtures compare.
  private introStartMs: number | null = null;
  private static readonly INTRO_EMPHASIS_MS = 1800;
  private static readonly INTRO_DIM_ALPHA = 0.28;

  /** Call once when this client's match view begins (fresh match or a
   *  mid-match join) so the next INTRO_EMPHASIS_MS of render() calls
   *  spotlight the local fighter. Safe to call with no local player
   *  (spectating): render() only ever dims fighters other than
   *  frame.localPlayerIndex, so with no local player nothing dims. */
  announceLocalPlayer(): void {
    this.introStartMs = performance.now();
  }

  constructor(stageBounds: StageBounds) {
    this.stageBounds = stageBounds;
  }

  /** Swap the static arena the renderer draws, e.g. once an online match's
   * real arena (createMatchSim's BATTLE_ROYALE_20_ARENA) is known, after
   * the Renderer had to be constructed earlier with a placeholder. */
  setStageBounds(stageBounds: StageBounds): void {
    this.stageBounds = stageBounds;
  }

  /** Pixi's own default for an unspecified `resolution` is the raw
   *  `window.devicePixelRatio` -- fine on desktop (DPR 1-2) but a real
   *  fill-rate cost on the DPR-3 phones we see in production: every
   *  pixel shader invocation (fighters, effects, stage) runs 9x more
   *  samples than DPR1 (3x3), not 3x, because it scales both canvas
   *  dimensions. Camera/world math below reads `app.renderer.width/height`
   *  (CSS-space, resolution-independent -- see getCanvasPixelSize), so
   *  clamping this is presentation-only: it changes GPU pixel-shader work,
   *  never a coordinate any camera/framing/sim code depends on. 2 matches
   *  desktop's actual max useful DPR and was already production's typical
   *  high end before 2026-09-15's zoom increase raised per-pixel cost. */
  static readonly MAX_RESOLUTION = 2;

  async init(parent: HTMLElement): Promise<void> {
    const dpr = typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
    await this.app.init({
      resizeTo: parent,
      background: PALETTE.background,
      antialias: true,
      preference: 'webgl',
      resolution: clampRenderResolution(dpr, Renderer.MAX_RESOLUTION),
      autoDensity: true,
    });
    parent.appendChild(this.app.canvas);

    // Must be attached to the real canvas element, not `this.app` --
    // that's what the browser actually fires these two events on.
    // preventDefault() on 'webglcontextlost' is not optional decoration:
    // per spec, the context is only EVER eligible for restoration
    // (a later 'webglcontextrestored') if some listener calls it during
    // this event. Skipping it would make every loss permanent, silently
    // turning a recoverable GPU hiccup into the exact same forever-black
    // screen this exists to fix.
    this.app.canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.contextLost = true;
      this.onContextLost?.();
    });
    this.app.canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      // Forces the next render() to treat elapsed time as "first frame"
      // rather than measuring a multi-second gap (however long the loss
      // lasted) as one dtMs, which would otherwise hand effects.update()
      // a huge delta and make every timed effect (hitstop, shake decay)
      // jump.
      this.lastFrameTimeMs = null;
      this.onContextRestored?.();
    });

    // Pixi's `resizeTo` reads `parent.clientWidth/clientHeight` exactly
    // once, synchronously, inside `app.init()` above, and afterwards only
    // resizes on a *window* resize event -- it never observes `parent`
    // itself. That is not a hypothetical: the stylesheet only insets
    // `#canvas-root` by the HUD sidebar width once the fighter list turns
    // dense, which a 20-fighter match does well after the renderer has
    // taken its one measurement. The window never resizes afterwards, so
    // the canvas stayed 200px wider than its container for the whole
    // match -- a fifth of the world drawn off the right edge of the
    // screen where no player could see it. The same one-shot read also
    // leaves the canvas at Pixi's 800x600 default if `parent` happened to
    // measure 0x0 mid-layout.
    //
    // Observing the container fixes both, and every later cause too
    // (phone rotation, mobile browser chrome sliding away, the sidebar
    // appearing or disappearing as the roster changes).
    const syncToParent = (): void => {
      if (this.contextLost) return;
      const width = parent.clientWidth;
      const height = parent.clientHeight;
      if (width <= 0 || height <= 0) return;
      const current = this.viewSize;
      if (current.width === width && current.height === height) return;
      this.app.renderer.resize(width, height);
    };
    syncToParent();
    // A fresh renderer means a fresh match: the camera must start framed
    // on the action, not glide in from wherever the previous one left off.
    resetCameraSmoothing();
    if (typeof ResizeObserver !== 'undefined') {
      this.parentResizeObserver = new ResizeObserver(() => {
        syncToParent();
      });
      this.parentResizeObserver.observe(parent);
    }

    this.world.addChild(this.stageLayer);
    this.world.addChild(this.hazardContainer);
    this.world.addChild(this.spriteContainer);
    this.world.addChild(this.itemContainer);
    this.world.addChild(this.effects.root);
    this.world.addChild(this.debugLayer);
    this.app.stage.addChild(this.world);

    this.debugText.position.set(10, 130);
    this.debugText.visible = false;
    this.app.stage.addChild(this.debugText);
    this.app.stage.addChild(this.badgeContainer);
    this.badgeContainer.addChild(this.localPointer);
    this.localDamageText.anchor.set(0, 1);
    this.badgeContainer.addChild(this.localDamageText);

    this.ready = true;
  }

  setDebug(on: boolean): void {
    this.debugOn = on;
    this.debugText.visible = on;
  }

  /** Hides every slot-number/name badge without touching anything else
   * this renders. Used by the start screen's attract-mode background
   * match (see packages/app/src/attract-mode.ts): that match is scenery,
   * not something a visitor is meant to read, so its badges would just
   * be noise -- but it is still the same real Renderer everything else
   * uses, not a stripped-down copy. */
  setShowBadges(show: boolean): void {
    this.badgeContainer.visible = show;
  }

  /** Switches between real-match framing (framing.ts's population-aware
   * floor, always shows "a fight in an arena") and attract mode's tight
   * cluster-following camera + suppressed outer-blast-zone wash (see
   * attractCameraConfig and drawStage's suppressOuterWash above). Only
   * ever set by attract-mode.ts; real matches leave this false. */
  setAttractFraming(on: boolean): void {
    this.attractFraming = on;
  }

  isDebug(): boolean {
    return this.debugOn;
  }

  get viewSize(): { width: number; height: number } {
    // A lost (or not-yet-restored) context can leave the renderer with
    // no usable size for a frame or two around the event; a fixed 0x0
    // is an honest "nothing to draw", not a guess, and callers already
    // treat width/height 0 safely (computeCamera etc. run on live
    // fighter data, not on this size, and render() below bails before
    // reaching any of that while contextLost is true anyway).
    if (!this.app.renderer) return { width: 0, height: 0 };
    return { width: this.app.renderer.width, height: this.app.renderer.height };
  }

  /** Real device-pixel backing-store size of the canvas -- CSS `viewSize`
   *  above times whatever resolution Pixi actually applied -- plus that
   *  resolution itself, so a report can tell a small-viewport/high-DPR
   *  phone apart from a small-viewport/low-DPR one (2026-09-15, see
   *  docs/MEASUREMENT.md "Slow-frame attribution"). Reads straight off
   *  the live `<canvas>` element and the renderer's own resolution
   *  field; same 0x0-on-lost-context honesty as `viewSize`. */
  getCanvasPixelSize(): { widthPx: number; heightPx: number; resolution: number } {
    if (!this.app.renderer) return { widthPx: 0, heightPx: 0, resolution: 1 };
    const canvas = this.app.canvas as HTMLCanvasElement | undefined;
    const resolution = this.app.renderer.resolution || 1;
    return {
      widthPx: canvas?.width ?? Math.round(this.app.renderer.width * resolution),
      heightPx: canvas?.height ?? Math.round(this.app.renderer.height * resolution),
      resolution,
    };
  }

  /** How many fighters were alive, and how many of those the camera
   *  actually drew inside the canvas bounds, as of the most recently
   *  completed render() call (2026-09-15, see docs/MEASUREMENT.md
   *  "Slow-frame attribution"). The two are expected to match almost
   *  always -- the camera is built never to crop a live fighter out of
   *  frame (see "Camera Framing" in the wiki) -- so a persistent gap is
   *  itself a signal, not just a frame-cost one. */
  getLastFrameFighterCounts(): { alive: number; onScreen: number } {
    return { alive: this.lastFrameFightersAlive, onScreen: this.lastFrameFightersOnScreen };
  }

  /** Live particle/pop/trail-segment count as of the most recently
   *  completed render() call (2026-09-15, see docs/MEASUREMENT.md
   *  "Slow-frame attribution"). Delegates straight to the effects
   *  layer's own O(1) length read. */
  getLiveEffectsLoad(): number {
    return this.effects.getLiveEffectsLoad();
  }

  /** Pool a sprite per fighter slot — created once, reused every frame so
   * a 20-fighter FFA doesn't allocate PIXI objects per tick. */
  private ensureSpritePool(count: number): void {
    while (this.sprites.length < count) {
      const sprite = new FighterSprite(this.sprites.length % PLAYER_COLOR_COUNT);
      this.sprites.push(sprite);
      this.spriteContainer.addChild(sprite.root);
    }
    for (let i = count; i < this.sprites.length; i++) {
      (this.sprites[i] as FighterSprite).root.visible = false;
    }
  }

  private ensureItemPool(count: number): void {
    while (this.itemSprites.length < count) {
      const sprite = new ItemSprite();
      this.itemSprites.push(sprite);
      this.itemContainer.addChild(sprite.root);
    }
    for (let i = count; i < this.itemSprites.length; i++) {
      (this.itemSprites[i] as ItemSprite).root.visible = false;
    }
  }

  private ensureHazardPool(count: number): void {
    while (this.hazardSprites.length < count) {
      const sprite = new HazardSprite();
      this.hazardSprites.push(sprite);
      this.hazardContainer.addChild(sprite.root);
    }
    for (let i = count; i < this.hazardSprites.length; i++) {
      (this.hazardSprites[i] as HazardSprite).root.visible = false;
    }
  }

  private ensureBadgePool(count: number): void {
    while (this.badgeTexts.length < count) {
      const text = new Text({
        text: '',
        style: { fontFamily: FONT_FAMILY, fontSize: BADGE_FONT_SIZE, fill: PALETTE.hud, fontWeight: '700' },
      });
      text.anchor.set(0.5, 1);
      text.resolution = 2;
      this.badgeTexts.push(text);
      this.badgeContainer.addChild(text);
    }
    for (let i = count; i < this.badgeTexts.length; i++) {
      (this.badgeTexts[i] as Text).visible = false;
    }
  }

  /** Places the slot-number badges in screen space, attached directly
   * above each fighter's own head, and greedily drops any badge that
   * would overlap one already placed.
   *
   * This is the fix for the "1714 6" defect: in the old world-space
   * version every badge was always drawn, so a bunched-up crowd produced
   * overlapping runs of digits that read as garbage. Text is unreadable
   * once it overlaps -- there is no useful partial state between "clear"
   * and "illegible" -- so once two badges would collide, showing only
   * one of them is strictly more informative than showing a smear of
   * both. The local player's own badge is exempt from being dropped (it
   * is the one identity cue this player actually needs every frame) and
   * is placed first, reserving its space so nearby badges yield to it
   * rather than the other way around. Remaining badges are placed in
   * order of distance to the local player, so in a crowded scrum the
   * badges that survive are the ones for whoever is actually nearby --
   * exactly the fighters this player is about to fight or be hit by. */
  private names: readonly string[] | undefined;
  private attractFraming = false;

  private layoutBadges(candidates: BadgeCandidate[], bodyBoxes: BodyBox[]): void {
    this.ensureBadgePool(candidates.length);
    const placements = computeBadgePlacements(candidates, bodyBoxes, this.names, this.viewSize);
    let textIndex = 0;
    for (const p of placements) {
      const text = this.badgeTexts[textIndex] as Text;
      textIndex += 1;
      text.text = p.label;
      text.position.set(p.x, p.y);
      text.visible = true;
      // The local player's own badge gets the same bright fill as the
      // rest for consistency, but a slightly larger size so it is the
      // one badge a player can find at a glance without reading digits.
      // The local player's damage readout gets a further size bump on
      // top of that (see LOCAL_DAMAGE_FONT_BONUS) -- of every damage
      // number on screen, this is the one the player must never have to
      // hunt for (2026-09-17 player report: "had no idea how much hp
      // anybody had"). Colour is a secondary, non-load-bearing cue: the
      // numeral itself already carries the information, so this reads
      // the same under grayscale.
      const localBonus = p.candidate.isLocalPlayer ? (p.hasPercent ? LOCAL_DAMAGE_FONT_BONUS : 3) : 0;
      text.style.fontSize = BADGE_FONT_SIZE + localBonus;
      text.style.fill = p.hasPercent && (p.percent ?? 0) >= 100 ? PALETTE.danger : PALETTE.hud;
    }
    for (let i = textIndex; i < this.badgeTexts.length; i++) {
      (this.badgeTexts[i] as Text).visible = false;
    }
    this.drawLocalPointer(placements);
  }

  /** Draws (or hides) the single constant-size "this is you" pointer --
   * a small flat downward-pointing triangle in screen space, anchored
   * just above the local player's own badge (see computeLocalPointer).
   * Unlike everything else this renderer draws on a fighter, this never
   * scales with camera zoom: that's the whole point -- at true
   * 20-fighter zoom on a wide stage, a marker sized in *world* units
   * (as fighter-sprite.ts's old chevron was) shrinks along with the
   * fighter itself down to a few pixels, which is exactly the
   * readability gap a real player reported. A fixed pixel size means
   * this pointer reads exactly the same whether the local player is
   * alone on screen or one of twenty. Flat cream fill, no glow, no
   * gradient, matches the rest of this project's austere HUD language;
   * no animation, so it costs nothing under reduced-motion. Hidden
   * automatically whenever there is no local-player badge placement --
   * i.e. whenever there is no local player at all (attract mode) -- by
   * computeLocalPointer returning null. */
  private drawLocalPointer(placements: ReturnType<typeof computeBadgePlacements>): void {
    const pos = computeLocalPointer(placements, {
      width: this.viewSize.width,
      height: this.viewSize.height,
    });
    this.localPointer.clear();
    if (!pos) {
      this.localPointer.visible = false;
      return;
    }
    this.localPointer.visible = true;
    // Slightly larger when it is standing in for a fighter you cannot see,
    // since then it is the only thing telling you where you are. Larger
    // still, easing back down over INTRO_EMPHASIS_MS, right after a match
    // begins for this client -- see announceLocalPlayer(). introScale
    // is 1 once the window has elapsed or was never started.
    const introScale =
      this.introStartMs !== null
        ? 1 + 1.6 * (1 - Math.min(1, (performance.now() - this.introStartMs) / Renderer.INTRO_EMPHASIS_MS))
        : 1;
    const w = (pos.offScreen ? 9 : 7) * introScale;
    const h = (pos.offScreen ? 11 : 8) * introScale;
    const sin = Math.sin(pos.angle);
    const cos = Math.cos(pos.angle);
    // Rotate about the pointer's tip, which is the point that means
    // something: it is aimed at the fighter.
    const rot = (dx: number, dy: number): [number, number] => [
      pos.x + dx * cos - dy * sin,
      pos.y + dx * sin + dy * cos,
    ];
    const [ax, ay] = rot(-w, -h);
    const [bx, by] = rot(w, -h);
    this.localPointer
      .moveTo(ax, ay)
      .lineTo(bx, by)
      .lineTo(pos.x, pos.y)
      .closePath()
      .fill({ color: PALETTE.hud });
  }

  /** Draws (or hides) the fixed corner readout of the local player's own
   * damage. Independent of camera zoom, badge collision and everything
   * else on screen -- see the field doc comment for why. Hidden when
   * there is no local player or it has been eliminated (nothing to
   * report). */
  private drawLocalDamageReadout(percentFixed: number | undefined): void {
    const percent = percentFixed !== undefined ? fx.toFloat(percentFixed) : undefined;
    const readout = computeLocalDamageReadout(percent, this.viewSize);
    if (!readout) {
      this.localDamageText.visible = false;
      return;
    }
    this.localDamageText.visible = true;
    this.localDamageText.text = readout.text;
    this.localDamageText.position.set(readout.x, readout.y);
    this.localDamageText.style.fill = readout.danger ? PALETTE.danger : PALETTE.hud;
  }

  /** Ground-truth check of the browser's own WebGL context, independent
   * of whether our `webglcontextlost` listener ever fired for it (see the
   * race documented in `init`). `renderer.context` is PixiJS's internal
   * GlContextSystem; `.isLost` is a thin wrapper over the browser's own
   * `gl.isContextLost()`. Not part of Pixi's stable public API, so kept
   * isolated here like the debugForceContextLoss/Restore helpers above. */
  private hasLiveGlContext(): boolean {
    const renderer = this.app.renderer as unknown as { context?: { isLost?: boolean } };
    if (!renderer) return false;
    return renderer.context?.isLost !== true;
  }

  /** Frames genuinely drawn so far -- see the field doc above. */
  getFramesPresented(): number {
    return this.framesPresented;
  }

  render(frame: RenderFrame): void {
    if (!this.ready || this.contextLost) return;

    // Counts this frame as presented only if the browser's own WebGL
    // context confirms it was alive going into this draw pass -- see
    // hasLiveGlContext's doc comment for why that's the ground truth a
    // watchdog should trust, not our own contextLost flag (which is what
    // this whole check exists to be independent of).
    if (this.hasLiveGlContext()) this.framesPresented++;

    const now = performance.now();
    const dtMs = this.lastFrameTimeMs === null ? 16.6667 : Math.min(50, now - this.lastFrameTimeMs);
    this.lastFrameTimeMs = now;

    const { width: vw, height: vh } = this.viewSize;
    const liveFighters = frame.fighters.filter((f) => !f.eliminated);
    this.ensureSpritePool(frame.fighters.length);

    const stageForDraw: StageBounds = frame.liveArenaBounds
      ? {
          ...this.stageBounds,
          blastMinX: frame.liveArenaBounds.minX,
          blastMaxX: frame.liveArenaBounds.maxX,
          blastMinY: frame.liveArenaBounds.minY,
          blastMaxY: frame.liveArenaBounds.maxY,
        }
      : this.stageBounds;

    const fighterPositions = liveFighters.map((f) => ({ x: f.x, y: f.y }));
    // Matches camera.ts's own fSpanX padding exactly, so the framing
    // floor's aspect-ratio step (framing.ts) trims to the same effective
    // width computeRawCamera will end up using -- see
    // ARENA_FLOOR_SLACK_FACTOR/MIN_COUNT in framing.ts for why this needs
    // to happen before, not after, that step.
    const fighterSpanXHint =
      fighterPositions.length > 0
        ? Math.max(...fighterPositions.map((p) => p.x)) -
          Math.min(...fighterPositions.map((p) => p.x)) +
          2 * 20
        : undefined;
    const cam =
      frame.cameraOverride ??
      computeCamera(
        fighterPositions,
        this.attractFraming
          ? attractCameraConfig(stageForDraw, vw, vh, fighterPositions)
          : cameraConfig(stageForDraw, vw, vh, liveFighters.length, fighterSpanXHint),
        // Real elapsed time between draws, so the camera's follow damping
        // runs on the same wall clock on a phone managing 15fps as on a
        // 60fps desktop.
        dtMs,
      );

    // Translate any hit/elimination effects the app layer observed since
    // the last render() call into screen space using *this* frame's
    // camera, then hand them to the effects layer. This is the only place
    // world coordinates ever get turned into shake/particle positions.
    // DEV-ONLY debug hook, inert unless a developer explicitly sets
    // window.__debugFreezeOnNextEffect = true from the console/devtools
    // (e.g. via a browser_batch javascript step right before landing a
    // hit while testing). Lets you screenshot a live flash/spark/shake
    // frame despite screenshot round-trip latency exceeding the effect's
    // natural lifetime. Ships inert: this block only ever does anything
    // if that global was set, which nothing in the app does on its own.
    const win = typeof window !== 'undefined' ? (window as unknown as Record<string, unknown>) : undefined;
    if (win?.__debugUnfreeze) {
      this.freezeRemainingMs = 0;
      win.__debugUnfreeze = false;
    }

    // Screen shake should care whether the local player was actually
    // involved in a hit, not just that a hit happened anywhere in a
    // 20-fighter brawl -- see shakeAttenuation on HitEffectInput. Decided
    // here (not in effects.ts) from world-space distance to the local
    // fighter, since only the app/render layer knows which fighter (if
    // any) is the local one this frame. No local fighter (spectating) or
    // no world position available -> no attenuation, full shake, since
    // there is nothing to be "far from".
    const localFighter =
      frame.localPlayerIndex !== undefined ? frame.fighters[frame.localPlayerIndex] : undefined;
    const SHAKE_FULL_RADIUS = 90; // world units: melee range and closer -> full shake
    const SHAKE_ZERO_RADIUS = 320; // world units: further than this -> no shake at all
    const shakeAttenuationFor = (worldX: number, worldY: number): number => {
      if (!localFighter || localFighter.eliminated) return 1;
      const dist = Math.hypot(worldX - localFighter.x, worldY - localFighter.y);
      if (dist <= SHAKE_FULL_RADIUS) return 1;
      if (dist >= SHAKE_ZERO_RADIUS) return 0;
      return 1 - (dist - SHAKE_FULL_RADIUS) / (SHAKE_ZERO_RADIUS - SHAKE_FULL_RADIUS);
    };

    for (const hit of frame.hitEffects ?? []) {
      const screen = worldToScreen(hit.worldX, hit.worldY, cam, vw, vh);
      // Direction is a vector, not a point: flip Y (world Y-up -> screen
      // Y-down) without translating.
      this.effects.spawnHit({
        x: screen.x,
        y: screen.y,
        dirX: hit.dirX,
        dirY: -hit.dirY,
        strength: hit.strength,
        shakeAttenuation: shakeAttenuationFor(hit.worldX, hit.worldY),
      });
      this.effects.flashFighter(hit.fighterIndex, hit.strong);
    }
    for (const elim of frame.eliminationEffects ?? []) {
      const screen = worldToScreen(elim.worldX, elim.worldY, cam, vw, vh);
      this.effects.spawnElimination(screen.x, screen.y, shakeAttenuationFor(elim.worldX, elim.worldY));
    }

    // Freeze-frame: hold the last drawn picture for a few milliseconds on
    // a strong hit. This never touches the sim -- it just skips this
    // render() call's redraw, so whatever was on screen a moment ago
    // stays there. Shake/particle timers still advance underneath so the
    // freeze blends into the shake rather than looking like a stall.
    if (this.freezeRemainingMs > 0) {
      this.freezeRemainingMs -= dtMs;
      this.effects.update(dtMs);
      return;
    }

    const shake = this.effects.update(dtMs);
    this.world.position.set(shake.x, shake.y);

    // Backdrop is drawn inside drawStage itself, onto this same
    // stageLayer, first -- see stage.ts's drawBackdrop call and its
    // comment for why a separate layer didn't work in this renderer.
    // `now` (wall-clock, from the top of this method) and reduced-motion
    // are the only backdrop inputs -- never sim ticks, never fed back
    // into anything.
    drawStage(this.stageLayer, stageForDraw, cam, vw, vh, frame.previewArenaBounds, this.attractFraming, now, isCameraReducedMotion());

    const badgeCandidates: BadgeCandidate[] = [];
    const bodyBoxes: BodyBox[] = [];
    // Slow-frame attribution (2026-09-15, see docs/MEASUREMENT.md
    // "Slow-frame attribution"): plain counters bumped inline in a loop
    // this method already runs every frame regardless -- no extra
    // iteration, no allocation.
    let fightersAlive = 0;
    let fightersOnScreen = 0;
    for (let i = 0; i < frame.fighters.length; i++) {
      const f = frame.fighters[i] as RenderFighterState;
      const sprite = this.sprites[i] as FighterSprite;
      if (f.eliminated) {
        sprite.root.visible = false;
        this.effects.resetTrail(i);
        continue;
      }
      fightersAlive += 1;
      sprite.root.visible = true;
      const screen = worldToScreen(f.x, f.y, cam, vw, vh);
      if (screen.x >= 0 && screen.x <= vw && screen.y >= 0 && screen.y <= vh) fightersOnScreen += 1;
      sprite.root.position.set(screen.x, screen.y);
      sprite.root.scale.set(cam.scale); // silhouette is drawn in world units
      this.effects.trailFighter(i, screen.x, screen.y, f.hitstun > 0);
      const char = frame.characters[i] as CharacterData | undefined;
      const isLocalPlayer = frame.localPlayerIndex === i;
      // Intro emphasis: dim everyone except the local fighter for the
      // first INTRO_EMPHASIS_MS after announceLocalPlayer() was called,
      // easing back to full opacity. See the field doc above.
      sprite.root.alpha =
        this.introStartMs !== null && !isLocalPlayer
          ? Renderer.INTRO_DIM_ALPHA +
            (1 - Renderer.INTRO_DIM_ALPHA) *
              Math.min(1, (now - this.introStartMs) / Renderer.INTRO_EMPHASIS_MS)
          : 1;
      sprite.draw({
        facing: f.facing,
        hitstun: f.hitstun,
        shieldActive: f.state === FighterStateId.SHIELD,
        shieldHealthFrac: fx.toFloat(f.shieldHealth) / 100,
        isDead: f.state === FighterStateId.DEAD,
        flashAmount: this.effects.flashAmount(i),
        characterName: char?.name,
        state: f.state,
        moveId: f.moveId,
        moveFrame: f.moveFrame,
        character: char,
        anim: char ? resolveAnimation(char.name) : undefined,
        isLocalPlayer,
        edgeDangerFrac: isLocalPlayer ? computeEdgeDangerFrac(f.x, f.y, stageForDraw) : undefined,
      });
      badgeCandidates.push({
        slot: i,
        isLocalPlayer,
        headX: screen.x,
        headY: screen.y - clampHeadOffsetPx(FighterSprite.HEAD_TOP_OFFSET_WORLD * cam.scale),
        // Presentation only: percent already lives on the RenderFighterState
        // snapshot the sim handed this frame -- nothing here reads or
        // derives sim state, it only decides whether/how to draw a number
        // the sim already computed.
        percent: fx.toFloat(f.percent),
      });
      // A generous half-width (BODY_WIDTH alone is the torso; fighters'
      // limbs/hitboxes read wider than that on screen) so a name label
      // is treated as colliding slightly before it visually touches a
      // neighbour, not only once pixels already overlap.
      const bodyHalfWidth = BODY_WIDTH * 1.3 * cam.scale;
      const bodyTopWorld = BODY_HEIGHT + HEAD_RADIUS * 2;
      bodyBoxes.push({
        slot: i,
        left: screen.x - bodyHalfWidth,
        right: screen.x + bodyHalfWidth,
        top: screen.y - bodyTopWorld * cam.scale,
        bottom: screen.y,
      });
    }
    this.lastFrameFightersAlive = fightersAlive;
    this.lastFrameFightersOnScreen = fightersOnScreen;
    this.names = frame.names;
    this.layoutBadges(badgeCandidates, bodyBoxes);
    this.drawLocalDamageReadout(localFighter?.eliminated ? undefined : localFighter?.percent);

    const hazards = frame.hazards ?? [];
    this.ensureHazardPool(hazards.length);
    for (let i = 0; i < hazards.length; i++) {
      const h = hazards[i] as RenderHazardState;
      const sprite = this.hazardSprites[i] as HazardSprite;
      if (!h.active) {
        sprite.root.visible = false;
        continue;
      }
      sprite.root.visible = true;
      const screen = worldToScreen(h.x, h.y, cam, vw, vh);
      sprite.root.position.set(screen.x, screen.y);
      sprite.root.scale.set(cam.scale);
      sprite.draw({
        posX: h.x,
        posY: h.y,
        groundY: mainGroundY(stageForDraw),
        halfWidth: h.halfWidth,
      });
    }

    const items = frame.items ?? [];
    this.ensureItemPool(items.length);
    for (let i = 0; i < items.length; i++) {
      const it = items[i] as RenderItemState;
      const sprite = this.itemSprites[i] as ItemSprite;
      if (!it.active) {
        sprite.root.visible = false;
        continue;
      }
      sprite.root.visible = true;
      const screen = worldToScreen(it.x, it.y, cam, vw, vh);
      sprite.root.position.set(screen.x, screen.y);
      sprite.root.scale.set(cam.scale);
      sprite.draw({
        typeId: it.typeId,
        held: it.held,
        facing: it.holderFacing,
        armed: it.armed,
        fuseTicks: it.fuseTicks,
      });
    }

    if (this.debugOn) {
      const debugInputs: DebugFighterInput[] = frame.fighters
        .map((f, i) => ({ f, i }))
        .filter(({ f }) => !f.eliminated)
        .map(({ f, i }) => ({
          x: f.x,
          y: f.y,
          facing: f.facing,
          state: f.state,
          moveId: f.moveId,
          moveFrame: f.moveFrame,
          percent: f.percent,
          character: frame.characters[i] as CharacterData,
        }));
      drawDebugBoxes(this.debugLayer, debugInputs, cam, vw, vh);
      this.debugText.text = formatDebugText(debugInputs, frame.tick, frame.hash);
    } else {
      this.debugLayer.clear();
    }

    // DEV-ONLY debug freeze trigger: only arms *after* this frame -- which
    // just drew the flash/spark/shake/elimination-ring -- has been fully
    // rendered, so the frozen picture is the effect itself, not the frame
    // before it. See the __debugUnfreeze check near the top of render().
    if (win?.__debugFreezeOnNextEffect && ((frame.hitEffects?.length ?? 0) > 0 || (frame.eliminationEffects?.length ?? 0) > 0)) {
      win.__debugFreezeOnNextEffect = false;
      this.freezeRemainingMs = Number.POSITIVE_INFINITY; // held until __debugUnfreeze is set
    }

    // DEV-ONLY debug freeze trigger: window.__debugFreezeOnAttackActive = true
    // arms a freeze for the first frame, from now on, where any fighter is
    // in the ATTACK state with moveFrame inside that move's real 'active'
    // (hitbox-live) window -- read via the sim's own findMove/windowAtFrame,
    // the exact lookup fighter-pose.ts uses to pose the swing. Exists only
    // to let a slow remote screenshot tool land on the one frame that
    // proves (or disproves) that the animated swing is on-screen while the
    // hitbox is actually live, not before or after it. Inert unless a
    // developer sets the flag from devtools/a debug console; reads frame
    // state only, never writes to the sim, and does not touch the fixed
    // 60Hz advance() cadence -- it only ever holds *rendering* of already-
    // simulated frames, same mechanism as __debugFreezeOnNextEffect above.
    if (win?.__debugFreezeOnAttackActive) {
      for (let i = 0; i < frame.fighters.length; i++) {
        const f = frame.fighters[i];
        if (!f || f.eliminated || f.state !== FighterStateId.ATTACK) continue;
        const character = frame.characters[i] as CharacterData | undefined;
        if (!character) continue;
        const move = findMove(character, f.moveId as never);
        if (!move) continue;
        // sim.ts's resolveHitsFor: moveFrame was already incremented for
        // this tick before hit resolution runs, so the window that was
        // actually live is at (moveFrame - 1), not moveFrame. Match that
        // convention here too or this debug trigger fires one frame late.
        const found = windowAtFrame(move, f.moveFrame - 1);
        if (found?.window.kind === 'active') {
          win.__debugFreezeOnAttackActive = false;
          this.freezeRemainingMs = Number.POSITIVE_INFINITY;
          break;
        }
      }
    }
  }

  isContextLost(): boolean {
    return this.contextLost;
  }

  /** DEV/QA-ONLY: forces a real `webglcontextlost` (and, if called later,
   * a real `webglcontextrestored`) through the same `WEBGL_lose_context`
   * extension a real browser exposes -- see MDN. Reaches into Pixi's
   * renderer.gl, which is not part of Pixi's public API, so this is
   * deliberately isolated to one place rather than spread across test
   * code. Exists so an automated QA pass can prove the real event path
   * end-to-end (not just call the internal handlers directly) without
   * needing actual flaky hardware/driver conditions. Inert for a normal
   * player: nothing in this codebase calls it except a deliberate test. */
  debugForceContextLoss(): void {
    const gl = (this.app.renderer as unknown as { gl?: WebGLRenderingContext | WebGL2RenderingContext })?.gl;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  }

  /** See debugForceContextLoss. Only takes effect if the context is
   * currently actually lost -- WEBGL_lose_context.restoreContext() is a
   * no-op otherwise. */
  debugForceContextRestore(): void {
    const gl = (this.app.renderer as unknown as { gl?: WebGLRenderingContext | WebGL2RenderingContext })?.gl;
    gl?.getExtension('WEBGL_lose_context')?.restoreContext();
  }

  destroy(): void {
    this.parentResizeObserver?.disconnect();
    this.parentResizeObserver = null;
    // Hand the WebGL context back to the browser *now*, explicitly.
    //
    // A browser grants a page only a handful of live contexts (roughly a
    // dozen in Firefox), and dropping the last JavaScript reference to
    // one only queues it for garbage collection at some unspecified later
    // time. Attract mode builds a fresh renderer for every demo cycle, so
    // in a long session the page can hold far more contexts than it is
    // owed; the browser then starts killing the oldest ones ("WebGL
    // context was lost") and refuses new ones, which is how a real match
    // ended up with a renderer that could never draw. WEBGL_lose_context
    // is the only portable way to release one deterministically.
    // Every step here is defensive on purpose. `app.canvas` is a getter
    // that reads through `app.renderer`, and a renderer whose init failed
    // or whose context died has no `renderer` at all -- reading it throws
    // "can't access property canvas, this.renderer is undefined". That
    // threw out of destroy(), out of attract mode's teardown, and out of
    // the caller that was trying to start a real match, so the match never
    // began and the player got a black page. Teardown must never be able
    // to break the thing tearing it down.
    try {
      const canvas: unknown = this.app.renderer ? this.app.canvas : null;
      if (canvas instanceof HTMLCanvasElement) {
        const gl =
          (canvas.getContext('webgl2') as WebGL2RenderingContext | null) ??
          (canvas.getContext('webgl') as WebGLRenderingContext | null);
        if (gl && !gl.isContextLost()) {
          gl.getExtension('WEBGL_lose_context')?.loseContext();
        }
      }
    } catch {
      // Nothing to release, or the browser refused to say. Either way this
      // is a best-effort early return of a context, never a failure.
    }
    try {
      this.app.destroy(true, { children: true });
    } catch {
      // Same reasoning: a half-constructed Pixi application is exactly the
      // case we are cleaning up after.
    }
  }
}
