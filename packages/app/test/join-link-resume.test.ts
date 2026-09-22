// Source-level pin (no jsdom in this repo): following an invite link must
// win over a stale resume token, or a friend who played minutes ago lands
// back in their own old match. Found on production 2026-09-22.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const net = readFileSync(new URL('../src/net-match.ts', import.meta.url), 'utf8');

test('both join-link entry paths drop the stored resume token first', () => {
  const calls = main.match(/clearStoredResumeToken\(\)/g) ?? [];
  // One for hosting ("Play with a friend"), one for arriving on ?join=CODE,
  // one for arriving on ?watch=CODE (see [[Spectate by link]]).
  assert.equal(calls.length, 3);
  assert.match(main, /clearStoredResumeToken\(\);\s*\n\s*void beginOnlineMatch\(false, sanitised\)/);
  assert.match(main, /const code = generateJoinCode\(\);\s*\n\s*clearStoredResumeToken\(\)/);
  assert.match(main, /clearStoredResumeToken\(\);\s*\n\s*void beginOnlineMatch\(false, sanitised, true\)/);
});

test('clearStoredResumeToken is exported and clears the stored token', () => {
  assert.match(net, /export function clearStoredResumeToken\(\): void \{\s*saveResumeToken\(null\);/);
});
