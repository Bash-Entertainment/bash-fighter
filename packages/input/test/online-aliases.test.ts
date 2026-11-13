// Online play accepts arrows, J/Z, K/X and the left mouse button in addition
// to the player's own binding; local two-player must stay split P1/P2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUTTON_ATTACK, BUTTON_JUMP, BUTTON_SPECIAL, fixed as fx } from '@bash-fighter/sim';
import { InputManager, ONLINE_ALIASES, DEFAULT_P1_BINDING, cloneBinding } from '../src/index.ts';

class FakeSurface extends EventTarget {}

class FakeEvent extends Event {
  constructor(type: string, fields: Record<string, unknown>) {
    super(type);
    for (const [k, v] of Object.entries(fields)) Object.defineProperty(this, k, { value: v });
  }
}

function setup(aliased: boolean) {
  const win = new EventTarget();
  const surface = new FakeSurface();
  const input = new InputManager();
  input.setGamepadIndex(0, null);
  input.setGamepadIndex(1, null);
  if (aliased) input.setAliases(0, ONLINE_ALIASES);
  input.attach(win as unknown as Window);
  input.attachCanvasMouse(surface as unknown as HTMLElement, win as unknown as Window);
  const key = (type: 'keydown' | 'keyup', code: string) =>
    win.dispatchEvent(new FakeEvent(type, { code, target: null }));
  const pointer = (type: string, target: object, pointerType = 'mouse', button = 0) => {
    const ev = new FakeEvent(type, { pointerType, button, target });
    (type === 'pointerdown' ? surface : win).dispatchEvent(ev);
  };
  return { input, key, pointer };
}

test('online: arrows move, ArrowUp jumps, J/Z attack, K/X special', () => {
  const { input, key } = setup(true);
  key('keydown', 'ArrowRight');
  key('keydown', 'ArrowUp');
  let f = input.poll()[0]!;
  assert.equal(f.stickX, fx.ONE);
  assert.equal(f.stickY, fx.ONE);
  assert.equal(f.buttons & BUTTON_JUMP, BUTTON_JUMP);
  key('keyup', 'ArrowRight');
  key('keyup', 'ArrowUp');
  key('keydown', 'KeyZ');
  assert.equal(input.poll()[0]!.buttons, BUTTON_ATTACK);
  key('keyup', 'KeyZ');
  key('keydown', 'KeyX');
  assert.equal(input.poll()[0]!.buttons, BUTTON_SPECIAL);
});

test('online: left mouse press on the canvas attacks; HUD, touch and other buttons do not', () => {
  const { input, pointer } = setup(true);
  pointer('pointerdown', { tagName: 'BUTTON' });
  pointer('pointerdown', { tagName: 'CANVAS' }, 'touch');
  pointer('pointerdown', { tagName: 'CANVAS' }, 'mouse', 2);
  assert.equal(input.poll()[0]!.buttons, 0);
  pointer('pointerdown', { tagName: 'CANVAS' });
  assert.equal(input.poll()[0]!.buttons, BUTTON_ATTACK);
  pointer('pointerup', { tagName: 'CANVAS' });
  assert.equal(input.poll()[0]!.buttons, 0);
});

test('online: a key rebound onto an alias fires only its rebound action', () => {
  const { input, key } = setup(true);
  const b = cloneBinding(DEFAULT_P1_BINDING);
  b.jump = 'KeyJ';
  input.setBinding(0, b);
  key('keydown', 'KeyJ');
  assert.equal(input.poll()[0]!.buttons, BUTTON_JUMP);
});

test('local: slots stay separate and aliases are not applied', () => {
  const { input, key } = setup(false);
  key('keydown', 'ArrowLeft');
  key('keydown', 'KeyJ');
  const [p1, p2] = input.poll();
  assert.equal(p1!.stickX, 0);
  assert.equal(p1!.buttons, 0);
  assert.equal(p2!.stickX, fx.sub(0, fx.ONE));
});
