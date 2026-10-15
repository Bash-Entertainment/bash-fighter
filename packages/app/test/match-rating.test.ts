import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildMatchRatingBody, isRatingTapAllowed, RATING_GRACE_MS } from '../src/match-rating.ts';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('a rating tap is ignored during the leftover-input grace and after the first answer', () => {
  assert.equal(isRatingTapAllowed(1000, 1000 + RATING_GRACE_MS - 1, false), false);
  assert.equal(isRatingTapAllowed(1000, 1000 + RATING_GRACE_MS, false), true);
  assert.equal(isRatingTapAllowed(1000, 1000 + RATING_GRACE_MS, true), false);
});

test('the request body is the strict match-rating shape', () => {
  const body = buildMatchRatingBody('good', 'timed-brawl', false, { width: 390, height: 844 }, 'abc');
  assert.deepEqual(body, {
    kind: 'match-rating',
    rating: 'good',
    context: { mode: 'timed-brawl', viewport: { width: 390, height: 844 }, buildSha: 'abc' },
  });
  assert.equal(buildMatchRatingBody('bad', 'm', true, { width: 1, height: 1 }).qa, true);
});

test('rating taps neither cancel the countdown nor take focus from the rematch button', () => {
  const auto = read('../src/ui/auto-continue.ts');
  const row = read('../src/ui/match-rating-row.ts');
  assert.match(auto, /closest\(KEEPS_COUNTDOWN_SELECTOR\)\) return;/);
  assert.match(row, /row\.dataset\.keepsCountdown/);
  assert.match(row, /addEventListener\('mousedown', \(e\) => e\.preventDefault\(\)\)/);
  assert.match(row, /b\.tabIndex = -1/);
  assert.doesNotMatch(row, /\.focus\(|autoContinue|cancel\(/);
});

test('both end screens open the row once per show', () => {
  for (const f of ['win-screen', 'timed-brawl-end-screen']) {
    const src = read(`../src/ui/${f}.ts`);
    assert.equal((src.match(/this\.rating\.open\(/g) ?? []).length, 1, f);
    assert.match(src, /match-rating-slot/);
  }
});
