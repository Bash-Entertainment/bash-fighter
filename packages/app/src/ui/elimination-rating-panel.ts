import { ELIMINATION_RATING_GRACE_MS } from '../elimination-rating.ts';
import { mountQuickRating } from './quick-rating.ts';

/**
 * Small dismissible panel with the one-tap rating, shown when the local
 * player is eliminated. It is a sibling of the elimination overlay, not
 * inside it, so using it never cancels the "Play again" countdown, and it
 * takes no space from the touch controls (it sits at the top of the screen).
 */
export class EliminationRatingPanel {
  private root: HTMLElement | null = null;

  constructor(
    private readonly parent: HTMLElement,
    private readonly isTouchActive: () => boolean,
  ) {}

  show(mode: string, placement: number): void {
    this.hide();
    const root = document.createElement('div');
    root.className = 'elim-rating';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'How was the match?');
    root.innerHTML = [
      '<div class="exit-intent-head">',
      '  <span class="exit-intent-title">How was the match?</span>',
      '  <button type="button" class="exit-intent-close" aria-label="Dismiss">\u00d7</button>',
      '</div>',
      '<div class="exit-intent-body"></div>',
    ].join('');
    this.parent.appendChild(root);
    mountQuickRating(root.querySelector('.exit-intent-body') as HTMLElement, {
      extra: () => ({ trigger: 'eliminated', mode, placement }),
      isTouchActive: this.isTouchActive,
      graceMs: ELIMINATION_RATING_GRACE_MS,
      onDone: () => setTimeout(() => this.hide(), 1500),
    });
    (root.querySelector('.exit-intent-close') as HTMLButtonElement).addEventListener('click', () => this.hide());
    this.root = root;
  }

  /** On a phone, moves the panel from the top (over the HUD) to just above the spectate chip. */
  dockAboveChip(): void {
    this.root?.classList.add('elim-rating-docked');
  }

  hide(): void {
    this.root?.remove();
    this.root = null;
  }
}
