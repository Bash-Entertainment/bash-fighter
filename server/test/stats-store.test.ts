// Tests for the private, durable stats aggregator (server/src/stats-store.ts,
// see docs/MEASUREMENT.md). No HTTP surface reads this file -- these
// tests exercise only the accumulation, restart-persistence, and
// write-failure-fallback behaviour that scripts/stats-report.mjs later
// reads. Pattern follows feedback.test.ts and session-telemetry.test.ts:
// exercise the real code against scratch files, not a mock of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStatsRecorder, appendStatsLine, defaultStatsLogPath } from '../src/stats-store.ts';
import { Match, type MatchEvents, type MatchSummary } from '../src/match.ts';
import type { SessionEndConnLike } from '../src/session-telemetry.ts';

function readLines(logPath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function noopEvents(): MatchEvents {
  return {
    onStart: () => {},
    onSnapshot: () => {},
    onEliminated: () => {},
    onMatchEnd: () => {},
    onSeatGraceExpired: () => {},
  };
}

function fakeConn(overrides: Partial<SessionEndConnLike>): SessionEndConnLike {
  return {
    slot: 0,
    profile: null,
    lastReport: null,
    ...overrides,
  };
}

function scratchDir(): { dir: string; logPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-store-test-'));
  const logPath = path.join(dir, 'nested', 'stats.jsonl');
  return { dir, logPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function sampleSummary(overrides: Partial<MatchSummary> = {}): MatchSummary {
  return {
    evt: 'matchSummary',
    matchId: 'match-1',
    endReason: 'resolved',
    durationSec: '84.4',
    finalTick: 5064,
    arenaId: 'the-foundry',
    winCondition: 'battleRoyale',
    totalSeats: 20,
    humanSeats: 1,
    humanSlotsEliminated: 0,
    remainingAlive: 1,
    totalKOs: 19,
    maxKoCount: 3,
    ...overrides,
  };
}

test('defaultStatsLogPath: honours STATS_LOG_PATH, falls back to the shared production path', () => {
  const prior = process.env.STATS_LOG_PATH;
  try {
    delete process.env.STATS_LOG_PATH;
    assert.equal(defaultStatsLogPath(), '/srv/bash-fighter/shared/stats.jsonl');
    process.env.STATS_LOG_PATH = '/tmp/whatever/stats.jsonl';
    assert.equal(defaultStatsLogPath(), '/tmp/whatever/stats.jsonl');
  } finally {
    if (prior === undefined) delete process.env.STATS_LOG_PATH;
    else process.env.STATS_LOG_PATH = prior;
  }
});

test('recordMatchSummary: appends one matchEnd record with the expected shape', () => {
  const { logPath, cleanup } = scratchDir();
  try {
    const recorder = createStatsRecorder({ logPath, now: () => 1_700_000_000_000 });
    recorder.recordMatchSummary(sampleSummary());

    const lines = readLines(logPath);
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0], {
      type: 'matchEnd',
      ts: new Date(1_700_000_000_000).toISOString(),
      matchId: 'match-1',
      arenaId: 'the-foundry',
      winCondition: 'battleRoyale',
      endReason: 'resolved',
      durationSec: 84.4,
      totalSeats: 20,
      humanSeats: 1,
      totalKOs: 19,
      maxKoCount: 3,
    });
  } finally {
    cleanup();
  }
});

test('recordSessionEnd: appends one sessionEnd record derived from the real Match/seat, no PII', () => {
  const { logPath, cleanup } = scratchDir();
  try {
    const match = new Match('stats-session-test-1', 2, 1, noopEvents());
    match.addSeat('human-a', false);
    match.addSeat('bot-1', true, undefined as unknown as string);
    match.start();

    const recorder = createStatsRecorder({ logPath, now: () => 1_700_000_010_000 });
    const conn = fakeConn({ slot: 0, lastReport: { firstInputMs: 900, inputTicks: 42, frameMedianMs: 16.7, frameP95Ms: 20.1 } });
    recorder.recordSessionEnd(conn, match);
    match.stop();

    const lines = readLines(logPath);
    assert.equal(lines.length, 1);
    const record = lines[0]!;
    assert.equal(record.type, 'sessionEnd');
    assert.equal(record.matchId, match.id);
    assert.equal(record.winCondition, match.winCondition);
    assert.equal(record.eliminated, false);
    assert.equal(record.firstInputMs, 900);
    assert.equal(record.inputTicks, 42);

    const serialised = JSON.stringify(record).toLowerCase();
    assert.ok(!('ip' in record));
    assert.ok(!('address' in record));
    assert.ok(!serialised.includes('127.0.0.1'));
  } finally {
    cleanup();
  }
});

test('accumulation: multiple matchEnd/sessionEnd records land as separate lines in the one file', () => {
  const { logPath, cleanup } = scratchDir();
  try {
    const recorder = createStatsRecorder({ logPath });
    recorder.recordMatchSummary(sampleSummary({ matchId: 'm1' }));
    recorder.recordMatchSummary(sampleSummary({ matchId: 'm2', winCondition: 'timedKO' }));

    const match = new Match('stats-session-test-2', 2, 1, noopEvents());
    match.addSeat('human-a', false);
    match.addSeat('bot-1', true, undefined as unknown as string);
    match.start();
    recorder.recordSessionEnd(fakeConn({ slot: 0 }), match);
    match.stop();

    const lines = readLines(logPath);
    assert.equal(lines.length, 3);
    assert.equal(lines.filter((l) => l.type === 'matchEnd').length, 2);
    assert.equal(lines.filter((l) => l.type === 'sessionEnd').length, 1);
  } finally {
    cleanup();
  }
});

test('restart persistence: a fresh recorder pointed at the same path appends after existing history, none of it lost', () => {
  const { logPath, cleanup } = scratchDir();
  try {
    const first = createStatsRecorder({ logPath });
    first.recordMatchSummary(sampleSummary({ matchId: 'before-restart' }));

    // Simulate a service restart: a brand-new recorder instance, same
    // durable path. Nothing in createStatsRecorder should truncate or
    // overwrite the file -- it only ever appends.
    const second = createStatsRecorder({ logPath });
    second.recordMatchSummary(sampleSummary({ matchId: 'after-restart' }));

    const lines = readLines(logPath);
    assert.equal(lines.length, 2);
    assert.equal(lines[0]?.matchId, 'before-restart');
    assert.equal(lines[1]?.matchId, 'after-restart');
  } finally {
    cleanup();
  }
});

test('write failure: an unwritable log directory falls back to stdout instead of throwing/crashing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-store-test-badpath-'));
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'not a directory');
  const badLogPath = path.join(blocker, 'nested', 'stats.jsonl');

  const consoleLines: string[] = [];
  const realLog = console.log;
  console.log = ((...args: unknown[]) => {
    if (typeof args[0] === 'string') consoleLines.push(args[0]);
  }) as typeof console.log;

  try {
    const recorder = createStatsRecorder({ logPath: badLogPath });
    assert.doesNotThrow(() => recorder.recordMatchSummary(sampleSummary({ matchId: 'should-not-crash' })));
  } finally {
    console.log = realLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  assert.ok(consoleLines.some((l) => l.includes('should-not-crash')));
});

test('write failure inside recordSessionEnd is also swallowed, not thrown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-store-test-badpath2-'));
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'not a directory');
  const badLogPath = path.join(blocker, 'nested', 'stats.jsonl');

  const realLog = console.log;
  console.log = (() => {}) as typeof console.log;
  try {
    const match = new Match('stats-session-test-3', 2, 1, noopEvents());
    match.addSeat('human-a', false);
    match.addSeat('bot-1', true, undefined as unknown as string);
    match.start();
    const recorder = createStatsRecorder({ logPath: badLogPath });
    assert.doesNotThrow(() => recorder.recordSessionEnd(fakeConn({ slot: 0 }), match));
    match.stop();
  } finally {
    console.log = realLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('appendStatsLine: exported directly and also never throws on a bad path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-store-test-badpath3-'));
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'not a directory');
  const badLogPath = path.join(blocker, 'nested', 'stats.jsonl');
  const realLog = console.log;
  console.log = (() => {}) as typeof console.log;
  try {
    assert.doesNotThrow(() => appendStatsLine(badLogPath, { type: 'matchEnd', ts: 'x' } as never));
  } finally {
    console.log = realLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
