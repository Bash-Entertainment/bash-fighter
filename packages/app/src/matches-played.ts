// First-matches knockout boost (2026-09-26, see wiki "Tapered First-Matches
// Knockout Boost"): the server tapers a human seat's rookie knockback
// scale by how many matches this browser has already played, not just
// whether it was auto-requeued -- match 2 used to drop straight to 1.0x,
// a cliff a real newcomer hit immediately after match 1.
//
// Persisted in localStorage rather than a cookie/account because there is
// no account system (see [[Player Feedback Channel 2026-09-13]] for the
// account-free precedent) and it only needs to survive reloads on the
// same browser, not follow the player anywhere. Never sent anywhere but
// the join `hello` -- see net-match.ts.
export const MATCHES_PLAYED_KEY = 'bash-fighter-matches-played';

/** Best-effort: private-browsing/storage-denied environments throw on
 *  localStorage access, and a `node --test` run outside a browser has no
 *  `window` at all (see net-match.ts's own guards) -- both just mean "we
 *  don't know", not a crash. */
export function getMatchesPlayed(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const raw = window.localStorage.getItem(MATCHES_PLAYED_KEY);
    const n = raw ? parseInt(raw, 10) : 0;
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Called once a match actually starts for the local seat (not for a
 *  spectate-only connection -- see net-match.ts's startMatch). */
export function recordMatchPlayed(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MATCHES_PLAYED_KEY, String(getMatchesPlayed() + 1));
  } catch {
    // Storage denied/full -- the taper just falls back to the
    // requeued-based behaviour server-side. Not worth surfacing.
  }
}
