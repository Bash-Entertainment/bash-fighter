import { RATING_GRACE_MS } from '../match-rating.ts';
import { wasRatedThisSession } from '../quick-rating.ts';
import { mountQuickRating } from './quick-rating.ts';

/**
 * One-tap rating inside an end screen, offered once per session. It must
 * never disturb the rematch flow: see keepsCountdown in ui/quick-rating.ts.
 */
export class MatchRatingRow {
  constructor(private readonly slot: HTMLElement) {}

  /** Call each time the end screen is shown. */
  open(mode: string): void {
    this.slot.textContent = '';
    if (wasRatedThisSession()) return;
    mountQuickRating(this.slot, {
      extra: () => ({ trigger: `end-screen-${mode}` }),
      isTouchActive: () => 'ontouchstart' in window,
      keepsCountdown: true,
      graceMs: RATING_GRACE_MS,
    });
  }
}
