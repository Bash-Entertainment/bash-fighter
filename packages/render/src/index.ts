// packages/render: PixiJS/WebGL2 renderer. Reads sim state (already
// interpolated by the caller) and draws it; never mutates sim state.
// Built for N fighters — the sim milestone is fixed at 2, but nothing
// here hardcodes that so the renderer isn't what blocks 20-player FFA.
import { Application, Container, Graphics, Text } from 'pixi.js';
import { fixed as fx, FighterStateId, findMove, windowAtFrame, type CharacterData, type FighterStateValue } from '@bash-fighter/sim';
import { PALETTE, FONT_FAMILY } from './palette.ts';
import { computeCamera, worldToScreen, type ArenaBounds, type CameraConfig, type CameraView } from './camera.ts';
import { drawStage, type StageBounds } from './stage.ts';
import { FighterSprite } from './fighter-sprite.ts';
import { BODY_WIDTH, BODY_HEIGHT, HEAD_RADIUS } from './fighter-shape-placeholder.ts';
import { ItemSprite } from './item-sprite.ts';
import { HazardSprite } from './hazard-sprite.ts';
import { drawDebugBoxes, makeDebugText, formatDebugText, type DebugFighterInput } from './debug-overlay.ts';
import { EffectsLayer } from './effects.ts';
import { resolveAnimation } from '@bash-fighter/content';
import {
  computeBadgePlacements,
  BADGE_FONT_SIZE,
  type BadgeCandidate,
  type BodyBox,
} from './badge-layout.ts';
import { computePopulationAwareFramingFloor } from './framing.ts';

export { RenderItemTypeId } from './item-sprite.ts';
export { EffectsLayer, type HitEffectInput, setReducedMotion, isReducedMotion } from './effects.ts';

export type { StageBounds, StagePlatform } from './stage.ts';
export { arenaDataToStageBounds } from './arena-adapter.ts';
export type { ArenaBounds, CameraView, CameraConfig } from './camera.ts';
export { computeCamera, worldToScreen } from './camera.ts';
export { computeFollowCamera, computeOverviewCamera, SmoothedCamera, type FollowConfig } from './spectator-camera.ts';
export { PALETTE, FONT_FAMILY, UI_FONT_FAMILY } from './palette.ts';
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
): CameraConfig {
  return {
    viewWidth,
    viewHeight,
    minScale: 1.6,
    maxScale: 5.5,
    paddingWorld: 20,
    arena: computePopulationAwareFramingFloor(stage, viewWidth, viewHeight, livingCount),
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
  private readonly debugText = makeDebugText();
  private stageBounds: StageBounds;
  private readonly effects = new EffectsLayer();
  private lastFrameTimeMs: number | null = null;
  // Freeze-frame ("hitstop") state: purely a rendering hold -- the sim
  // keeps advancing at 60Hz underneath regardless. See render()'s early
  // return. Duration is short and capped so it reads as a punch landing,
  // not as lag.
  private freezeRemainingMs = 0;

  constructor(stageBounds: StageBounds) {
    this.stageBounds = stageBounds;
  }

  /** Swap the static arena the renderer draws, e.g. once an online match's
   * real arena (createMatchSim's BATTLE_ROYALE_20_ARENA) is known, after
   * the Renderer had to be constructed earlier with a placeholder. */
  setStageBounds(stageBounds: StageBounds): void {
    this.stageBounds = stageBounds;
  }

  async init(parent: HTMLElement): Promise<void> {
    await this.app.init({
      resizeTo: parent,
      background: PALETTE.background,
      antialias: true,
      preference: 'webgl',
    });
    parent.appendChild(this.app.canvas);

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
    return { width: this.app.renderer.width, height: this.app.renderer.height };
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
    const placements = computeBadgePlacements(candidates, bodyBoxes, this.names);
    let textIndex = 0;
    for (const p of placements) {
      const text = this.badgeTexts[textIndex] as Text;
      textIndex += 1;
      text.text = p.label;
      text.position.set(p.candidate.headX, p.candidate.headY);
      text.visible = true;
      // The local player's own badge gets the same bright fill as the
      // rest for consistency, but a slightly larger size so it is the
      // one badge a player can find at a glance without reading digits.
      text.style.fontSize = p.candidate.isLocalPlayer ? BADGE_FONT_SIZE + 3 : BADGE_FONT_SIZE;
    }
    for (let i = textIndex; i < this.badgeTexts.length; i++) {
      (this.badgeTexts[i] as Text).visible = false;
    }
  }

  render(frame: RenderFrame): void {
    if (!this.ready) return;

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
    const cam =
      frame.cameraOverride ??
      computeCamera(
        fighterPositions,
        this.attractFraming
          ? attractCameraConfig(stageForDraw, vw, vh, fighterPositions)
          : cameraConfig(stageForDraw, vw, vh, liveFighters.length),
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

    for (const hit of frame.hitEffects ?? []) {
      const screen = worldToScreen(hit.worldX, hit.worldY, cam, vw, vh);
      // Direction is a vector, not a point: flip Y (world Y-up -> screen
      // Y-down) without translating.
      this.effects.spawnHit({ x: screen.x, y: screen.y, dirX: hit.dirX, dirY: -hit.dirY, strength: hit.strength });
      this.effects.flashFighter(hit.fighterIndex, hit.strong);
      if (hit.strong) this.freezeRemainingMs = Math.max(this.freezeRemainingMs, 55);
    }
    for (const elim of frame.eliminationEffects ?? []) {
      const screen = worldToScreen(elim.worldX, elim.worldY, cam, vw, vh);
      this.effects.spawnElimination(screen.x, screen.y);
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

    drawStage(this.stageLayer, stageForDraw, cam, vw, vh, frame.previewArenaBounds, this.attractFraming);

    const badgeCandidates: BadgeCandidate[] = [];
    const bodyBoxes: BodyBox[] = [];
    for (let i = 0; i < frame.fighters.length; i++) {
      const f = frame.fighters[i] as RenderFighterState;
      const sprite = this.sprites[i] as FighterSprite;
      if (f.eliminated) {
        sprite.root.visible = false;
        continue;
      }
      sprite.root.visible = true;
      const screen = worldToScreen(f.x, f.y, cam, vw, vh);
      sprite.root.position.set(screen.x, screen.y);
      sprite.root.scale.set(cam.scale); // silhouette is drawn in world units
      const char = frame.characters[i] as CharacterData | undefined;
      const isLocalPlayer = frame.localPlayerIndex === i;
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
    this.names = frame.names;
    this.layoutBadges(badgeCandidates, bodyBoxes);

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

  destroy(): void {
    this.app.destroy(true, { children: true });
  }
}
