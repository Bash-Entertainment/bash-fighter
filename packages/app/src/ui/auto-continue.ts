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

export class AutoContinue {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly label: string;
  private readonly cancelOnInteraction = (event: Event): void => {
    if (event.target instanceof Node && this.button.contains(event.target)) return;
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
