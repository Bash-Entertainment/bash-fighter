import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { EliminationRatingOffer } from '../src/elimination-rating.ts';
import { markRatedThisSession } from '../src/quick-rating.ts';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  Object.assign(globalThis, {
    window: {
      sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    },
  });
});
afterEach(() => Reflect.deleteProperty(globalThis, 'window'));

test('offers once per match and again after the next match begins', () => {
  const offer = new EliminationRatingOffer();
  assert.equal(offer.claim(), true);
  assert.equal(offer.claim(), false);
  offer.reset();
  assert.equal(offer.claim(), true);
});

test('a visitor who already rated is not asked, and rating on elimination silences the end screen', async () => {
  const { wasRatedThisSession } = await import('../src/quick-rating.ts');
  const offer = new EliminationRatingOffer();
  markRatedThisSession();
  assert.equal(offer.claim(), false);
  offer.reset();
  assert.equal(offer.claim(), false);
  assert.equal(wasRatedThisSession(), true);
});
