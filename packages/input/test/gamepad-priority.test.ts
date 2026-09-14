// Regression tests for the 2026-09-14 gamepad-priority bug: pollSlot() used
// to give an attached gamepad priority over the keyboard unconditionally,
// so a merely-connected (or drifting) pad silently swallowed keyboard input
// and mis-attributed usage telemetry. Fix: a gamepad frame only outranks
// keyboard when it is non-neutral (isNeutralFrame, gamepad.ts). These tests
// build a fake gamepad the same way gamepad.test.ts does, and drive
// KeyboardSource the way keyboard.test.ts does (a fake window whose
// addEventListener captures the down/up handlers so keydown/keyup can be
// dispatched by calling them directly -- no real DOM needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InputManager, TouchSource } from '../src/index.ts';

interface FakeButton {
  pressed: boolean;
}

interface FakeGamepad {
  connected: boolean;
  axes: number[];
  buttons: FakeButton[];
}

function makeNeutralGamepad(overrides: Partial<FakeGamepad> = {}): FakeGamepad {
  return {
    connected: true,
    axes: [0, 0],
    buttons: [
      { pressed: false },
      { pressed: false },
      { pressed: false },
      { pressed: false },
      { pressed: false },
      { pressed: false },
    ],
    ...overrides,
  };
}

function withFakeGamepads<T>(pads: (FakeGamepad | null)[], fn: () => T): T {
  const g = globalThis as unknown as { navigator?: unknown };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { getGamepads: () => pads },
    configurable: true,
    writable: true,
  });
  try {
    return fn();
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, 'navigator', previous);
    } else {
      delete g.navigator;
    }
  }
}

// Minimal fake window: KeyboardSource.attach() only calls addEventListener
// with 'keydown'/'keyup', so this captures those two callbacks and lets the
// test dispatch fake events directly, matching the pattern already used in
// keyboard.test.ts.
class FakeWindow {
  listeners = new Map<string, (e: unknown) => void>();
  addEventListener(type: string, cb: (e: unknown) => void): void {
    this.listeners.set(type, cb);
  }
  removeEventListener(type: string): void {
    this.listeners.delete(type);
  }
  fire(type: string, event: unknown): void {
    this.listeners.get(type)?.(event);
  }
}

function press(win: FakeWindow, code: string): void {
  win.fire('keydown', { code, target: { tagName: 'DIV', isContentEditable: false } });
}

test('gamepad priority: neutral pad + held keyboard key -> keyboard frame and keyboard source', () => {
  withFakeGamepads([makeNeutralGamepad()], () => {
    const mgr = new InputManager();
    const win = new FakeWindow();
    mgr.attach(win as unknown as Window);
    // slot 0 default binding's "right" key -- see bindings.ts DEFAULT_P1_BINDING.
    press(win, 'KeyD');

    const [frame] = mgr.poll();
    assert.ok(frame);
    assert.notEqual(frame.stickX, 0);
    assert.equal(mgr.lastSourceForSlot(0), 'keyboard');
  });
});

test('gamepad priority: non-neutral pad wins over keyboard', () => {
  const pad = makeNeutralGamepad({ axes: [0.9, 0] });
  withFakeGamepads([pad], () => {
    const mgr = new InputManager();
    const win = new FakeWindow();
    mgr.attach(win as unknown as Window);
    press(win, 'KeyD'); // keyboard also held, but pad should win

    const [frame] = mgr.poll();
    assert.ok(frame);
    assert.equal(mgr.lastSourceForSlot(0), 'gamepad');
    assert.equal(frame.stickX > 0, true);
  });
});

test('gamepad priority: active touch beats both a non-neutral pad and keyboard', () => {
  const pad = makeNeutralGamepad({ axes: [0.9, 0] });
  withFakeGamepads([pad], () => {
    const mgr = new InputManager();
    const win = new FakeWindow();
    mgr.attach(win as unknown as Window);
    press(win, 'KeyD');
    const touch = new TouchSource();
    mgr.setTouchSource(0, touch);
    touch.setActivePointerCount(1);
    touch.setStick(-1, 0);

    const [frame] = mgr.poll();
    assert.ok(frame);
    assert.equal(mgr.lastSourceForSlot(0), 'touch');
    assert.equal(frame.stickX < 0, true);
  });
});

test('gamepad priority: neutral pad and neutral keyboard leave lastSource at the previous real source', () => {
  const pad = makeNeutralGamepad({ axes: [0.9, 0] });
  withFakeGamepads([pad], () => {
    const mgr = new InputManager();
    const win = new FakeWindow();
    mgr.attach(win as unknown as Window);
    press(win, 'KeyD');

    // Frame 1: non-neutral pad wins.
    mgr.poll();
    assert.equal(mgr.lastSourceForSlot(0), 'gamepad');

    // Frame 2: pad goes neutral, keyboard key released -- nothing this
    // slot has is producing real input. lastSource must not flap to
    // 'keyboard'; it should keep reporting 'gamepad', the last source
    // that actually drove the fighter.
    pad.axes = [0, 0];
    win.fire('keyup', { code: 'KeyD', target: { tagName: 'DIV', isContentEditable: false } });
    const [frame] = mgr.poll();
    assert.ok(frame);
    assert.equal(frame.buttons, 0);
    assert.equal(frame.stickX, 0);
    assert.equal(frame.stickY, 0);
    assert.equal(mgr.lastSourceForSlot(0), 'gamepad');
  });
});

test('gamepad priority: lastSourceForSlot defaults to keyboard before any poll, even with a non-neutral pad attached', () => {
  const pad = makeNeutralGamepad({ axes: [0.9, 0] });
  withFakeGamepads([pad], () => {
    const mgr = new InputManager();
    assert.equal(mgr.lastSourceForSlot(0), 'keyboard');
  });
});
