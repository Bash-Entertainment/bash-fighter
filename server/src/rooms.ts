// Lobby/room manager: assigns connecting clients to a filling match, starts
// matches, and garbage-collects ended ones. Many independent Match objects;
// this class never runs a sim itself.
import { Match, TICK_HZ, seedFromMatchId, type MatchEvents } from './match.ts';
import { botName } from '@bash-fighter/sim/src/ai/bot.ts';
import { seedRng, nextBounded } from '@bash-fighter/sim/src/math/prng.ts';
import { ALL_CHARACTERS } from '@bash-fighter/content/src/characters.ts';
import { decideMatchModeForJoin, MODE_ROTATION_CADENCE, MODE_ROTATION_DISABLED } from './mode-rotation.ts';

export const DEFAULT_CAPACITY = 20;
export const DEFAULT_MINIMUM = 2;
export const COUNTDOWN_SECONDS = Number(process.env.MATCH_COUNTDOWN_SECONDS ?? 15);
// A 20-stranger lobby that needs 20 simultaneous humans to ever start is
// how a launch dies quietly: the first visitor waits in an empty room and
// leaves. So once *some* players are in, wait a short while for more real
// humans, then fill the rest of the lobby with bots and start anyway —
// "nobody else is here" becomes "a full chaotic match starts in a few
// seconds" instead of an indefinite wait. Configurable like
// MATCH_COUNTDOWN_SECONDS so ops/tests can tune or disable it
// (MATCH_BOT_FILL_SECONDS=0 fills immediately; a very large value
// effectively disables bot-filling).
export const BOT_FILL_SECONDS = Number(process.env.MATCH_BOT_FILL_SECONDS ?? 8);
// How many total seats (human + bot) a bot-filled match should start with.
// Defaults to full capacity: fill the whole 20-slot battle royale so one
// early player still gets the intended chaotic-FFA experience.
export const BOT_FILL_TARGET = Number(process.env.MATCH_BOT_FILL_TARGET ?? DEFAULT_CAPACITY);
// A coded (shareable-link) lobby waits far longer than the public lobby's
// short grace period, because waiting for friends to click the link is
// the entire point of this feature -- see [[Shareable lobby links]]. The
// public-lobby countdown-on-minimum behaviour never applies to a coded
// lobby at all (see joinLobby below); this timer, plus the "Start now"
// button, are the only ways a coded lobby ever starts on its own.
export const PRIVATE_BOT_FILL_SECONDS = Number(process.env.MATCH_PRIVATE_BOT_FILL_SECONDS ?? 60);

interface LobbyTimers {
  countdownTimer: NodeJS.Timeout | null;
  botFillTimer: NodeJS.Timeout | null;
  displayTicker: NodeJS.Timeout | null;
}

export class RoomManager {
  private matches = new Map<string, Match>();
  private filling: Match | null = null;
  private nextId = 1;
  // A coded lobby is never the public `filling` room -- it's reachable
  // only by presenting the exact code, so strangers can never land in it.
  // Keyed by the sanitised 4-character code. Entries are removed the
  // moment their match leaves the lobby phase (start()) so codes never
  // leak memory across a match's whole lifetime, not just its lobby
  // phase. See [[Shareable lobby links]].
  private readonly coded = new Map<string, Match>();
  // Per-match lobby timer state. A public lobby and any number of coded
  // lobbies can all be in the lobby phase at once, so these can no longer
  // be single fields on the manager the way they were before coded
  // lobbies existed -- each match's timers are independent.
  private readonly timers = new Map<string, LobbyTimers>();
  readonly capacity: number;
  readonly minimum: number;
  private readonly makeEvents: (matchId: string) => MatchEvents;

  constructor(makeEvents: (matchId: string) => MatchEvents, capacity = DEFAULT_CAPACITY, minimum = DEFAULT_MINIMUM) {
    this.makeEvents = makeEvents;
    this.capacity = capacity;
    this.minimum = minimum;
  }

  get matchCount(): number {
    return this.matches.size;
  }

  get playerCount(): number {
    let n = 0;
    // Bots are never real connected clients (no websocket, no snapshots
    // sent to them) — exclude them so this reflects actual player load.
    for (const m of this.matches.values()) n += m.seats.filter((s) => s.connected && !s.isBot).length;
    return n;
  }

  /** Bot-filled seats across every live match, reported separately from
   *  playerCount so a log reader can tell a bot-padded lobby from a real
   *  crowd of humans. */
  get botCount(): number {
    let n = 0;
    for (const m of this.matches.values()) n += m.seats.filter((s) => s.isBot).length;
    return n;
  }

  getMatch(id: string): Match | undefined {
    return this.matches.get(id);
  }

  /** Finds the match a spectate-by-link code refers to (see [[Spectate by
   *  link]]), whether it's still in its lobby (via `coded`, the fast
   *  path) or already in progress -- `coded` is cleared the moment a
   *  match starts (onLobbyLeft), but `Match.joinCode` itself is never
   *  cleared, so a started match is still found by the fallback scan.
   *  Never returns an ended match: callers should fall back to
   *  currentPublicMatch() for that case, same as an unknown code. */
  findMatchByCode(code: string): Match | undefined {
    const lobby = this.coded.get(code);
    if (lobby && lobby.phase !== 'ended') return lobby;
    for (const match of this.matches.values()) {
      if (match.joinCode === code && match.phase !== 'ended') return match;
    }
    return undefined;
  }

  /** The match a spectator with no code (or an unknown/ended one) should
   *  fall back to watching: the public lobby currently filling, or else
   *  the most recently created still-live match that was never a coded
   *  (private) lobby. Returns undefined only when there is truly nothing
   *  public to watch. */
  currentPublicMatch(): Match | undefined {
    if (this.filling && this.filling.phase !== 'ended') return this.filling;
    let best: Match | undefined;
    for (const match of this.matches.values()) {
      if (match.joinCode !== undefined) continue;
      if (match.phase === 'ended') continue;
      best = match;
    }
    return best;
  }

  /** Finds the match/seat a resume token reclaims, across every match this
   *  manager still knows about (a client does not know its old matchId is
   *  still needed, so it just presents the token). Not indexed separately
   *  by token: match/seat counts are small (capacity 20, matchCount bounded
   *  by reap()) and this only runs on the rare reconnect path, not the hot
   *  60Hz tick path. */
  findReclaim(token: string): { match: Match; slot: number } | undefined {
    for (const match of this.matches.values()) {
      const seat = match.findReclaimableSeat(token);
      if (seat) return { match, slot: seat.slot };
    }
    return undefined;
  }

  /** True if `token` belongs to a seat that is valid but currently
   *  connected (a duplicate/racing connection), as opposed to simply
   *  unknown or expired. Used only to choose the more honest error code. */
  isTokenForConnectedSeat(token: string): boolean {
    for (const match of this.matches.values()) {
      if (match.findSeatByAnyToken(token)) return true;
    }
    return false;
  }

  /** Same lookup as isTokenForConnectedSeat but returns the match/slot
   *  instead of a boolean, so a caller can inspect (and, if it's actually
   *  dead, retire) the connection currently holding that seat before
   *  deciding whether to reject a resume as a genuine duplicate. */
  findByAnyToken(token: string): { match: Match; slot: number } | undefined {
    for (const match of this.matches.values()) {
      const seat = match.findSeatByAnyToken(token);
      if (seat) return { match, slot: seat.slot };
    }
    return undefined;
  }

  private createMatch(requeued: boolean): Match {
    const matchNumber = this.nextId;
    const id = `m${this.nextId++}`;
    const match = new Match(id, this.capacity, this.minimum, this.makeEvents(id));
    // Mode rotation (2026-09-11, Timed Brawl launch, see
    // server/src/mode-rotation.ts): decided once per created match, not
    // per connecting player -- every seat that joins this match sees
    // the same mode. Logged here, at decision time, so a journalctl
    // read confirms the split independent of whether/when the match
    // ever starts.
    const decision = decideMatchModeForJoin(matchNumber, requeued);
    match.plannedWinCondition = decision.winCondition;
    match.plannedTimeLimitTicks = decision.timeLimitTicks;
    match.plannedStartingStocks = decision.startingStocks;
    // forcedForFirstTimeVisitor: true when this match's mode was chosen
    // by the first-time-visitor rule (decideMatchModeForJoin), not by
    // the rotation -- distinguishes the two causes in the log rather
    // than implying the rotation itself picked timedKO here.
    const forcedForFirstTimeVisitor = !MODE_ROTATION_DISABLED && !requeued;
    console.log(`[modeRotation] ${JSON.stringify({
      matchId: id,
      matchNumber,
      cadence: MODE_ROTATION_CADENCE,
      disabled: MODE_ROTATION_DISABLED,
      winCondition: decision.winCondition,
      forcedForFirstTimeVisitor,
    })}`);
    this.matches.set(id, match);
    return match;
  }

  /** Finds or creates the match currently filling, adds a seat to it, and
   *  returns both. Starting the match (full, or countdown reaching zero) is
   *  handled here too so callers don't need to poll.
   *
   *  `arena` is the dev-only stage pin from the joiner's hello (see
   *  HelloMessage.arena / Match.arenaRequest). The first joiner to
   *  actually present a pin claims it for the lobby: a joiner without
   *  one neither claims nor blocks, and a later joiner never retargets a
   *  lobby another joiner has already pinned. Honoured only when the
   *  server opted in via MATCH_ARENA_OVERRIDE=1 (checked in
   *  Match.start(), not here) -- a production server ignores it.
   *
   *  `joinCode` (see HelloMessage.joinCode / [[Shareable lobby links]]):
   *  when present and already sanitised by the caller, this joiner lands
   *  in the coded lobby for that exact code -- reusing it while it's
   *  still in the lobby phase, or creating and registering a fresh one
   *  otherwise. A coded lobby is never the public `filling` room and
   *  never runs the post-minimum countdown; it starts only via its own
   *  (longer) bot-fill grace period or an explicit "Start now". */
  joinLobby(
    name: string,
    characterId?: string,
    qa = false,
    arena?: string,
    requeued = false,
    joinCode?: string,
  ): { match: Match; slot: number } {
    let freshMatch = false;
    let match: Match;

    if (joinCode) {
      const existing = this.coded.get(joinCode);
      if (existing && existing.phase === 'lobby') {
        match = existing;
      } else {
        match = this.createMatch(requeued);
        match.joinCode = joinCode;
        this.coded.set(joinCode, match);
        freshMatch = true;
      }
    } else {
      if (!this.filling || this.filling.phase !== 'lobby') {
        match = this.createMatch(requeued);
        this.filling = match;
        freshMatch = true;
      } else {
        match = this.filling;
      }
    }

    if (arena !== undefined && match.arenaRequest === undefined) match.arenaRequest = arena;
    const seat = match.addSeat(name, false, characterId, qa, !MODE_ROTATION_DISABLED && !requeued);

    if (joinCode) {
      console.log(`[codedLobby] ${JSON.stringify({
        matchId: match.id,
        code: joinCode,
        filledSlots: match.filledSlots,
        event: freshMatch ? 'created' : 'joined',
      })}`);
    }

    if (freshMatch) this.startBotFillTimer(match, joinCode !== undefined);

    if (match.filledSlots >= match.capacity) {
      this.clearTimersFor(match.id);
      match.start();
      this.onLobbyLeft(match);
    } else if (!joinCode && match.filledSlots >= match.minimum && !this.timersFor(match.id).countdownTimer) {
      // Coded lobbies deliberately never run this countdown: two friends
      // meeting the public minimum should not be forced to start 15
      // seconds later just because a public lobby would have. See
      // [[Shareable lobby links]].
      this.startCountdown(match);
    }
    return { match, slot: seat.slot };
  }

  private timersFor(matchId: string): LobbyTimers {
    let t = this.timers.get(matchId);
    if (!t) {
      t = { countdownTimer: null, botFillTimer: null, displayTicker: null };
      this.timers.set(matchId, t);
    }
    return t;
  }

  /** Called whenever a match stops being an open lobby (starts, or is
   *  force-started): detaches it from whichever "open lobby" index was
   *  holding it (the public `filling` slot, or its `coded` entry) and
   *  drops its timer bookkeeping, so codes and timers never outlive the
   *  lobby phase they existed for. */
  private onLobbyLeft(match: Match): void {
    if (this.filling === match) this.filling = null;
    if (match.joinCode !== undefined && this.coded.get(match.joinCode) === match) {
      this.coded.delete(match.joinCode);
    }
    this.timers.delete(match.id);
  }

  private startCountdown(match: Match): void {
    const t = this.timersFor(match.id);
    let ticksLeft = COUNTDOWN_SECONDS * TICK_HZ;
    match.countdownTicksRemaining = ticksLeft;
    match.noteStartDeadline(Date.now() + COUNTDOWN_SECONDS * 1000);
    t.countdownTimer = setInterval(() => {
      ticksLeft -= TICK_HZ / 5;
      match.countdownTicksRemaining = Math.max(0, ticksLeft);
      match.events.onLobbyUpdate?.();
      if (ticksLeft <= 0) {
        this.clearTimersFor(match.id);
        if (match.phase === 'lobby') {
          match.start();
          this.onLobbyLeft(match);
        }
      }
    }, 200);
  }

  /** Started once per newly-created lobby. If nobody else has joined by
   *  the time it fires and the lobby is still open, fills every remaining
   *  slot (up to BOT_FILL_TARGET) with bots and starts immediately —
   *  a human alone in a 20-slot lobby should not have to wait for 19
   *  strangers, or wait at all beyond this short grace period. A coded
   *  lobby uses the much longer PRIVATE_BOT_FILL_SECONDS instead, since
   *  waiting for friends to click the link is the point. */
  private startBotFillTimer(match: Match, isCoded: boolean): void {
    const t = this.timersFor(match.id);
    const fillSeconds = isCoded ? PRIVATE_BOT_FILL_SECONDS : BOT_FILL_SECONDS;
    match.noteStartDeadline(Date.now() + Math.max(0, fillSeconds) * 1000);
    t.botFillTimer = setTimeout(() => {
      t.botFillTimer = null;
      if (match.phase !== 'lobby') return;
      this.fillWithBots(match);
      this.clearTimersFor(match.id);
      match.start();
      this.onLobbyLeft(match);
    }, Math.max(0, fillSeconds) * 1000);
    t.displayTicker = setInterval(() => {
      if (match.phase !== 'lobby') {
        this.clearTimersFor(match.id);
        return;
      }
      match.events.onLobbyUpdate?.();
    }, 1000);
  }

  /** Fills every empty seat up to BOT_FILL_TARGET (never below whatever is
   *  already filled, never above capacity) with bots. Shared by the
   *  lone-player grace-period timer and the "start now" request so both
   *  paths pick characters exactly the same deterministic way. */
  private fillWithBots(match: Match): void {
    const target = Math.min(match.capacity, Math.max(BOT_FILL_TARGET, match.minimum, match.filledSlots));
    // Bots get a character deterministically drawn from the roster, seeded
    // from the match id + slot index (never Math.random), so every client
    // that reconstructs the sim from the same match id picks the same
    // characters -- see resolveCharacterId in match.ts for how seat
    // characterId flows into createMatchSim. Human seats are untouched;
    // this only fills in a characterId for the isBot=true seats added here.
    const matchSeed = seedFromMatchId(match.id);
    let botIndex = 0;
    while (match.filledSlots < target) {
      const slot = match.filledSlots;
      const rng = seedRng((matchSeed ^ (slot * 0x9e3779b9)) >>> 0);
      const draw = nextBounded(rng, ALL_CHARACTERS.length);
      const characterId = ALL_CHARACTERS[draw.value].id;
      match.addSeat(botName(botIndex), true, characterId);
      botIndex++;
    }
  }

  /** Handles a seat-holder's "start now" request: fills the rest of this
   *  lobby's seats with bots and starts immediately. Idempotent -- once
   *  the match has left the lobby phase (this request already handled it,
   *  or it started/ended some other way), later calls are a silent no-op
   *  rather than a second start or an error, so a client can safely retry
   *  or double-send. Callers (server/src/index.ts) are responsible for
   *  verifying the requester actually holds a seat in this exact match
   *  before calling this -- this method itself does not re-check that,
   *  since by the time we're here "which match" has already collapsed to
   *  a single Match object via the caller's own seat lookup. */
  startNow(match: Match): boolean {
    if (match.phase !== 'lobby') return false;
    this.clearTimersFor(match.id);
    this.fillWithBots(match);
    match.start();
    this.onLobbyLeft(match);
    return true;
  }

  private clearTimersFor(matchId: string): void {
    const t = this.timers.get(matchId);
    if (!t) return;
    if (t.countdownTimer) clearInterval(t.countdownTimer);
    if (t.botFillTimer) clearTimeout(t.botFillTimer);
    if (t.displayTicker) clearInterval(t.displayTicker);
    this.timers.delete(matchId);
  }

  /** Drop matches that ended a while ago, so memory doesn't grow forever. */
  reap(maxAgeMs = 60_000): void {
    const now = Date.now();
    for (const [id, m] of this.matches) {
      if (m.phase === 'ended' && m.endedAt !== null && now - m.endedAt > maxAgeMs) {
        this.matches.delete(id);
        // Belt-and-suspenders: a coded entry should already have been
        // removed the moment this match left the lobby phase (see
        // onLobbyLeft), but never leave a dangling code pointing at a
        // deleted match if that cleanup was ever missed.
        if (m.joinCode !== undefined && this.coded.get(m.joinCode) === m) {
          this.coded.delete(m.joinCode);
        }
        this.timers.delete(id);
      }
    }
  }
}
