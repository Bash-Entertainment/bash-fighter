// Regression for task #28231 (Client-Server Match Divergence follow-up): a
// resumed reconnect's startMatch() resets NetMatch's prediction clock
// (localTick) to 0 unconditionally, but the first snapshot after a resume
// carries the real, large mid-match server tick. Without resyncing forward,
// localTick stays permanently behind snap.tick for the rest of the match
// (at the time this also silenced handleBinary's replay loop, which then ran
// from snap.tick+1 to localTick). Found and measured with
// scripts/reconnect-divergence-harness.mjs (replay window drifted to -52,
// -123, -192 ticks over three reconnect cycles without this guard).
//
// resyncLocalTickAfterSnapshot is exported as a pure, DOM-free function
// specifically so this can be tested without NetMatch's browser
// dependencies (Renderer/AudioManager/InputManager use parameter properties
// unsupported by Node's strip-only loader used by `npm test`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resyncLocalTickAfterSnapshot } from '../src/reconnect-resync.ts';

test('resyncLocalTickAfterSnapshot pulls a stale prediction clock forward to the authoritative tick', () => {
  // The buggy resume case: localTick reset to 0 (or small) by startMatch,
  // first post-resume snapshot arrives with a real mid-match tick.
  assert.equal(resyncLocalTickAfterSnapshot(3, 1997), 1997, 'must jump forward to the snapshot tick, not stay stranded');
});

test('resyncLocalTickAfterSnapshot never moves the clock backwards during normal play', () => {
  // Normal steady-state: the client predicts ahead of the last confirmed
  // server tick (that's the whole point of prediction) -- localTick must
  // stay ahead, unaffected by this guard.
  assert.equal(resyncLocalTickAfterSnapshot(120, 100), 120, 'must not regress a healthy, ahead-of-server prediction clock');
});

test('resyncLocalTickAfterSnapshot is a no-op exactly at parity', () => {
  assert.equal(resyncLocalTickAfterSnapshot(50, 50), 50);
});

test('repeated resumes never leave the clock permanently behind (regression for the harness-measured drift)', () => {
  // Simulates three resume cycles in a row, each restarting localTick at 0
  // (as startMatch() does) and then receiving one snapshot at an
  // ever-larger real server tick -- exactly the scenario the harness ran
  // against a live server. Before the fix this produced replay windows of
  // -52, -123, -192; with the guard the window is always >= 0.
  const serverTicksAtResume = [400, 900, 1997];
  for (const snapTick of serverTicksAtResume) {
    let localTick = 0; // startMatch() always resets to 0 on matchStart, resume or not
    localTick = resyncLocalTickAfterSnapshot(localTick, snapTick);
    const replayWindow = localTick - snapTick;
    assert.ok(replayWindow >= 0, `replay window must never go negative after a resync; got ${replayWindow} for snapTick=${snapTick}`);
  }
});
