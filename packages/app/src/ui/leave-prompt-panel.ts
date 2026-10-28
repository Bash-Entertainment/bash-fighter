import { LEAVE_REASONS, settleLeavePrompt, type LeaveReasonId } from '../leave-prompt.ts';
import { postLeaveReason } from '../feedback-post.ts';

const MAX_TEXT = 200;

/** Small inline, non-modal panel under the Play button. */
export function mountLeavePrompt(after: HTMLElement, isTouchActive: () => boolean): void {
  const root = document.createElement('div');
  root.id = 'leave-prompt';
  root.className = 'leave-prompt';
  root.innerHTML = [
    '<div class="leave-prompt-head">',
    '  <span class="leave-prompt-title">Last time you left mid-match. What made you leave?</span>',
    '  <button type="button" class="leave-prompt-close" aria-label="Dismiss">\u00d7</button>',
    '</div>',
    '<div class="leave-prompt-chips"></div>',
    '<div class="leave-prompt-row">',
    `  <input class="leave-prompt-input" type="text" maxlength="${MAX_TEXT}" placeholder="Anything else? (optional)" aria-label="Anything else" autocomplete="off" />`,
    '  <button type="button" class="leave-prompt-send" disabled>Send</button>',
    '</div>',
  ].join('');
  after.insertAdjacentElement('afterend', root);

  const chips = root.querySelector('.leave-prompt-chips') as HTMLElement;
  const input = root.querySelector('.leave-prompt-input') as HTMLInputElement;
  const send = root.querySelector('.leave-prompt-send') as HTMLButtonElement;
  let selected: LeaveReasonId | null = null;

  for (const r of LEAVE_REASONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'leave-prompt-chip';
    b.textContent = r.label;
    b.dataset.reason = r.id;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => {
      selected = r.id;
      for (const c of chips.children) c.setAttribute('aria-pressed', String((c as HTMLElement).dataset.reason === r.id));
      send.disabled = false;
    });
    chips.appendChild(b);
  }

  const finish = (thanks: boolean) => {
    settleLeavePrompt();
    if (!thanks) {
      root.remove();
      return;
    }
    root.className = 'leave-prompt leave-prompt-thanks';
    root.textContent = 'Thanks';
    setTimeout(() => root.remove(), 2000);
  };

  (root.querySelector('.leave-prompt-close') as HTMLButtonElement).addEventListener('click', () => finish(false));
  send.addEventListener('click', () => {
    if (!selected) return;
    postLeaveReason(selected, input.value.trim(), isTouchActive(), { trigger: 'next-visit' });
    finish(true);
  });
}
