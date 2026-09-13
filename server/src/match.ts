// One Match = one Sim + one fixed-tick loop + the connected clients playing
// or spectating it. Matches are fully isolated: no shared mutable state
// between matches, no global game instance.
import { randomBytes } from 'node:crypto';
import { Sim, makeInputFrame, type InputFrame, type MatchSettings, type WinCondition } from '@bash-fighter/sim/src/index.ts';
import { BotController, BotDifficulty, deriveBotSeed, type BotDifficultyValue } from '@bash-fighter/sim/src/ai/bot.ts';
import { createMatchSim, resolveCharacterId, DEFAULT_CHARACTER_ID, pickArenaId } from '@bash-fighter/content/src/index.ts';
import { SNAPSHOT_HZ, dedupeName } from '@bash-fighter/net/src/protocol.ts';
import { recordTickDurationMs } from './tick-metrics.ts';
import { PRODUCTION_DEFAULT_BOT_DIFFICULTY_NAME } from './match-defaults.ts';

// --- Reconnection (see wiki "Netcode Design Part 3") ------------------------
// A dropped socket does not remove the fighter from the sim: it keeps being
// simulated on empty (neutral) input, exactly as before reconnection
// existed, because the sim is authoritative and does not need the client to
// keep up. What's new is that the seat stays reclaimable for a bounded grace
// window via an unguessable resume token, instead of being lost the moment
// the socket closes. A laptop sleeping, a phone switching networks, or a
// backgrounded tab is the common case for a browser game, not an edge case.
//
// Deliberately NOT implemented: bot-takeover of an abandoned seat after the
// grace window. The task brief only asks for "release the seat and
// invalidate the token" once the window expires or the fighter is
// eliminated -- it does not ask for the seat to keep playing under AI
// control afterwards, and a design that kept the token alive during a bot
// take-over would conflict with "the token no longer works" after the
// window. Simpler and matches the brief: once released, the seat just sits
// on neutral input like any other un-reclaimed disconnect, same as today.

/** How long a disconnected seat stays reclaimable via its resume token
 *  before it is released (and the token invalidated), leaving the seat
 *  simulating on empty input permanently -- same as an unreclaimed one is
 *  today. Follows the existing MATCH_* env-var pattern. */
export const RECONNECT_GRACE_MS = Number(process.env.MATCH_RECONNECT_GRACE_MS ?? 45_000);

function generateResumeToken(): string {
  // 32 bytes of crypto-grade randomness, hex-encoded: not derivable from
  // the slot number or match id, and not guessable by brute force. This is
  // the ONLY credential that can reclaim a seat -- Match.findReclaimableSeat
  // never accepts a slot number or match id as a substitute.
  return randomBytes(32).toString('hex');
}

/** Resolves the bot difficulty a match should use. PRODUCTION_DEFAULT_
 *  BOT_DIFFICULTY_NAME (server/src/match-defaults.ts) is the single
 *  source of truth and is what every match uses by default.
 *
 *  The MATCH_BOT_DIFFICULTY env var is honoured ONLY when
 *  MATCH_BOT_DIFFICULTY_ALLOW_OVERRIDE=1 is also set. This is
 *  deliberate: on 2026-09-10 a stray `MATCH_BOT_DIFFICULTY=easy` sitting
 *  in the deployed env file silently overrode the code default for an
 *  unknown period, and a prior pass's harness fix assumed (wrongly,
 *  without checking) that the env var was unset in production. Requiring
 *  a second explicit flag makes that class of silent drift impossible:
 *  a one-line env file edit can no longer change production behaviour
 *  by itself. Unknown difficulty names fall back to the code default. */
function botDifficultyFromEnv(): BotDifficultyValue {
  const overrideAllowed = process.env.MATCH_BOT_DIFFICULTY_ALLOW_OVERRIDE === '1';
  const raw = (
    overrideAllowed && process.env.MATCH_BOT_DIFFICULTY
      ? process.env.MATCH_BOT_DIFFICULTY
      : PRODUCTION_DEFAULT_BOT_DIFFICULTY_NAME
  ).toLowerCase();
  if (raw === 'easy') return BotDifficulty.EASY;
  if (raw === 'hard') return BotDifficulty.HARD;
  if (raw === 'medium') return BotDifficulty.MEDIUM;
  return (
    { easy: BotDifficulty.EASY, hard: BotDifficulty.HARD, medium: BotDifficulty.MEDIUM }[
      PRODUCTION_DEFAULT_BOT_DIFFICULTY_NAME
    ] ?? BotDifficulty.EASY
  );
}

export const TICK_HZ = 60;
export const TICK_MS = 1000 / TICK_HZ;
export const SNAPSHOT_EVERY_N_TICKS = Math.round(TICK_HZ / SNAPSHOT_HZ);

export interface Seat {
  slot: number;
  name: string;
  connected: boolean;
  eliminated: boolean;
  /** True for a server-filled AI seat (see RoomManager's bot-fill timer).
   *  A bot seat has no ClientConn/websocket, is never a broadcast watcher,
   *  and its input comes from a BotController rather than the network. */
  isBot: boolean;
  /** Requested character id (from @bash-fighter/content's roster),
   *  resolved to CharacterData when the sim is built in start(). Defaults
   *  to DEFAULT_CHARACTER_ID for bots and for any client that didn't send
   *  one -- see resolveCharacterId's fallback for unknown ids too. */
  characterId: string;
  /** Latest input received for this slot. Empty (neutral) input is used for
   *  ticks where nothing has arrived yet, or once disconnected -- unchanged
   *  from before reconnection existed. */
  pendingInput: InputFrame;
  lastInputTick: number;
  /** Opaque resume token for this seat, or null once released (and never
   *  issued for a bot seat -- there is no human to reconnect). The ONLY way
   *  to reclaim this seat is presenting this exact string back in a
   *  `hello`'s `resume` field; it is never derived from `slot` or the match
   *  id, and is invalidated (set back to null) once the grace window
   *  expires or the fighter is eliminated. */
  resumeToken: string | null;
  /** Wall-clock time (Date.now()) the seat's socket most recently closed,
   *  or null while connected. */
  disconnectedAt: number | null;
}

export type MatchPhase = 'lobby' | 'playing' | 'ended';

export interface MatchEvents {
  /** Fired when the match leaves the lobby and the sim starts. The transport
   *  layer must tell every watcher, otherwise a match started by the lobby
   *  countdown (rather than by filling every slot) begins ticking on the
   *  server while its clients sit forever on "waiting for players". */
  onStart?: () => void;
  /** Fired while the lobby is filling or counting down, so clients see a
   *  countdown that actually moves. */
  onLobbyUpdate?: () => void;
  /** Fired when a disconnected seat's grace window expires and its resume
   *  token is invalidated (releaseSeat). Otherwise a player who comes back
   *  after the grace window has nothing server-side explaining why they
   *  landed in a fresh join instead of their old seat. */
  onSeatGraceExpired?: (slot: number) => void;
  onSnapshot: (tick: number, ackedInputTick: Map<number, number>) => void;
  onEliminated: (slot: number, placement: number, tick: number) => void;
  onMatchEnd: (winner: number | null, leaderboard: number[], tick: number, resolved: boolean) => void;
  //          ^ resolved=true means sim.isMatchOver() decided this naturally
  //          (a real winner, or a genuine simultaneous-KO draw); false
  //          means the match was torn down early because it was abandoned
  //          (no client, playing or spectating, left connected -- see
  //          isAbandoned()) or hit the absolute duration cap -- the sim
  //          result exists but it's an artefact of stopping the clock,
  //          not a fair verdict. The client uses this to decide whether
  //          an already-eliminated player should still be shown a final
  //          result screen (added 2026-09-09, see wiki 'End-of-Match
  //          Screen Missing Entirely').
}

/** Deterministic seed derived from the match id so every client can be
 *  told the same 32-bit seed without trusting Math.random on the wire. */
export function seedFromMatchId(matchId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < matchId.length; i++) {
    h ^= matchId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class Match {
  readonly id: string;
  readonly capacity: number;
  readonly minimum: number;
  phase: MatchPhase = 'lobby';
  seats: Seat[] = [];
  sim: Sim | null = null;
  seed = 0;
  /** Stage this match plays on, chosen once in start() from the match
   *  seed (see pickArenaId) -- server-decided, never client-chosen, and
   *  told to every client via MatchStartMessage.arenaId so a joining or
   *  reconnecting client builds the identical Sim (see match-sim.ts). */
  arenaId = 'battle-royale-20';
  tick = 0;
  // Resolved once in start() and never recomputed -- lets any log line
  // for the rest of this match's life report the difficulty bots were
  // actually given, rather than re-deriving it from env. See
  // botDifficultyFromEnv().
  botDifficulty: BotDifficultyValue | null = null;

  /** Mode this match will run, decided by RoomManager at match-creation
   * time (server/src/mode-rotation.ts) -- before start(), so the lobby
   * message can tell a waiting player the real mode instead of the
   * eventual default. Undefined means "let start() fall back to
   * MATCH_WIN_CONDITION / battleRoyale", which keeps every existing test
   * that constructs a Match directly (without going through
   * RoomManager's rotation) working unchanged. */
  plannedWinCondition?: WinCondition;
  plannedTimeLimitTicks?: number;
  plannedStartingStocks?: number;

  /** What start() will actually pick, computable before start() has run
   * (needed for the lobby message: a waiting player must be told the
   * real mode, not guess it) -- same precedence start() itself applies:
   * an explicit MATCH_WIN_CONDITION env pin wins, then plannedWinCondition
   * from rotation, then the sim default (battleRoyale). */
  effectiveWinCondition(): WinCondition {
    const override = process.env.MATCH_WIN_CONDITION;
    if (override === 'battleRoyale' || override === 'timedKO' || override === 'stocks') return override;
    return this.plannedWinCondition ?? 'battleRoyale';
  }

  effectiveTimeLimitTicks(): number | undefined {
    const timeLimitOverride = process.env.MATCH_TIME_LIMIT_TICKS;
    if (timeLimitOverride) return Number(timeLimitOverride);
    return this.plannedTimeLimitTicks;
  }

  effectiveStartingStocks(): number | undefined {
    const stocksOverride = process.env.MATCH_STARTING_STOCKS;
    if (stocksOverride) return Number(stocksOverride);
    return this.plannedStartingStocks;
  }

  /** Win condition of the currently-running (or most recently run) sim,
   * for the [matchEnd] production log (2026-09-11, Timed Brawl). null
   * before start() has ever run. */
  get winCondition(): string | null {
    return this.sim?.getMatchSettings().winCondition ?? null;
  }

  /** Client-facing match settings for the matchStart message (2026-09-11,
   * Timed Brawl): the protocol's `settings: unknown` field has always been
   * documented as carrying "win condition, stocks, time limit" but every
   * send site left it as an empty object stub. A plain client needs at
   * least winCondition and timeLimitTicks to know whether to render a
   * clock/score HUD instead of an alive count; expose the full resolved
   * MatchSettings so the client can pick whatever else it needs later
   * without another server round trip. null before start() has ever run. */
  getClientSettings(): Record<string, unknown> | null {
    const s = this.sim?.getMatchSettings();
    if (!s) return null;
    return { ...s };
  }
  private bots = new Map<number, BotController>();
  private timer: NodeJS.Timeout | null = null;
  private lastTickAt = 0;
  private accumulatorMs = 0;
  private ended = false;
  endedAt: number | null = null;
  /** Per-slot elimination-cause tracking for production ground-truth
   *  measurement (task: match-duration contradiction, 2026-09-09). Not
   *  used by any gameplay logic -- observability only. lastDamageTick
   *  mirrors the classification method already used by
   *  scripts/arena-shrink-metrics.mjs (damage within COMBAT_WINDOW_TICKS
   *  of elimination = combat; otherwise boundary/other). */
  private lastPercent: number[] = [];
  private lastDamageTick: number[] = [];
  /** Per-slot death-count tracking so a stock-consuming death (stocks mode
   *  only: respawns without eliminating) can be logged exactly once, the
   *  moment DEATH_COUNT increments without ELIMINATED being set. Stocks
   *  mode was previously unverifiable from production logs: the server
   *  only ever logged 'elimination' (stocks exhausted), so a death that
   *  merely burned a stock and respawned left no trace at all. */
  private lastDeathCount: number[] = [];
  private matchStartedAtTick = 0;
  private static readonly COMBAT_WINDOW_TICKS = 60;
  countdownTicksRemaining = -1;
  /** Wall-clock deadline (ms epoch, Date.now() timebase) by which this
   *  match will start even if nobody else joins -- the sooner of the
   *  post-minimum countdown and the lone-player bot-fill grace period,
   *  both set by RoomManager (server/src/rooms.ts) via noteStartDeadline.
   *  null until the first deadline-setting timer starts (e.g. before the
   *  very first seat exists), and after the match has started. Read via
   *  remainingStartTicks() rather than directly, so callers always get a
   *  live value computed from the actual clock instead of a number that
   *  can go stale between broadcasts. */
  startDeadlineAt: number | null = null;
  /** Moves startDeadlineAt to atMs if that is sooner than what's already
   *  recorded (or nothing is recorded yet). Never moves it later: once a
   *  player has been told "starting in Ns", that promise must not
   *  silently slip just because a second, later-firing timer also calls
   *  in. */
  noteStartDeadline(atMs: number): void {
    if (this.startDeadlineAt === null || atMs < this.startDeadlineAt) {
      this.startDeadlineAt = atMs;
    }
  }
  /** Ticks remaining until startDeadlineAt, or -1 if no deadline is set.
   *  Computed from wall-clock time on every call (not decremented on a
   *  timer) so it's correct even if nothing has actively ticked it down
   *  since the deadline was set -- the value a freshly-connecting client
   *  gets is exactly as accurate as one that's been watching all along. */
  remainingStartTicks(): number {
    if (this.startDeadlineAt === null) return -1;
    const msLeft = this.startDeadlineAt - Date.now();
    return Math.max(0, Math.round((msLeft / 1000) * TICK_HZ));
  }
  readonly events: MatchEvents;
  /** How many clients (playing seats or spectators) the transport layer
   *  currently has connected to this match. Set by the transport layer
   *  (server/src/index.ts) whenever its watcher-set for this match id
   *  changes size; defaults to -1 ("unknown / not wired") so unit tests
   *  that construct a Match directly, with no transport layer at all,
   *  keep the simpler human-seat-only abandonment check -- see
   *  isAbandoned(). Once set to a real count (>= 0), that count -- not
   *  human-seat occupancy -- decides abandonment: a match with zero
   *  human seats but one spectator watching (e.g. "Keep spectating"
   *  after elimination) stays alive (2026-09-09, see wiki 'Match
   *  Duration Contradiction: The Spire Firing Squad'). */
  private watcherCount = -1;
  /** Absolute upper bound on match ticks regardless of watcherCount, so a
   *  stuck client, a bot stalemate, or a bug that never lets
   *  sim.isMatchOver() return true can't tie up a Match/CPU slot forever
   *  now that matches may run as long as anyone is watching. 20 minutes
   *  (72000 ticks @ 60Hz) is generously above every observed real match
   *  duration (measured 4.7-10.2 min at the current 6-min shrink clock,
   *  see wiki 'Task #28195'). Overridable for tests. */
  private static readonly MAX_MATCH_TICKS = Number(process.env.MATCH_MAX_DURATION_TICKS ?? 72_000);
  /** slot -> grace-window setTimeout that releases the seat (and its token)
   *  if it fires before a reconnect cancels it. Cleared on reconnect,
   *  elimination, match end, or stop(). */
  private graceTimers = new Map<number, NodeJS.Timeout>();

  constructor(id: string, capacity: number, minimum: number, events: MatchEvents) {
    this.id = id;
    this.capacity = capacity;
    this.minimum = minimum;
    this.events = events;
  }

  get filledSlots(): number {
    return this.seats.length;
  }

  addSeat(name: string, isBot = false, characterId: string = DEFAULT_CHARACTER_ID): Seat {
    const slot = this.seats.length;
    // De-duplicate against every name already in this match (human or
    // bot -- a human called "Rex" showing up alongside a bot already
    // named "Rex" is just as confusing as two humans colliding) so two
    // fighters are never indistinguishable by name alone in the HUD, the
    // win screen, or the elimination log. Empty names (no name chosen)
    // are left alone -- see dedupeName's own comment.
    const dedupedName = dedupeName(name, this.seats.map((s) => s.name));
    const seat: Seat = {
      slot,
      name: dedupedName,
      connected: true,
      eliminated: false,
      isBot,
      characterId,
      pendingInput: makeInputFrame(),
      lastInputTick: -1,
      resumeToken: isBot ? null : generateResumeToken(),
      disconnectedAt: null,
    };
    this.seats.push(seat);
    return seat;
  }

  /** Looks up a seat by resume token. Returns undefined for a wrong/expired/
   *  unknown token, for a bot seat (never issued one), or for a seat that is
   *  currently connected -- a live seat can never be reclaimed out from
   *  under its own player; the caller must reject the newcomer instead of
   *  kicking the incumbent. */
  findReclaimableSeat(token: string): Seat | undefined {
    const seat = this.seats.find((s) => s.resumeToken !== null && s.resumeToken === token && !s.connected);
    if (!seat) return undefined;
    // An eliminated seat has no fighter left to hand control back to --
    // but only while the match is still running. Once phase is 'ended'
    // there is nothing to reclaim control of anyway (the caller reports
    // the outcome instead, see handleResume), so an eliminated seat's
    // token must keep working for that.
    if (seat.eliminated && this.phase !== 'ended') return undefined;
    // The grace-window setTimeout in markDisconnected is the seat's primary
    // expiry mechanism, but a JS timer is only guaranteed to fire no
    // earlier than its delay -- under event-loop load it can fire
    // arbitrarily later. Trusting resumeToken !== null alone therefore lets
    // a token that is already past its grace window still be honoured if
    // the timer callback simply hasn't run yet. Re-check elapsed wall-clock
    // time here so expiry is correct regardless of scheduler lag, and
    // self-heal by releasing the seat immediately if it is found stale.
    if (seat.disconnectedAt !== null && Date.now() - seat.disconnectedAt >= RECONNECT_GRACE_MS) {
      this.releaseSeat(seat.slot, true);
      return undefined;
    }
    return seat;
  }

  /** Finds a seat by token regardless of connected state, purely so the
   *  transport layer can tell "unknown/expired token" apart from "valid
   *  token, but that seat already has a live connection" (a duplicate
   *  connection racing the original) for a more honest error message.
   *  Excludes seats whose grace window has elapsed even if the release
   *  timer hasn't fired yet, for the same reason as findReclaimableSeat. */
  findSeatByAnyToken(token: string): Seat | undefined {
    const seat = this.seats.find((s) => s.resumeToken !== null && s.resumeToken === token);
    if (!seat) return undefined;
    if (seat.eliminated && this.phase !== 'ended') return undefined;
    if (!seat.connected && seat.disconnectedAt !== null && Date.now() - seat.disconnectedAt >= RECONNECT_GRACE_MS) {
      this.releaseSeat(seat.slot, true);
      return undefined;
    }
    return seat;
  }

  /** Reclaims a disconnected seat for a new connection: cancels its grace
   *  timer and marks it connected again. The caller (transport layer) is
   *  responsible for wiring the new socket to this slot and does not need
   *  to touch pendingInput -- it already holds neutral input from
   *  markDisconnected and the client will send fresh input immediately.
   *  Returns false if the seat is not in a reclaimable state; defensive,
   *  callers are expected to have gone through findReclaimableSeat first. */
  reclaimSeat(slot: number): boolean {
    const seat = this.seats[slot];
    if (!seat || seat.connected || seat.resumeToken === null) return false;
    seat.connected = true;
    seat.disconnectedAt = null;
    this.clearGraceTimer(slot);
    return true;
  }

  private clearGraceTimer(slot: number): void {
    const t = this.graceTimers.get(slot);
    if (t) clearTimeout(t);
    this.graceTimers.delete(slot);
  }

  /** Ends a seat's reclaimability: invalidates its token so a stale/used
   *  token can never succeed again. Does not touch the sim -- the seat
   *  keeps simulating on whatever input it already has (neutral, since
   *  markDisconnected zeroed it). Idempotent. */
  private releaseSeat(slot: number, viaGraceExpiry = false): void {
    this.clearGraceTimer(slot);
    const seat = this.seats[slot];
    if (!seat) return;
    const wasReclaimable = seat.resumeToken !== null;
    seat.resumeToken = null;
    if (viaGraceExpiry && wasReclaimable) this.events.onSeatGraceExpired?.(slot);
  }

  setInput(slot: number, input: InputFrame, tick: number): void {
    const seat = this.seats[slot];
    if (!seat || seat.eliminated) return;
    // Reject inputs far in the future/past: a hostile client could otherwise
    // send garbage tick numbers to confuse reconciliation on other clients'
    // logs, though the server sim itself never trusts the client tick for
    // anything beyond bookkeeping (it always applies the latest input on
    // its own next tick regardless of what tick the client claims).
    if (tick < 0) return;
    seat.pendingInput = input;
    seat.lastInputTick = Math.max(seat.lastInputTick, tick);
  }

  /** Called by the transport layer when a seat's socket closes. The fighter
   *  keeps being simulated on empty input, same as before reconnection
   *  existed -- what's new is starting the grace window during which the
   *  seat's resume token can reclaim it. No timer is started for a bot
   *  seat, an already-released seat, or once the match has ended: there is
   *  nothing to reclaim in any of those cases. */
  markDisconnected(slot: number): void {
    const seat = this.seats[slot];
    if (!seat) return;
    seat.connected = false;
    seat.pendingInput = makeInputFrame();
    seat.disconnectedAt = Date.now();
    this.clearGraceTimer(slot);
    if (seat.isBot || seat.eliminated || seat.resumeToken === null || this.phase === 'ended') return;
    const timer = setTimeout(() => this.releaseSeat(slot, true), RECONNECT_GRACE_MS);
    // Never keep the process alive just for this timer (tests spawn many
    // short-lived matches; production always has the tick-loop timer/http
    // server keeping it alive regardless).
    timer.unref?.();
    this.graceTimers.set(slot, timer);
  }

  /** Starts the fixed tick loop. Idempotent. */
  start(): void {
    if (this.phase !== 'lobby') return;
    this.phase = 'playing';
    this.seed = seedFromMatchId(this.id);
    // Seeded, not wall-clock-rotated: two matches created in the same
    // second must not collide, and a match must be able to replay
    // identically from its recorded seed (see pickArenaId's comment).
    this.arenaId = pickArenaId(this.seed);
    // Per-seat character, resolved from each seat's requested id (see
    // Seat.characterId's comment for the bot/unset/unknown-id fallback).
    const characters = this.seats.map((seat) => resolveCharacterId(seat.characterId));
    const settingsOverride: Partial<MatchSettings> = {};
    // Test/CI hook only: lets the integration test force a short match
    // instead of waiting out the real multi-minute battle-royale shrink
    // clock. Never set in production (systemd unit does not set it).
    const shrinkOverride = process.env.MATCH_SHRINK_FULLY_CLOSED_TICK;
    if (shrinkOverride) settingsOverride.shrinkFullyClosedTick = Number(shrinkOverride);
    // Mode selection (2026-09-11, Timed Brawl): 'battleRoyale' (last
    // fighter standing, the production default) is what a player joining
    // production gets unless this is set. Follows the same MATCH_* env
    // pattern as everything else here; the systemd unit does not set it
    // in production, so this is a deliberate opt-in only, e.g. for a
    // dedicated Timed Brawl rollout or this task's own live verification.
    // An explicit MATCH_WIN_CONDITION env var is a manual pin (used by
    // tests, and available as an operator override) and takes priority
    // over rotation. Otherwise plannedWinCondition -- set by
    // RoomManager's mode rotation, see server/src/mode-rotation.ts --
    // decides. Falls back to the sim's own default (battleRoyale) if
    // neither is present (e.g. a Match built directly, bypassing
    // RoomManager, with no env override).
    const winConditionOverride = process.env.MATCH_WIN_CONDITION;
    if (winConditionOverride === 'battleRoyale' || winConditionOverride === 'timedKO' || winConditionOverride === 'stocks') {
      settingsOverride.winCondition = winConditionOverride;
    } else if (this.plannedWinCondition) {
      settingsOverride.winCondition = this.plannedWinCondition;
      if (this.plannedTimeLimitTicks) settingsOverride.timeLimitTicks = this.plannedTimeLimitTicks;
      if (this.plannedStartingStocks) settingsOverride.startingStocks = this.plannedStartingStocks;
    }
    const timeLimitOverride = process.env.MATCH_TIME_LIMIT_TICKS;
    if (timeLimitOverride) settingsOverride.timeLimitTicks = Number(timeLimitOverride);
    const stocksOverride = process.env.MATCH_STARTING_STOCKS;
    if (stocksOverride) settingsOverride.startingStocks = Number(stocksOverride);
    this.sim = createMatchSim(this.seed, this.seats.length, settingsOverride, characters, this.arenaId);
    this.lastPercent = new Array(this.seats.length).fill(0);
    this.lastDamageTick = new Array(this.seats.length).fill(-Match.COMBAT_WINDOW_TICKS - 1);
    this.lastDeathCount = new Array(this.seats.length).fill(0);
    this.matchStartedAtTick = this.tick;
    const difficulty = botDifficultyFromEnv();
    this.botDifficulty = difficulty;
    // Human (non-bot) seats, passed to every bot so EASY's anti-dogpile
    // tuning (protectedTargetPenalty/protectedClusterMultiplier in
    // packages/sim/src/ai/bot.ts) knows which fighters are real players.
    // No-op at MEDIUM/HARD, where those tuning values are 0.
    const humanSlots = new Set(this.seats.filter((s) => !s.isBot).map((s) => s.slot));
    this.bots.clear();
    for (const seat of this.seats) {
      if (seat.isBot) {
        this.bots.set(seat.slot, new BotController(seat.slot, difficulty, deriveBotSeed(this.seed, seat.slot), humanSlots));
      }
    }
    this.lastTickAt = Date.now();
    this.accumulatorMs = 0;
    // [matchStart] production log (2026-09-13): journalctl had no way to
    // tell which of the six stages players actually get -- [modeRotation]
    // logs the mode at match-*creation* time, but arenaId is only chosen
    // here in start() (see pickArenaId above). One line per match, emitted
    // once the sim (and therefore the real resolved winCondition) exists.
    console.log(`[matchStart] ${JSON.stringify({
      matchId: this.id,
      arenaId: this.arenaId,
      winCondition: this.winCondition,
      seatCount: this.seats.length,
    })}`);
    this.timer = setInterval(() => this.loop(), TICK_MS);
    this.events.onStart?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Cancel pending grace-release timers -- there's no sim ticking any
    // more so "release into the sim" is moot -- but deliberately do NOT
    // invalidate the tokens themselves here. A player who disconnects just
    // before the match ends (and was never eliminated) should still be able
    // to reconnect briefly afterwards and be told the outcome (edge case:
    // reconnect-after-match-end) rather than getting a cold rejection. Those
    // tokens go away naturally once RoomManager.reap() drops this whole
    // Match object -- there is nothing left holding a reference to them.
    for (const t of this.graceTimers.values()) clearTimeout(t);
    this.graceTimers.clear();
  }

  private loop(): void {
    const now = Date.now();
    let elapsed = now - this.lastTickAt;
    this.lastTickAt = now;
    // Cap how much wall-clock catch-up a single call does, so a stalled
    // event loop (GC pause, or the process being suspended) cannot make the
    // sim try to run hundreds of ticks in one burst.
    if (elapsed > 250) elapsed = 250;
    this.accumulatorMs += elapsed;
    while (this.accumulatorMs >= TICK_MS && this.phase === 'playing') {
      this.accumulatorMs -= TICK_MS;
      this.tickOnce();
    }
  }

  private tickOnce(): void {
    const sim = this.sim;
    if (!sim) return;
    const inputs: InputFrame[] = this.seats.map((s) => {
      const bot = this.bots.get(s.slot);
      return bot ? bot.nextInput(sim) : s.pendingInput;
    });
    const tickStart = process.hrtime.bigint();
    sim.advance(inputs);
    recordTickDurationMs(Number(process.hrtime.bigint() - tickStart) / 1e6);
    this.tick++;

    for (const seat of this.seats) {
      if (seat.eliminated) continue;
      const snap = sim.getFighter(seat.slot);
      const pct = snap.percent;
      if (pct > this.lastPercent[seat.slot]) this.lastDamageTick[seat.slot] = this.tick;
      this.lastPercent[seat.slot] = pct;
      // Stocks-mode ground truth (2026-09-12): a death that only consumes a
      // stock (DEATH_COUNT increments, ELIMINATED does not get set) was
      // logged nowhere before this, making Stocks mode unverifiable from
      // production logs. Only stocks mode ever reaches this branch: in
      // battleRoyale startingStocks is forced to 1 so the first death always
      // eliminates, and timedKO enables respawns so ELIMINATED is never set
      // there either -- gating on winCondition === 'stocks' anyway keeps
      // this from ever firing outside the one mode it means something for.
      if (this.winCondition === 'stocks' && !snap.eliminated && snap.deathCount > this.lastDeathCount[seat.slot]) {
        const ev = sim.eliminationEvents.find((e) => e.fighterIndex === seat.slot);
        const cause = ev ? ev.cause : 'unknown';
        const attacker = ev ? ev.attacker : -1;
        // Read percentAtDeath off the elimination event, not snap.percent:
        // by the time this tick's getFighter() runs, checkBlastZone has
        // already reset PERCENT to 0 for the new life on the respawn path
        // (see sim.ts), so snap.percent here is always 0 and would silently
        // misreport every stockLoss's percent as zero.
        const percentAtDeath = ev ? ev.percentAtDeath : pct;
        const matchAgeSec = ((this.tick - this.matchStartedAtTick) / 60).toFixed(1);
        console.log(JSON.stringify({
          evt: 'stockLoss',
          matchId: this.id,
          slot: seat.slot,
          isBot: seat.isBot,
          tick: this.tick,
          matchAgeSec,
          percentAtDeath,
          cause,
          attacker,
          stocksRemaining: snap.stocks,
        }));
      }
      this.lastDeathCount[seat.slot] = snap.deathCount;
      if (snap.eliminated) {
        seat.eliminated = true;
        // Deliberately NOT calling releaseSeat/nulling the token here.
        // Elimination alone must not end reclaimability: a disconnected
        // seat's fighter can be eliminated by the very same shrinking-ring
        // tick that ends the whole match (a stationary, disconnected
        // fighter is an entirely ordinary thing for a closing ring to
        // catch first), and that must not race ahead of -- and defeat --
        // the "reconnect after the match already ended reports the
        // outcome instead of erroring" guarantee in handleResume/
        // Match.stop(). Mid-match reclaim of an eliminated (but
        // not-yet-ended) seat is still refused: see the eliminated-and-
        // not-ended check in findReclaimableSeat/findSeatByAnyToken below
        // -- there is genuinely no fighter to hand control back to while
        // the match keeps running. Only once phase is 'ended' does the
        // token stop mattering for seat control and start mattering only
        // for reporting the outcome, which an eliminated seat is just as
        // entitled to hear as a surviving one.
        this.events.onEliminated(seat.slot, snap.placement, this.tick);
        // Truthful attribution (2026-09-10): read the cause straight off the sim's own
        // elimination bookkeeping for this tick rather than re-deriving it from "damage
        // recently" here, which mislabelled ordinary falls/walk-offs at low percent as combat
        // KOs (see wiki 'Opening-Seconds Eliminations: Falls Misreported as Knockouts
        // 2026-09-10'). Fall back to 'unknown' only if the event is somehow missing --
        // should not happen since checkBlastZone always pushes one on elimination.
        const ev = sim.eliminationEvents.find((e) => e.fighterIndex === seat.slot);
        const cause = ev ? ev.cause : 'unknown';
        const attacker = ev ? ev.attacker : -1;
        const matchAgeSec = ((this.tick - this.matchStartedAtTick) / 60).toFixed(1);
        console.log(JSON.stringify({
          evt: 'elimination',
          matchId: this.id,
          slot: seat.slot,
          isBot: seat.isBot,
          placement: snap.placement,
          tick: this.tick,
          matchAgeSec,
          percentAtDeath: pct,
          cause,
          attacker,
          aliveAfter: this.seats.filter((s) => !s.eliminated).length,
        }));
      }
    }

    if (this.tick % SNAPSHOT_EVERY_N_TICKS === 0) {
      const acked = new Map<number, number>();
      for (const seat of this.seats) acked.set(seat.slot, seat.lastInputTick);
      this.events.onSnapshot(this.tick, acked);
    }

    if (!this.ended && sim.isMatchOver()) {
      this.ended = true;
      this.phase = 'ended';
      this.logMatchSummary('resolved');
      this.events.onMatchEnd(sim.getWinner(), sim.getLeaderboard(), this.tick, true);
      this.endedAt = Date.now();
      this.stop();
      return;
    }

    // A genuinely abandoned match -- nobody playing it, and nobody
    // watching it either -- has no one who could ever see its result.
    // Left running, it keeps ticking a full sim (CPU, memory, one entry
    // in matchCount) for as long as the bots take to fight it out, which
    // is the multi-minute real match length -- not a leak exactly, but a
    // real waste and a false read on server capacity while it lasts. End
    // it now instead of waiting that out. Deliberately NOT triggered by
    // the last human seat merely being eliminated any more: the
    // "Keep spectating" button only means something if the match keeps
    // running while someone is using it (2026-09-09, see wiki 'Match
    // Duration Contradiction: The Spire Firing Squad').
    if (!this.ended && this.isAbandoned()) {
      this.ended = true;
      this.phase = 'ended';
      this.logMatchSummary('abandoned_by_humans');
      this.events.onMatchEnd(sim.getWinner(), sim.getLeaderboard(), this.tick, false);
      this.endedAt = Date.now();
      this.stop();
      return;
    }

    // Absolute failsafe: no match may run forever even if someone is
    // (or a bug thinks someone is) still watching it.
    if (!this.ended && this.tick - this.matchStartedAtTick >= Match.MAX_MATCH_TICKS) {
      this.ended = true;
      this.phase = 'ended';
      this.logMatchSummary('max_duration');
      this.events.onMatchEnd(sim.getWinner(), sim.getLeaderboard(), this.tick, false);
      this.endedAt = Date.now();
      this.stop();
    }
  }

  /** Called by the transport layer whenever the number of clients (playing
   *  or spectating) connected to this match changes. -1 means "never told
   *  me", which keeps the old human-seat-only rule for tests that build a
   *  Match with no transport layer at all. */
  setWatcherCount(count: number): void {
    this.watcherCount = count;
  }

  /** A match is abandoned once nobody -- playing or spectating -- is left
   *  connected to it. When the transport layer has told us a real
   *  watcher count (watcherCount >= 0), that decides it outright. Only
   *  when it hasn't (unit tests with no transport layer) do we fall back
   *  to the older, narrower isAbandonedByHumans() check. */
  private isAbandoned(): boolean {
    if (this.watcherCount >= 0) return this.watcherCount === 0;
    return this.isAbandonedByHumans();
  }

  /** Ground-truth summary line for the match-duration measurement task
   *  (2026-09-09): one JSON line per match end, cheap (fires once),
   *  observability only -- no effect on gameplay.
   *
   *  Diagnosed 2026-09-13 (pacing-anomaly investigation): remainingAlive
   *  and humanSlotsEliminated both read Seat.eliminated, which the sim
   *  deliberately never sets while respawns are enabled (currently just
   *  'timedKO' -- see respawnsEnabled/checkBlastZone in packages/sim's
   *  sim.ts). So a perfectly ordinary, combat-heavy timedKO match reports
   *  remainingAlive: totalSeats and humanSlotsEliminated: 0 for its
   *  entire duration -- identical to a match with zero combat -- and a
   *  log reader has no way to tell the two apart. That produced a false
   *  "bots aren't fighting" alarm for real production matches (m3/m7,
   *  2026-09-13) that in fact had normal KOs throughout; see
   *  getWinner()/getLeaderboard() picking a real (non-null) winner off
   *  koCount as the tell. Fix: always log winCondition so readers know
   *  when eliminated-based fields don't apply, plus totalKOs (sum of
   *  every seat's koCount) and maxKoCount as a truthful, mode-agnostic
   *  combat-happened signal that IS populated in every mode. */
  private logMatchSummary(endReason: 'resolved' | 'abandoned_by_humans' | 'max_duration'): void {
    const durationSec = ((this.tick - this.matchStartedAtTick) / 60).toFixed(1);
    const humanSlots = this.seats.filter((s) => !s.isBot).map((s) => s.slot);
    const koCounts = this.sim
      ? this.seats.map((seat) => this.sim!.getFighter(seat.slot).koCount)
      : [];
    console.log(JSON.stringify({
      evt: 'matchSummary',
      matchId: this.id,
      endReason,
      durationSec,
      finalTick: this.tick,
      arenaId: this.arenaId,
      winCondition: this.winCondition,
      totalSeats: this.seats.length,
      humanSeats: humanSlots.length,
      humanSlotsEliminated: humanSlots.filter((slot) => this.seats[slot].eliminated).length,
      remainingAlive: this.seats.filter((s) => !s.eliminated).length,
      totalKOs: koCounts.reduce((sum, n) => sum + n, 0),
      maxKoCount: koCounts.length ? Math.max(...koCounts) : 0,
    }));
  }

  /** True once every human seat is unreachable: eliminated, or
   *  disconnected with its resume token already gone (grace expired or
   *  never reclaimable). A match with zero human seats to begin with is
   *  deliberately NOT treated as abandoned here; that would end a match
   *  before it had a chance to matter, and shouldn't happen anyway since
   *  bots only ever fill an already-human-started lobby. */
  private isAbandonedByHumans(): boolean {
    const humanSeats = this.seats.filter((s) => !s.isBot);
    if (humanSeats.length === 0) return false;
    return humanSeats.every((s) => s.eliminated || (!s.connected && s.resumeToken === null));
  }
}
