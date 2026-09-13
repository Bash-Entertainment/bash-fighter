// Flat-shape fighter silhouette, animated by fighter-pose.ts off the
// sim's own state machine. `root` is a thin Container so the pose
// transform (lean/bob/scale) can be applied without touching the
// world-scale set by the caller (camera zoom) -- the caller still does
// `sprite.root.position.set(...)` and `sprite.root.scale.set(cam.scale)`
// exactly as before; everything pose-driven lives on the `body` child.
import { Container, Graphics } from 'pixi.js';
import { PALETTE } from './palette.ts';
import { drawSilhouetteForCharacter } from './silhouette-dispatch.ts';
import { BODY_WIDTH, BODY_HEIGHT, HEAD_RADIUS } from './fighter-shape-placeholder.ts';
import { computePose, NEUTRAL_POSE, type Pose, type PoseInput } from './fighter-pose.ts';
import type { AnimationParams } from '@bash-fighter/content';
import type { CharacterData, FighterStateValue } from '@bash-fighter/sim';

export interface FighterVisualState {
  facing: 1 | -1;
  hitstun: number;
  shieldActive: boolean;
  shieldHealthFrac: number; // 0..1
  isDead: boolean;
  /** 0..1, driven by EffectsLayer.flashAmount(fighterIndex) -- how far
   * through the post-hit flash this fighter currently is. 0 = normal
   * colour. Purely presentational; never read by the sim. */
  flashAmount?: number;
  /** CharacterData.name for this fighter, if known. Additive: selects an
   * alternate silhouette (see fighter-shape-ballast.ts) for characters
   * other than the placeholder capsule. Undefined/unknown falls back to
   * the default capsule-plus-head shape below. */
  characterName?: string;
  /** State machine + animation inputs, all optional so existing callers
   * (and tests) that only care about tint/shield keep working: without
   * these the sprite falls back to a static NEUTRAL_POSE, same as
   * before this file grew an animation system. */
  state?: FighterStateValue;
  stateTicks?: number;
  moveId?: number;
  moveFrame?: number;
  character?: CharacterData;
  anim?: AnimationParams;
  /** True for exactly one fighter per local client: the player's own.
   * Draws a persistent marker above the fighter that survives a 20-player
   * crowd. Presentation-only -- never read by the sim, never sent over
   * the wire. */
  isLocalPlayer?: boolean;
  /** 0 = comfortably inside the blast-zone boundary, 1 = at or past it.
   * Only ever meaningful (and only ever set by the app layer) for the
   * local player's own fighter -- this is the "you personally are about
   * to die" cue, deliberately not a generic screen-wide effect, so a
   * player connects the warning to their own position on the stage
   * rather than a vignette they have to interpret. Presentation-only:
   * derived from the already-broadcast blast rect and fighter position,
   * never fed back into the sim. */
  edgeDangerFrac?: number;
}

// World units, not pixels — the root container is scaled by the camera's
// pixels-per-unit factor, same as everything else drawn in the arena.
// Sized to read clearly against a stage a few hundred units wide rather
// than to match the sim's (much smaller) hurtbox exactly; the debug
// overlay is what shows the real hurtbox.
function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

export class FighterSprite {
  readonly root = new Container();
  private readonly body = new Graphics();
  private readonly shieldGfx = new Graphics();
  private readonly bodyColor: number;

  // Render-side-only bookkeeping for animation phase: which sim state we
  // were in last draw() and how many consecutive draws we've been in it.
  // This never feeds back into the sim; it just lets idle/run/attack
  // cycles restart cleanly whenever the fighter's state changes.
  private lastState: FighterStateValue | undefined;
  private stateTicks = 0;

  private readonly localMarker = new Graphics();
  private readonly edgeWarning = new Graphics();

  // Render-only pulse clock for the edge-danger ring (see draw()). Ticks
  // once per draw() call, never read by the sim, never synced across
  // clients -- purely local screen timing, same category as stateTicks
  // above.
  private pulseTicks = 0;

  constructor(playerIndex: number) {
    this.bodyColor = PALETTE.playerColors[playerIndex % PALETTE.playerColors.length] as number;
    this.root.addChild(this.body);
    this.root.addChild(this.shieldGfx);
    this.root.addChild(this.localMarker);
    this.root.addChild(this.edgeWarning);
  }

  draw(state: FighterVisualState): void {
    if (state.isDead) {
      this.root.visible = false;
      return;
    }
    this.root.visible = true;

    if (state.state !== undefined) {
      if (state.state !== this.lastState) {
        this.stateTicks = 0;
        this.lastState = state.state;
      } else {
        this.stateTicks += 1;
      }
    }

    const pose: Pose =
      state.state !== undefined && state.character !== undefined && state.anim !== undefined
        ? computePose({
            state: state.state,
            stateTicks: this.stateTicks,
            moveId: state.moveId ?? -1,
            moveFrame: state.moveFrame ?? 0,
            hitstun: state.hitstun,
            facing: state.facing,
            character: state.character,
            anim: state.anim,
          } satisfies PoseInput)
        : NEUTRAL_POSE;

    this.body.rotation = pose.bodyLean;
    this.body.scale.set(pose.bodyScaleX, pose.bodyScaleY);
    this.body.position.set(0, -pose.bodyBob);

    const g = this.body;
    g.clear();

    // Base tint: danger-red while in hitstun (existing behaviour), else
    // the fighter's own colour blended toward a bright flash colour for
    // the brief post-hit window -- the flash reads as "impact" even after
    // hitstun itself has ended (hitstun on a light jab can be very short).
    const flash = state.flashAmount ?? 0;
    const baseTint = state.hitstun > 0 ? PALETTE.danger : this.bodyColor;
    const tint = flash > 0 ? lerpColor(baseTint, PALETTE.hud, flash * 0.85) : baseTint;

    drawSilhouetteForCharacter(g, tint, state.facing, pose, state.characterName);

    this.shieldGfx.clear();
    if (state.shieldActive) this.drawShieldBubble(state);

    this.localMarker.clear();
    if (state.isLocalPlayer) this.drawLocalMarker();

    this.pulseTicks += 1;
    this.edgeWarning.clear();
    const danger = state.isLocalPlayer ? (state.edgeDangerFrac ?? 0) : 0;
    if (danger > 0) this.drawEdgeWarning(danger);
  }

  /** World-space head-top offset used by the screen-space slot-number
   * badge layer (see packages/render/src/index.ts) so the badge can be
   * anchored to this fighter's own head without duplicating the body
   * measurements here. */
  static readonly HEAD_TOP_OFFSET_WORLD = BODY_HEIGHT + HEAD_RADIUS * 2;

  /** A thin flat ring around the local player's own feet -- the
   * close-range "this one is you" confirmation. This used to be paired
   * with a small chevron drawn above the head in this same *world*
   * space, but that chevron was sized in world units and scaled down
   * by camera zoom exactly like the fighter's own body: at true
   * 20-fighter zoom on a wide stage it shrank to a few illegible
   * pixels, which is exactly the readability gap a real player
   * reported ("which one is me"). The long-range, zoom-proof version of
   * that cue is now the screen-space pointer drawn once, above the
   * local player's badge, by Renderer.drawLocalPointer in index.ts
   * (constant pixel size, unaffected by cam.scale) -- this ring is kept
   * only as the close-range subtle treatment, since up close it never
   * needed to fight camera zoom in the first place. No colour, glow, or
   * animation, so it can't be mistaken for game state. */
  private drawLocalMarker(): void {
    const m = this.localMarker;
    m.circle(0, -1, BODY_WIDTH * 0.85);
    m.stroke({ color: PALETTE.hud, width: 2, alpha: 0.9 });
  }

  /** Pulsing ring around the local player's own fighter as they approach,
   * then cross, the blast-zone boundary. `danger` is 0..1: rises from 0
   * starting a fixed world-distance out from the boundary, hits 1 right
   * at the line, and stays 1 while actually outside it (still taking
   * blast-zone damage). Colour shifts amber -> red and the pulse speeds
   * up as danger rises, so the escalation itself carries information,
   * not just a static icon. Tied to the fighter's own screen position
   * (not a full-screen flash) so a player in a 20-fighter crowd knows
   * unambiguously that it's *them* the warning is about. */
  private drawEdgeWarning(danger: number): void {
    const clamped = Math.min(1, danger);
    const color = clamped < 1 ? PALETTE.hazardWarning : PALETTE.danger;
    const pulseHz = 1.5 + clamped * 3.5; // calmer near the threshold, frantic once outside
    const pulse = 0.5 + 0.5 * Math.sin(this.pulseTicks * (pulseHz * 0.1));
    const radius = BODY_WIDTH * 1.35;
    const alpha = 0.35 + 0.45 * clamped + 0.2 * pulse * clamped;
    this.edgeWarning.circle(0, -BODY_HEIGHT / 2, radius);
    this.edgeWarning.stroke({ color, width: 3 + 2 * clamped, alpha });
  }

  private drawShieldBubble(state: FighterVisualState): void {
    const r = BODY_WIDTH * 0.95;
    this.shieldGfx.circle(0, -BODY_HEIGHT / 2, r);
    this.shieldGfx.stroke({ color: PALETTE.hud, width: 2, alpha: 0.5 + 0.5 * state.shieldHealthFrac });
    this.shieldGfx.fill({ color: PALETTE.hud, alpha: 0.08 + 0.1 * state.shieldHealthFrac });
  }
}
