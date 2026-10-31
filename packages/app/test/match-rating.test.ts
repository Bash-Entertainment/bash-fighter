import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('rating taps neither cancel the countdown nor take focus from the rematch button', () => {
  const auto = read('../src/ui/auto-continue.ts');
  const row = read('../src/ui/match-rating-row.ts');
  const rating = read('../src/ui/quick-rating.ts');
  assert.match(auto, /closest\(KEEPS_COUNTDOWN_SELECTOR\)\) return;/);
  assert.match(rating, /row\.dataset\.keepsCountdown/);
  assert.match(rating, /addEventListener\('mousedown', \(e\) => e\.preventDefault\(\)\)/);
  assert.match(rating, /b\.tabIndex = -1/);
  assert.match(row, /keepsCountdown: true/);
  assert.doesNotMatch(row + rating, /\.focus\(|autoContinue|cancel\(/);
});

test('both end screens open the row once per show', () => {
  for (const f of ['win-screen', 'timed-brawl-end-screen']) {
    const src = read(`../src/ui/${f}.ts`);
    assert.equal((src.match(/this\.rating\.open\(/g) ?? []).length, 1, f);
    assert.match(src, /match-rating-slot/);
  }
});
