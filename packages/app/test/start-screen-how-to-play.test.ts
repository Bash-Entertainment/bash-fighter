// Coverage for the always-visible how-to-play summary added 2026-09-19
// after a real player finished a full match and said they didn't
// understand how to win or what to do. No jsdom in this repo, so this
// is pinned by source inspection like the other UI tests (see
// hud-match-status.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const startScreenSrc = readFileSync(join(here, '../src/ui/start-screen.ts'), 'utf8');

test('the how-to-play rules section is not behind a <details> or any click-to-reveal element', () => {
  const block = startScreenSrc.match(/<section class="how-to-play">[\s\S]*?<\/section>/);
  assert.ok(block, 'how-to-play section must exist on the start screen');
  assert.doesNotMatch(block[0], /<details/, 'must be visible without clicking anything, not behind a <details> disclosure');
});

test('the key-chip row sits on the first screen, beside Play, not below the fold', () => {
  const hero = startScreenSrc.slice(startScreenSrc.indexOf('<div class="hero">'), startScreenSrc.indexOf('<div class="below-fold">'));
  assert.match(hero, /id="primary-actions"/);
  assert.match(hero, /class="how-to-play-controls"/);
  assert.match(hero, /Knock the other fighters off the arena\. Up to 20 in a match, free in your browser\./);
  assert.doesNotMatch(hero, /class="how-to-play"/, 'the long rules text belongs below the fold');
});

test('the key-chip row names all five controls that matter', () => {
  for (const key of ['A/D', 'Space', 'F', 'G', 'Shift']) {
    assert.match(startScreenSrc, new RegExp(`<b>${key}</b>`), `missing control key ${key}`);
  }
});

test('the how-to-play section explains damage increases knockback', () => {
  assert.match(startScreenSrc, /damage[^<]*fly farther/i);
});
