// First-time-visitor mode rule (2026-09-20): a fresh match created for a
// joining human who did NOT arrive via auto-requeue always runs Timed
// Brawl (timedKO), because Battle Royale often eliminates a newcomer in
// well under a minute and ends their session, while Timed Brawl respawns
// them for the whole match. A requeued join ("Play again") keeps the
// normal rotation. See mode-rotation.ts (decideMatchModeForJoin) and
// rooms.ts (joinLobby).
//
// No server/websocket/port needed here: decideMatchModeForJoin is pure,
// and the RoomManager tests below drive joinLobby() in-process exactly
// like mode-rotation.test.ts's existing RoomManager test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideMatchModeForJoin, decideMatchMode, TIMED_BRAWL_TIME_LIMIT_TICKS } from '../src/mode-rotation.ts';
import { RoomManager } from '../src/rooms.ts';

test('decideMatchModeForJoin: a non-requeued (first-time) join forces timedKO regardless of rotation position', () => {
  for (let matchNumber = 1; matchNumber <= 8; matchNumber++) {
    const decision = decideMatchModeForJoin(matchNumber, false);
    assert.equal(decision.winCondition, 'timedKO');
    assert.equal(decision.timeLimitTicks, TIMED_BRAWL_TIME_LIMIT_TICKS);
  }
});

test('decideMatchModeForJoin: a requeued join follows the normal rotation, unchanged', () => {
  for (let matchNumber = 1; matchNumber <= 8; matchNumber++) {
    assert.deepEqual(decideMatchModeForJoin(matchNumber, true), decideMatchMode(matchNumber));
  }
});

test('decideMatchModeForJoin: forcing timedKO for one matchNumber does not shift what other matchNumbers get', () => {
  // matchNumber 3 is naturally timedKO already in the default rotation;
  // matchNumber 1 is naturally battleRoyale. Forcing #1 via a non-requeued
  // join must not change what #2, #3, #4... decide -- decideMatchMode is
  // pure over matchNumber alone, so a requeued lookup afterwards must
  // match the untouched rotation exactly.
  decideMatchModeForJoin(1, false);
  decideMatchModeForJoin(1, false);
  decideMatchModeForJoin(1, false);
  const modes = Array.from({ length: 8 }, (_, i) => decideMatchModeForJoin(i + 1, true).winCondition);
  assert.deepEqual(modes, [
    'battleRoyale', 'battleRoyale', 'timedKO', 'stocks',
    'battleRoyale', 'battleRoyale', 'timedKO', 'stocks',
  ]);
});

test('decideMatchModeForJoin: the rotation kill switch (env-disabled) overrides the first-time-visitor rule', () => {
  // disabled=true pins every match to battleRoyale, including a
  // non-requeued first-time join -- the operator's explicit override wins.
  for (let matchNumber = 1; matchNumber <= 5; matchNumber++) {
    const decision = decideMatchModeForJoin(matchNumber, false, undefined, true);
    assert.equal(decision.winCondition, 'battleRoyale');
    assert.equal(decision.timeLimitTicks, undefined);
  }
});

test('RoomManager: a fresh match created for a non-requeued join runs Timed Brawl', () => {
  const noopEvents = () => ({ onSnapshot: () => {}, onEliminated: () => {} });
  const manager = new RoomManager(noopEvents, /* capacity */ 2, /* minimum */ 2);
  const first = manager.joinLobby('a', undefined, false, undefined, false);
  const second = manager.joinLobby('b', undefined, false, undefined, false);
  assert.equal(first.match.id, second.match.id);
  assert.equal(first.match.winCondition, 'timedKO');
  // First-match knockout boost: both non-requeued humans are rookies.
  assert.deepEqual(first.match.getClientSettings()?.rookieSlots, [0, 1]);
  first.match.stop();
});

test('RoomManager: a fresh match created for a requeued join follows the rotation (battleRoyale first)', () => {
  const noopEvents = () => ({ onSnapshot: () => {}, onEliminated: () => {} });
  const manager = new RoomManager(noopEvents, /* capacity */ 2, /* minimum */ 2);
  const first = manager.joinLobby('a', undefined, false, undefined, true);
  const second = manager.joinLobby('b', undefined, false, undefined, true);
  assert.equal(first.match.id, second.match.id);
  assert.equal(first.match.winCondition, 'battleRoyale');
  assert.deepEqual(first.match.getClientSettings()?.rookieSlots, []);
  first.match.stop();
});

test('RoomManager: only the requesting join matters, not who else is already in the lobby', () => {
  // A lobby is already "filling" when the second joiner (non-requeued)
  // arrives -- joinLobby only decides the mode when it creates a FRESH
  // match, on the first joiner into that match. This documents that: the
  // second joiner's requeued flag is irrelevant once the match already
  // exists.
  const noopEvents = () => ({ onSnapshot: () => {}, onEliminated: () => {} });
  const manager = new RoomManager(noopEvents, /* capacity */ 3, /* minimum */ 3);
  const first = manager.joinLobby('a', undefined, false, undefined, true); // requeued: rotation -> battleRoyale
  const second = manager.joinLobby('b', undefined, false, undefined, false); // not requeued, but lobby already exists
  const third = manager.joinLobby('c', undefined, false, undefined, false);
  assert.equal(first.match.id, second.match.id);
  assert.equal(first.match.id, third.match.id);
  assert.equal(first.match.winCondition, 'battleRoyale');
  first.match.stop();
});
