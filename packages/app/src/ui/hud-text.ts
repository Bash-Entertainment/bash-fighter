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

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}
