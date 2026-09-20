// Mode rotation tests (2026-09-11, Timed Brawl launch; extended
// 2026-09-12 for Stocks). Two layers:
//   1. Pure unit tests of decideMatchMode/modeDisplayName -- no server,
//      no timers, exhaustively checks the rotation, the numeric-cadence
//      back-compat path, the kill switch, and the player-facing text.
//   2. An in-process RoomManager integration test that drives real
//      joinLobby() calls (2-capacity lobbies so each fills and starts
//      immediately) and checks that match creation, not connection,
//      decides the mode, and that the actual Match ends up running the
//      sim with the planned winCondition.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideMatchMode,
  modeDisplayName,
  TIMED_BRAWL_TIME_LIMIT_TICKS,
  STOCKS_STARTING_STOCKS,
} from '../src/mode-rotation.ts';
import { RoomManager } from '../src/rooms.ts';

test('decideMatchMode: default rotation is Battle Royale twice, Timed Brawl, Stocks, repeating', () => {
  const modes = Array.from({ length: 12 }, (_, i) => decideMatchMode(i + 1).winCondition);
  assert.deepEqual(modes, [
    'battleRoyale', 'battleRoyale', 'timedKO', 'stocks',
    'battleRoyale', 'battleRoyale', 'timedKO', 'stocks',
    'battleRoyale', 'battleRoyale', 'timedKO', 'stocks',
  ]);
});

test('decideMatchMode: a custom rotation array is honoured', () => {
  const modes = Array.from({ length: 6 }, (_, i) => decideMatchMode(i + 1, ['stocks', 'battleRoyale']).winCondition);
  assert.deepEqual(modes, ['stocks', 'battleRoyale', 'stocks', 'battleRoyale', 'stocks', 'battleRoyale']);
});

test('decideMatchMode: numeric cadence (back-compat) is a plain two-mode "every Nth is timedKO" split', () => {
  const modes = Array.from({ length: 8 }, (_, i) => decideMatchMode(i + 1, 4).winCondition);
  assert.deepEqual(modes, [
    'battleRoyale', 'battleRoyale', 'battleRoyale', 'timedKO',
    'battleRoyale', 'battleRoyale', 'battleRoyale', 'timedKO',
  ]);
});

test('decideMatchMode: numeric cadence 1 makes every match timedKO (allowed, just an extreme config)', () => {
  for (let i = 1; i <= 5; i++) assert.equal(decideMatchMode(i, 1).winCondition, 'timedKO');
});

test('decideMatchMode: kill switch pins every match to battleRoyale regardless of rotation', () => {
  for (let i = 1; i <= 9; i++) {
    assert.equal(decideMatchMode(i, ['stocks', 'timedKO'], true).winCondition, 'battleRoyale');
  }
});

test('decideMatchMode: the timedKO decision carries the 3-minute time limit; the stocks decision carries 2 lives; battleRoyale carries neither', () => {
  const timed = decideMatchMode(3);
  assert.equal(timed.winCondition, 'timedKO');
  assert.equal(timed.timeLimitTicks, TIMED_BRAWL_TIME_LIMIT_TICKS);
  assert.equal(timed.timeLimitTicks, 60 * 60 * 3);
  assert.equal(timed.startingStocks, undefined);

  const stocks = decideMatchMode(4);
  assert.equal(stocks.winCondition, 'stocks');
  assert.equal(stocks.startingStocks, STOCKS_STARTING_STOCKS);
  assert.equal(stocks.startingStocks, 2);
  assert.equal(stocks.timeLimitTicks, undefined);

  const royale = decideMatchMode(1);
  assert.equal(royale.winCondition, 'battleRoyale');
  assert.equal(royale.timeLimitTicks, undefined);
  assert.equal(royale.startingStocks, undefined);
});

test('modeDisplayName: never leaks an internal identifier, always plain language', () => {
  const royale = modeDisplayName('battleRoyale');
  const timed = modeDisplayName('timedKO', TIMED_BRAWL_TIME_LIMIT_TICKS);
  const stocks = modeDisplayName('stocks', undefined, STOCKS_STARTING_STOCKS);
  assert.ok(!royale.includes('battleRoyale'));
  assert.ok(!timed.includes('timedKO'));
  assert.ok(!stocks.includes('stocks') || stocks === 'Stocks — 2 lives each, last fighter standing wins');
  assert.match(royale, /Battle Royale/);
  assert.match(royale, /last fighter standing/i);
  assert.match(timed, /Timed Brawl/);
  assert.match(timed, /3 minutes/);
  assert.match(timed, /knockouts/i);
  assert.match(stocks, /Stocks/);
  assert.match(stocks, /2 lives/);
  assert.match(stocks, /last fighter standing/i);
});

test('RoomManager: match creation (not connection) decides the mode, following the default rotation', async () => {
  const noopEvents = () => ({ onSnapshot: () => {}, onEliminated: () => {} });
  const manager = new RoomManager(noopEvents, /* capacity */ 2, /* minimum */ 2);
  const seenModes: string[] = [];
  const seenMatchIds = new Set<string>();
  const startedMatches: Array<{ stop: () => void }> = [];
  for (let i = 0; i < 8; i++) {
    // Two joins fill and start a 2-capacity lobby immediately, so each
    // iteration creates exactly one fresh match.
    // requeued: true on both seats -- this test is specifically about the
    // rotation sequence, which only applies to requeued joins post the
    // first-time-visitor rule (see rooms.test.ts for that rule itself).
    const first = manager.joinLobby(`p${i}a`, undefined, false, undefined, true);
    const second = manager.joinLobby(`p${i}b`, undefined, false, undefined, true);
    assert.equal(first.match.id, second.match.id, 'both seats landed in the same freshly created match');
    assert.ok(!seenMatchIds.has(first.match.id), 'each iteration created a genuinely new match');
    seenMatchIds.add(first.match.id);
    // Mode was decided (and, once start() ran, actually applied to the
    // sim) once per match -- both seats see the identical mode.
    seenModes.push(first.match.winCondition ?? 'null');
    startedMatches.push(first.match);
  }
  for (const m of startedMatches) m.stop();
  assert.deepEqual(seenModes, [
    'battleRoyale', 'battleRoyale', 'timedKO', 'stocks',
    'battleRoyale', 'battleRoyale', 'timedKO', 'stocks',
  ]);
});
