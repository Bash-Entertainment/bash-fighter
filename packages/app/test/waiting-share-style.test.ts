// No jsdom in this repo, so CSS/DOM contracts are pinned at source level
// (pattern: packages/app/test/start-screen-touch-copy.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');

test('hiding the generic waiting explanation actually hides it', () => {
  // WaitingScreen.setShareLink toggles .hidden on .waiting-explain; without
  // a rule for that combination the host saw both the share panel and the
  // "empty seats fill with bots" line at once.
  assert.match(css, /\.waiting-explain\.hidden\s*\{\s*display:\s*none;/);
});

test('the share panel itself can be hidden', () => {
  assert.match(css, /\.waiting-share\.hidden\s*\{\s*display:\s*none;/);
});

test('hiding the control hint for spectators actually hides it', () => {
  assert.match(css, /\.waiting-hint\.hidden\s*\{\s*display:\s*none;/);
});
