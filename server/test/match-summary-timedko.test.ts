// Regression test for the pacing-anomaly false alarm (2026-09-13, see
// wiki page "20-Player Production-Hardware..." investigation notes / the
// Hetzner journalctl matchSummary lines for m3 and m7). remainingAlive
// and humanSlotsEliminated in matchSummary both read Seat.eliminated,
// which the sim never sets while respawns are enabled -- true today only
// for winCondition 'timedKO' (see respawnsEnabled/checkBlastZone in
// packages/sim/src/sim.ts). That made a combat-heavy timedKO match that
// ends early (abandoned by humans) look identical, from the logs alone,
// to a match with zero combat: remainingAlive stuck at totalSeats and
// humanSlotsEliminated stuck at 0 either way. This asserts matchSummary
// now also carries winCondition and a totalKOs/maxKoCount signal that IS
// populated for timedKO, so real combat is distinguishable from none
// without reading sim internals.
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

function captureMatchSummaryLogs(run: () => void): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  const realLog = console.log;
  console.log = ((...args: unknown[]) => {
    const [line] = args;
    if (typeof line === 'string' && line.startsWith('{')) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.evt === 'matchSummary') events.push(parsed);
      } catch {
        // not JSON, ignore (unrelated console.log noise from other code paths)
      }
    }
  }) as typeof console.log;
  try {
    run();
  } finally {
    console.log = realLog;
  }
  return events;
}

test('matchSummary for an abandoned timedKO match reports winCondition and real combat via totalKOs, not just remainingAlive', () => {
  const match = new Match('summary-timedko-test-1', 2, 1, noopEvents());
  match.plannedWinCondition = 'timedKO';
  const a = match.addSeat('human-a', false);
  match.addSeat('bot-1', true);
  match.start();
  clearInterval((match as unknown as { timer: NodeJS.Timeout }).timer as NodeJS.Timeout);
  (match as unknown as { timer: null }).timer = null;

  // human-a never sends input (a real human seat with no pendingInput,
  // exactly like a stalled/AFK production seat), so bot-1's real AI has
  // an easy, undefended target -- tick long enough for a real KO to land
  // through the actual sim/AI code path this test is protecting.
  for (let i = 0; i < 6000; i++) {
    (match as unknown as { tickOnce(): void }).tickOnce();
  }

  // Now abandon: the human disconnects and its grace window expires.
  a.connected = false;
  a.resumeToken = null;

  const logs = captureMatchSummaryLogs(() => {
    for (let i = 0; i < 20000; i++) {
      (match as unknown as { tickOnce(): void }).tickOnce();
      if ((match as unknown as { phase: string }).phase !== 'playing') break;
    }
  });

  assert.equal(logs.length, 1, 'exactly one matchSummary line should be logged');
  const summary = logs[0] as Record<string, unknown>;
  assert.equal(summary.endReason, 'abandoned_by_humans');
  assert.equal(summary.winCondition, 'timedKO');
  // The pre-fix fields are still present and still both 'no elimination
  // ever happens in timedKO' by sim design -- that is correct, not the
  // bug. The bug was that nothing else in the line could tell you that.
  assert.equal(summary.remainingAlive, 2);
  assert.equal(summary.humanSlotsEliminated, 0);
  assert.equal(typeof summary.totalKOs, 'number');
  assert.ok((summary.totalKOs as number) > 0, 'a real fight with an undefended target must register at least one KO');
  assert.equal(typeof summary.maxKoCount, 'number');
});
