import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KoTracker, KO_ATTRIBUTION_TICKS, REVENGE_TICKS } from '../src/ko-callout.ts';

type F = { percent: number; deathCount: number; eliminated: boolean; lastAttacker: number };
const fighter = (over: Partial<F> = {}): F => ({ percent: 0, deathCount: 0, eliminated: false, lastAttacker: -1, ...over });
const ME = 0;
const ROOK = 2;

/** Three fighters; `over` patches individual slots. */
const frame = (over: Record<number, Partial<F>> = {}): F[] => [0, 1, 2].map((i) => fighter(over[i]));

function hitThenDie(tracker: KoTracker, victim: number, attacker: number, ticksBetween: number) {
  const before = frame();
  const hit = frame({ [victim]: { percent: 90, lastAttacker: attacker } });
  tracker.observe(before, hit, ME, 100);
  const dead = frame({ [victim]: { percent: 0, deathCount: 1 } });
  return tracker.observe(hit, dead, ME, 100 + ticksBetween);
}

test('names the fighter whose hit preceded the local death, even though the sim clears lastAttacker on death', () => {
  const events = hitThenDie(new KoTracker(), ME, ROOK, 40);
  assert.deepEqual(events, [{ type: 'koedBy', attacker: ROOK }]);
});

test('a death with no recent hit reads as a fall', () => {
  assert.deepEqual(hitThenDie(new KoTracker(), ME, ROOK, KO_ATTRIBUTION_TICKS + 1), [{ type: 'fell' }]);
  const t = new KoTracker();
  const events = t.observe(frame(), frame({ [ME]: { deathCount: 1 } }), ME, 50);
  assert.deepEqual(events, [{ type: 'fell' }]);
  assert.equal(t.revengeSlot(50), null);
});

test('a fall after being hit marks nobody, and other fighters\' deaths are silent', () => {
  const t = new KoTracker();
  assert.deepEqual(hitThenDie(t, 1, ROOK, 30), []);
  assert.equal(t.revengeSlot(130), null);
});

test('revenge marks the attacker until the target is knocked out or 20s pass', () => {
  const t = new KoTracker();
  hitThenDie(t, ME, ROOK, 40);
  assert.equal(t.revengeSlot(141), ROOK);
  assert.equal(t.revengeSlot(140 + REVENGE_TICKS - 1), ROOK);
  assert.equal(t.revengeSlot(140 + REVENGE_TICKS), null);
});

test('knocking the target out announces revenge and clears the marker', () => {
  const t = new KoTracker();
  hitThenDie(t, ME, ROOK, 40);
  const hit = frame({ [ROOK]: { percent: 120, lastAttacker: ME } });
  t.observe(frame(), hit, ME, 300);
  const events = t.observe(hit, frame({ [ROOK]: { deathCount: 1 } }), ME, 330);
  assert.deepEqual(events, [{ type: 'revenge' }]);
  assert.equal(t.revengeSlot(331), null);
});

test('the target dying to someone else clears the marker without a revenge callout', () => {
  const t = new KoTracker();
  hitThenDie(t, ME, ROOK, 40);
  const hit = frame({ [ROOK]: { percent: 120, lastAttacker: 1 } });
  t.observe(frame(), hit, ME, 300);
  assert.deepEqual(t.observe(hit, frame({ [ROOK]: { deathCount: 1 } }), ME, 330), []);
  assert.equal(t.revengeSlot(331), null);
});

test('no marker once the local player is out of the match for good', () => {
  const t = new KoTracker();
  const hit = frame({ [ME]: { percent: 150, lastAttacker: ROOK } });
  t.observe(frame(), hit, ME, 100);
  t.observe(hit, frame({ [ME]: { deathCount: 1, eliminated: true } }), ME, 120);
  assert.equal(t.revengeSlot(121), null);
});

test('spectators (no local slot) get no events', () => {
  assert.deepEqual(new KoTracker().observe(frame(), frame({ 1: { deathCount: 1 } }), -1, 10), []);
});
