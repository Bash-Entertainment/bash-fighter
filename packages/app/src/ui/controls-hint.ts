// A reminder of the controls, shown at the start of a match to a player
// who has not yet touched the controls. It stays up until they actually
// do something (with a hard cap so it never becomes furniture) and the
// "you have seen this" flag is only written once real input happened --
// about a third of seats press nothing at all, and those are exactly the
// people who should still get the hint next time.
const STORAGE_KEY = 'bash-fighter:seen-controls-hint';
/** Fired by NetMatch the first tick the local seat presses attack. */
export const LOCAL_ATTACK_EVENT = 'bash-fighter:local-attack';
const MAX_VISIBLE_MS = 20000;
// Real sessions load the game, watch a match for ten or fifteen seconds and
// leave without ever pressing anything. The quiet strip at the bottom is easy
// to read past, so if nothing has been pressed by this point it gets louder.
const URGENT_AFTER_MS = 5000;
const LINGER_AFTER_INPUT_MS = 1200;
const FADE_MS = 600;

const KEYBOARD_TEXT = 'A/D move · Space jump · F attack · G special · Shift shield';
const TOUCH_TEXT = 'Drag the stick to move · tap Jump and Attack';
const KEYBOARD_URGENT = 'You are in the match — A/D to move, Space to jump, F to attack';
const TOUCH_URGENT = 'You are in the match — drag the stick to move, tap Attack';
// Real newcomers moved around for 25-30s and never pressed attack once: the
// hint used to vanish on the first key of any kind, taking "F attack" with
// it. Moving now swaps it for the one thing still missing; only an actual
// attack dismisses it.
const KEYBOARD_ATTACK_NEXT = 'Now press F to attack';
const TOUCH_ATTACK_NEXT = 'Now tap Attack to hit';
const ATTACK_NEXT_MAX_MS = 30000;

export class ControlsHint {
  private readonly el: HTMLDivElement;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private listening = false;
  private touch = false;
  private moved = false;
  private readonly onInput = (): void => this.noteMovement();
  private readonly onAttack = (): void => this.acknowledge();

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
    this.touch = touch;
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
    this.moved = false;
    this.el.classList.remove('hidden', 'fading', 'urgent');
    if (!this.listening) {
      this.listening = true;
      window.addEventListener('keydown', this.onInput);
      window.addEventListener('pointerdown', this.onInput);
      window.addEventListener(LOCAL_ATTACK_EVENT, this.onAttack);
    }
    this.timers.push(setTimeout(() => this.escalate(), URGENT_AFTER_MS));
    this.timers.push(setTimeout(() => this.fade(), MAX_VISIBLE_MS));
  }

  /** Nothing pressed yet: say so plainly instead of listing keys quietly. */
  private escalate(): void {
    if (this.el.classList.contains('hidden')) return;
    this.el.classList.add('urgent');
    this.el.textContent = this.touch ? TOUCH_URGENT : KEYBOARD_URGENT;
  }

  /** Any key or touch that was not an attack: they found movement, so point
   * at attack instead of repeating the whole list. */
  private noteMovement(): void {
    if (this.moved) return;
    this.moved = true;
    this.clearTimers();
    this.el.classList.remove('fading', 'hidden');
    this.el.classList.add('urgent');
    this.el.textContent = this.touch ? TOUCH_ATTACK_NEXT : KEYBOARD_ATTACK_NEXT;
    this.timers.push(setTimeout(() => this.fade(), ATTACK_NEXT_MAX_MS));
  }

  /** The player attacked: remember that, then get out of the way. */
  private acknowledge(): void {
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      /* ignore */
    }
    this.stopListening();
    this.clearTimers();
    this.el.classList.remove('urgent');
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
    window.removeEventListener(LOCAL_ATTACK_EVENT, this.onAttack);
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
