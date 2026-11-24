// Announcer callout text ("Double KO!", "On a roll"). Presentation-only DOM
// overlay; a new call replaces any still showing so rapid KOs never stack.
import { isReducedMotion } from '@bash-fighter/render';

const CALL_MS = 1400;

let current: HTMLElement | null = null;
let removeTimer: ReturnType<typeof setTimeout> | undefined;

export function showAnnouncerCall(text: string): void {
  if (typeof document === 'undefined') return;
  current?.remove();
  clearTimeout(removeTimer);
  const el = document.createElement('div');
  el.className = isReducedMotion() ? 'announcer-call announcer-call-still' : 'announcer-call';
  el.textContent = text;
  el.setAttribute('aria-hidden', 'true');
  document.body.appendChild(el);
  current = el;
  removeTimer = setTimeout(() => {
    el.remove();
    if (current === el) current = null;
  }, CALL_MS);
}
