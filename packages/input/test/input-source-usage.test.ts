// Regression coverage for the input-device *usage* attribution added
// 2026-09-14 (see docs/MEASUREMENT.md "Capability vs usage" and the
// wiki page "Real Player Measurements 2026-09-14"). InputManager.poll()
// already picks touch > gamepad > keyboard per slot per frame; this
// pins that lastSourceForSlot() reports exactly which one actually won,
// which is what packages/app/src/session-report.ts's InputUsageTracker
// is built on. No DOM needed: KeyboardSource.isHeld() just reads a Set
// this test never populates, so every keyboard poll here is a real
// "nothing held" case, same as a session where the player truly hasn't
// touched anything yet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InputManager, TouchSource } from '../src/index.ts';

// No real Gamepad hardware here -- same minimal navigator.getGamepads
// stub as gamepad.test.ts, always reporting "nothing connected" so
// pollGamepad() falls through to keyboard exactly like a real machine
// with no gamepad plugged in.
function withNoGamepads<T>(fn: () => T): T {
  const g = globalThis as unknown as { navigator?: unknown };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { getGamepads: () => [] },
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

test('InputManager.lastSourceForSlot: defaults to keyboard before any poll and after a plain keyboard poll', () => {
  withNoGamepads(() => {
    const mgr = new InputManager();
    assert.equal(mgr.lastSourceForSlot(0), 'keyboard');
    mgr.poll();
    assert.equal(mgr.lastSourceForSlot(0), 'keyboard');
  });
});

test('InputManager.lastSourceForSlot: reports touch only while a touch source is actually active', () => {
  withNoGamepads(() => {
    const mgr = new InputManager();
    const touch = new TouchSource();
    mgr.setTouchSource(0, touch);

    // No finger down yet -- touch source exists but isActive() is false,
    // so the slot must still fall through to keyboard.
    mgr.poll();
    assert.equal(mgr.lastSourceForSlot(0), 'keyboard');

    // A finger lands on the stick: now this slot's frame comes from touch.
    touch.setActivePointerCount(1);
    touch.setStick(1, 0);
    mgr.poll();
    assert.equal(mgr.lastSourceForSlot(0), 'touch');

    // Finger lifts and the frame the slot now produces (keyboard, since
    // no gamepad and no keys held) is neutral: reported lastSource stays
    // 'touch', the last source that actually produced real input, rather
    // than flapping to 'keyboard' on an idle frame (see pollSlot() and the
    // gamepad-priority fix's tests for the full "no flapping" semantics).
    touch.setActivePointerCount(0);
    mgr.poll();
    assert.equal(mgr.lastSourceForSlot(0), 'touch');
  });
});

test('InputManager.lastSourceForSlot: is tracked independently per slot', () => {
  withNoGamepads(() => {
    const mgr = new InputManager();
    const touch = new TouchSource();
    touch.setActivePointerCount(1);
    touch.setButton('jump', true);
    mgr.setTouchSource(1, touch);

    mgr.poll();
    assert.equal(mgr.lastSourceForSlot(0), 'keyboard'); // slot 0 has no touch source
    assert.equal(mgr.lastSourceForSlot(1), 'touch'); // slot 1 does, and it's active
  });
});
