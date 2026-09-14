// Regression/feature test for the self-declared QA seat marker
// (2026-09-14, see docs/MEASUREMENT.md): Seat.qa is set from the
// client's opt-in `?qa=1` (hello.profile.qa) and MatchSummary.qaSeats
// must count exactly the seats that set it, ignoring bots (which are
// never QA) and never counting a seat that didn't opt in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match, type MatchEvents, type MatchSummary } from '../src/match.ts';

function eventsCapturingSummary(onMatchSummary: (s: MatchSummary) => void): MatchEvents {
  return {
    onStart: () => {},
    onSnapshot: () => {},
    onEliminated: () => {},
    onMatchEnd: () => {},
    onSeatGraceExpired: () => {},
    onMatchSummary,
  };
}

test('MatchSummary.qaSeats counts only human seats whose hello.profile declared qa=true', () => {
  const summaries: MatchSummary[] = [];
  const match = new Match('qa-summary-test-1', 3, 1, eventsCapturingSummary((s) => summaries.push(s)));
  const qaSeat = match.addSeat('qa-tester', false, undefined as unknown as string, true);
  match.addSeat('real-player', false, undefined as unknown as string, false);
  match.addSeat('bot-1', true, undefined as unknown as string, true); // qa=true on a bot must not count
  match.start();
  qaSeat.connected = false;
  qaSeat.resumeToken = null;
  // Force the abandoned-by-humans path by disconnecting every human seat.
  for (const seat of (match as unknown as { seats: Array<{ isBot: boolean; connected: boolean; resumeToken: string | null }> }).seats) {
    if (!seat.isBot) {
      seat.connected = false;
      seat.resumeToken = null;
    }
  }
  clearInterval((match as unknown as { timer: NodeJS.Timeout }).timer as NodeJS.Timeout);
  (match as unknown as { timer: null }).timer = null;
  for (let i = 0; i < 20000 && summaries.length === 0; i++) {
    (match as unknown as { tickOnce(): void }).tickOnce();
  }
  assert.equal(summaries.length, 1, 'match should end exactly once');
  assert.equal(summaries[0]?.qaSeats, 1, 'only the one human seat with qa=true counts, not the bot');
});

test('MatchSummary.qaSeats is 0 when no seat declared qa', () => {
  const summaries: MatchSummary[] = [];
  const match = new Match('qa-summary-test-2', 2, 1, eventsCapturingSummary((s) => summaries.push(s)));
  const a = match.addSeat('human-a', false);
  match.addSeat('bot-1', true);
  match.start();
  a.connected = false;
  a.resumeToken = null;
  clearInterval((match as unknown as { timer: NodeJS.Timeout }).timer as NodeJS.Timeout);
  (match as unknown as { timer: null }).timer = null;
  for (let i = 0; i < 20000 && summaries.length === 0; i++) {
    (match as unknown as { tickOnce(): void }).tickOnce();
  }
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.qaSeats, 0);
});
