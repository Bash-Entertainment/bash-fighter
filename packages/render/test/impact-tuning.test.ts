import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BIG_HIT_STRENGTH,
  KO_BURST_LIFE_MS,
  SQUASH_MAX,
  isBigHit,
  koBurstAnchor,
  sparkCount,
  squashScale,
  victimPauseMs,
} from '../src/impact-tuning.ts';

test('light hits get no victim pause; heavier hits hold longer but stay under 200ms', () => {
  assert.equal(victimPauseMs(0.1), 0);
  const medium = victimPauseMs(0.4);
  const heavy = victimPauseMs(1);
  assert.ok(medium > 0 && heavy > medium && heavy <= 100);
});

test('only big hits qualify for screen kick', () => {
  assert.equal(isBigHit(BIG_HIT_STRENGTH - 0.01), false);
  assert.equal(isBigHit(BIG_HIT_STRENGTH), true);
});

test('squash compresses along the knockback axis, eases to neutral, never exceeds the max', () => {
  const side = squashScale(100, 100, 1, 1, 0);
  assert.ok(side.x < 1 && side.y > 1 && 1 - side.x <= SQUASH_MAX + 1e-9);
  const up = squashScale(100, 100, 1, 0, 1);
  assert.ok(up.y < 1 && up.x > 1);
  assert.deepEqual(squashScale(0, 100, 1, 1, 0), { x: 1, y: 1 });
  assert.ok(squashScale(20, 100, 1, 1, 0).x > side.x);
});

test('spark count grows with strength and damage and is capped', () => {
  assert.ok(sparkCount(0.2, 2) < sparkCount(0.9, 15));
  assert.equal(sparkCount(5, 500), 11);
});

test('KO burst anchors on the screen edge the fighter left through, facing inward', () => {
  const a = koBurstAnchor(2000, 300, 1280, 720);
  assert.equal(a.x, 1280 - 28);
  assert.equal(a.y, 300);
  assert.ok(a.inwardX < 0);
  assert.ok(KO_BURST_LIFE_MS <= 500);
  const inside = koBurstAnchor(600, 300, 1280, 720);
  assert.equal(inside.x, 600);
});
