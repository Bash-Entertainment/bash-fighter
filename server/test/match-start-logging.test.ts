// Regression/coverage test for the [matchStart] production log
// (2026-09-13). Before this, journalctl had no way to tell which of the
// six stages a match actually played on: [modeRotation] logs the mode at
// match-*creation* time (server/src/rooms.ts), but arenaId is only chosen
// once start() runs (server/src/match.ts, pickArenaId). This asserts
// Match.start() emits exactly one [matchStart] line carrying matchId,
// arenaId, winCondition and seatCount.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match, type MatchEvents } from '../src/match.ts';

function noopEvents(): MatchEvents {
  return {
    onStart: () => {},
    onSnapshot: () => {},
    onEliminated: () => {},
    onMatchEnd: () => {},
    onSeatGraceExpired: () => {},
  };
}

/** Capture [matchStart]-prefixed console.log lines, restoring the real
 *  console.log when done. Same plain console.log(`[tag] ${JSON...}`)
 *  mechanism production log-scraping (journalctl | grep '[matchStart]')
 *  observes -- see server/src/match.ts. */
function captureMatchStartLogs(run: () => void): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  const realLog = console.log;
  console.log = ((...args: unknown[]) => {
    const [line] = args;
    if (typeof line === 'string' && line.startsWith('[matchStart] ')) {
      events.push(JSON.parse(line.slice('[matchStart] '.length)) as Record<string, unknown>);
    }
  }) as typeof console.log;
  try {
    run();
  } finally {
    console.log = realLog;
  }
  return events;
}

test('Match.start() emits exactly one [matchStart] log line with matchId, arenaId, winCondition, seatCount', () => {
  const match = new Match('matchstart-test-1', 2, 1, noopEvents());
  match.addSeat('human-a', false);
  match.addSeat('bot-1', true, undefined as unknown as string);

  const events = captureMatchStartLogs(() => {
    match.start();
  });
  match.stop();

  assert.equal(events.length, 1);
  const [line] = events;
  assert.equal(line.matchId, 'matchstart-test-1');
  assert.equal(typeof line.arenaId, 'string');
  assert.ok((line.arenaId as string).length > 0);
  assert.equal(typeof line.winCondition, 'string');
  assert.equal(line.seatCount, 2);
});

test('Match.start() is idempotent: calling it again emits no additional [matchStart] line', () => {
  const match = new Match('matchstart-test-2', 2, 1, noopEvents());
  match.addSeat('human-a', false);
  match.addSeat('bot-1', true, undefined as unknown as string);

  const events = captureMatchStartLogs(() => {
    match.start();
    match.start();
  });
  match.stop();

  assert.equal(events.length, 1);
});
