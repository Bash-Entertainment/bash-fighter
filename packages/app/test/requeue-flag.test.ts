// 2026-09-19: adds a `requeued` field to session telemetry -- true when a
// match was entered by clicking "Play again" on the elimination/match-end
// overlay or win screen, rather than the start screen's "Play online"
// button. This is the re-queue-loop metric. No jsdom is available here
// (see "Sim Core Implementation Notes"), so this pins the wiring at
// source level, same convention as webgl-context-loss.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const netMatch = readFileSync(new URL('../src/net-match.ts', import.meta.url), 'utf8');

test('beginOnlineMatch defaults requeued to false for the start-screen path', () => {
  assert.match(main, /async function beginOnlineMatch\(requeued = false\): Promise<void>/);
  const startScreenIdx = main.indexOf("void beginOnlineMatch();");
  assert.notEqual(startScreenIdx, -1, 'start screen must call beginOnlineMatch() with no argument');
});

test('every "Play again" style action passes requeued=true into beginOnlineMatch', () => {
  const playAgainCallSites = [...main.matchAll(/label: 'Play again',[^}]*?onClick: \(\) => void beginOnlineMatch\((true)?\)/g)];
  assert.ok(playAgainCallSites.length >= 2, 'expected the elimination overlay and match-end overlay Play again buttons');
  for (const m of playAgainCallSites) {
    assert.equal(m[1], 'true', 'a Play again button must call beginOnlineMatch(true)');
  }

  // The win screen / timed-brawl-end-screen rematch callback, and the
  // spectate-stall chip's own "Play again" control.
  assert.match(main, /new SpectateChip\(appRoot, \(\) => void beginOnlineMatch\(true\)\)/);
  const rematchCalls = [...main.matchAll(/void beginOnlineMatch\(true\);/g)];
  assert.ok(rematchCalls.length >= 2, 'expected the win screen and timed-brawl end screen rematch callbacks to pass true');
});

test('beginOnlineMatch forwards requeued into the NetMatch constructor', () => {
  assert.match(main, /}, audio, isQaSession\(\), requestedArenaId\(\), requeued\);/);
});

test('NetMatch accepts a requeued constructor param and carries it into the session report', () => {
  assert.match(netMatch, /requeued = false,\s*\n\s*\)\s*{/);
  assert.match(netMatch, /this\.requeued = requeued;/);
  assert.match(netMatch, /requeued: this\.requeued,/);
});
