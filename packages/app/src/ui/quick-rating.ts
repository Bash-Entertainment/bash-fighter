import { postLeaveReason, type LeaveReasonExtra } from '../feedback-post.ts';
import { markRatedThisSession, QUICK_RATINGS, type QuickRatingId } from '../quick-rating.ts';

const MAX_TEXT = 200;

export interface QuickRatingOptions {
  /** Context recorded with the rating; the follow-up sentence reuses it with "-text" appended. */
  extra: () => LeaveReasonExtra;
  isTouchActive: () => boolean;
  /** End screens: taps must not cancel the auto-continue countdown or steal focus. */
  keepsCountdown?: boolean;
  /** Taps sooner than this after mounting are leftover match input. */
  graceMs?: number;
  /** Called after the sentence is sent (or skipped) so the host can close. */
  onDone?: () => void;
}

/** Renders the three rating buttons into `host`; one tap posts, then offers a one-line follow-up. */
export function mountQuickRating(host: HTMLElement, options: QuickRatingOptions): void {
  const mountedAt = Date.now();
  host.textContent = '';
  const row = document.createElement('div');
  row.className = 'quick-rating';
  if (options.keepsCountdown) row.dataset.keepsCountdown = '';
  // Typing in the follow-up field must not drive the fighter or trigger game keys.
  for (const t of ['keydown', 'keyup'] as const) row.addEventListener(t, (e) => e.stopPropagation());
  for (const r of QUICK_RATINGS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'quick-rating-btn';
    b.textContent = r.label;
    if (options.keepsCountdown) {
      b.tabIndex = -1;
      b.addEventListener('mousedown', (e) => e.preventDefault());
    }
    b.addEventListener('click', () => {
      if (Date.now() - mountedAt < (options.graceMs ?? 0)) return;
      choose(r.id, row, options);
    });
    row.appendChild(b);
  }
  host.appendChild(row);
}

function choose(rating: QuickRatingId, row: HTMLElement, options: QuickRatingOptions): void {
  postLeaveReason(rating, '', options.isTouchActive(), options.extra());
  markRatedThisSession();
  row.textContent = '';
  row.classList.add('quick-rating-thanks');
  const thanks = document.createElement('div');
  thanks.className = 'quick-rating-thanks-line';
  thanks.textContent = 'Thanks';
  const form = document.createElement('div');
  form.className = 'quick-rating-followup';
  const input = document.createElement('input');
  input.className = 'quick-rating-input';
  input.type = 'text';
  input.maxLength = MAX_TEXT;
  input.placeholder = 'What would make it better?';
  input.setAttribute('aria-label', 'What would make it better');
  input.autocomplete = 'off';
  const send = document.createElement('button');
  send.type = 'button';
  send.className = 'quick-rating-send';
  send.textContent = 'Send';
  send.addEventListener('click', () => {
    const comment = input.value.trim();
    if (comment.length > 0) {
      const extra = options.extra();
      postLeaveReason(rating, comment, options.isTouchActive(), { ...extra, trigger: `${extra.trigger ?? 'rating'}-text` });
    }
    row.textContent = 'Thanks';
    options.onDone?.();
  });
  form.append(input, send);
  row.append(thanks, form);
}
