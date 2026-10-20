import test from 'node:test';
import assert from 'node:assert/strict';
import { BEST_KEY, nextGoalLine, recordKos, type StorageLike } from '../src/personal-best.ts';

const mem = (init?: string): StorageLike & { v: string | null } => ({
  v: init ?? null,
  getItem() { return this.v; },
  setItem(_k, val) { this.v = val; },
});

test('beating the best stores it and flags it new', () => {
  const s = mem('3');
  assert.deepEqual(recordKos(s, 5), { kos: 5, best: 5, isNew: true });
  assert.equal(s.v, '5');
});
test('equal or lower keeps the stored best', () => {
  const s = mem('4');
  assert.deepEqual(recordKos(s, 4), { kos: 4, best: 4, isNew: false });
  assert.deepEqual(recordKos(s, 2), { kos: 2, best: 4, isNew: false });
  assert.equal(s.v, '4');
});
test('zero KOs never stores a best', () => {
  const s = mem();
  assert.deepEqual(recordKos(s, 0), { kos: 0, best: 0, isNew: false });
  assert.equal(s.v, null);
});
test('corrupt value is treated as no best', () => {
  const s = mem('abc');
  assert.equal(recordKos(s, 2).isNew, true);
  assert.equal(BEST_KEY, 'bash-fighter:best-timed-kos');
});
test('next goal line names the best, empty without one', () => {
  assert.equal(nextGoalLine(mem('7')), 'Next: beat 7 KOs');
  assert.equal(nextGoalLine(mem()), '');
});
test('next goal singular', () => { assert.equal(nextGoalLine(mem('1')), 'Next: beat 1 KO'); });
