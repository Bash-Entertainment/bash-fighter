// Server-side mode rotation (2026-09-11, Timed Brawl launch; extended
// 2026-09-12 to add Stocks). Decides, per created match (not per
// connection -- a match's mode must be fixed for every seat that joins
// it), which of the three modes that match runs.
//
// Deliberately a single small pure function, unit-testable without a
// server or a websocket: given a 1-based match sequence number and a
// rotation sequence, it returns the mode -- no side effects, no clock.
// RoomManager calls this once per fresh match and logs the result; Match
// just receives the already-decided mode.
import type { WinCondition } from '@bash-fighter/sim/src/index.ts';

/** The rotation shape shipped 2026-09-12: Battle Royale twice, then Timed
 *  Brawl, then Stocks, repeating -- Battle Royale stays the headline
 *  experience at a 2-in-4 majority, and the two newer modes each get a
 *  clean 1-in-4 slot rather than competing for the same "every Nth"
 *  cadence slot Timed Brawl used alone before Stocks existed.
 *  Configurable via MATCH_MODE_ROTATION as a comma-separated list of
 *  'battleRoyale'|'timedKO'|'stocks' so ops can change the split, or
 *  remove a mode entirely, without a redeploy. */
const DEFAULT_ROTATION: WinCondition[] = ['battleRoyale', 'battleRoyale', 'timedKO', 'stocks'];

function parseRotation(raw: string | undefined): WinCondition[] {
  if (!raw) return DEFAULT_ROTATION;
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is WinCondition => s === 'battleRoyale' || s === 'timedKO' || s === 'stocks');
  return parts.length > 0 ? parts : DEFAULT_ROTATION;
}

// Back-compat: production already carries MATCH_MODE_ROTATION_CADENCE=3
// from the pre-Stocks Timed Brawl launch (2026-09-11). If the new
// MATCH_MODE_ROTATION list env var is not set but the old cadence env
// var is, honour it by building the equivalent plain two-mode rotation
// (every Nth match is timedKO, the rest battleRoyale) rather than
// silently ignoring an operator's existing config.
function rotationFromLegacyCadence(raw: string | undefined): WinCondition[] | null {
  if (!raw) return null;
  const cadence = Number(raw);
  if (!Number.isFinite(cadence) || cadence < 1) return null;
  return Array.from({ length: Math.round(cadence) }, (_, i) => (i === Math.round(cadence) - 1 ? 'timedKO' : 'battleRoyale'));
}

export const MODE_ROTATION: WinCondition[] =
  process.env.MATCH_MODE_ROTATION !== undefined
    ? parseRotation(process.env.MATCH_MODE_ROTATION)
    : rotationFromLegacyCadence(process.env.MATCH_MODE_ROTATION_CADENCE) ?? DEFAULT_ROTATION;

/** Kept for backward compatibility with the pre-Stocks single-mode
 *  cadence knob and existing tests/docs that reference it: the rotation
 *  length itself now IS the cadence. */
export const MODE_ROTATION_CADENCE = MODE_ROTATION.length;

/** Kill switch: set truthy to disable rotation entirely and pin
 *  production to the pre-rotation behaviour (every match uses the
 *  existing MATCH_WIN_CONDITION override, or battleRoyale if that is
 *  also unset). For an emergency rollback without touching code. */
export const MODE_ROTATION_DISABLED = /^(1|true|yes)$/i.test(process.env.MATCH_MODE_ROTATION_DISABLED ?? '');

/** Timed Brawl's match length in the rotation. Chosen at 3 minutes
 *  (10800 ticks @ 60Hz): production Battle Royale matches resolve in
 *  60-90s (docs/MEASUREMENT.md, median 84.4s), so Timed Brawl needs to
 *  run noticeably longer than that to read as a distinct mode rather
 *  than "the same match but with a clock" -- but the sim's own default
 *  of 5 minutes (packages/sim/src/match-settings.ts) is too long for a
 *  bot-filled casual drop-in lobby where the median player did not
 *  choose this mode. 3 minutes matches the plain-language line shown to
 *  players ("most knockouts in 3 minutes wins") and is a round, legible
 *  number distinct from both the sim default and Battle Royale's
 *  natural length. */
export const TIMED_BRAWL_TIME_LIMIT_TICKS = 60 * 60 * 3;

/** Stocks' starting-life count in the rotation. 2 lives, chosen from a
 *  measurement (scripts/stocks-metrics.mjs, 2026-09-12), not taste: a
 *  full 20-fighter HARD-bot stocks match with 2 vs. 3 starting stocks
 *  resolved at almost the same median length (~224s vs. ~236s, 4 trials
 *  each) once the mode-specific 3-minute shrink hard-margin (see
 *  match-settings.ts) was added, because that backstop -- not the stock
 *  count -- is what actually bounds match length; population-based
 *  arena narrowing barely engages while respawns keep ~20 fighters alive
 *  most of the match. Since stock count does not buy shorter matches
 *  here, 2 was chosen over 3 as the leaner, faster-reading option the
 *  owner asked to prefer absent a reason to do otherwise.
 */
export const STOCKS_STARTING_STOCKS = 2;

export interface ModeDecision {
  winCondition: WinCondition;
  /** Only set when winCondition is 'timedKO'; undefined otherwise so
   *  callers don't accidentally apply a time limit to another mode. */
  timeLimitTicks?: number;
  /** Only set when winCondition is 'stocks'. */
  startingStocks?: number;
}

/** Pure decision function: given the 1-based sequence number of the match
 *  being created (RoomManager's nextId at creation time, before
 *  increment), returns which mode it should run. Deterministic: the same
 *  (matchNumber, rotation, disabled) always returns the same answer, so
 *  this is testable without any timers or randomness -- the rotation is
 *  a fixed repeating sequence, not merely probabilistic.
 *
 *  The `cadence` parameter is kept for backward compatibility with
 *  existing call sites and tests: when given explicitly (not the
 *  default), it selects a plain "every Nth match is timedKO, the rest
 *  battleRoyale" two-mode rotation, matching the pre-Stocks behaviour,
 *  so callers that only care about the two-mode split are unaffected by
 *  the new default four-slot rotation. */
export function decideMatchMode(
  matchNumber: number,
  cadenceOrRotation: number | WinCondition[] = MODE_ROTATION,
  disabled: boolean = MODE_ROTATION_DISABLED,
): ModeDecision {
  if (disabled) return { winCondition: 'battleRoyale' };
  if (typeof cadenceOrRotation === 'number') {
    const cadence = Math.max(1, cadenceOrRotation);
    if (matchNumber % cadence === 0) return { winCondition: 'timedKO', timeLimitTicks: TIMED_BRAWL_TIME_LIMIT_TICKS };
    return { winCondition: 'battleRoyale' };
  }
  const rotation = cadenceOrRotation.length > 0 ? cadenceOrRotation : DEFAULT_ROTATION;
  const winCondition = rotation[(matchNumber - 1) % rotation.length] as WinCondition;
  if (winCondition === 'timedKO') return { winCondition, timeLimitTicks: TIMED_BRAWL_TIME_LIMIT_TICKS };
  if (winCondition === 'stocks') return { winCondition, startingStocks: STOCKS_STARTING_STOCKS };
  return { winCondition };
}

/** Plain-language line shown to players before the match starts (lobby
 *  screen) -- see index item 2: never show the internal identifier
 *  ('timedKO'/'stocks') to a player. Battle Royale is the headline
 *  default and gets a short label; the other two state their win
 *  condition and any relevant number in words a new player understands. */
/** Fresh-match variant of decideMatchMode for RoomManager.joinLobby:
 *  a first-time visitor's first online match should be Timed Brawl
 *  (winCondition timedKO) rather than Last-Fighter-Standing, because in
 *  Battle Royale a newcomer is often eliminated well under a minute in
 *  and their session simply ends, while Timed Brawl respawns them and
 *  guarantees continuous play for the match's duration. A player who
 *  arrived via auto-requeue ("Play again") is not a first-time visitor
 *  in this sense -- they already know what they're getting into and
 *  keep the normal rotation.
 *
 *  Deliberately layered on top of decideMatchMode rather than folded
 *  into it: this does not consume or shift the rotation sequence for
 *  other matches. `matchNumber` is RoomManager's own creation counter
 *  and increments once per fresh match regardless of which mode any
 *  match ends up using, so overriding the *result* here for one match
 *  never changes what decideMatchMode(matchNumber) returns for any
 *  other matchNumber. The rotation stays exactly as deterministic and
 *  testable as before.
 *
 *  The kill switch (MODE_ROTATION_DISABLED, an explicit operator
 *  choice) wins over this rule too: when rotation is disabled the
 *  server is pinned to the pre-rotation battleRoyale-only behaviour and
 *  this function does not second-guess that. */
export function decideMatchModeForJoin(
  matchNumber: number,
  joinerRequeued: boolean,
  cadenceOrRotation: number | WinCondition[] = MODE_ROTATION,
  disabled: boolean = MODE_ROTATION_DISABLED,
): ModeDecision {
  if (!disabled && !joinerRequeued) {
    return { winCondition: 'timedKO', timeLimitTicks: TIMED_BRAWL_TIME_LIMIT_TICKS };
  }
  return decideMatchMode(matchNumber, cadenceOrRotation, disabled);
}

export function modeDisplayName(winCondition: WinCondition, timeLimitTicks?: number, startingStocks?: number): string {
  if (winCondition === 'timedKO') {
    const minutes = Math.round((timeLimitTicks ?? TIMED_BRAWL_TIME_LIMIT_TICKS) / 60 / 60);
    return `Timed Brawl — most knockouts in ${minutes} minutes wins`;
  }
  if (winCondition === 'stocks') {
    const lives = startingStocks ?? STOCKS_STARTING_STOCKS;
    return `Stocks — ${lives} lives each, last fighter standing wins`;
  }
  return 'Battle Royale — last fighter standing wins';
}
