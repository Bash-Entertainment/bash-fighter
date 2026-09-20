import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// No jsdom in this project, so UI wiring is pinned at source level.
const src = readFileSync(new URL('../src/ui/start-screen.ts', import.meta.url), 'utf8');

test('Enter in the name field starts the match', () => {
  const handler = /nameInput\.addEventListener\('keydown',[\s\S]*?\n {4}\}\);/.exec(src);
  assert.ok(handler, 'name input has a keydown handler');
  const body = handler[0];
  assert.match(body, /ev\.key !== 'Enter'/);
  // Enter must trigger the primary action (Play online), not the local
  // side door. Shipping the naive version started a local 1v1 instead.
  assert.match(body, /#primary-actions button/);
  assert.match(body, /primary\.click\(\)/);
  assert.match(body, /preventDefault\(\)/);
});
