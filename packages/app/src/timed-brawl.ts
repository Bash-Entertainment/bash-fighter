// Pure, DOM-free helpers for the Timed Brawl client HUD and end screen.
// Split out (same convention as match-overlay.ts's winnerAnnouncementLine)
// so the actual logic -- clock formatting, standings ordering, placement --
// has regression coverage without needing a browser.
import type { MatchSettings } from '@bash-fighter/sim';

/** True when the match is running the timed, respawn, highest-KO-count
 * mode -- the one condition every Timed-Brawl-only client affordance
 * (clock, score column, score-based end screen) is gated on. Battle
 * Royale and 'stocks' both fall through to the existing elimination UI
 * unchanged. */
export function isTimedBrawl(settings: Pick<MatchSettings, 'winCondition'> | null | undefined): boolean {
  return settings?.winCondition === 'timedKO';
}

/** Ticks remaining until time expiry, floored at 0 -- never negative, so a
 * clock never reads e.g. "-0:01" in the last-tick window before matchEnd
 * arrives. Sim runs at a fixed 60Hz (see packages/sim). */
export function ticksRemaining(currentTick: number, settings: Pick<MatchSettings, 'timeLimitTicks'>): number {
  return Math.max(0, settings.timeLimitTicks - currentTick);
}

/** "M:SS" clock text from a tick count at 60Hz. Always two digits of
 * seconds (e.g. "1:05", not "1:5") so the width never jitters as seconds
 * roll over, which would be distracting in a HUD sidebar refreshed every
 * frame. */
export function formatClock(ticks: number, ticksPerSecond = 60): string {
  const totalSeconds = Math.ceil(Math.max(0, ticks) / ticksPerSecond);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export interface TimedBrawlScore {
  slot: number;
  koCount: number;
  deathCount: number;
}

/** One row of the end-of-match standings, in finishing order (winner
 * first). `place` is 1-based. Ties (equal KOs and deaths) share the
 * displayed place, matching how a scoreboard is normally read -- two
 * fighters tied for first are both "1st", not "1st"/"2nd". */
export interface TimedBrawlStanding extends TimedBrawlScore {
  place: number;
}

/** Builds ranked standings from the server's authoritative leaderboard
 * order (slots best-to-worst, already tie-broken deterministically by
 * Sim.getLeaderboard on both server and every client) plus each slot's
 * score. Never re-sorts -- the leaderboard order is the single source of
 * truth for placement, this just attaches display fields to it. */
export function buildStandings(leaderboard: readonly number[], scores: readonly TimedBrawlScore[]): TimedBrawlStanding[] {
  const byslot = new Map(scores.map((s) => [s.slot, s]));
  const standings: TimedBrawlStanding[] = [];
  let place = 0;
  let prev: TimedBrawlScore | null = null;
  for (const slot of leaderboard) {
    const score = byslot.get(slot) ?? { slot, koCount: 0, deathCount: 0 };
    place++;
    if (prev && prev.koCount === score.koCount && prev.deathCount === score.deathCount) {
      const lastPlace = standings[standings.length - 1]?.place ?? place;
      standings.push({ ...score, place: lastPlace });
    } else {
      standings.push({ ...score, place });
    }
    prev = score;
  }
  return standings;
}

/** 1-based placement of a given slot within standings already built by
 * buildStandings, or null if that slot isn't present (shouldn't happen
 * for a real match, but callers pass this straight to the UI so it must
 * degrade rather than throw on a malformed input). */
export function placementOf(standings: readonly TimedBrawlStanding[], slot: number): number | null {
  return standings.find((s) => s.slot === slot)?.place ?? null;
}


/** Deterministic best-to-worst slot order derived directly from scores,
 * for the HUD's live standing -- mid-match there is no server-sent
 * leaderboard array to reuse (that only arrives with the match-end
 * message, see buildStandings' doc comment), but the tie-break rule is
 * exactly Sim.getLeaderboard's own (packages/sim/src/sim.ts): highest
 * koCount first, ties broken by fewest deathCount, then by slot for a
 * fully deterministic order. Every client computes this from the same
 * snapshot fields, so it always agrees with the server's own ordering
 * once the match actually ends. */
export function standingsFromScores(scores: readonly TimedBrawlScore[]): TimedBrawlStanding[] {
  const order = [...scores]
    .sort((a, b) => b.koCount - a.koCount || a.deathCount - b.deathCount || a.slot - b.slot)
    .map((s) => s.slot);
  return buildStandings(order, scores);
}

export interface KoStandingInfo {
  ownKo: number;
  /** 1-based; ties share a rank, same convention as TimedBrawlStanding.place. */
  ownRank: number;
  totalFighters: number;
  leaderKo: number;
}

/** The three numbers the live HUD standing needs (see
 * koStandingLineText in hud-text.ts) -- the local player's own count,
 * own rank, and the current leader's count -- or null if localSlot
 * isn't in scores (shouldn't happen for a real match, but this is fed
 * straight to the UI so it must degrade rather than throw). */
export function koStandingInfo(scores: readonly TimedBrawlScore[], localSlot: number): KoStandingInfo | null {
  if (localSlot < 0) return null;
  const standings = standingsFromScores(scores);
  const own = standings.find((s) => s.slot === localSlot);
  if (!own) return null;
  return {
    ownKo: own.koCount,
    ownRank: own.place,
    totalFighters: standings.length,
    leaderKo: standings[0]?.koCount ?? own.koCount,
  };
}
