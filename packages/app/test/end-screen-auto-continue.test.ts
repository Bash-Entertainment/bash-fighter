import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Source-level pins (no jsdom in this repo). The behaviour being protected:
// doing nothing at the end of a match should lead back into a match, and a
// player who is reading the standings must be able to stop that.
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
const auto = read('../src/ui/auto-continue.ts');
const win = read('../src/ui/win-screen.ts');
const timed = read('../src/ui/timed-brawl-end-screen.ts');
const main = read('../src/main.ts');

test('the countdown is cancelled by any interaction outside the button', () => {
  assert.match(auto, /addEventListener\('pointerdown', this\.cancelOnInteraction\)/);
  assert.match(auto, /addEventListener\('keydown', this\.cancelOnInteraction\)/);
  assert.match(auto, /if \(event\.target instanceof Node && this\.button\.contains\(event\.target\)\) return;/);
});

test('both end screens start the countdown on show and cancel it on hide', () => {
  for (const [name, src] of [['win', win], ['timed brawl', timed]] as const) {
    assert.match(src, /if \(this\.autoContinueEnabled\) this\.autoContinue\.start\(this\.onRematch\);/, name);
    const hideBody = src.slice(src.indexOf('hide('));
    assert.ok(
      hideBody.indexOf('this.autoContinue.cancel();') < hideBody.indexOf("classList.add('hidden')"),
      `${name}: hide() must cancel before hiding`,
    );
  }
});

test('only an online match rolls into another one on its own', () => {
  assert.match(main, /timedBrawlEndScreen\.autoContinueEnabled = true;/);
  assert.match(main, /winScreen\.autoContinueEnabled = true;/);
  assert.match(main, /winScreen\.autoContinueEnabled = false;\s*\n\s*winScreen\.show\(winnerIndex, 0,/);
});
