import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldShowExitIntent } from './exit-intent.ts';

const base = { clientY: 0, leftDocument: true, playingLive: true, matchAgeSec: 10, alreadyShown: false };

test('exit intent fires only when a live player moves the pointer out through the top edge', () => {
  assert.equal(shouldShowExitIntent(base), true);
  assert.equal(shouldShowExitIntent({ ...base, clientY: 300 }), false);
  assert.equal(shouldShowExitIntent({ ...base, leftDocument: false }), false);
  assert.equal(shouldShowExitIntent({ ...base, playingLive: false }), false);
  assert.equal(shouldShowExitIntent({ ...base, matchAgeSec: 1 }), false);
  assert.equal(shouldShowExitIntent({ ...base, alreadyShown: true }), false);
});
