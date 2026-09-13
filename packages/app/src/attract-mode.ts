// Attract mode: a silent, self-running 20-bot match rendered behind the
// start screen's hero content, so a first-time visitor sees the game
// moving before they decide to press Play. Reuses the exact same Match
// (real Sim via createMatchSim, real Renderer) every real local/online
// match uses -- see docs/LOCAL_CROWD_TESTING.md and ?crowd20=1 for the
// existing dev harness this mirrors -- rather than forking a second sim
// or render path. This file is the *only* thing that decides when that
// background match runs; main.ts just tells it to start/stop.
import { Match } from './match.ts';
import { ALL_CHARACTERS, ALL_ARENAS } from '@bash-fighter/content';
import { AudioManager } from '@bash-fighter/audio';

const NUM_FIGHTERS = 20;

/** Below this CSS width, attract mode never runs (a static frame is
 * shown instead): this is the same 390px-class phone layout the rest of
 * the client treats as narrow (see style.css's mobile breakpoints), and
 * running a 20-fighter sim+render loop for pure decoration is not worth
 * the battery/CPU cost on a phone. */
const NARROW_WIDTH_PX = 700;

function pickArenaIndex(seed: number, count: number): number {
  return Math.abs(seed) % count;
}

function randomSeed(): number {
  return (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) & 0xffffffff;
}

/** True when either the OS-level `prefers-reduced-motion` or the game's
 * own "Reduce screen shake" setting says to avoid animation. Read fresh
 * each time rather than cached: main.ts's reducedMotionPref can change
 * any time the settings panel is open, including while the start screen
 * (and this decision) is on screen. */
export type ReducedMotionSource = () => boolean;

export class AttractMode {
  private match: Match | null = null;
  private running = false;
  private nextArenaAvoid: string | null = null;
  private readonly audio = new AudioManager();

  constructor(
    private readonly parent: HTMLElement,
    private readonly isReducedMotion: ReducedMotionSource,
  ) {
    // Never call audio.initOnGesture(): AudioManager.play() is a safe
    // no-op with no AudioContext (see packages/audio/src/index.ts), so
    // this instance stays silent for the demo's whole life without
    // needing its own mute flag -- and, importantly, without touching
    // the *shared* mute-preference localStorage key AudioManager.
    // setMuted() would write, which would otherwise leak into the real
    // game's mute setting.
  }

  /** True if the viewport is currently narrow enough that attract mode
   * should not run at all (phone-class width). Public so main.ts's
   * resize/orientation handling can decide whether to (re)start. */
  static isNarrowViewport(): boolean {
    return window.innerWidth < NARROW_WIDTH_PX;
  }

  private buildCharacters() {
    return Array.from(
      { length: NUM_FIGHTERS },
      (_, i) => (ALL_CHARACTERS[i % ALL_CHARACTERS.length] as (typeof ALL_CHARACTERS)[number]).character,
    );
  }

  private pickArenaId(seed: number): string {
    const ids = ALL_ARENAS.map((a) => a.id);
    let id = ids[pickArenaIndex(seed, ids.length)] as string;
    // "a different stage" (task requirement) -- avoid repeating the
    // immediately previous arena when there's more than one to choose
    // from, so a visitor who lingers through one full match sees an
    // actual change, not the same stage reseeded.
    if (ids.length > 1 && id === this.nextArenaAvoid) {
      id = ids[(ids.indexOf(id) + 1) % ids.length] as string;
    }
    this.nextArenaAvoid = id;
    return id;
  }

  /** Starts (or restarts) the animated background match. No-op if
   * already running -- callers don't need to track that themselves. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.spawnMatch();
  }

  private async spawnMatch(): Promise<void> {
    if (!this.running) return;
    this.destroyMatch();
    const seed = randomSeed();
    const arenaId = this.pickArenaId(seed);
    const characters = this.buildCharacters();
    const match = new Match(
      this.parent,
      characters,
      seed,
      {
        onMatchOver: () => {
          // Resolved matches (occasionally a mass wipe in a few
          // seconds -- see "Arena Collapse Cascade") should not leave a
          // frozen last frame sitting behind the hero content; start a
          // fresh one with a new seed/stage immediately so repeat
          // visitors see variety, per the task's requirement.
          void this.spawnMatch();
        },
      },
      undefined,
      this.audio,
      // humanSlotCount: 0 -- every one of the 20 slots is bot-controlled,
      // deterministically seeded from `seed` exactly like a real crowd
      // match (see buildLocalBots in local-crowd-bots.ts). There is no
      // local player, so InputManager.attach() below never needs any
      // real input to make the match run.
      0,
      arenaId,
    );
    this.match = match;
    await match.init(this.parent);
    match.renderer.setShowBadges(false);
    match.renderer.setDebug(false);
    if (this.isReducedMotion()) {
      // Reduced motion: render a handful of frames so the bots have
      // settled into a natural pose, then freeze -- a static picture of
      // the game, not an animated match. The loop is rAF-driven, so
      // stopping it synchronously right after start() would cancel the
      // very first scheduled frame and leave the canvas blank; a short
      // timeout lets a few real frames render first, and the canvas
      // simply keeps showing its last-drawn pixels once the loop stops.
      match.start();
      window.setTimeout(() => {
        if (this.match === match) match.stop();
      }, 250);
      return;
    }
    match.start();
  }

  private destroyMatch(): void {
    if (!this.match) return;
    this.match.stop();
    this.match.renderer.destroy();
    this.parent.innerHTML = '';
    this.match = null;
  }

  /** Stops the demo dead: called the instant a real match starts, the
   * tab is hidden, or the viewport becomes narrow. Safe to call whether
   * or not attract mode is currently running. */
  stop(): void {
    this.running = false;
    this.destroyMatch();
  }

  get isRunning(): boolean {
    return this.running;
  }
}
