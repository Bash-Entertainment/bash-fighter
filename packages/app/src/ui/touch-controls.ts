// On-screen touch controls: a drag-anywhere movement stick (bottom-left)
// and four action buttons (bottom-right), shown only on touch-capable
// devices and only while the player is actually touching them -- see
// packages/input/src/touch.ts for the InputFrame-producing half of this.
//
// Design rationale (see the touch input design wiki page for the full
// write-up):
//  - One draggable stick beats separate left/right/up/down buttons for
//    movement: a fighting game needs diagonal aerial drift (stickY feeds
//    uair/dair choice and hitstun DI, see packages/sim/src/sim.ts), and a
//    thumb sliding inside a radius is faster and more forgiving under
//    time pressure than hitting four discrete zones.
//  - Four separate buttons beat any gesture for actions: attack/special/
//    shield/jump must be individually and simultaneously pressable
//    (moving while attacking is core to the genre), and a control that
//    can be missed loses the exchange in a fighting game -- so hit
//    targets are large and spaced for thumb error, not screen economy.
//  - Both clusters live in the bottom corners, within one-handed thumb
//    reach on a phone held in landscape or portrait, and stay clear of
//    the upper two-thirds of the screen where the fight actually happens.
import { TouchSource, type TouchButton } from '@bash-fighter/input';

interface StickPointerState {
  pointerId: number;
  originX: number;
  originY: number;
}

const STICK_RADIUS = 52;

// Synthetic pointer id for keyboard activation (Enter/Space on a focused
// action button). Real browsers issue non-negative pointer ids, so -1 can
// never collide with a real finger; reusing the pointer bookkeeping means
// keyboard presses get the same "another finger may still hold this
// button" release logic for free (issue #27).
const KEYBOARD_POINTER_ID = -1;

/** Clearance between the top of the stick and the damage readout. */
const STICK_READOUT_GAP_PX = 14;

export class TouchControls {
  readonly root: HTMLDivElement;
  readonly source = new TouchSource();

  private readonly stickBase: HTMLDivElement;
  private readonly stickNub: HTMLDivElement;
  private stickPointer: StickPointerState | null = null;

  private readonly buttonPointers = new Map<number, TouchButton>();

  /** Told the height the controls occupy in the bottom-left corner, so the
   * canvas can move anything drawn there (the local damage percent) out
   * from under the player's thumb. Injected rather than imported so this
   * module stays free of the renderer. */
  private readonly onBottomLeftInsetChange: (px: number) => void;

  constructor(parent: HTMLElement, onBottomLeftInsetChange: (px: number) => void = () => {}) {
    this.onBottomLeftInsetChange = onBottomLeftInsetChange;
    this.root = document.createElement('div');
    this.root.id = 'touch-controls';
    this.root.className = 'hidden';

    this.stickBase = document.createElement('div');
    this.stickBase.className = 'touch-stick-base';
    this.stickNub = document.createElement('div');
    this.stickNub.className = 'touch-stick-nub';
    this.stickBase.appendChild(this.stickNub);
    this.root.appendChild(this.stickBase);

    const buttons = document.createElement('div');
    buttons.className = 'touch-buttons';
    buttons.appendChild(this.makeButton('shield', 'Shield'));
    buttons.appendChild(this.makeButton('special', 'Special'));
    buttons.appendChild(this.makeButton('attack', 'Attack'));
    buttons.appendChild(this.makeButton('jump', 'Jump'));
    this.root.appendChild(buttons);

    parent.appendChild(this.root);
    this.attachStickHandlers();
  }

  show(): void {
    this.root.classList.remove('hidden');
    // The local damage percent -- the biggest number on screen -- is drawn
    // into the canvas's bottom-left corner, which is exactly where the
    // movement stick sits on a phone. Tell the renderer how much of that
    // corner is taken so the number moves above the stick.
    const stick = this.stickBase.getBoundingClientRect();
    this.onBottomLeftInsetChange(stick.height + STICK_READOUT_GAP_PX);
  }

  hide(): void {
    this.root.classList.add('hidden');
    this.onBottomLeftInsetChange(0);
    this.reset();
  }

  private reset(): void {
    this.stickPointer = null;
    this.buttonPointers.clear();
    this.stickNub.style.transform = 'translate(0, 0)';
    this.source.reset();
  }

  private updateActiveCount(): void {
    const count = (this.stickPointer ? 1 : 0) + this.buttonPointers.size;
    this.source.setActivePointerCount(count);
  }

  // -- Shared press/release bookkeeping (pointer + keyboard) ---------

  // One code path for every way a button can come down (touch, pen,
  // keyboard) so the multi-pointer rules -- second finger on the same
  // button, releases arriving out of order -- are identical regardless
  // of input source. Keyboard presses ride the same Map under
  // KEYBOARD_POINTER_ID.
  private pressButton(name: TouchButton, btn: HTMLButtonElement, pointerId: number): void {
    this.buttonPointers.set(pointerId, name);
    this.source.setButton(name, true);
    btn.classList.add('pressed');
    this.updateActiveCount();
  }

  private releaseButton(name: TouchButton, btn: HTMLButtonElement, pointerId: number): void {
    if (!this.buttonPointers.has(pointerId)) return;
    this.buttonPointers.delete(pointerId);
    // Only clear the button if no other pointer is still holding it --
    // relevant if a second finger lands on the same button mid-tap, or a
    // finger holds it while the keyboard press on it is released.
    const stillHeld = Array.from(this.buttonPointers.values()).includes(name);
    if (!stillHeld) {
      this.source.setButton(name, false);
      btn.classList.remove('pressed');
    }
    this.updateActiveCount();
  }

  private makeButton(name: TouchButton, label: string): HTMLButtonElement {
    // A real <button>, not a div with role="button" (issue #27): it is
    // in the tab order by default, announced as a button by screen
    // readers (its text content is the accessible name), and
    // Enter/Space key handling below makes keyboard activation drive
    // the same source state a finger would.
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `touch-btn touch-btn-${name}`;
    btn.textContent = label;
    btn.dataset.button = name;
    const onDown = (e: PointerEvent): void => {
      e.preventDefault();
      // setPointerCapture can throw (invalid/stale pointer id, pointer
      // already released between event dispatch and this call, etc). If
      // it throws before the state below is set, the finger's press is
      // silently lost and can leave the button state inconsistent with
      // what's on screen -- worse than not capturing at all. Capture is
      // a nice-to-have (keeps move/up events routed to this element even
      // if the finger drifts outside it); state tracking below is what
      // actually matters, so it must not depend on capture succeeding.
      try {
        btn.setPointerCapture(e.pointerId);
      } catch {
        // Ignored -- see comment above.
      }
      this.pressButton(name, btn, e.pointerId);
    };
    const onUp = (e: PointerEvent): void => {
      this.releaseButton(name, btn, e.pointerId);
    };
    // Keyboard activation: hold Enter or Space and the button is held,
    // release and it clears -- matching a finger's press-and-hold
    // semantics (shield especially is a hold, not a tap). preventDefault
    // stops the browser's synthetic click on keyup, which would fire a
    // second, stateless activation on top of the hold.
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.repeat) return; // key auto-repeat must not re-enter the press path
      e.preventDefault();
      this.pressButton(name, btn, KEYBOARD_POINTER_ID);
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      this.releaseButton(name, btn, KEYBOARD_POINTER_ID);
    };
    // If focus leaves while the keyboard press is held (Tab away, or
    // focus jumps on a HUD toggle), the keyup would land on another
    // element and the action would stick on forever -- the worst
    // failure mode here, same reason pointercancel is handled below.
    // Releasing on blur closes that hole.
    const onBlur = (): void => {
      this.releaseButton(name, btn, KEYBOARD_POINTER_ID);
    };
    btn.addEventListener('pointerdown', onDown);
    btn.addEventListener('pointerup', onUp);
    btn.addEventListener('pointercancel', onUp);
    btn.addEventListener('keydown', onKeyDown);
    btn.addEventListener('keyup', onKeyUp);
    btn.addEventListener('blur', onBlur);
    return btn;
  }

  private attachStickHandlers(): void {
    const onDown = (e: PointerEvent): void => {
      if (this.stickPointer) return; // one finger drives the stick at a time
      e.preventDefault();
      // See the button handler's onDown for why this is guarded the
      // same way: a thrown setPointerCapture must not stop the stick
      // from registering the finger that just pressed it down.
      try {
        this.stickBase.setPointerCapture(e.pointerId);
      } catch {
        // Ignored -- capture is a nice-to-have, not a requirement.
      }
      this.stickPointer = { pointerId: e.pointerId, originX: e.clientX, originY: e.clientY };
      this.updateActiveCount();
    };
    const onMove = (e: PointerEvent): void => {
      if (!this.stickPointer || e.pointerId !== this.stickPointer.pointerId) return;
      e.preventDefault();
      const dx = e.clientX - this.stickPointer.originX;
      const dy = e.clientY - this.stickPointer.originY;
      const mag = Math.hypot(dx, dy);
      const clampedMag = Math.min(mag, STICK_RADIUS);
      const nx = mag > 0 ? (dx / mag) * clampedMag : 0;
      const ny = mag > 0 ? (dy / mag) * clampedMag : 0;
      this.stickNub.style.transform = `translate(${nx}px, ${ny}px)`;
      // Screen Y grows downward; the sim's up is positive Y (see
      // gamepad.ts's own inversion), so flip here too.
      this.source.setStick(nx / STICK_RADIUS, -ny / STICK_RADIUS);
    };
    const onUp = (e: PointerEvent): void => {
      if (!this.stickPointer || e.pointerId !== this.stickPointer.pointerId) return;
      this.stickPointer = null;
      this.stickNub.style.transform = 'translate(0, 0)';
      this.source.setStick(0, 0);
      this.updateActiveCount();
    };
    this.stickBase.addEventListener('pointerdown', onDown);
    this.stickBase.addEventListener('pointermove', onMove);
    this.stickBase.addEventListener('pointerup', onUp);
    this.stickBase.addEventListener('pointercancel', onUp);
  }
}
