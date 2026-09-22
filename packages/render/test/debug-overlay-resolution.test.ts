// Issue #43: the F3 debug overlay must show the adaptive-resolution
// governor's live state (current resolution and downgrade count), not a
// value cached at startup, so a real match can confirm the governor is
// actually working.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDebugText } from '../src/debug-overlay.ts';
import { FighterStateId } from '@bash-fighter/sim';

test('overlay text includes the current resolution and downgrade count', () => {
  const text = formatDebugText([], 42, 'abc123', 1.5, 3);
  assert.match(text, /^tick 42 {2}hash abc123\nres 1\.5x {2}downgrades 3/);
});

test('every fighter state has a debug label, including RESPAWN', () => {
  const states = Object.values(FighterStateId) as number[];
  for (const state of states) {
    const text = formatDebugText(
      [{ state, moveId: -1, moveFrame: 0, percent: 0, character: {} }] as never,
      1,
      'h',
      1,
      0,
    );
    assert.ok(!/undefined/.test(text), `state ${state} produced: ${text}`);
  }
});
