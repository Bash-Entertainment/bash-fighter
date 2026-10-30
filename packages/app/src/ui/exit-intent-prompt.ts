import { EXIT_INTENT_MIN_MATCH_AGE_SEC, EXIT_INTENT_SHOWN_KEY, shouldShowExitIntent } from '../exit-intent.ts';
import { postLeaveReason } from '../feedback-post.ts';
import { LEAVE_REASONS, settleLeavePrompt } from '../leave-prompt.ts';

const MAX_TEXT = 200;
const TAB_RETURN_MIN_AWAY_MS = 4000;

export interface ExitIntentDeps {
  playingLive: () => boolean;
  matchAgeSec: () => number;
  matchIndex: () => number;
  isTouchActive: () => boolean;
}

function wasShown(): boolean {
  try {
    return localStorage.getItem(EXIT_INTENT_SHOWN_KEY) !== null;
  } catch {
    return true;
  }
}

function markShown(): void {
  try {
    localStorage.setItem(EXIT_INTENT_SHOWN_KEY, '1');
  } catch {
    // storage denied: shown at most once per page load anyway
  }
}

/** Installs the once-per-visitor "Leaving? What sucked?" prompt. */
export function installExitIntentPrompt(deps: ExitIntentDeps): void {
  let shownThisPage = false;
  document.addEventListener('mouseout', (e) => {
    const show = shouldShowExitIntent({
      clientY: e.clientY,
      leftDocument: e.relatedTarget === null,
      playingLive: deps.playingLive(),
      matchAgeSec: deps.matchAgeSec(),
      alreadyShown: shownThisPage || wasShown(),
    });
    if (!show) return;
    shownThisPage = true;
    markShown();
    mount(deps, 'Leaving? One tap tells us what to fix.', 'exit-intent');
  });
  // Phones have no exit-intent pointer: ask when the player comes back to
  // the tab after stepping away from a live match.
  let hiddenAt: number | null = null;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = deps.playingLive() && deps.matchAgeSec() >= EXIT_INTENT_MIN_MATCH_AGE_SEC ? Date.now() : null;
      return;
    }
    const awayMs = hiddenAt === null ? 0 : Date.now() - hiddenAt;
    hiddenAt = null;
    if (awayMs < TAB_RETURN_MIN_AWAY_MS || shownThisPage || wasShown()) return;
    shownThisPage = true;
    markShown();
    mount(deps, 'Welcome back. What made you step away?', 'tab-return');
  });
}

function mount(deps: ExitIntentDeps, title: string, trigger: string): void {
  const root = document.createElement('div');
  root.id = 'exit-intent';
  root.className = 'exit-intent';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Why are you leaving?');
  root.innerHTML = [
    '<div class="exit-intent-head">',
    `  <span class="exit-intent-title">${title}</span>`,
    '  <button type="button" class="exit-intent-close" aria-label="Dismiss">\u00d7</button>',
    '</div>',
    '<div class="exit-intent-chips"></div>',
  ].join('');
  document.body.appendChild(root);
  // Typing in the follow-up field must not drive the fighter or be swallowed by game keys.
  for (const t of ['keydown', 'keyup'] as const) root.addEventListener(t, (e) => e.stopPropagation());

  const chips = root.querySelector('.exit-intent-chips') as HTMLElement;
  for (const r of LEAVE_REASONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'leave-prompt-chip';
    b.textContent = r.label;
    b.addEventListener('click', () => {
      postLeaveReason(r.id, '', deps.isTouchActive(), {
        trigger,
        matchAgeSec: deps.matchAgeSec(),
        matchIndex: deps.matchIndex(),
      });
      settleLeavePrompt();
      showFollowUp(root);
    });
    chips.appendChild(b);
  }
  (root.querySelector('.exit-intent-close') as HTMLButtonElement).addEventListener('click', () => root.remove());
}

function showFollowUp(root: HTMLElement): void {
  root.innerHTML = [
    '<div class="exit-intent-head">',
    '  <span class="exit-intent-title">Thanks. Anything specific?</span>',
    '  <button type="button" class="exit-intent-close" aria-label="Close">\u00d7</button>',
    '</div>',
    '<div class="leave-prompt-row">',
    `  <input class="leave-prompt-input" type="text" maxlength="${MAX_TEXT}" placeholder="What happened? (optional)" aria-label="What happened" autocomplete="off" />`,
    '  <button type="button" class="leave-prompt-send">Send</button>',
    '</div>',
  ].join('');
  const input = root.querySelector('.leave-prompt-input') as HTMLInputElement;
  (root.querySelector('.exit-intent-close') as HTMLButtonElement).addEventListener('click', () => root.remove());
  (root.querySelector('.leave-prompt-send') as HTMLButtonElement).addEventListener('click', () => {
    const comment = input.value.trim();
    if (comment.length > 0) {
      void fetch('/api/feedback', {
        method: 'POST',
        keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(new URLSearchParams(location.search).get('qa') === '1' ? { qa: true } : {}),
          comment,
          context: { trigger: 'exit-intent-text', viewport: { width: window.innerWidth, height: window.innerHeight } },
        }),
      }).catch(() => undefined);
    }
    root.textContent = 'Thanks';
    setTimeout(() => root.remove(), 1500);
  });
  input.focus();
}
