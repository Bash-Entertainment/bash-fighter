import { EXIT_INTENT_MIN_MATCH_AGE_SEC, EXIT_INTENT_SHOWN_KEY, shouldShowExitIntent } from '../exit-intent.ts';
import { settleLeavePrompt } from '../leave-prompt.ts';
import { mountQuickRating } from './quick-rating.ts';

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
    mount(deps, 'Leaving? How was it?', 'exit-intent');
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
    mount(deps, 'Welcome back. How was it?', 'tab-return');
  });
}

function mount(deps: ExitIntentDeps, title: string, trigger: string): void {
  const root = document.createElement('div');
  root.id = 'exit-intent';
  root.className = 'exit-intent';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'How was it?');
  root.innerHTML = [
    '<div class="exit-intent-head">',
    `  <span class="exit-intent-title">${title}</span>`,
    '  <button type="button" class="exit-intent-close" aria-label="Dismiss">\u00d7</button>',
    '</div>',
    '<div class="exit-intent-body"></div>',
  ].join('');
  document.body.appendChild(root);
  mountQuickRating(root.querySelector('.exit-intent-body') as HTMLElement, {
    extra: () => ({ trigger, matchAgeSec: deps.matchAgeSec(), matchIndex: deps.matchIndex() }),
    isTouchActive: deps.isTouchActive,
    onDone: () => {
      settleLeavePrompt();
      setTimeout(() => root.remove(), 1500);
    },
  });
  (root.querySelector('.exit-intent-close') as HTMLButtonElement).addEventListener('click', () => root.remove());
}
