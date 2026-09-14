// Tests for the self-declared QA grouping added to scripts/stats-report.mjs
// (2026-09-14, see docs/MEASUREMENT.md). Verifies the three-way session
// split (all / notQa / qa), the matches.qa breakdown, and that legacy
// records with no qa/qaSeats field are reported as "unknown" -- never
// silently folded into "not QA".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, classifySessionQa, classifyMatchQa } from '../stats-report.mjs';

function sessionLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'sessionEnd',
    ts: '2026-09-14T00:00:00Z',
    matchId: 'm1',
    winCondition: 'battleRoyale',
    eliminated: true,
    endReason: 'eliminated',
    sessionDurationSec: 30,
    touchActive: false,
    firstInputMs: 100,
    inputTicks: 10,
    frameMedianMs: 16,
    frameP95Ms: 20,
    ...overrides,
  });
}

function matchLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'matchEnd',
    ts: '2026-09-14T00:00:00Z',
    matchId: 'm1',
    arenaId: 'the-spire',
    winCondition: 'battleRoyale',
    endReason: 'resolved',
    durationSec: 60,
    totalSeats: 2,
    humanSeats: 2,
    totalKOs: 1,
    maxKoCount: 1,
    ...overrides,
  });
}

test('classifySessionQa: true/false/absent map to qa/notQa/unknown', () => {
  assert.equal(classifySessionQa({ qa: true }), 'qa');
  assert.equal(classifySessionQa({ qa: false }), 'notQa');
  assert.equal(classifySessionQa({}), 'unknown');
});

test('classifyMatchQa: a numeric qaSeats maps to hasQaSeats/noQaSeats, missing maps to unknown', () => {
  assert.equal(classifyMatchQa({ qaSeats: 2 }), 'hasQaSeats');
  assert.equal(classifyMatchQa({ qaSeats: 0 }), 'noQaSeats');
  assert.equal(classifyMatchQa({}), 'unknown');
});

test('buildReport: splits sessions into all/notQa/qa and never drops anything from "all"', () => {
  const storeLines = [
    sessionLine({ matchId: 'm1', qa: true }),
    sessionLine({ matchId: 'm1', qa: false }),
    sessionLine({ matchId: 'm1', qa: false }),
    matchLine({ matchId: 'm1', qaSeats: 1 }),
  ];
  const report = buildReport({ storeLines, extraLines: [], feedbackCount: 0, since: null });
  assert.equal(report.humanSessions.all.total, 3);
  assert.equal(report.humanSessions.qa.total, 1);
  assert.equal(report.humanSessions.notQa.total, 2);
  assert.equal(report.humanSessions.unknownCount, 0);
});

test('buildReport: legacy sessionEnd/matchEnd records with no qa field are "unknown", never counted as notQa/noQaSeats', () => {
  const storeLines = [
    sessionLine({ matchId: 'm2' }), // no `qa` key at all: pre-feature record
    matchLine({ matchId: 'm2' }), // no `qaSeats` key at all: pre-feature record
  ];
  const report = buildReport({ storeLines, extraLines: [], feedbackCount: 0, since: null });
  assert.equal(report.humanSessions.all.total, 1);
  assert.equal(report.humanSessions.notQa.total, 0);
  assert.equal(report.humanSessions.qa.total, 0);
  assert.equal(report.humanSessions.unknownCount, 1);
  assert.equal(report.matches.qa.matchesUnknown, 1);
  assert.equal(report.matches.qa.matchesWithNoQaSeats, 0);
  assert.equal(report.matches.qa.matchesWithQaSeats, 0);
});

test('buildReport: matches.qa breakdown counts matches with/without a QA seat and sums the known qaSeats', () => {
  const storeLines = [
    matchLine({ matchId: 'm3', qaSeats: 2 }),
    matchLine({ matchId: 'm4', qaSeats: 0 }),
    matchLine({ matchId: 'm5' }), // legacy, unknown
  ];
  const report = buildReport({ storeLines, extraLines: [], feedbackCount: 0, since: null });
  assert.equal(report.matches.qa.matchesWithQaSeats, 1);
  assert.equal(report.matches.qa.matchesWithNoQaSeats, 1);
  assert.equal(report.matches.qa.matchesUnknown, 1);
  assert.equal(report.matches.qa.totalQaSeatsKnown, 2);
});
