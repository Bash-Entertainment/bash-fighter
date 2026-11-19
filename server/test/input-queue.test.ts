// The server used to keep only the latest input per seat, so any two frames
// arriving between two sim ticks (a burst from one browser frame, or network
// jitter) lost the first one: ~7% of frames on loopback, enough to swallow a
// quick tap and to make every reconciliation snap the local fighter back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUTTON_ATTACK, BUTTON_JUMP, makeInputFrame } from '@bash-fighter/sim/src/index.ts';
import { InputQueue, MAX_INPUT_BACKLOG } from '../src/input-queue.ts';

const press = (buttons: number) => makeInputFrame(buttons);
const idle = () => makeInputFrame();

test('frames that arrive together are applied on consecutive ticks, none dropped', () => {
  const q = new InputQueue();
  q.push(press(BUTTON_ATTACK), 1);
  q.push(idle(), 2);
  assert.equal(q.next().buttons, BUTTON_ATTACK);
  assert.equal(q.lastAppliedTick, 1);
  assert.equal(q.next().buttons, 0);
  assert.equal(q.lastAppliedTick, 2);
});

test('with nothing new queued the last frame is held and the ack does not advance', () => {
  const q = new InputQueue();
  q.push(press(BUTTON_JUMP), 7);
  q.next();
  assert.equal(q.next().buttons, BUTTON_JUMP);
  assert.equal(q.lastAppliedTick, 7);
});

test('a burst beyond the backlog cap is folded so the press inside it still reaches the sim', () => {
  const q = new InputQueue();
  q.push(press(BUTTON_ATTACK), 1);
  for (let t = 2; t <= MAX_INPUT_BACKLOG + 5; t++) q.push(idle(), t);
  const applied: number[] = [];
  for (let i = 0; i < MAX_INPUT_BACKLOG; i++) applied.push(q.next().buttons);
  assert.equal(applied[0], BUTTON_ATTACK, 'the folded tap fires on the first tick');
  assert.equal(q.lastAppliedTick, MAX_INPUT_BACKLOG + 5, 'backlog drained to the newest frame');
  assert.equal(q.next().buttons, 0);
});

test('clear() drops queued frames and holds neutral input from then on', () => {
  const q = new InputQueue();
  q.push(press(BUTTON_ATTACK), 1);
  q.push(press(BUTTON_ATTACK), 2);
  q.clear();
  assert.equal(q.next().buttons, 0);
});

test('disconnect resets the ack so a resumed client, counting from tick 1 again, gets its frames replayed', () => {
  const q = new InputQueue();
  q.push(press(BUTTON_JUMP), 500);
  q.next();
  q.clear();
  assert.equal(q.lastAppliedTick, 0);
  assert.equal(q.next().buttons, 0);
});
