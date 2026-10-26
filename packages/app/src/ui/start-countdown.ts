import { isReducedMotion } from '@bash-fighter/render';
import { GO_LABEL } from '../start-countdown.ts';

/** Large centred "3, 2, 1, GO!" over the arena while the sim is frozen.
 * Presentation-only; never takes pointer events. */
export class StartCountdown {
  private readonly root: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'start-countdown hidden';
    this.root.setAttribute('aria-hidden', 'true');
    parent.appendChild(this.root);
  }

  /** Show a label, or hide with null. Re-triggers the pop animation each call. */
  show(label: string | null): void {
    if (label === null) {
      this.root.classList.add('hidden');
      return;
    }
    const text = document.createElement('span');
    text.className = 'start-countdown-text';
    text.classList.toggle('go', label === GO_LABEL);
    text.classList.toggle('reduced', isReducedMotion());
    text.textContent = label;
    this.root.replaceChildren(text);
    this.root.classList.remove('hidden');
  }
}
