// Contextual "how do I attack" hint for a newcomer's first match. The
// trigger rule lives in ../attack-hint.ts; this owns the DOM and the
// once-per-match / gone-for-good-after-an-attack lifecycle. Presentation
// only: it reads samples and never feeds anything back into the sim.
import { isReducedMotion } from '@bash-fighter/render';
import { shouldShowAttackHint, type AttackHintSample } from '../attack-hint.ts';

export interface AttackHintTarget {
  /** Highlights the on-screen Attack button with a label; touch only. */
  setTouchAttackHint(on: boolean): void;
}

export class AttackHint {
  private readonly el: HTMLDivElement;
  private visible = false;
  private spent = false;

  constructor(
    parent: HTMLElement,
    private readonly touch: AttackHintTarget | null,
    private readonly attackKeyLabel: () => string,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'attack-hint hidden';
    this.el.setAttribute('aria-live', 'polite');
    parent.appendChild(this.el);
  }

  /** Call at each match start: the hint may show again once per match. */
  reset(): void {
    this.hide();
    this.spent = false;
  }

  /** Feeds the latest sample; returns true on the call that first shows it. */
  update(sample: AttackHintSample | null): boolean {
    if (this.spent) return false;
    if (sample?.attackOrSpecialPressed || sample === null) {
      if (this.visible || sample?.attackOrSpecialPressed) this.dismiss();
      return false;
    }
    if (this.visible || !shouldShowAttackHint(sample)) return false;
    this.visible = true;
    if (this.touch) {
      this.touch.setTouchAttackHint(true);
    } else {
      this.el.textContent = `Press ${this.attackKeyLabel()} to attack`;
      this.el.classList.toggle('reduced', isReducedMotion());
      this.el.classList.remove('hidden');
    }
    return true;
  }

  /** Hides the hint for the rest of this match. */
  dismiss(): void {
    this.spent = true;
    this.hide();
  }

  private hide(): void {
    this.visible = false;
    this.el.classList.add('hidden');
    this.touch?.setTouchAttackHint(false);
  }
}
