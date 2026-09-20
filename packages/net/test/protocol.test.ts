import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeInput,
  decodeInput,
  encodeSnapshot,
  decodeSnapshot,
  parseClientControl,
  MAX_SESSION_REPORT_BYTES,
  sanitiseName,
  dedupeName,
  PROTOCOL_VERSION,
  INPUT_FRAME_BYTES,
  type WelcomeMessage,
  type LobbyMessage,
  type MatchStartMessage,
  type EliminatedMessage,
  type MatchEndMessage,
  type ErrorMessage,
  type PingMessage,
  type ServerControlMessage,
  FRAME_HISTOGRAM_BOUNDARIES_MS,
  FRAME_HISTOGRAM_BUCKET_COUNT,
} from '../src/protocol.ts';
import type { HelloMessage, SessionReportMessage } from '../src/protocol.ts';

describe('input frame encode/decode', () => {
  test('round-trips a normal frame', () => {
    const wire = { tick: 12345, buttons: 0b1011, stickX: 65536, stickY: -32768 };
    const bytes = encodeInput(wire);
    assert.equal(bytes.byteLength, INPUT_FRAME_BYTES);
    const decoded = decodeInput(bytes);
    assert.deepEqual(decoded, wire);
  });

  test('rejects wrong-length buffers', () => {
    assert.equal(decodeInput(new Uint8Array(3)), null);
    assert.equal(decodeInput(new Uint8Array(INPUT_FRAME_BYTES + 1)), null);
  });

  test('rejects a buffer with the wrong tag byte', () => {
    const bytes = encodeInput({ tick: 1, buttons: 0, stickX: 0, stickY: 0 });
    bytes[0] = 99;
    assert.equal(decodeInput(bytes), null);
  });
});

describe('snapshot encode/decode', () => {
  test('round-trips header and state words', () => {
    const state = new Int32Array([1, -2, 3, -400000, 0]);
    const wire = { tick: 999, ackedInputTick: 998, state };
    const bytes = encodeSnapshot(wire);
    const decoded = decodeSnapshot(bytes);
    assert.ok(decoded);
    assert.equal(decoded!.tick, 999);
    assert.equal(decoded!.ackedInputTick, 998);
    assert.deepEqual(Array.from(decoded!.state), Array.from(state));
  });

  test('round-trips an empty state buffer', () => {
    const bytes = encodeSnapshot({ tick: 1, ackedInputTick: 0, state: new Int32Array(0) });
    const decoded = decodeSnapshot(bytes);
    assert.equal(decoded!.state.length, 0);
  });

  test('rejects a payload that is not a whole number of 4-byte words', () => {
    const bytes = encodeSnapshot({ tick: 1, ackedInputTick: 0, state: new Int32Array([1]) });
    const truncated = bytes.slice(0, bytes.length - 1);
    assert.equal(decodeSnapshot(truncated), null);
  });
});

describe('parseClientControl', () => {
  test('parses a valid hello', () => {
    const msg = parseClientControl(JSON.stringify({ t: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'Alice' }));
    assert.deepEqual(msg, { t: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'Alice' });
  });

  test('rejects malformed JSON', () => {
    assert.equal(parseClientControl('{not json'), null);
  });

  test('rejects an unknown message type', () => {
    assert.equal(parseClientControl(JSON.stringify({ t: 'nonsense' })), null);
  });

  test('rejects an oversized frame', () => {
    const huge = JSON.stringify({ t: 'hello', protocolVersion: 1, name: 'x'.repeat(10_000) });
    assert.equal(parseClientControl(huge), null);
  });

  test('parses spectate and pong', () => {
    assert.deepEqual(parseClientControl(JSON.stringify({ t: 'spectate' })), { t: 'spectate' });
    assert.deepEqual(parseClientControl(JSON.stringify({ t: 'pong', id: 7 })), { t: 'pong', id: 7 });
  });

  test('parses a hello with the dev-only arena pin (issue #19)', () => {
    const msg = parseClientControl(
      JSON.stringify({ t: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'Alice', arena: 'the-atoll' }),
    );
    assert.deepEqual(msg, {
      t: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      name: 'Alice',
      arena: 'the-atoll',
    });
  });

  test('hello arena is absent when the client does not send one (back-compat shape unchanged)', () => {
    const msg = parseClientControl(JSON.stringify({ t: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'Alice' }));
    assert.equal('arena' in (msg as unknown as Record<string, unknown>), false);
  });

  test('hello arena is clamped like every other client string (control chars stripped, length capped)', () => {
    const msg = parseClientControl(
      JSON.stringify({ t: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'Alice', arena: '  the-atoll\u0000 ' }),
    );
    assert.equal((msg as { arena?: string }).arena, 'the-atoll');
    const long = parseClientControl(
      JSON.stringify({ t: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'Alice', arena: 'x'.repeat(200) }),
    );
    // Clamped to 64 chars, so it can never smuggle an unregistered id
    // through length -- registry validation happens server-side anyway.
    assert.equal((long as { arena?: string }).arena, 'x'.repeat(64));
  });
});

// Server -> client control messages (issue #21): protocol.test.ts previously
// only exercised the client->server text-frame decode path
// (parseClientControl) plus the two binary shapes. It never exercised the
// server->client JSON control messages at all (welcome/lobby/matchStart/
// eliminated/matchEnd/error/ping, see docs/PROTOCOL.md's "server -> client"
// table), even though those are also part of the wire protocol and just as
// capable of drifting silently.
//
// protocol.ts does not define a dedicated encode/decode pair for these --
// the real production code (server/src/index.ts's `send()`, and
// packages/app/src/net-match.ts's message handler) transmits them exactly
// as `JSON.stringify(msg)` / `JSON.parse(text) as ServerControlMessage`.
// So "encode it, decode it back" for this half of the protocol means
// exercising that same JSON round trip against the real `*Message`
// interfaces from protocol.ts, fully typed -- which both (a) proves the
// JSON round trip is lossless for every field on every message shape, and
// (b) means a field rename/removal on any of these interfaces breaks the
// typecheck here immediately, the same way a binary layout change would
// break `encodeSnapshot`'s round-trip test.
function encodeServerControl(msg: ServerControlMessage): string {
  return JSON.stringify(msg);
}

function decodeServerControl(text: string): ServerControlMessage {
  return JSON.parse(text) as ServerControlMessage;
}

describe('server->client control message encode/decode', () => {
  test('welcome: round-trips every field, including a null resumeToken (pure spectator)', () => {
    const msg: WelcomeMessage = {
      t: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      clientId: 'client-abc123',
      slot: -1,
      matchId: 'match-1',
      resumeToken: null,
      resumed: false,
    };
    const decoded = decodeServerControl(encodeServerControl(msg));
    assert.deepEqual(decoded, msg);
  });

  test('welcome: round-trips a real seat with a resume token, resumed=true', () => {
    const msg: WelcomeMessage = {
      t: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      clientId: 'client-def456',
      slot: 3,
      matchId: 'match-2',
      resumeToken: 'tok_9f8e7d',
      resumed: true,
    };
    const decoded = decodeServerControl(encodeServerControl(msg));
    assert.deepEqual(decoded, msg);
  });

  test('lobby: round-trips a filling lobby, including a live countdown and the names array', () => {
    const msg: LobbyMessage = {
      t: 'lobby',
      players: 5,
      capacity: 20,
      minimum: 4,
      countdownTicks: 180,
      names: ['Rook', '', 'Anchor', 'Zephyr (2)', ''],
    };
    const decoded = decodeServerControl(encodeServerControl(msg));
    assert.deepEqual(decoded, msg);
  });

  test('lobby: round-trips the not-counting-down sentinel (-1) and an empty names array', () => {
    const msg: LobbyMessage = { t: 'lobby', players: 0, capacity: 20, minimum: 4, countdownTicks: -1, names: [] };
    const decoded = decodeServerControl(encodeServerControl(msg));
    assert.deepEqual(decoded, msg);
  });

  test('matchStart: round-trips settings (opaque unknown payload), arenaId, names and characterIds together', () => {
    const msg: MatchStartMessage = {
      t: 'matchStart',
      matchId: 'match-3',
      seed: 123456789,
      numFighters: 3,
      slot: 1,
      settings: { winCondition: 'stocks', stocks: 3, timeLimitTicks: null },
      arenaId: 'the-foundry',
      names: ['Rook', '', 'Anchor'],
      characterIds: ['placeholder', 'ballast', 'placeholder'],
    };
    const decoded = decodeServerControl(encodeServerControl(msg));
    assert.deepEqual(decoded, msg);
  });

  test('eliminated: round-trips slot/placement/tick', () => {
    const msg: EliminatedMessage = { t: 'eliminated', slot: 7, placement: 12, tick: 4321 };
    const decoded = decodeServerControl(encodeServerControl(msg));
    assert.deepEqual(decoded, msg);
  });

  test('matchEnd: round-trips a real winner and a full leaderboard', () => {
    const msg: MatchEndMessage = { t: 'matchEnd', winner: 2, leaderboard: [2, 0, 1, 3], tick: 9001, resolved: true };
    const decoded = decodeServerControl(encodeServerControl(msg));
    assert.deepEqual(decoded, msg);
  });

  test('matchEnd: round-trips a null winner (simultaneous-KO draw) and resolved=false (abandoned teardown)', () => {
    const msg: MatchEndMessage = { t: 'matchEnd', winner: null, leaderboard: [0, 1], tick: 500, resolved: false };
    const decoded = decodeServerControl(encodeServerControl(msg));
    assert.deepEqual(decoded, msg);
  });

  test('error: round-trips every documented error code', () => {
    const codes: ErrorMessage['code'][] = [
      'protocol_mismatch',
      'bad_message',
      'match_full',
      'server_error',
      'resume_invalid',
      'resume_expired',
      'resume_seat_taken',
    ];
    for (const code of codes) {
      const msg: ErrorMessage = { t: 'error', code, message: `human-readable: ${code}` };
      const decoded = decodeServerControl(encodeServerControl(msg));
      assert.deepEqual(decoded, msg);
    }
  });

  test('ping: round-trips its id', () => {
    const msg: PingMessage = { t: 'ping', id: 42 };
    const decoded = decodeServerControl(encodeServerControl(msg));
    assert.deepEqual(decoded, msg);
  });

  test('every ServerControlMessage variant survives the JSON round trip with its \'t\' discriminant intact', () => {
    // Guards against a category of bug distinct from the per-field checks
    // above: something upstream (a proxy, a logger that mutates before
    // send, a future migration) silently dropping the whole message.
    const messages: ServerControlMessage[] = [
      { t: 'welcome', protocolVersion: PROTOCOL_VERSION, clientId: 'c1', slot: 0, matchId: 'm1', resumeToken: 'tok', resumed: false },
      { t: 'lobby', players: 1, capacity: 20, minimum: 4, countdownTicks: -1, names: ['Rook'] },
      {
        t: 'matchStart',
        matchId: 'm1',
        seed: 1,
        numFighters: 1,
        slot: 0,
        settings: {},
        arenaId: 'battle-royale-20',
        names: ['Rook'],
        characterIds: ['placeholder'],
      },
      { t: 'eliminated', slot: 0, placement: 1, tick: 1 },
      { t: 'matchEnd', winner: 0, leaderboard: [0], tick: 1, resolved: true },
      { t: 'error', code: 'bad_message', message: 'nope' },
      { t: 'ping', id: 1 },
    ];
    for (const msg of messages) {
      const decoded = decodeServerControl(encodeServerControl(msg));
      assert.equal(decoded.t, msg.t);
      assert.deepEqual(decoded, msg);
    }
  });
});

describe('sanitiseName', () => {
  test('strips control characters and truncates to 16', () => {
    assert.equal(sanitiseName('Al\u0000ice\u007fLongLongLongName'), 'AliceLongLongLon');
  });

  test('returns empty for an empty/whitespace-only name, not a forced placeholder', () => {
    assert.equal(sanitiseName('   '), '');
    assert.equal(sanitiseName(''), '');
    assert.equal(sanitiseName('\u0000\u0001\u0007'), '');
  });

  test('collapses interior whitespace runs (tabs, newlines-as-control-chars)', () => {
    assert.equal(sanitiseName('Rook   the   Second'), 'Rook the Second');
  });

  test('strips a script tag down to inert text, never markup', () => {
    // Control characters are stripped but '<'/'>' are ordinary printable
    // characters here -- they are never treated as markup because every
    // renderer in the app writes names via textContent/PIXI Text, never
    // innerHTML. sanitiseName's job is length/control-character hygiene,
    // not HTML escaping (there is nothing that would ever parse this).
    assert.equal(sanitiseName('<script>alert(1)</script>'), '<script>alert(1)');
  });

  test('a 500-character name is capped to 16', () => {
    const huge = 'x'.repeat(500);
    assert.equal(sanitiseName(huge).length, 16);
  });

  test('rejects a lone all-whitespace name including unicode spaces', () => {
    assert.equal(sanitiseName('\u00a0\u2003\t\n'), '');
  });
});

describe('dedupeName', () => {
  test('leaves a unique name untouched', () => {
    assert.equal(dedupeName('Rook', ['Anchor', 'Zephyr']), 'Rook');
  });

  test('appends a counter suffix on collision, case-insensitively', () => {
    assert.equal(dedupeName('rook', ['Rook']), 'rook (2)');
    assert.equal(dedupeName('Rook', ['Rook', 'Rook (2)']), 'Rook (3)');
  });

  test('never dedupes an empty name -- it carries no identity to collide on', () => {
    assert.equal(dedupeName('', ['', '', '']), '');
  });

  test('keeps the deduped result within MAX_NAME_LENGTH', () => {
    const long = 'AAAAAAAAAAAAAAAA'; // exactly 16 chars
    const result = dedupeName(long, [long]);
    assert.ok(result.length <= 16, `expected <=16 chars, got "${result}" (${result.length})`);
    assert.notEqual(result, long);
  });
});

describe('client telemetry: device-capability buckets and frame/network histograms (2026-09-14)', () => {
  function helloWith(profileExtra: Record<string, unknown>) {
    return JSON.stringify({ t: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'Ann', profile: profileExtra });
  }

  test('hello.profile: accepts and clamps well-formed device-capability buckets', () => {
    const msg = parseClientControl(helloWith({ hwConcurrencyBucket: 8, deviceMemoryBucket: 4, dprBucket: 2 }));
    assert.equal(msg?.t, 'hello');
    assert.deepEqual((msg as HelloMessage).profile, { hwConcurrencyBucket: 8, deviceMemoryBucket: 4, dprBucket: 2 });
  });

  test('hello.profile: clamps an absurd hwConcurrencyBucket rather than trusting the client', () => {
    const msg = parseClientControl(helloWith({ hwConcurrencyBucket: 999999 }));
    assert.equal((msg as HelloMessage).profile?.hwConcurrencyBucket, 128);
  });

  test('hello.profile: rejects non-numeric fields and clamps out-of-range ones instead of trusting the client', () => {
    const msg = parseClientControl(helloWith({ hwConcurrencyBucket: 'lots', deviceMemoryBucket: -4, dprBucket: null })) as HelloMessage;
    assert.equal(msg?.t, 'hello');
    // hwConcurrencyBucket ('lots') and dprBucket (null) are not numbers at all -> dropped.
    assert.equal('hwConcurrencyBucket' in msg.profile!, false);
    assert.equal('dprBucket' in msg.profile!, false);
    // deviceMemoryBucket (-4) is a number but below the valid floor -> clamped to the min, not dropped.
    assert.equal(msg.profile!.deviceMemoryBucket, 0.25);
  });

  test('hello.profile: an old client that never sends these fields still parses fine (backward compatible)', () => {
    const msg = parseClientControl(
      JSON.stringify({ t: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'Ann', profile: { touchActive: true } }),
    );
    assert.equal(msg?.t, 'hello');
    assert.deepEqual((msg as HelloMessage).profile, { touchActive: true });
  });

  function sessionReportWith(extra: Record<string, unknown>) {
    return JSON.stringify({
      t: 'sessionReport',
      firstInputMs: 100,
      inputTicks: 10,
      frameMedianMs: 16,
      frameP95Ms: 20,
      ...extra,
    });
  }

  test('sessionReport: FRAME_HISTOGRAM_BOUNDARIES_MS/FRAME_HISTOGRAM_BUCKET_COUNT stay in sync', () => {
    assert.equal(FRAME_HISTOGRAM_BUCKET_COUNT, FRAME_HISTOGRAM_BOUNDARIES_MS.length + 1);
    assert.deepEqual(FRAME_HISTOGRAM_BOUNDARIES_MS, [20, 33, 50, 100, 250]);
  });

  test('sessionReport: accepts a well-formed frameHistogram/hiddenFrames/networkHitchCount', () => {
    const msg = parseClientControl(
      sessionReportWith({ frameHistogram: [1, 2, 3, 4, 5, 6], hiddenFrames: 7, networkHitchCount: 2 }),
    ) as SessionReportMessage;
    assert.deepEqual(msg.frameHistogram, [1, 2, 3, 4, 5, 6]);
    assert.equal(msg.hiddenFrames, 7);
    assert.equal(msg.networkHitchCount, 2);
  });

  test('sessionReport: drops a malformed frameHistogram entirely rather than half-trusting it', () => {
    const wrongLength = parseClientControl(sessionReportWith({ frameHistogram: [1, 2, 3] })) as SessionReportMessage;
    assert.equal('frameHistogram' in wrongLength, false);

    const negativeElement = parseClientControl(sessionReportWith({ frameHistogram: [1, -2, 3, 4, 5, 6] })) as SessionReportMessage;
    assert.equal('frameHistogram' in negativeElement, false);

    const wrongType = parseClientControl(sessionReportWith({ frameHistogram: 'nope' })) as SessionReportMessage;
    assert.equal('frameHistogram' in wrongType, false);
  });

  test('sessionReport: clamps an absurd/negative hiddenFrames/networkHitchCount into range rather than trusting the client', () => {
    const msg = parseClientControl(sessionReportWith({ hiddenFrames: 1e12, networkHitchCount: -5 })) as SessionReportMessage;
    assert.equal(msg.hiddenFrames, 10_000_000); // clamped to the max, same convention as inputTicks
    assert.equal(msg.networkHitchCount, 0); // clamped to the min, same convention as inputTicks
  });

  test('sessionReport: accepts well-formed keyboardInputTicks/touchInputTicks/gamepadInputTicks', () => {
    const msg = parseClientControl(
      sessionReportWith({ keyboardInputTicks: 100, touchInputTicks: 0, gamepadInputTicks: 5 }),
    ) as SessionReportMessage;
    assert.equal(msg.keyboardInputTicks, 100);
    assert.equal(msg.touchInputTicks, 0);
    assert.equal(msg.gamepadInputTicks, 5);
  });

  test('sessionReport: clamps an absurd/negative input-usage tick count into range rather than trusting the client', () => {
    const msg = parseClientControl(
      sessionReportWith({ keyboardInputTicks: -5, touchInputTicks: 1e12 }),
    ) as SessionReportMessage;
    assert.equal(msg.keyboardInputTicks, 0);
    assert.equal(msg.touchInputTicks, 10_000_000);
  });

  test('sessionReport: an old client sending none of the input-usage fields leaves them absent, not zero', () => {
    const msg = parseClientControl(sessionReportWith({})) as SessionReportMessage;
    assert.equal('keyboardInputTicks' in msg, false);
    assert.equal('touchInputTicks' in msg, false);
    assert.equal('gamepadInputTicks' in msg, false);
  });

  test('sessionReport: an old client sending none of the new fields still parses exactly as before', () => {
    const msg = parseClientControl(
      JSON.stringify({ t: 'sessionReport', firstInputMs: null, inputTicks: 0, frameMedianMs: 16, frameP95Ms: 20 }),
    ) as SessionReportMessage;
    assert.deepEqual(msg, { t: 'sessionReport', firstInputMs: null, inputTicks: 0, frameMedianMs: 16, frameP95Ms: 20 });
  });
});

describe('client telemetry: slow-frame attribution (2026-09-15)', () => {
  function helloWith(profileExtra: Record<string, unknown>) {
    return JSON.stringify({ t: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'Ann', profile: profileExtra });
  }
  function sessionReportWith(extra: Record<string, unknown>) {
    return JSON.stringify({
      t: 'sessionReport',
      firstInputMs: 100,
      inputTicks: 10,
      frameMedianMs: 16,
      frameP95Ms: 20,
      ...extra,
    });
  }

  test('hello.profile: accepts canvas pixel size, screen buckets, and a valid uaFamily', () => {
    const msg = parseClientControl(
      helloWith({ canvasWidthPx: 1080, canvasHeightPx: 2340, screenWidthBucket: 480, screenHeightBucket: 1024, uaFamily: 'safari' }),
    ) as HelloMessage;
    assert.deepEqual(msg.profile, {
      canvasWidthPx: 1080,
      canvasHeightPx: 2340,
      screenWidthBucket: 480,
      screenHeightBucket: 1024,
      uaFamily: 'safari',
    });
  });

  test('hello.profile: clamps an absurd canvas size and drops an unrecognised uaFamily rather than trusting the client', () => {
    const msg = parseClientControl(helloWith({ canvasWidthPx: 1e9, uaFamily: 'ie6' })) as HelloMessage;
    assert.equal(msg.profile!.canvasWidthPx, 20000);
    assert.equal('uaFamily' in msg.profile!, false);
  });

  test('hello.profile: an old client sending none of these fields still parses fine (backward compatible)', () => {
    const msg = parseClientControl(
      JSON.stringify({ t: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'Ann', profile: { touchActive: true } }),
    ) as HelloMessage;
    assert.deepEqual(msg.profile, { touchActive: true });
    assert.equal('canvasWidthPx' in msg.profile!, false);
    assert.equal('uaFamily' in msg.profile!, false);
  });

  test('sessionReport: accepts well-formed slowFrame* fields', () => {
    const msg = parseClientControl(
      sessionReportWith({
        slowFrameCount: 12,
        slowFrameFightersAliveBuckets: [1, 2, 3, 6],
        slowFrameFightersOnScreenBuckets: [1, 2, 3, 6],
        slowFrameEffectsLoadBuckets: [0, 4, 4, 4],
        slowFrameHitchCoincidentCount: 3,
        slowFrameTransitionCoincidentCount: 1,
      }),
    ) as SessionReportMessage;
    assert.equal(msg.slowFrameCount, 12);
    assert.deepEqual(msg.slowFrameFightersAliveBuckets, [1, 2, 3, 6]);
    assert.deepEqual(msg.slowFrameFightersOnScreenBuckets, [1, 2, 3, 6]);
    assert.deepEqual(msg.slowFrameEffectsLoadBuckets, [0, 4, 4, 4]);
    assert.equal(msg.slowFrameHitchCoincidentCount, 3);
    assert.equal(msg.slowFrameTransitionCoincidentCount, 1);
  });

  test('sessionReport: drops a slowFrame*Buckets array of the wrong length or with a negative element', () => {
    const wrongLength = parseClientControl(sessionReportWith({ slowFrameFightersAliveBuckets: [1, 2, 3] })) as SessionReportMessage;
    assert.equal('slowFrameFightersAliveBuckets' in wrongLength, false);

    const negative = parseClientControl(sessionReportWith({ slowFrameEffectsLoadBuckets: [1, -1, 3, 4] })) as SessionReportMessage;
    assert.equal('slowFrameEffectsLoadBuckets' in negative, false);
  });

  test('sessionReport: an old client sending none of the slow-frame fields leaves them absent, and still validates/stores fine (mixed-version deploy safety)', () => {
    const msg = parseClientControl(
      JSON.stringify({ t: 'sessionReport', firstInputMs: null, inputTicks: 0, frameMedianMs: 16, frameP95Ms: 20 }),
    ) as SessionReportMessage;
    assert.deepEqual(msg, { t: 'sessionReport', firstInputMs: null, inputTicks: 0, frameMedianMs: 16, frameP95Ms: 20 });
    assert.equal('slowFrameCount' in msg, false);
    assert.equal('slowFrameFightersAliveBuckets' in msg, false);
  });
});

// 2026-09-19. The session records had no device pixel ratio at all, so
// every frame-time figure we quoted for high-density phone screens was
// unbackable. The field now travels client to server, and this pins the
// parse: kept and rounded when sane, dropped when it isn't, and never
// enough to threaten the size cap that once made the server hang up on
// every player.
test('sessionReport: devicePixelRatio is kept when sane and dropped when not', () => {
  const sessionReportWith = (extra: Record<string, unknown>) =>
    JSON.stringify({ t: 'sessionReport', firstInputMs: 100, inputTicks: 10, frameMedianMs: 16, frameP95Ms: 20, ...extra });
  const kept = parseClientControl(sessionReportWith({ devicePixelRatio: 2.6666 }));
  assert.equal(kept?.t, 'sessionReport');
  assert.equal((kept as { devicePixelRatio?: number }).devicePixelRatio, 2.67);

  for (const bad of [0, -1, Number.NaN, 'two', null, 1e9]) {
    const parsed = parseClientControl(sessionReportWith({ devicePixelRatio: bad })) as
      | { devicePixelRatio?: number }
      | null;
    assert.equal(parsed?.devicePixelRatio, undefined, `devicePixelRatio ${String(bad)} must be dropped`);
  }

  assert.ok(
    sessionReportWith({ devicePixelRatio: 3 }).length < MAX_SESSION_REPORT_BYTES,
    'a report carrying the field must stay under the session-report cap',
  );
});

// 2026-09-19. Re-queue rate (Play again vs start screen) is the metric we
// care most about, so requeued must survive a strict boolean and get
// dropped otherwise -- never coerced from a truthy/falsy non-boolean.
test('sessionReport: requeued is kept only when a strict boolean', () => {
  const sessionReportWith = (extra: Record<string, unknown>) =>
    JSON.stringify({ t: 'sessionReport', firstInputMs: 100, inputTicks: 10, frameMedianMs: 16, frameP95Ms: 20, ...extra });

  const keptTrue = parseClientControl(sessionReportWith({ requeued: true }));
  assert.equal((keptTrue as { requeued?: boolean })?.requeued, true);

  const keptFalse = parseClientControl(sessionReportWith({ requeued: false }));
  assert.equal((keptFalse as { requeued?: boolean })?.requeued, false);

  for (const bad of [1, 0, 'true', null, undefined, {}]) {
    const parsed = parseClientControl(sessionReportWith({ requeued: bad })) as
      | { requeued?: boolean }
      | null;
    assert.equal(parsed?.requeued, undefined, `requeued ${String(bad)} must be dropped`);
  }

  assert.ok(
    sessionReportWith({ requeued: true }).length < MAX_SESSION_REPORT_BYTES,
    'a report carrying the field must stay under the session-report cap',
  );
});
