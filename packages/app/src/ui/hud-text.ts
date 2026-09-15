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
