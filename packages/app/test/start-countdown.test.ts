import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countdownLabel } from '../src/start-countdown.ts';

test('countdown reads 3, 2, 1, GO! across a 180-tick freeze, then clears', () => {
  const labels = [0, 59, 60, 119, 120, 179, 180, 239, 240].map((t) => countdownLabel(t, 180));
  assert.deepEqual(labels, ['3', '3', '2', '2', '1', '1', 'GO!', 'GO!', null]);
});

test('no countdown when the match has no intro freeze', () => {
  assert.equal(countdownLabel(0, 0), null);
});
