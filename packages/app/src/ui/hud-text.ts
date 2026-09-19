// Pure survivors-line text logic, split out of hud.ts so it can be unit
// tested without pulling in @bash-fighter/render's barrel export (which
// hud.ts needs for PALETTE, but which also re-exports spectator-camera.ts
// -- a module with TypeScript parameter-property syntax that Node's
// built-in --test type-stripping cannot parse). Keeping this text logic
// import-free means its regression test (packages/app/test/hud-survivors.test.ts)
// doesn't depend on that unrelated module loading cleanly.
export function survivorsLineText(survivors: number, total: number, timedBrawl: boolean): string {
  return !timedBrawl && total > 2 ? `${survivors} / ${total} remaining` : '';
}


/** Human-readable mode name and its win condition, shown in the sidebar's
 * match-status block (the space below the chip grid, reclaimed
 * 2026-09-14 -- see wiki "Camera Framing" era docs for the sidebar
 * layout history). Pure string mapping, no DOM, so it is unit-testable
 * without jsdom. */
export function modeLabelText(winCondition: 'battleRoyale' | 'timedKO' | 'stocks'): string {
  switch (winCondition) {
    case 'timedKO':
      return 'Timed Brawl';
    case 'stocks':
      return 'Stocks';
    default:
      return 'Battle Royale';
  }
}

export function winConditionText(winCondition: 'battleRoyale' | 'timedKO' | 'stocks'): string {
  switch (winCondition) {
    case 'timedKO':
      return 'most KOs when time expires';
    case 'stocks':
      return 'last stock standing';
    default:
      return 'last fighter standing';
  }
}

/** The persistent one-sentence objective line shown in the in-match HUD
 * for the whole match, in every mode (2026-09-19, added after a real
 * player finished a full Timed Brawl match and wrote "I don't
 * understand how to win or what to do" -- the mode's win condition was
 * never shown anywhere in-match). Deliberately built from
 * modeLabelText/winConditionText -- the same two functions the
 * match-status block already used -- rather than a fresh hardcoded
 * string per mode, so this line can never drift from what the sidebar
 * mode/win-condition text already says. */
export function objectiveLineText(winCondition: 'battleRoyale' | 'timedKO' | 'stocks'): string {
  const mode = modeLabelText(winCondition);
  if (winCondition === 'timedKO') {
    return `${mode}: most knockouts when the clock runs out wins.`;
  }
  return `${mode}: the ${winConditionText(winCondition)} wins.`;
}

/** One line for the compact elimination feed under the chip grid. Kept
 * to a single short sentence per fighter -- with 20 fighters dying in
 * about 90 seconds (see wiki "Arena Collapse Cascade") the feed must
 * never become a wall of text, so callers cap how many of these are
 * kept on screen (see hud.ts's ELIMINATION_FEED_LIMIT), not this
 * function. */
export function eliminationFeedLine(name: string, placement: number | null): string {
  const who = name && name.length > 0 ? name : 'Fighter';
  if (placement === 1) return `${who} wins`;
  if (placement && placement > 0) return `${who} eliminated · ${ordinal(placement)}`;
  return `${who} eliminated`;
}


/** Chip-grid display name: drops the redundant "CPU " prefix bots carry
 * (see packages/sim/src/ai/bot.ts's nameFor, which this deliberately does
 * not touch -- world-space labels and the elimination feed keep the full
 * "CPU Name" text; only the 200px/128px chip column, where every
 * character counts, shows the bare name). Human names have no prefix and
 * pass through unchanged. */
export function chipDisplayName(name: string): string {
  return name.startsWith('CPU ') ? name.slice(4) : name;
}

/** True elimination order for a feed entry: in every mode with
 * eliminations (battleRoyale, stocks) placements are handed out in
 * strict descending order as the match runs -- the first fighter out
 * gets the worst (highest) placement number and each later elimination
 * gets the next-lower number, down to the winner at 1st. So placement
 * itself *is* a chronological ordering, and sorting by it ascending
 * always puts the most recent elimination first -- regardless of the
 * order the client happened to observe/render them in (a laggy frame
 * that batches two deaths, or a mid-match spectator join that sees a
 * pile of already-eliminated fighters on its very first update(), see
 * hud.ts). We deliberately sort by this instead of by observation
 * order for that reason. */
export interface EliminationFeedEntry {
  name: string;
  placement: number | null;
  /** Tiebreaker only: the order this client first observed the
   * elimination. Used when placement is missing or (should not happen)
   * tied, so behaviour stays deterministic rather than depending on
   * object insertion order. */
  observedOrder: number;
}

export function sortFeedEntriesNewestFirst(entries: readonly EliminationFeedEntry[]): EliminationFeedEntry[] {
  return [...entries].sort((a, b) => {
    const ap = a.placement ?? Number.POSITIVE_INFINITY;
    const bp = b.placement ?? Number.POSITIVE_INFINITY;
    if (ap !== bp) return ap - bp;
    return b.observedOrder - a.observedOrder;
  });
}

/** Shared "1st"/"2nd"/"3rd"/"Nth" formatting, used by both the
 * elimination feed and the Timed Brawl live knockout standing so the
 * two never format placement differently. */
export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}


/** Live Timed Brawl knockout standing shown in the HUD, quiet and
 * small: the player's own count, own rank (ties share a rank, matching
 * the end-screen's buildStandings behaviour), and the current leader's
 * count -- never a full N-row table (see koStandingInfo in
 * timed-brawl.ts for how this is computed). */
export function koStandingLineText(ownKo: number, ownRank: number, totalFighters: number, leaderKo: number): string {
  // "leader 2" read as a fighter number rather than a knockout count when
  // I played it, which is the exact ambiguity this whole line exists to
  // remove, so the unit is spelled out (2026-09-19).
  const leaderPart =
    ownRank === 1 ? '' : ` \u00b7 leader has ${leaderKo} KO${leaderKo === 1 ? '' : 's'}`;
  return `${ownKo} KO${ownKo === 1 ? '' : 's'} \u00b7 ${ordinal(ownRank)} of ${totalFighters}${leaderPart}`;
}
