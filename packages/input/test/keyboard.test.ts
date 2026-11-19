// Regression tests for issue #35: KeyboardSource listens on `window` and
// used to feed every key press to the game even while a real <button>
// (mute, Controls, Moves, a touch action button, a panel's close/reset
// button) had keyboard focus. That meant tabbing to a button, or clicking
// one with the mouse, and then pressing Space caused a double-fire: the
// browser activated the focused button *and* the game read Space as Jump.
//
// The fix does not blur buttons on activation (that would defeat tabbing
// and hide focus from keyboard users) -- it only skips feeding the key to
// the game when the event's target is itself a focusable form control,
// letting the browser's own activation behaviour proceed untouched.
//
// No jsdom here, so this builds the minimal fake KeyboardEvent/target
// shape KeyboardSource actually touches (matching the pattern in
// touch-controls.test.ts), attaching to a real Node EventTarget so
// dispatch/listener semantics are genuine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyboardSource } from '../src/keyboard.ts';

class FakeButton {
  tagName = 'BUTTON';
  isContentEditable = false;
}

class FakeTextField {
  tagName = 'INPUT';
  isContentEditable = false;
}

class FakeGameSurface {
  tagName = 'DIV';
  isContentEditable = false;
}

class FakeKeyboardEvent {
  code: string;
  target: object;
  constructor(code: string, target: object) {
    this.code = code;
    this.target = target;
  }
}

// A minimal fake `window`: KeyboardSource only ever calls addEventListener/
// removeEventListener on it and hands the callback a plain object shaped
// like a KeyboardEvent, so this avoids real EventTarget dispatch entirely
// (real Event.target is a getter fixed to whatever it was dispatched on --
// fighting that is more trouble than it's worth for what this needs).
class FakeWindow {
  private listeners = new Map<string, Set<(e: FakeKeyboardEvent) => void>>();
  addEventListener(type: string, cb: (e: FakeKeyboardEvent) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }
  removeEventListener(type: string, cb: (e: FakeKeyboardEvent) => void): void {
    this.listeners.get(type)?.delete(cb);
  }
  fire(type: string, code: string, target: object): void {
    for (const cb of this.listeners.get(type) ?? []) cb(new FakeKeyboardEvent(code, target));
  }
}

function fireDown(win: FakeWindow, code: string, eventTarget: object): void {
  win.fire('keydown', code, eventTarget);
}

function fireUp(win: FakeWindow, code: string, eventTarget: object): void {
  win.fire('keyup', code, eventTarget);
}

test('KeyboardSource: a game key with the game surface focused is held as before', () => {
  const win = new FakeWindow();
  const source = new KeyboardSource();
  source.attach(win as unknown as Window);

  fireDown(win, 'Space', new FakeGameSurface());
  assert.equal(source.isHeld('Space'), true);

  fireUp(win, 'Space', new FakeGameSurface());
  assert.equal(source.isHeld('Space'), false);
});

test('KeyboardSource: a key pressed while a button has focus is not read as a game input', () => {
  const win = new FakeWindow();
  const source = new KeyboardSource();
  source.attach(win as unknown as Window);

  fireDown(win, 'Space', new FakeButton());
  assert.equal(
    source.isHeld('Space'),
    false,
    'Space pressed on a focused button must not also be read as Jump',
  );
});

test('KeyboardSource: releasing a key always clears it, even if the up-event target is a button', () => {
  const win = new FakeWindow();
  const source = new KeyboardSource();
  source.attach(win as unknown as Window);

  // Key goes down while the game surface has focus (so it is held)...
  fireDown(win, 'Space', new FakeGameSurface());
  assert.equal(source.isHeld('Space'), true);

  // ...then focus moves to a button before the key is released (e.g. Tab
  // was pressed mid-hold). The key-up must still clear it, or it would
  // ghost-hold Jump forever.
  fireUp(win, 'Space', new FakeButton());
  assert.equal(source.isHeld('Space'), false);
});

test('KeyboardSource: detach stops both listeners', () => {
  const win = new FakeWindow();
  const source = new KeyboardSource();
  source.attach(win as unknown as Window);
  source.detach(win as unknown as Window);

  fireDown(win, 'Space', new FakeGameSurface());
  assert.equal(source.isHeld('Space'), false);
});

// Narrowed after review (John, 2026-09-12): swallowing *every* key while a
// button holds focus is a worse defect than the double-fire it fixed -- click
// the mute button with a mouse and the whole keyboard would go dead until you
// clicked the arena again. Only the keys the browser itself consumes as an
// activation are withheld.
test('KeyboardSource: movement keys still work while a button holds focus', () => {
  const win = new FakeWindow();
  const source = new KeyboardSource();
  source.attach(win as unknown as Window);

  fireDown(win, 'KeyD', new FakeButton());
  assert.equal(source.isHeld('KeyD'), true, 'a mouse click leaving a button focused must not kill movement');

  fireDown(win, 'KeyF', new FakeButton());
  assert.equal(source.isHeld('KeyF'), true, 'attack must still reach the game');
});

test('KeyboardSource: Enter on a focused button is withheld like Space', () => {
  const win = new FakeWindow();
  const source = new KeyboardSource();
  source.attach(win as unknown as Window);

  fireDown(win, 'Enter', new FakeButton());
  assert.equal(source.isHeld('Enter'), false);
});

test('KeyboardSource: typing in a text field never reaches the game', () => {
  const win = new FakeWindow();
  const source = new KeyboardSource();
  source.attach(win as unknown as Window);

  for (const code of ['KeyD', 'KeyF', 'Space']) {
    fireDown(win, code, new FakeTextField());
    assert.equal(source.isHeld(code), false, `${code} typed into a name field must not drive the fighter`);
  }
});

test('KeyboardSource: a tap released before the next poll is still read by that poll, once', () => {
  const win = new FakeWindow();
  const source = new KeyboardSource();
  source.attach(win as unknown as Window);

  // An ~8 ms tap lands entirely between two 60Hz samples.
  fireDown(win, 'KeyJ', new FakeGameSurface());
  fireUp(win, 'KeyJ', new FakeGameSurface());
  assert.equal(source.isHeld('KeyJ'), false);
  assert.equal(source.isDownForPoll('KeyJ'), true, 'the sample after the tap sees it');
  source.endPoll();
  assert.equal(source.isDownForPoll('KeyJ'), false, 'and the one after does not');
});

test('KeyboardSource: a held key stays down across polls; reset() drops a pending tap', () => {
  const win = new FakeWindow();
  const source = new KeyboardSource();
  source.attach(win as unknown as Window);

  fireDown(win, 'KeyD', new FakeGameSurface());
  source.endPoll();
  assert.equal(source.isDownForPoll('KeyD'), true);

  fireDown(win, 'KeyJ', new FakeGameSurface());
  fireUp(win, 'KeyJ', new FakeGameSurface());
  source.reset();
  assert.equal(source.isDownForPoll('KeyJ'), false);
  assert.equal(source.isDownForPoll('KeyD'), false);
});
