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

test('buildReport: frame-time histogram sums per-bucket across sessions in the group', () => {
  const storeLines = [
    sessionLine({ matchId: 'm6', frameHistogram: [1, 2, 3, 4, 5, 6] }),
    sessionLine({ matchId: 'm6', frameHistogram: [0, 1, 0, 1, 0, 1] }),
    sessionLine({ matchId: 'm6' }), // legacy record, no histogram -- must not throw or pollute the sum
  ];
  const report = buildReport({ storeLines, extraLines: [], feedbackCount: 0, since: null });
  const fh = report.humanSessions.all.frameHistogram;
  assert.deepEqual(fh.buckets, [1, 3, 3, 5, 5, 7]);
  assert.equal(fh.total, 24);
  assert.equal(fh.sessions, 2);
});

test('buildReport: hiddenFrames and networkHitches are aggregated and counted separately from frame time', () => {
  const storeLines = [
    sessionLine({ matchId: 'm7', hiddenFrames: 10, networkHitchCount: 0 }),
    sessionLine({ matchId: 'm7', hiddenFrames: 0, networkHitchCount: 3 }),
    sessionLine({ matchId: 'm7' }), // legacy, neither field known
  ];
  const report = buildReport({ storeLines, extraLines: [], feedbackCount: 0, since: null });
  const hf = report.humanSessions.all.hiddenFrames;
  assert.equal(hf.sessionsWithAny, 1);
  assert.equal(hf.knownDenominator, 2);
  assert.equal(hf.total, 10);
  const nh = report.humanSessions.all.networkHitches;
  assert.equal(nh.sessionsWithAny, 1);
  assert.equal(nh.knownDenominator, 2);
  assert.equal(nh.total, 3);
});

test('buildReport: device-capability bucket distributions count known values per bucket, ignore unknown', () => {
  const storeLines = [
    sessionLine({ matchId: 'm8', hwConcurrencyBucket: 8, deviceMemoryBucket: 4, dprBucket: 2 }),
    sessionLine({ matchId: 'm8', hwConcurrencyBucket: 8, deviceMemoryBucket: 2, dprBucket: 2 }),
    sessionLine({ matchId: 'm8' }), // legacy, no capability fields at all
  ];
  const report = buildReport({ storeLines, extraLines: [], feedbackCount: 0, since: null });
  const dc = report.humanSessions.all.deviceCapability;
  assert.deepEqual(dc.hwConcurrencyBucket.counts, { 8: 2 });
  assert.equal(dc.hwConcurrencyBucket.known, 2);
  assert.deepEqual(dc.deviceMemoryBucket.counts, { 2: 1, 4: 1 });
  assert.deepEqual(dc.dprBucket.counts, { 2: 2 });
});
