// Glue: owns the Sim, the InputManager, and the Renderer, and drives them
// from the fixed-timestep loop. Iterates fighters by this.sim.numFighters (
// the sim) rather than assuming 2, so the app layer isn't what blocks a
// future N-fighter sim.
import {
  Sim,
  fixed as fx,
  hashStateBuffer,
  MAX_ITEMS,
  MAX_HAZARDS,
  botName,
  type StateBuffer,
  type CharacterData,
  type FighterSnapshot,
  type ItemSnapshot,
  type HazardSnapshot,
  type InputFrame,
  type MatchSettings,
  DEFAULT_ARENA,
} from '@bash-fighter/sim';
import { buildLocalBots, buildTickInputs, type BotController } from './local-crowd-bots.ts';
import { PLACEHOLDER_CHARACTER, createMatchSim, pickArenaId } from '@bash-fighter/content';
import { InputManager } from '@bash-fighter/input';
import {
  Renderer,
  arenaDataToStageBounds,
  computeEdgeDangerFrac,
  type RenderFighterState,
  type RenderItemState,
  type RenderHazardState,
  type RenderFrame,
  type StageBounds,
} from '@bash-fighter/render';
import { FixedTimestepLoop } from './loop.ts';
import { AudioManager } from '@bash-fighter/audio';
import { detectFighterEvents, detectItemEvents } from './effects-events.ts';
import { EffectsAudioBridge } from './effects-audio.ts';
import { currentArenaBounds, previewArenaBounds } from './arena-preview.ts';

// Item HELD state id (mirrors packages/sim/src/sim.ts's private ItemState
// enum: 0=world, 1=held, 2=thrown, 3=armed). Not exported by the sim
// package, so duplicated here as a stable numeric constant rather than
// widening the sim's public surface for a render-only concern.
const ITEM_STATE_HELD = 1;
const ITEM_STATE_ARMED = 3;

// Stylized world-unit marker size for the hazard's ground-impact
// indicator — matches the general scale FighterSprite/ItemSprite use
// (BODY_WIDTH=14), not a pixel-exact readout of the sim's hazard hitbox.
const HAZARD_MARKER_HALF_WIDTH = 11;

// Kept for callers (main.ts's spectator fallback arena) that need a
// StageBounds before any Match/Sim exists. The Match instance itself
// always derives its Renderer's StageBounds from the actual Sim's arena
// below (this.sim.getArena()), never from this constant, so a match built
// with a different arena still renders correctly.
export const STAGE_BOUNDS: StageBounds = arenaDataToStageBounds(DEFAULT_ARENA);

export interface MatchEvents {
  onStockLost?(fighterIndex: number, stocksRemaining: number): void;
  /** leaderboard is slots best-to-worst (Sim.getLeaderboard()) and
   * settings is this match's resolved MatchSettings -- both needed by
   * main.ts to tell a Timed Brawl finish from a Battle Royale one and
   * show the right end screen (see timed-brawl.ts, TimedBrawlEndScreen). */
  onMatchOver?(winnerIndex: number | null, leaderboard?: readonly number[], settings?: MatchSettings): void;
  /** Runs right before a frame is handed to the renderer. Lets the app
   * layer (spectator camera, elimination flags) rewrite the frame
   * without the Match/Renderer needing to know about spectate policy. */
  transformFrame?(frame: RenderFrame): RenderFrame;
  /** Fired once when the canvas's WebGL context is lost (see
   * packages/render/src/index.ts's Renderer.onContextLost) -- the sim
   * keeps ticking underneath regardless, this is presentation-only. */
  onContextLost?(): void;
  /** Fired once if/when the browser restores the context. */
  onContextRestored?(): void;
  /** Fired once if, a few seconds after the match started, the renderer
   * has not genuinely presented a single frame -- see Renderer.
   * getFramesPresented and the watchdog in start() below. Covers the
   * case webglcontextlost/restored cannot: a renderer that never
   * becomes able to draw in the first place (dead/blocklisted GPU
   * context, WebGL exhausted after a prior context died), which our own
   * contextLost flag has no event to catch. Never fires if onContextLost
   * already did, for the same underlying failure -- see start(). */
  onRenderStalled?(): void;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Runs one local match: fixed 60Hz sim + interpolated render + input
 * sampling. Fighter count comes from this.sim.numFighters, read once, not 2
 * literals scattered through this file. */
export class Match {
  readonly sim: Sim;
  readonly characters: CharacterData[];
  readonly input = new InputManager();
  readonly renderer: Renderer;
  private readonly loop: FixedTimestepLoop;
  private prevSnapshots: FighterSnapshot[];
  private currSnapshots: FighterSnapshot[];
  private prevItemSnapshots: ItemSnapshot[];
  private currItemSnapshots: ItemSnapshot[];
  private prevHazardSnapshots: HazardSnapshot[];
  private currHazardSnapshots: HazardSnapshot[];
  private lastStocks: number[];
  private over = false;
  private pendingEvents: import('./effects-events.ts').EffectEvent[] = [];
  // Debounce for the boundary-danger sound: only fires on the falling->
  // rising crossing of the threshold, never continuously while inside the
  // danger band (a player standing at the edge would otherwise get a
  // sound every frame -- the opposite of useful signal).
  private edgeDangerSounding = false;
  private ringDamageAudioCooldownTicks = 0;
  private readonly hashBuf: StateBuffer;

  private readonly numFighters: number;
  readonly audio: AudioManager;
  private readonly effectsBridge: EffectsAudioBridge;
  private readonly bots: Map<number, BotController>;
  // Local-play equivalent of NetMatch's server-broadcast names[] (see
  // packages/app/src/net-match.ts and the Player Names 2026-09-11 wiki
  // page): a local/?crowd20=1 match has no server to hand out names, so
  // bot slots get the same botName(slot) the server itself uses
  // (packages/sim/src/ai/bot.ts) and human slots are left unnamed --
  // matching how the local HUD/badges already read for a human ("#1",
  // no name line) before this feature existed. This is what makes
  // ?crowd20=1 a genuine stand-in for a crowded online match when
  // checking name-label legibility, rather than a silent no-op.
  private readonly names: string[];

  constructor(
    parent: HTMLElement,
    characters: CharacterData[] = new Array(2).fill(PLACEHOLDER_CHARACTER),
    seed: number = 1,
    private readonly events: MatchEvents = {},
    sim?: Sim,
    audio: AudioManager = new AudioManager(),
    // Local play (the 2-keyboard harness and the ?crowd20=1 debug/QA
    // harness alike) never had bot input sources: InputManager.poll()
    // always returns exactly 2 InputFrames (one per local slot), so any
    // extra fighter slots got no InputFrame at all and Sim.advance()
    // threw "expected N inputs, got 2" the moment a match had more than
    // 2 fighters -- this is exactly what made ?crowd20=1 throw every
    // tick. humanSlotCount says how many of the leading fighter slots
    // are driven by InputManager (2 for local play); every slot at or
    // beyond it gets a BotController, deterministically seeded from the
    // match seed exactly like the server does (see server/src/match.ts),
    // so a crowd match is reproducible for a given seed.
    humanSlotCount: number = 2,
    // Dev/QA override only (see ?arena=<id> in main.ts and issue #19):
    // pins this local match's stage instead of deriving it from the seed.
    // Ignored (stays seed-derived) when omitted/null, so this changes
    // nothing about ordinary local play or online play (which threads its
    // own server-assigned arenaId through a different path entirely).
    arenaIdOverride?: string | null,
    // Dev/QA override only (local-crowd Timed Brawl testing, see
    // ?mode=timedKO&timeLimit=<seconds> in main.ts and
    // docs/LOCAL_CROWD_TESTING.md): lets a local match run any
    // MatchSettings the sim supports instead of always defaulting to
    // battleRoyale. Ignored (stays battleRoyale) when omitted, so this
    // changes nothing about ordinary local play.
    settingsOverride?: Partial<MatchSettings>,
  ) {
    this.characters = characters;
    this.audio = audio;
    this.effectsBridge = new EffectsAudioBridge(audio);
    // Local play: the human is always fighter slot 0 by convention (the
    // rest are bots) -- see InputManager wiring below.
    this.effectsBridge.setContext(characters, 0);
    // Local play must build its Sim through the same sanctioned path the
    // server and online clients use (createMatchSim) so it exercises the
    // real item set, hazard config, and arena resolution instead of the
    // bare Sim defaults -- see packages/content/src/match-sim.ts. Local
    // matches have no server dictating an arenaId, so we pick one
    // deterministically from the seed via the same pickArenaId helper the
    // server uses for its own random-arena selection, keeping local play
    // varied but reproducible for a given seed.
    this.sim = sim ?? createMatchSim(seed, characters.length, settingsOverride, characters, arenaIdOverride ?? pickArenaId(seed));
    this.numFighters = this.sim.numFighters;
    // Bot-fill every slot InputManager doesn't drive. Same construction
    // the server uses per-seat (BotDifficulty.EASY, matching production's
    // actual difficulty -- see "Bot Difficulty Correction" -- and
    // deriveBotSeed(seed, slot) for determinism), just decided locally by
    // slot index instead of a per-seat isBot flag.
    this.bots = buildLocalBots(seed, this.numFighters, humanSlotCount);
    this.names = Array.from({ length: this.numFighters }, (_, slot) => (this.bots.has(slot) ? botName(slot) : ''));
    this.renderer = new Renderer(arenaDataToStageBounds(this.sim.getArena()));
    this.prevSnapshots = this.snapshotAll();
    this.currSnapshots = this.snapshotAll();
    this.prevItemSnapshots = this.snapshotItems();
    this.currItemSnapshots = this.snapshotItems();
    this.prevHazardSnapshots = this.snapshotHazards();
    this.currHazardSnapshots = this.snapshotHazards();
    this.lastStocks = this.currSnapshots.map((s) => s.stocks);
    this.hashBuf = this.sim.createStateBuffer();
    this.loop = new FixedTimestepLoop(
      () => this.tick(),
      (alpha) => this.renderFrame(alpha),
    );
    void parent;
  }

  async init(parent: HTMLElement): Promise<void> {
    this.renderer.onContextLost = () => this.events.onContextLost?.();
    this.renderer.onContextRestored = () => this.events.onContextRestored?.();
    await this.renderer.init(parent);
    // QA/automation hook only, mirrors the existing window.__debug*
    // convention in packages/render -- lets a browser-automation pass
    // force/verify a real webglcontextlost/restored round trip via
    // Renderer.debugForceContextLoss/Restore. Inert for a real player:
    // nothing in this codebase reads this global on its own.
    if (typeof window !== 'undefined') (window as unknown as Record<string, unknown>).__debugRenderer = this.renderer;
    this.input.attach(window);
  }

  // A slow-but-working device must never see this: the grace period is
  // generous (several seconds) and the trigger condition is "literally
  // zero frames drawn", not "few" -- a device managing even a single
  // frame in that window cancels it. Tuned against the watchdog test in
  // packages/app/test/webgl-context-loss.test.ts.
  private static readonly RENDER_WATCHDOG_MS = 6000;
  private renderWatchdogTimer: ReturnType<typeof setTimeout> | null = null;

  start(): void {
    this.loop.start();
    this.renderWatchdogTimer = setTimeout(() => {
      this.renderWatchdogTimer = null;
      // If onContextLost already fired for this renderer, that is the
      // same underlying failure by a different route -- do not also fire
      // onRenderStalled and do not show a second overlay for it (see
      // main.ts's showContextLostOverlay callers).
      if (this.renderer.isContextLost()) return;
      if (this.renderer.getFramesPresented() === 0) this.events.onRenderStalled?.();
    }, Match.RENDER_WATCHDOG_MS);
  }

  stop(): void {
    this.loop.stop();
    this.input.detach(window);
    if (this.renderWatchdogTimer !== null) {
      clearTimeout(this.renderWatchdogTimer);
      this.renderWatchdogTimer = null;
    }
  }

  setDebug(on: boolean): void {
    this.renderer.setDebug(on);
  }

  toggleDebug(): void {
    this.renderer.setDebug(!this.renderer.isDebug());
  }

  private snapshotAll(): FighterSnapshot[] {
    const out: FighterSnapshot[] = [];
    for (let i = 0; i < this.numFighters; i++) out.push(this.sim.getFighter(i));
    return out;
  }

  private snapshotItems(): ItemSnapshot[] {
    const out: ItemSnapshot[] = [];
    for (let i = 0; i < MAX_ITEMS; i++) out.push(this.sim.getItem(i));
    return out;
  }

  private snapshotHazards(): HazardSnapshot[] {
    const out: HazardSnapshot[] = [];
    for (let i = 0; i < MAX_HAZARDS; i++) out.push(this.sim.getHazard(i));
    return out;
  }

  private tick(): void {
    if (this.over) return;
    const polled: InputFrame[] = this.input.poll();
    const inputs: InputFrame[] = buildTickInputs(this.sim, polled, this.bots, this.numFighters);
    this.sim.advance(inputs);

    this.prevSnapshots = this.currSnapshots;
    this.currSnapshots = this.snapshotAll();
    this.prevItemSnapshots = this.currItemSnapshots;
    this.currItemSnapshots = this.snapshotItems();
    this.prevHazardSnapshots = this.currHazardSnapshots;
    this.currHazardSnapshots = this.snapshotHazards();

    const fighterEvents = detectFighterEvents(this.prevSnapshots, this.currSnapshots, this.numFighters);
    const itemEvents = detectItemEvents(this.prevItemSnapshots, this.currItemSnapshots, MAX_ITEMS);
    this.pendingEvents.push(...fighterEvents, ...itemEvents);

    for (let i = 0; i < this.numFighters; i++) {
      const stocks = (this.currSnapshots[i] as FighterSnapshot).stocks;
      if (stocks < (this.lastStocks[i] as number)) {
        this.events.onStockLost?.(i, stocks);
      }
      this.lastStocks[i] = stocks;
    }

    if (this.sim.isMatchOver() && !this.over) {
      this.over = true;
      this.events.onMatchOver?.(this.sim.getWinner(), this.sim.getLeaderboard(), this.sim.getMatchSettings());
    }
  }

  private renderFrame(alpha: number): void {
    const fighters: RenderFighterState[] = [];
    for (let i = 0; i < this.numFighters; i++) {
      const prev = this.prevSnapshots[i] as FighterSnapshot;
      const curr = this.currSnapshots[i] as FighterSnapshot;
      fighters.push({
        x: lerp(fx.toFloat(prev.posX), fx.toFloat(curr.posX), alpha),
        y: lerp(fx.toFloat(prev.posY), fx.toFloat(curr.posY), alpha),
        facing: curr.facing,
        state: curr.state,
        moveId: curr.moveId,
        moveFrame: curr.moveFrame,
        percent: curr.percent,
        stocks: curr.stocks,
        shieldHealth: curr.shieldHealth,
        hitstun: curr.hitstun,
        eliminated: curr.eliminated,
        inRingDanger: curr.inRingDanger,
      });
    }
    const items: RenderItemState[] = [];
    for (let i = 0; i < MAX_ITEMS; i++) {
      const prev = this.prevItemSnapshots[i] as ItemSnapshot;
      const curr = this.currItemSnapshots[i] as ItemSnapshot;
      if (!curr.active) {
        items.push({ active: false, typeId: 0, x: 0, y: 0, held: false, holderFacing: 1, armed: false, fuseTicks: 0 });
        continue;
      }
      const held = curr.state === ITEM_STATE_HELD;
      // Held items snap to the holder's interpolated position instead of
      // lerping the item's own prev/curr (which jump when pickup/drop
      // changes ownership) so they never visually detach from the hand.
      let x: number;
      let y: number;
      let holderFacing: 1 | -1 = 1;
      if (held && curr.holder >= 0 && curr.holder < this.numFighters) {
        const hf = fighters[curr.holder] as RenderFighterState;
        x = hf.x;
        y = hf.y;
        holderFacing = hf.facing;
      } else if (prev.active) {
        x = lerp(fx.toFloat(prev.posX), fx.toFloat(curr.posX), alpha);
        y = lerp(fx.toFloat(prev.posY), fx.toFloat(curr.posY), alpha);
      } else {
        x = fx.toFloat(curr.posX);
        y = fx.toFloat(curr.posY);
      }
      items.push({
        active: true,
        typeId: curr.typeId,
        x,
        y,
        held,
        holderFacing,
        armed: curr.state === ITEM_STATE_ARMED,
        fuseTicks: curr.fuse,
      });
    }

    const hazards: RenderHazardState[] = [];
    for (let i = 0; i < MAX_HAZARDS; i++) {
      const prev = this.prevHazardSnapshots[i] as HazardSnapshot;
      const curr = this.currHazardSnapshots[i] as HazardSnapshot;
      if (!curr.active) {
        hazards.push({ active: false, x: 0, y: 0, halfWidth: HAZARD_MARKER_HALF_WIDTH });
        continue;
      }
      const x = prev.active ? lerp(fx.toFloat(prev.posX), fx.toFloat(curr.posX), alpha) : fx.toFloat(curr.posX);
      const y = prev.active ? lerp(fx.toFloat(prev.posY), fx.toFloat(curr.posY), alpha) : fx.toFloat(curr.posY);
      hazards.push({ active: true, x, y, halfWidth: HAZARD_MARKER_HALF_WIDTH });
    }

    const { hitEffects, eliminationEffects } = this.effectsBridge.consume(this.pendingEvents, this.currSnapshots);
    this.pendingEvents = [];

    // Hazard/boundary danger cue for the local player only (index 0 in
    // local play -- see the EffectsAudioBridge.setContext call above).
    // Debounced on the threshold crossing so it announces "you're now in
    // danger", not a continuous alarm.
    const localSnap = this.currSnapshots[0];
    if (localSnap && !localSnap.eliminated) {
      const liveBounds = currentArenaBounds(this.sim.getCurrentBlastRect());
      const danger = computeEdgeDangerFrac(fx.toFloat(localSnap.posX), fx.toFloat(localSnap.posY), {
        platforms: [],
        blastMinX: liveBounds.minX,
        blastMaxX: liveBounds.maxX,
        blastMinY: liveBounds.minY,
        blastMaxY: liveBounds.maxY,
      });
      const inDanger = danger > 0.6;
      if (inDanger && !this.edgeDangerSounding) this.audio.playHazardWarning(true);
      this.edgeDangerSounding = inDanger;

      // Ring pressure (2026-09-10): the local player is actually taking accumulating
      // out-of-bounds damage, not just approaching the line. Distinct, throttled alarm so it
      // reads as "you are being hurt, move now" rather than a continuous drone.
      if (this.ringDamageAudioCooldownTicks > 0) this.ringDamageAudioCooldownTicks -= 1;
      if (localSnap.inRingDanger && this.ringDamageAudioCooldownTicks <= 0) {
        this.audio.playRingDamage(true);
        this.ringDamageAudioCooldownTicks = 18; // ~0.3s at 60tps: audible as a pulse, not a drone
      }
    }

    // Blast-zone shrink: local 2-human matches (this class) previously
    // never told the Renderer about the live/shrinking rect at all, so
    // it always drew the arena's original, never-shrinking footprint --
    // the arena-shrink sim logic ran correctly underneath but nothing
    // ever became visible. aliveCount comes from the snapshots already
    // built above rather than a new Sim method, since the sim's own
    // aliveCount() is private and this is exactly the count it would
    // return.
    const aliveCount = this.currSnapshots.filter((s) => !s.eliminated).length;
    const blastRect = this.sim.getCurrentBlastRect();

    const frame: RenderFrame = {
      fighters,
      characters: this.characters,
      items,
      hazards,
      tick: this.sim.getTick(),
      hash: this.currentHash(),
      hitEffects,
      eliminationEffects,
      liveArenaBounds: currentArenaBounds(blastRect),
      previewArenaBounds: previewArenaBounds(
        this.sim.getArena(),
        this.sim.getTick(),
        aliveCount,
        this.numFighters,
        this.sim.getMatchSettings(),
      ),
      names: this.names,
    };
    this.renderer.render(this.events.transformFrame ? this.events.transformFrame(frame) : frame);
  }

  currentSnapshots(): readonly FighterSnapshot[] {
    return this.currSnapshots;
  }

  /** True once tick() has fired onMatchOver -- see NetMatch.isOver() for
   * why the hud tick loop in main.ts must check this instead of relying
   * on a "has it started" flag that never reverts. */
  isOver(): boolean {
    return this.over;
  }

  /** Per-slot display names, parallel to NetMatch.displayNames() -- bot
   * seats get botName(slot) (see the constructor), human seats are ''
   * (no local lobby name entry yet). Callers should go through nameFor()
   * for the '#N' fallback rather than indexing this directly. */
  displayNames(): readonly string[] {
    return this.names;
  }

  /** A slot's display name, or its slot label ('#N', 1-based) if that
   * seat has none -- the same fallback rule as NetMatch.nameFor(), kept
   * in one place per side. */
  nameFor(slot: number): string {
    const n = this.names[slot];
    return n && n.length > 0 ? n : `#${slot + 1}`;
  }

  /** This match's resolved settings, for the Timed Brawl clock/end screen
   * gating in main.ts (see isTimedBrawl in timed-brawl.ts). */
  getMatchSettings(): MatchSettings {
    return this.sim.getMatchSettings();
  }

  /** Sim ticks elapsed, for formatClock/ticksRemaining in timed-brawl.ts. */
  get currentTick(): number {
    return this.sim.getTick();
  }

  private currentHash(): string {
    this.sim.saveState(this.hashBuf);
    return hashStateBuffer(this.hashBuf);
  }
}
