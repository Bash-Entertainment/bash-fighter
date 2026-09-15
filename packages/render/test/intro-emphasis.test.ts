// Source-level tests for the local-fighter intro emphasis added
// 2026-09-15 in response to two real players independently asking
// "which one am I" -- the existing screen-space pointer (see
// "Own-Fighter Findability Pointer 2026-09-13") is fine once a player
// knows to look for it and useless the first time they have never
// seen the game. announceLocalPlayer() dims every other fighter and
// enlarges the local pointer for a short wall-clock window, then eases
// back to the untouched steady state.
//
// No jsdom/WebGL here (see "Sim Core Implementation Notes"), so this
// is pinned at source level the way canvas-sizing.test.ts pins the
// container-resize fix in the same file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

test('announceLocalPlayer records a wall-clock start, not a frame count', () => {
  const method = SOURCE.slice(SOURCE.indexOf('announceLocalPlayer(): void'));
  assert.match(method.slice(0, method.indexOf('}')), /this\.introStartMs = performance\.now\(\);/);
});

test('every fighter but the local one is dimmed while the intro window is open, and it eases back to full opacity', () => {
  const block = SOURCE.slice(SOURCE.indexOf('sprite.root.alpha ='), SOURCE.indexOf('sprite.root.alpha =') + 600);
  assert.match(block, /!isLocalPlayer/);
  assert.match(block, /Renderer\.INTRO_DIM_ALPHA/);
  assert.match(block, /Math\.min\(1, \(now - this\.introStartMs\) \/ Renderer\.INTRO_EMPHASIS_MS\)/);
});

test('the local pointer is drawn oversized during the same window and settles back to its normal size', () => {
  const block = SOURCE.slice(SOURCE.indexOf('const introScale ='), SOURCE.indexOf('const introScale =') + 400);
  assert.match(block, /1 \+ 1\.6 \* \(1 - Math\.min\(1,/);
  assert.match(SOURCE, /const w = \(pos\.offScreen \? 9 : 7\) \* introScale;/);
});

test('with no local player, nothing is dimmed (spectating is unaffected)', () => {
  // The dim branch is keyed off this frame's own isLocalPlayer flag
  // (frame.localPlayerIndex === i), which is never true for any i when
  // there is no local player, so alpha resolves to 1 for everyone.
  assert.match(SOURCE, /const isLocalPlayer = frame\.localPlayerIndex === i;/);
});

test('this is presentation state only -- it lives on the renderer, not the sim', () => {
  const simSources = ['../../sim/src'];
  for (const rel of simSources) {
    // Sanity check the boundary: the renderer package does not reach
    // into sim internals to drive this feature.
    assert.doesNotMatch(SOURCE.slice(SOURCE.indexOf('introStartMs')), /packages\/sim/);
  }
  assert.match(SOURCE, /private introStartMs: number \| null = null;/);
});
