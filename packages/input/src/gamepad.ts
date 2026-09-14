// Standard Gamepad API polling: axis 0/1 for the left stick, standard
// mapping button indices for jump/attack/special/shield. Polled on demand
// (poll-based API, no events) once per app frame.
import { fixed as fx, makeInputFrame, type InputFrame } from '@bash-fighter/sim';
import { BUTTON_ATTACK, BUTTON_JUMP, BUTTON_SHIELD, BUTTON_SPECIAL } from '@bash-fighter/sim';

// Standard mapping (https://www.w3.org/TR/gamepad/#remapping): 0=A/Cross
// (jump), 1=B/Circle (attack), 2=X/Square (special), 5=RB/R1 (shield).
const BTN_JUMP = 0;
const BTN_ATTACK = 1;
const BTN_SPECIAL = 2;
const BTN_SHIELD = 5;
const DEADZONE = 0.2;

export function axisToFixed(v: number): number {
  const clamped = Math.abs(v) < DEADZONE ? 0 : v;
  return fx.fromFloat(Math.max(-1, Math.min(1, clamped)));
}

/** Returns the InputFrame for gamepad `padIndex`, or null if not connected. */
export function pollGamepad(padIndex: number): InputFrame | null {
  const pads = typeof navigator !== 'undefined' ? navigator.getGamepads() : [];
  const pad = pads[padIndex];
  if (!pad || !pad.connected) return null;

  let buttons = 0;
  if (pad.buttons[BTN_JUMP]?.pressed) buttons |= BUTTON_JUMP;
  if (pad.buttons[BTN_ATTACK]?.pressed) buttons |= BUTTON_ATTACK;
  if (pad.buttons[BTN_SPECIAL]?.pressed) buttons |= BUTTON_SPECIAL;
  if (pad.buttons[BTN_SHIELD]?.pressed) buttons |= BUTTON_SHIELD;

  const stickX = axisToFixed(pad.axes[0] ?? 0);
  const stickY = axisToFixed(-(pad.axes[1] ?? 0)); // invert: up should be positive Y

  return makeInputFrame(buttons, stickX, stickY);
}

/** True when an InputFrame carries no actual input: no buttons held and
 * both stick axes at rest (post-deadzone fixed-point zero). Shared by the
 * pollSlot() priority chain (a gamepad frame only outranks keyboard when it
 * is non-neutral) and by packages/app/src/net-match.ts's hadInput check --
 * kept here rather than duplicated so both agree on what "no input" means. */
export function isNeutralFrame(frame: InputFrame): boolean {
  return frame.buttons === 0 && frame.stickX === 0 && frame.stickY === 0;
}

export function listConnectedGamepads(): number[] {
  if (typeof navigator === 'undefined') return [];
  const pads = navigator.getGamepads();
  const result: number[] = [];
  for (let i = 0; i < pads.length; i++) {
    if (pads[i]?.connected) result.push(i);
  }
  return result;
}
