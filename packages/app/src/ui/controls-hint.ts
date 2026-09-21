// A reminder of the controls, shown at the start of a match to a player
// who has not yet touched the controls. It stays up until they actually
// do something (with a hard cap so it never becomes furniture) and the
// "you have seen this" flag is only written once real input happened --
// about a third of seats press nothing at all, and those are exactly the
// people who should still get the hint next time.
const STORAGE_KEY = 'bash-fighter:seen-controls-hint';
const MAX_VISIBLE_MS = 20000;
const LINGER_AFTER_INPUT_MS = 1200;
const FADE_MS = 600;

const KEYBOARD_TEXT = 'A/D move · Space jump · F attack · G special · Shift shield';
const TOUCH_TEXT = 'Drag the stick to move · tap Jump and Attack';

export class ControlsHint {
  private readonly el: HTMLDivElement;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private listening = false;
  private readonly onInput = (): void => this.acknowledge();

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.id = 'controls-hint';
    this.el.className = 'controls-hint hidden';
    this.el.textContent = KEYBOARD_TEXT;
    parent.appendChild(this.el);
  }

  /** Call once per match start. Skipped for players who have already
   * played with it up (tracked in localStorage), so returning players who
   * know the controls are never nagged. */
  maybeShow(touch = false): void {
    if (this.hasPlayed()) return;
    this.el.textContent = touch ? TOUCH_TEXT : KEYBOARD_TEXT;
    this.el.classList.toggle('touch', touch);
    this.show();
  }

  private hasPlayed(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      // localStorage unavailable (privacy mode etc.) -- fail open and show it.
      return false;
    }
  }

  private show(): void {
    this.clearTimers();
    this.el.classList.remove('hidden', 'fading');
    if (!this.listening) {
      this.listening = true;
      window.addEventListener('keydown', this.onInput);
      window.addEventListener('pointerdown', this.onInput);
    }
    this.timers.push(setTimeout(() => this.fade(), MAX_VISIBLE_MS));
  }

  /** The player did something: remember that, then get out of the way. */
  private acknowledge(): void {
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      /* ignore */
    }
    this.stopListening();
    this.clearTimers();
    this.timers.push(setTimeout(() => this.fade(), LINGER_AFTER_INPUT_MS));
  }

  private fade(): void {
    this.el.classList.add('fading');
    this.timers.push(setTimeout(() => this.el.classList.add('hidden'), FADE_MS));
  }

  private stopListening(): void {
    if (!this.listening) return;
    this.listening = false;
    window.removeEventListener('keydown', this.onInput);
    window.removeEventListener('pointerdown', this.onInput);
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  dispose(): void {
    this.stopListening();
    this.clearTimers();
    this.el.classList.add('hidden');
  }
}
