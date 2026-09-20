// Tests for the engagement-telemetry work (2026-09-13, see
// docs/MEASUREMENT.md): the hello.profile / sessionReport wire messages
// (validated and clamped in packages/net/src/protocol.ts) and the
// [sessionEnd] production log line they feed (server/src/index.ts).
// Pattern follows stock-loss-logging.test.ts: exercise the real code,
// not a mock of it, and assert on exactly what it produced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClientControl, PROTOCOL_VERSION, type HelloMessage, type SessionReportMessage } from '@bash-fighter/net/src/protocol.ts';
import { logSessionEnd, type SessionEndConnLike } from '../src/session-telemetry.ts';
import { Match, type MatchEvents } from '../src/match.ts';

function captureLogs(run: () => void): string[] {
  const lines: string[] = [];
  const realLog = console.log;
  console.log = ((...args: unknown[]) => {
    if (typeof args[0] === 'string') lines.push(args[0]);
  }) as typeof console.log;
  try {
    run();
  } finally {
    console.log = realLog;
  }
  return lines;
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

// --- hello.profile parsing/clamping ---------------------------------

test('hello.profile: a well-formed profile round-trips', () => {
  const msg = parseClientControl(
    JSON.stringify({
      t: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      name: 'Al',
      profile: { touchActive: true, viewportWidth: 390, viewportHeight: 844, buildSha: '98ebe1a' },
    }),
  ) as HelloMessage | null;
  assert.ok(msg);
  assert.deepEqual(msg?.profile, { touchActive: true, viewportWidth: 390, viewportHeight: 844, buildSha: '98ebe1a' });
});

test('hello.profile: out-of-range viewport numbers are clamped, not rejected', () => {
  const msg = parseClientControl(
    JSON.stringify({
      t: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      name: 'Al',
      profile: { viewportWidth: -50, viewportHeight: 999999, touchActive: false },
    }),
  ) as HelloMessage | null;
  assert.ok(msg);
  assert.equal(msg?.profile?.viewportWidth, 0);
  assert.equal(msg?.profile?.viewportHeight, 20000);
  assert.equal(msg?.profile?.touchActive, false);
});

test('hello.profile: an overlong buildSha is capped at 64 characters', () => {
  const msg = parseClientControl(
    JSON.stringify({
      t: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      name: 'Al',
      profile: { buildSha: 'x'.repeat(200) },
    }),
  ) as HelloMessage | null;
  assert.equal(msg?.profile?.buildSha?.length, 64);
});

test('hello.profile: wrong-typed fields are dropped individually, never crash the parse', () => {
  const msg = parseClientControl(
    JSON.stringify({
      t: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      name: 'Al',
      profile: { touchActive: 'yes', viewportWidth: 'wide', buildSha: 12345 },
    }),
  ) as HelloMessage | null;
  assert.ok(msg);
  assert.equal(msg?.profile, undefined);
});

test('hello.profile: qa is validated as a plain boolean like any other field', () => {
  const withQa = parseClientControl(
    JSON.stringify({
      t: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      name: 'Al',
      profile: { touchActive: false, qa: true },
    }),
  ) as HelloMessage | null;
  assert.equal(withQa?.profile?.qa, true);

  const withoutQa = parseClientControl(
    JSON.stringify({ t: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'Al', profile: { touchActive: false } }),
  ) as HelloMessage | null;
  assert.equal(withoutQa?.profile?.qa, undefined);

  const wrongType = parseClientControl(
    JSON.stringify({ t: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'Al', profile: { qa: 'yes' } }),
  ) as HelloMessage | null;
  assert.equal(wrongType?.profile?.qa, undefined);
});

test('hello: still parses with no profile at all (older client)', () => {
  const msg = parseClientControl(JSON.stringify({ t: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'Al' })) as HelloMessage | null;
  assert.ok(msg);
  assert.equal(msg?.profile, undefined);
});

// --- sessionReport parsing/clamping ----------------------------------

test('sessionReport: a well-formed report round-trips', () => {
  const msg = parseClientControl(
    JSON.stringify({ t: 'sessionReport', firstInputMs: 1234, inputTicks: 40, frameMedianMs: 16.6, frameP95Ms: 33.3 }),
  ) as SessionReportMessage | null;
  assert.deepEqual(msg, { t: 'sessionReport', firstInputMs: 1234, inputTicks: 40, frameMedianMs: 16.6, frameP95Ms: 33.3 });
});

test('sessionReport: firstInputMs of null (never pressed a key) is preserved, not coerced to 0', () => {
  const msg = parseClientControl(
    JSON.stringify({ t: 'sessionReport', firstInputMs: null, inputTicks: 0, frameMedianMs: 16, frameP95Ms: 20 }),
  ) as SessionReportMessage | null;
  assert.equal(msg?.firstInputMs, null);
  assert.equal(msg?.inputTicks, 0);
});

test('sessionReport: absurd/negative values are clamped into range, not rejected', () => {
  const msg = parseClientControl(
    JSON.stringify({ t: 'sessionReport', firstInputMs: -100, inputTicks: 999_999_999, frameMedianMs: -5, frameP95Ms: 9_999_999 }),
  ) as SessionReportMessage | null;
  assert.ok(msg);
  assert.equal(msg?.firstInputMs, 0);
  assert.equal(msg?.inputTicks, 10_000_000);
  assert.equal(msg?.frameMedianMs, 0);
  assert.equal(msg?.frameP95Ms, 5_000);
});

test('sessionReport: a wrong-shaped/garbage payload is rejected as unparseable rather than partially trusted', () => {
  const msg = parseClientControl(JSON.stringify({ t: 'sessionReport', firstInputMs: 'soon', inputTicks: 'many' }));
  assert.equal(msg, null);
});

// This test used to assert the opposite -- that the shared 512-byte cap
// applied to sessionReport too -- and in doing so it pinned a real defect
// in place: a full session report is ~740 bytes, so every real one was
// rejected, and the server then closed the player's socket (reported by a
// real player as "connection dropped all the time", 2026-09-15). Reports
// now get their own generous cap; see packages/net/test/session-report-size.test.ts.
test('sessionReport: has its own generous size cap, but is still rejected beyond it', () => {
  const withinCap = parseClientControl(
    JSON.stringify({ t: 'sessionReport', firstInputMs: 1, inputTicks: 1, extra: 'x'.repeat(2000) }),
  );
  assert.ok(withinCap, 'a report larger than the small-message cap must still be accepted');
  const beyondCap = parseClientControl(
    JSON.stringify({ t: 'sessionReport', firstInputMs: 1, inputTicks: 1, extra: 'x'.repeat(20_000) }),
  );
  assert.equal(beyondCap, null);
});

// --- [sessionEnd] log line -------------------------------------------

function realMatch(): Match {
  const match = new Match('session-end-test-1', 2, 1, noopEvents());
  match.addSeat('human-a', false);
  match.addSeat('bot-1', true, undefined as unknown as string);
  match.start();
  clearInterval((match as unknown as { timer: NodeJS.Timeout }).timer);
  (match as unknown as { timer: null }).timer = null;
  return match;
}

test('[sessionEnd]: logs matchId/arenaId/winCondition/duration plus the profile and report, no PII', () => {
  const match = realMatch();
  const seat = match.seats[0]!;
  seat.joinedAt = Date.now() - 21_000; // joined 21s ago
  const conn = fakeConn({
    slot: 0,
    profile: { touchActive: true, viewportWidth: 390, viewportHeight: 844, buildSha: 'abc1234' },
    lastReport: { t: 'sessionReport', firstInputMs: null, inputTicks: 0, frameMedianMs: 16.7, frameP95Ms: 34.2 },
  });

  const lines = captureLogs(() => logSessionEnd(conn, match));
  const sessionEndLines = lines.filter((l) => l.startsWith('[sessionEnd]'));
  assert.equal(sessionEndLines.length, 1);
  const record = JSON.parse(sessionEndLines[0]!.slice('[sessionEnd] '.length)) as Record<string, unknown>;

  assert.equal(record.matchId, match.id);
  assert.equal(record.arenaId, match.arenaId);
  assert.equal(record.winCondition, match.winCondition);
  assert.equal(record.eliminated, false);
  assert.equal(record.endReason, 'disconnected');
  assert.ok((record.sessionDurationSec as number) >= 20 && (record.sessionDurationSec as number) <= 22);
  assert.equal(record.touchActive, true);
  assert.equal(record.viewportWidth, 390);
  assert.equal(record.viewportHeight, 844);
  assert.equal(record.buildSha, 'abc1234');
  assert.equal(record.firstInputMs, null); // the "never pressed a key" case
  assert.equal(record.inputTicks, 0);
  assert.equal(record.frameMedianMs, 16.7);
  assert.equal(record.frameP95Ms, 34.2);

  // No personal data of any kind: match-scoped fields only.
  const serialised = JSON.stringify(record).toLowerCase();
  for (const forbidden of ['ip', 'address', 'useragent', 'user-agent', 'cookie', 'token', 'fingerprint']) {
    assert.ok(!serialised.includes(forbidden), `must not contain "${forbidden}"`);
  }
});

test('[sessionEnd]: endReason is "eliminated" when the seat was eliminated', () => {
  const match = realMatch();
  const seat = match.seats[0]!;
  seat.eliminated = true;
  const conn = fakeConn({ slot: 0 });
  const lines = captureLogs(() => logSessionEnd(conn, match));
  const record = JSON.parse(lines.find((l) => l.startsWith('[sessionEnd]'))!.slice('[sessionEnd] '.length));
  assert.equal(record.endReason, 'eliminated');
  assert.equal(record.eliminated, true);
});

test('[sessionEnd]: endReason is "matchEnded" when the match already ended and the seat was not eliminated', () => {
  const match = realMatch();
  (match as unknown as { phase: string }).phase = 'ended';
  const conn = fakeConn({ slot: 0 });
  const lines = captureLogs(() => logSessionEnd(conn, match));
  const record = JSON.parse(lines.find((l) => l.startsWith('[sessionEnd]'))!.slice('[sessionEnd] '.length));
  assert.equal(record.endReason, 'matchEnded');
});

test('[sessionEnd]: a missing profile/report never crashes -- fields log as null, not throw', () => {
  const match = realMatch();
  const conn = fakeConn({ slot: 0, profile: null, lastReport: null });
  const lines = captureLogs(() => logSessionEnd(conn, match));
  const record = JSON.parse(lines.find((l) => l.startsWith('[sessionEnd]'))!.slice('[sessionEnd] '.length));
  assert.equal(record.touchActive, null);
  assert.equal(record.buildSha, null);
  assert.equal(record.firstInputMs, null);
  assert.equal(record.frameMedianMs, null);
});

test('[sessionEnd]: a bogus slot with no matching seat is a no-op, never throws', () => {
  const match = realMatch();
  const conn = fakeConn({ slot: 99 });
  assert.doesNotThrow(() => logSessionEnd(conn, match));
});


test('[sessionEnd]: device-capability buckets and frame/network telemetry (2026-09-14) log through when present', () => {
  const match = realMatch();
  const hello = parseClientControl(
    JSON.stringify({
      t: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      name: 'Ann',
      profile: { touchActive: true, hwConcurrencyBucket: 8, deviceMemoryBucket: 4, dprBucket: 3 },
    }),
  ) as HelloMessage;
  const report = parseClientControl(
    JSON.stringify({
      t: 'sessionReport',
      firstInputMs: 100,
      inputTicks: 5,
      frameMedianMs: 71,
      frameP95Ms: 90,
      frameHistogram: [0, 1, 2, 10, 3, 1],
      hiddenFrames: 4,
      networkHitchCount: 2,
      keyboardInputTicks: 5,
      touchInputTicks: 0,
      gamepadInputTicks: 0,
    }),
  ) as SessionReportMessage;
  const conn = fakeConn({ slot: 0, profile: hello.profile ?? null, lastReport: report });
  const lines = captureLogs(() => logSessionEnd(conn, match));
  const record = JSON.parse(lines.find((l) => l.startsWith('[sessionEnd]'))!.slice('[sessionEnd] '.length));
  assert.equal(record.hwConcurrencyBucket, 8);
  assert.equal(record.deviceMemoryBucket, 4);
  assert.equal(record.dprBucket, 3);
  assert.deepEqual(record.frameHistogram, [0, 1, 2, 10, 3, 1]);
  assert.equal(record.hiddenFrames, 4);
  assert.equal(record.networkHitchCount, 2);
  assert.equal(record.keyboardInputTicks, 5);
  assert.equal(record.touchInputTicks, 0);
  assert.equal(record.gamepadInputTicks, 0);
});

test('[sessionEnd]: a missing profile/report logs the new fields as null too, not throw', () => {
  const match = realMatch();
  const conn = fakeConn({ slot: 0, profile: null, lastReport: null });
  const lines = captureLogs(() => logSessionEnd(conn, match));
  const record = JSON.parse(lines.find((l) => l.startsWith('[sessionEnd]'))!.slice('[sessionEnd] '.length));
  assert.equal(record.hwConcurrencyBucket, null);
  assert.equal(record.deviceMemoryBucket, null);
  assert.equal(record.dprBucket, null);
  assert.equal(record.frameHistogram, null);
  assert.equal(record.hiddenFrames, null);
  assert.equal(record.networkHitchCount, null);
  assert.equal(record.keyboardInputTicks, null);
  assert.equal(record.touchInputTicks, null);
  assert.equal(record.gamepadInputTicks, null);
});

test('[sessionEnd]: slow-frame attribution and device/canvas fields (2026-09-15) log through when present', () => {
  const match = realMatch();
  const hello = parseClientControl(
    JSON.stringify({
      t: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      name: 'Ann',
      profile: {
        touchActive: true,
        canvasWidthPx: 1080,
        canvasHeightPx: 2340,
        screenWidthBucket: 480,
        screenHeightBucket: 1024,
        uaFamily: 'safari',
      },
    }),
  ) as HelloMessage;
  const report = parseClientControl(
    JSON.stringify({
      t: 'sessionReport',
      firstInputMs: 100,
      inputTicks: 5,
      frameMedianMs: 71,
      frameP95Ms: 90,
      slowFrameCount: 6,
      slowFrameFightersAliveBuckets: [0, 1, 2, 3],
      slowFrameFightersOnScreenBuckets: [0, 1, 2, 3],
      slowFrameEffectsLoadBuckets: [1, 1, 2, 2],
      slowFrameHitchCoincidentCount: 2,
      slowFrameTransitionCoincidentCount: 1,
    }),
  ) as SessionReportMessage;
  const conn = fakeConn({ slot: 0, profile: hello.profile ?? null, lastReport: report });
  const lines = captureLogs(() => logSessionEnd(conn, match));
  const record = JSON.parse(lines.find((l) => l.startsWith('[sessionEnd]'))!.slice('[sessionEnd] '.length));
  assert.equal(record.canvasWidthPx, 1080);
  assert.equal(record.canvasHeightPx, 2340);
  assert.equal(record.screenWidthBucket, 480);
  assert.equal(record.screenHeightBucket, 1024);
  assert.equal(record.uaFamily, 'safari');
  assert.equal(record.slowFrameCount, 6);
  assert.deepEqual(record.slowFrameFightersAliveBuckets, [0, 1, 2, 3]);
  assert.deepEqual(record.slowFrameFightersOnScreenBuckets, [0, 1, 2, 3]);
  assert.deepEqual(record.slowFrameEffectsLoadBuckets, [1, 1, 2, 2]);
  assert.equal(record.slowFrameHitchCoincidentCount, 2);
  assert.equal(record.slowFrameTransitionCoincidentCount, 1);
});

test('[sessionEnd]: an older client that never reports slow-frame/canvas fields logs them as null, not throw (mixed-version deploy safety)', () => {
  const match = realMatch();
  const hello = parseClientControl(
    JSON.stringify({ t: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'Ann', profile: { touchActive: true } }),
  ) as HelloMessage;
  const report = parseClientControl(
    JSON.stringify({ t: 'sessionReport', firstInputMs: 100, inputTicks: 5, frameMedianMs: 71, frameP95Ms: 90 }),
  ) as SessionReportMessage;
  const conn = fakeConn({ slot: 0, profile: hello.profile ?? null, lastReport: report });
  const lines = captureLogs(() => logSessionEnd(conn, match));
  const record = JSON.parse(lines.find((l) => l.startsWith('[sessionEnd]'))!.slice('[sessionEnd] '.length));
  assert.equal(record.canvasWidthPx, null);
  assert.equal(record.uaFamily, null);
  assert.equal(record.slowFrameCount, null);
  assert.equal(record.slowFrameFightersAliveBuckets, null);
});

test('[sessionEnd]: requeued (Play again vs start screen) logs through as true/false, and null when absent', () => {
  const trueMatch = realMatch();
  const trueConn = fakeConn({
    slot: 0,
    lastReport: { t: 'sessionReport', firstInputMs: null, inputTicks: 0, frameMedianMs: 16, frameP95Ms: 20, requeued: true },
  });
  const trueLines = captureLogs(() => logSessionEnd(trueConn, trueMatch));
  const trueRecord = JSON.parse(trueLines.find((l) => l.startsWith('[sessionEnd]'))!.slice('[sessionEnd] '.length));
  assert.equal(trueRecord.requeued, true);

  const falseMatch = realMatch();
  const falseConn = fakeConn({
    slot: 0,
    lastReport: { t: 'sessionReport', firstInputMs: null, inputTicks: 0, frameMedianMs: 16, frameP95Ms: 20, requeued: false },
  });
  const falseLines = captureLogs(() => logSessionEnd(falseConn, falseMatch));
  const falseRecord = JSON.parse(falseLines.find((l) => l.startsWith('[sessionEnd]'))!.slice('[sessionEnd] '.length));
  assert.equal(falseRecord.requeued, false);

  const absentMatch = realMatch();
  const absentConn = fakeConn({ slot: 0, profile: null, lastReport: null });
  const absentLines = captureLogs(() => logSessionEnd(absentConn, absentMatch));
  const absentRecord = JSON.parse(absentLines.find((l) => l.startsWith('[sessionEnd]'))!.slice('[sessionEnd] '.length));
  assert.equal(absentRecord.requeued, null);
});
