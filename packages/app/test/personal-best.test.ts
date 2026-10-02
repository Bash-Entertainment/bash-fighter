import test from 'node:test';
import assert from 'node:assert/strict';
import { BEST_KEY, recordAndDescribe, type StorageLike } from '../src/personal-best.ts';

const mem = (init?: string): StorageLike & { v: string | null } => ({
  v: init ?? null,
  getItem() { return this.v; },
  setItem(_k, val) { this.v = val; },
});

test('new best is stored and announced', () => {
  const s = mem('3');
  assert.equal(recordAndDescribe(s, 5), 'New personal best: 5 knockouts.');
  assert.equal(s.v, '5');
  assert.equal(recordAndDescribe(mem(), 1), 'New personal best: 1 knockout.');
});
test('not a best keeps the stored value', () => {
  const s = mem('4');
  assert.equal(recordAndDescribe(s, 2), 'Your best: 4 knockouts. You got 2.');
  assert.equal(recordAndDescribe(mem('1'), 0), 'Your best: 1 knockout. You got 0.');
  assert.equal(s.v, '4');
});
test('first match with 0 KOs stores nothing', () => {
  const s = mem();
  assert.match(recordAndDescribe(s, 0), /first knockout is waiting/);
  assert.equal(s.v, null);
});
test('corrupt stored value is treated as no best', () => {
  const s = mem('abc');
  assert.equal(recordAndDescribe(s, 2), 'New personal best: 2 knockouts.');
  assert.equal(s.v, '2');
  assert.equal(BEST_KEY, 'bash-fighter:best-timed-kos');
});
