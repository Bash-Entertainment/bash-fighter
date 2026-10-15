import { buildMatchRatingBody, isRatingTapAllowed, MATCH_RATING_OPTIONS, type MatchRatingId } from '../match-rating.ts';
import { readBuildSha } from './feedback-panel.ts';

/**
 * "How was that match?" row inside an end screen. It must never disturb the
 * rematch flow: buttons are marked data-keeps-countdown (AutoContinue ignores
 * them), mousedown is cancelled so a tap never moves focus off the rematch
 * button, and taps in the first moments are ignored as leftover match input.
 */
export class MatchRatingRow {
  private openedAt = 0;
  private answered = true;
  private mode = '';

  constructor(private readonly slot: HTMLElement) {}

  /** Call each time the end screen is shown: one rating per match. */
  open(mode: string): void {
    this.mode = mode;
    this.openedAt = Date.now();
    this.answered = false;
    this.slot.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'match-rating';
    row.dataset.keepsCountdown = '';
    const prompt = document.createElement('span');
    prompt.className = 'match-rating-prompt';
    prompt.textContent = 'How was that match?';
    row.appendChild(prompt);
    for (const option of MATCH_RATING_OPTIONS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.tabIndex = -1;
      b.className = 'match-rating-btn';
      b.textContent = option.label;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => this.choose(option.id, b, row));
      row.appendChild(b);
    }
    this.slot.appendChild(row);
  }

  private choose(rating: MatchRatingId, button: HTMLButtonElement, row: HTMLElement): void {
    if (!isRatingTapAllowed(this.openedAt, Date.now(), this.answered)) return;
    this.answered = true;
    button.setAttribute('aria-pressed', 'true');
    const qa = new URLSearchParams(location.search).get('qa') === '1';
    const body = buildMatchRatingBody(
      rating,
      this.mode,
      qa,
      { width: window.innerWidth, height: window.innerHeight },
      readBuildSha(),
    );
    void fetch('/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => undefined);
    row.className = 'match-rating match-rating-thanks';
    row.textContent = 'Thanks';
  }
}
