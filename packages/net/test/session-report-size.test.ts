import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseClientControl,
  MAX_CONTROL_MESSAGE_BYTES,
  MAX_SESSION_REPORT_BYTES,
} from '../src/protocol.ts';

// Regression: a real player reported "connection dropped all the time". The
// cause was on our side -- a full sessionReport is far larger than the old
// shared 512-byte control-message cap, so it failed to parse and the server
// closed the socket. Any new telemetry field must not be able to do that
// again, so pin a report at realistic size and one comfortably larger.
function buildReport(pad: number): string {
  return JSON.stringify({
    t: 'sessionReport',
    firstInputMs: 1234,
    inputTicks: 5000,
    frameMedianMs: 16.7,
    frameP95Ms: 22.4,
    contextLostCount: 0,
    renderStalled: false,
    frameHistogram: [100, 200, 300, 50, 10, 2, 1, 0, 0, 0, 0, 0],
    hiddenFrames: 12,
    networkHitchCount: 1,
    keyboardInputTicks: 4000,
    touchInputTicks: 0,
    gamepadInputTicks: 0,
    slowFrameCount: 44,
    slowFrameFightersAliveBuckets: [1, 2, 3, 4],
    slowFrameFightersOnScreenBuckets: [1, 2, 3, 4],
    slowFrameEffectsLoadBuckets: [1, 2, 3, 4],
    slowFrameHitchCoincidentCount: 2,
    slowFrameTransitionCoincidentCount: 1,
    visibleMs: 91_000,
    hiddenMs: 0,
    profile: {
      hardwareConcurrency: 16,
      deviceMemory: 32,
      devicePixelRatio: 1,
      canvasWidthPx: 1720,
      canvasHeightPx: 898,
      screenWidthBucket: 3840,
      screenHeightBucket: 2560,
      uaFamily: 'chrome',
    },
    // Stands in for the telemetry fields we have not added yet: the point of
    // this test is that adding more must not resurrect the bug.
    ...(pad > 0 ? { futureFieldPadding: 'x'.repeat(pad) } : {}),
  });
}

test('a realistically sized sessionReport parses (it is bigger than the small-message cap)', () => {
  const text = buildReport(0);
  assert.ok(
    text.length > MAX_CONTROL_MESSAGE_BYTES,
    'test is meaningless unless the report exceeds the small-message cap',
  );
  const parsed = parseClientControl(text);
  assert.ok(parsed, 'a real session report must not be rejected as malformed');
  assert.equal(parsed?.t, 'sessionReport');
});

test('sessionReport has headroom well beyond the small-message cap', () => {
  const parsed = parseClientControl(buildReport(2000));
  assert.ok(parsed, 'session reports must keep parsing as we add telemetry fields');
});

test('a sessionReport beyond the hard limit is rejected rather than trusted', () => {
  const text = buildReport(MAX_SESSION_REPORT_BYTES + 1000);
  assert.ok(text.length > MAX_SESSION_REPORT_BYTES);
  assert.equal(parseClientControl(text), null);
});

test('the small cap still applies to every other control message type', () => {
  const bloated = JSON.stringify({ t: 'pong', id: 1, pad: 'x'.repeat(MAX_CONTROL_MESSAGE_BYTES) });
  assert.ok(bloated.length > MAX_CONTROL_MESSAGE_BYTES);
  assert.equal(parseClientControl(bloated), null);
  assert.deepEqual(parseClientControl(JSON.stringify({ t: 'pong', id: 7 })), { t: 'pong', id: 7 });
});
