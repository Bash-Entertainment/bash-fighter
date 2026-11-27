import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fullyOnScreen } from './title-beacon.ts';

test('fullyOnScreen: a Play button cut off by the bottom edge does not count', () => {
  assert.equal(fullyOnScreen({ top: 614, bottom: 676 }, 720), true);
  assert.equal(fullyOnScreen({ top: 480, bottom: 542 }, 510), false);
  assert.equal(fullyOnScreen({ top: -10, bottom: 40 }, 510), false);
});
