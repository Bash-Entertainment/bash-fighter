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

test('the how-to-play block is not behind a <details> or any click-to-reveal element', () => {
  const block = startScreenSrc.match(/<div class="how-to-play">[\s\S]*?<\/div>\s*<\/div>/);
  assert.ok(block, 'how-to-play block must exist on the start screen');
  assert.doesNotMatch(block[0], /<details/, 'must be visible without clicking anything, not behind a <details> disclosure');
});

test('the how-to-play block names all five controls that matter', () => {
  for (const key of ['A/D', 'Space', 'F', 'G', 'Shift']) {
    assert.match(startScreenSrc, new RegExp(`<b>${key}</b>`), `missing control key ${key}`);
  }
});

test('the how-to-play block explains damage increases knockback', () => {
  assert.match(startScreenSrc, /damage[^<]*fly farther/i);
});
