// Ticks a "Play again" button down and then presses it, so that doing
// nothing at the end of a match leads back into a match instead of
// ending the session. The elimination overlay has had this since
// 2026-09-20; the two end screens had only a manual button, and they are
// where every Timed Brawl session ends -- which is now every first-time
// visitor's first match.
//
// It must stay cancellable: a player reading the standings, or opening
// the feedback panel, should not be yanked into a new fight. Any click
// or key inside the screen other than the button itself cancels.
const DEFAULT_SECONDS = 6;
// Phone players are mid-mash when the clock runs out; their next tap landed
// on the end screen and cancelled the countdown, leaving a static screen they
// closed instead of re-queueing. Input this soon after the screen opens is
// leftover match input, not a decision.
export const CANCEL_GRACE_MS = 1500;

export class AutoContinue {
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private readonly label: string;
  private readonly cancelOnInteraction = (event: Event): void => {
    if (event.target instanceof Node && this.button.contains(event.target)) return;
    if (Date.now() - this.startedAt < CANCEL_GRACE_MS) return;
    this.cancel();
  };

  constructor(
    private readonly root: HTMLElement,
    private readonly button: HTMLButtonElement,
    private readonly seconds = DEFAULT_SECONDS,
  ) {
    this.label = button.textContent ?? 'Play again';
  }

  start(onFire: () => void): void {
    this.cancel();
    this.startedAt = Date.now();
    let left = Math.ceil(this.seconds);
    this.button.textContent = `${this.label} (${left})`;
    this.root.addEventListener('pointerdown', this.cancelOnInteraction);
    this.root.addEventListener('keydown', this.cancelOnInteraction);
    this.timer = setInterval(() => {
      left -= 1;
      if (left > 0) {
        this.button.textContent = `${this.label} (${left})`;
        return;
      }
      this.cancel();
      onFire();
    }, 1000);
  }

  cancel(): void {
    this.root.removeEventListener('pointerdown', this.cancelOnInteraction);
    this.root.removeEventListener('keydown', this.cancelOnInteraction);
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.button.textContent = this.label;
  }
}
