// When to offer the one-tap rating to a player who was just eliminated for
// good. Most players leave around their own elimination and never reach the
// match-end screen, so this is the only moment most of them can be asked.
import { wasRatedThisSession } from './quick-rating.ts';

/** Taps this soon after the elimination are leftover match input, not an answer. */
export const ELIMINATION_RATING_GRACE_MS = 1500;

/** At most one offer per match, and none to a visitor who already rated this session. */
export class EliminationRatingOffer {
  private offered = false;

  /** Call when a new match begins. */
  reset(): void {
    this.offered = false;
  }

  /** True the first time it is called in a match, unless the visitor already rated. */
  claim(): boolean {
    if (this.offered || wasRatedThisSession()) return false;
    this.offered = true;
    return true;
  }
}
