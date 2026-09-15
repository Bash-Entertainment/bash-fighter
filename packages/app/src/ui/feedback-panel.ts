// Account-free player feedback (2026-09-13, owner directive: an agent has
// no human feel for the game, so real players need a dead-simple way to
// say what felt off, landing somewhere it can actually be read and acted
// on -- see server/src/feedback.ts for the POST /api/feedback endpoint
// and wiki "Bash Entertainment Overview").
//
// Reuses the shared modal shell (.move-reference-panel/.settings-panel)
// so this reads as the same product as every other panel, not a bolted
// -on widget -- see settings-panel.ts's own comment on the same choice.
//
// Never blocks play: closable by Escape and by an explicit Close button
// (see the unclosable-modal bug fixed in [[Client Traps Fixed 2026-09-11
// Evening]]), and it is only ever opened by an explicit click -- there is
// no automatic/timed popup anywhere in this file, so "shown automatically
// at most once per session" holds trivially. Typing in the comment box
// never reaches the game: packages/input/src/keyboard.ts's
// shouldIgnoreKeydown already ignores keydowns targeted at a focused
// INPUT/TEXTAREA, which is exactly what the textarea below is -- no new
// input-layer plumbing needed, see feedback-panel.test.ts for the
// assertion that this really is a plain <textarea>.
const RATING_QUESTIONS = [
  { key: 'combatWeight', label: 'Did hits feel like they landed with real weight?' },
  { key: 'cameraReadability', label: 'Could you always tell what was happening on screen?' },
  { key: 'funFactor', label: 'How much fun was that match?' },
  { key: 'touchErgonomics', label: 'Did the touch controls feel comfortable to use?', touchOnly: true },
  { key: 'matchmakingClarity', label: 'Was joining a match and knowing the mode clear?' },
] as const;

export type FeedbackRatingKey = (typeof RATING_QUESTIONS)[number]['key'];
export type FeedbackRatings = Partial<Record<FeedbackRatingKey, number>>;

export interface FeedbackContext {
  matchId?: string | null;
  arenaId?: string | null;
  mode?: string | null;
  placement?: number | string | null;
  result?: string | null;
}

const GITHUB_ISSUES_URL = 'https://github.com/Bash-Entertainment/bash-fighter/issues';

/** Optional global a build step can set (e.g. `window.__BASH_BUILD_SHA__
 *  = '<sha>'` injected at deploy time) so submissions carry a build sha
 *  when one exists. Nothing sets this today -- reading it is forward
 *  -looking and always falls back to undefined, never throws. */
export function readBuildSha(): string | undefined {
  const sha = (window as unknown as { __BASH_BUILD_SHA__?: unknown }).__BASH_BUILD_SHA__;
  return typeof sha === 'string' && sha.length > 0 ? sha : undefined;
}

export class FeedbackPanel {
  readonly root: HTMLDivElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly ratingsEl: HTMLDivElement;
  private readonly statusEl: HTMLDivElement;
  private readonly submitBtn: HTMLButtonElement;
  private readonly ratingButtons = new Map<FeedbackRatingKey, HTMLButtonElement[]>();
  private ratings: FeedbackRatings = {};
  private context: FeedbackContext = {};
  private submitting = false;

  private readonly isTouchActive: () => boolean;

  /** Escape closes the panel from anywhere, including while the comment
   *  textarea has focus -- same convention as settings-panel.ts's
   *  dismissHandler. Only registered while the panel is open. */
  private readonly dismissHandler = (e: KeyboardEvent) => {
    if (e.code !== 'Escape') return;
    e.preventDefault();
    this.hide();
  };

  constructor(parent: HTMLElement, isTouchActive: () => boolean) {
    this.isTouchActive = isTouchActive;
    this.root = document.createElement('div');
    this.root.id = 'feedback-panel';
    this.root.className = 'move-reference-panel feedback-panel hidden';
    this.root.innerHTML = [
      '<div class="move-reference-inner feedback-inner">',
      '  <div class="move-reference-header">',
      '    <div class="move-reference-title">Feedback</div>',
      '    <button type="button" class="move-reference-close" aria-label="Close">Close</button>',
      '  </div>',
      '  <div class="feedback-hint">What did you think? What felt off?</div>',
      '  <textarea class="feedback-textarea" maxlength="2000" rows="4" aria-label="What did you think? What felt off?"></textarea>',
      '  <div class="feedback-ratings"></div>',
      '  <div class="feedback-status" aria-live="polite"></div>',
      '  <div class="feedback-actions">',
      '    <button type="button" class="btn btn-primary feedback-submit-btn">Send feedback</button>',
      '    <a class="feedback-github-link" href="' + GITHUB_ISSUES_URL + '" target="_blank" rel="noopener noreferrer">Or file an issue on GitHub</a>',
      '  </div>',
      '</div>',
    ].join('\n');
    parent.appendChild(this.root);
    this.textarea = this.root.querySelector('.feedback-textarea') as HTMLTextAreaElement;
    this.ratingsEl = this.root.querySelector('.feedback-ratings') as HTMLDivElement;
    this.statusEl = this.root.querySelector('.feedback-status') as HTMLDivElement;
    this.submitBtn = this.root.querySelector('.feedback-submit-btn') as HTMLButtonElement;
    (this.root.querySelector('.move-reference-close') as HTMLButtonElement).addEventListener('click', () =>
      this.hide(),
    );
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.hide();
    });
    this.submitBtn.addEventListener('click', () => void this.submit());
    this.buildRatingRows();
  }

  private buildRatingRows(): void {
    this.ratingsEl.innerHTML = '';
    this.ratingButtons.clear();
    for (const q of RATING_QUESTIONS) {
      const row = document.createElement('div');
      row.className = 'feedback-rating-row';
      row.dataset.key = q.key;
      if ('touchOnly' in q && q.touchOnly) row.classList.add('feedback-touch-only');
      const label = document.createElement('div');
      label.className = 'feedback-rating-label';
      label.textContent = q.label;
      const scale = document.createElement('div');
      scale.className = 'feedback-rating-scale';
      const buttons: HTMLButtonElement[] = [];
      for (let n = 1; n <= 5; n++) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'feedback-rating-btn';
        btn.textContent = String(n);
        btn.setAttribute('aria-label', `${q.label} -- ${n} of 5`);
        btn.addEventListener('click', () => {
          const current = this.ratings[q.key];
          // Clicking the already-selected value clears it -- every rating
          // question is optional, and this is the only way to un-answer
          // one once picked without reopening the whole panel.
          this.ratings = { ...this.ratings, [q.key]: current === n ? undefined : n };
          this.renderRatingSelection(q.key);
        });
        buttons.push(btn);
        scale.appendChild(btn);
      }
      this.ratingButtons.set(q.key, buttons);
      row.appendChild(label);
      row.appendChild(scale);
      this.ratingsEl.appendChild(row);
    }
  }

  private renderRatingSelection(key: FeedbackRatingKey): void {
    const buttons = this.ratingButtons.get(key);
    if (!buttons) return;
    const value = this.ratings[key];
    buttons.forEach((btn, i) => btn.classList.toggle('selected', value === i + 1));
  }

  private renderTouchVisibility(): void {
    const touchActive = this.isTouchActive();
    const row = this.ratingsEl.querySelector('.feedback-touch-only') as HTMLDivElement | null;
    if (row) row.style.display = touchActive ? '' : 'none';
  }

  /** @param context Optional match/end-screen context to attach to this
   *  submission -- see FeedbackContext. Never required: the free-text
   *  Feedback entry point from the HUD/start screen calls show() with
   *  nothing. */
  show(context: FeedbackContext = {}): void {
    this.context = context;
    this.statusEl.textContent = '';
    this.statusEl.className = 'feedback-status';
    this.renderTouchVisibility();
    this.root.classList.remove('hidden');
    window.addEventListener('keydown', this.dismissHandler);
  }

  hide(): void {
    this.root.classList.add('hidden');
    window.removeEventListener('keydown', this.dismissHandler);
  }

  get isOpen(): boolean {
    return !this.root.classList.contains('hidden');
  }

  private hasAnyRating(): boolean {
    return Object.values(this.ratings).some((v) => v !== undefined);
  }

  private async submit(): Promise<void> {
    if (this.submitting) return;
    const comment = this.textarea.value.trim();
    if (comment.length === 0 && !this.hasAnyRating()) {
      this.statusEl.textContent = 'Say something in the box or pick at least one rating first.';
      this.statusEl.className = 'feedback-status feedback-status-error';
      return;
    }
    this.submitting = true;
    this.submitBtn.disabled = true;
    this.statusEl.textContent = 'Sending...';
    this.statusEl.className = 'feedback-status';
    const ratings: FeedbackRatings = {};
    for (const [key, value] of Object.entries(this.ratings)) {
      if (value !== undefined) (ratings as Record<string, number>)[key] = value;
    }
    const buildSha = readBuildSha();
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          comment: comment.length > 0 ? comment : undefined,
          ratings: Object.keys(ratings).length > 0 ? ratings : undefined,
          context: {
            ...this.context,
            touchControls: this.isTouchActive(),
            viewport: { width: window.innerWidth, height: window.innerHeight },
            ...(buildSha ? { buildSha } : {}),
          },
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && body.ok) {
        this.statusEl.textContent = 'Thanks -- that was sent.';
        this.statusEl.className = 'feedback-status feedback-status-ok';
        this.textarea.value = '';
        this.ratings = {};
        for (const q of RATING_QUESTIONS) this.renderRatingSelection(q.key);
      } else {
        this.statusEl.textContent = body.error
          ? `Could not send that: ${body.error}`
          : 'Could not send that. Try again in a moment.';
        this.statusEl.className = 'feedback-status feedback-status-error';
      }
    } catch {
      this.statusEl.textContent = 'Could not reach the server. Check your connection and try again.';
      this.statusEl.className = 'feedback-status feedback-status-error';
    } finally {
      this.submitting = false;
      this.submitBtn.disabled = false;
    }
  }
}
