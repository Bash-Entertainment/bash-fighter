// Engagement telemetry only (2026-09-13, see docs/MEASUREMENT.md). These
// pure, DOM-free helpers can be exercised directly with node:test --
// unlike net-match.ts itself (which needs window/document and so can
// only be pinned at the source-text level in this workspace's `npm
// test`), nothing here touches the browser, so we just run it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildClientProfile,
  buildSessionReportMessage,
  InputActivityTracker,
  InputUsageTracker,
  FrameTimeTracker,
  NetworkHitchTracker,
  bucketHardwareConcurrency,
  bucketDeviceMemory,
  bucketDevicePixelRatio,
  frameHistogramBucketIndex,
  bucketScreenDimension,
  detectUaFamily,
  bucketFighterCount,
  bucketEffectsLoad,
  SlowFrameTracker,
  SLOW_FRAME_THRESHOLD_MS,
} from '../src/session-report.ts';

test('buildClientProfile: constructs exactly the documented shape', () => {
  const profile = buildClientProfile({ touchActive: true, viewportWidth: 390.6, viewportHeight: 844.2, buildSha: '98ebe1a' });
  assert.deepEqual(profile, { touchActive: true, viewportWidth: 391, viewportHeight: 844, buildSha: '98ebe1a' });
});

test('buildClientProfile: omits buildSha when none is available, never sends an empty string', () => {
  const profile = buildClientProfile({ touchActive: false, viewportWidth: 1280, viewportHeight: 720, buildSha: null });
  assert.equal('buildSha' in profile, false);
});

test('buildClientProfile: clamps a negative viewport reading to 0 rather than sending garbage', () => {
  const profile = buildClientProfile({ touchActive: false, viewportWidth: -10, viewportHeight: -1, buildSha: null });
  assert.equal(profile.viewportWidth, 0);
  assert.equal(profile.viewportHeight, 0);
});

test('buildClientProfile: caps an overlong buildSha at 64 characters client-side too', () => {
  const profile = buildClientProfile({ touchActive: false, viewportWidth: 100, viewportHeight: 100, buildSha: 'x'.repeat(200) });
  assert.equal(profile.buildSha?.length, 64);
});

test('buildClientProfile: qa is sent only when true, never as an explicit false', () => {
  const withQa = buildClientProfile({ touchActive: false, viewportWidth: 100, viewportHeight: 100, buildSha: null, qa: true });
  assert.equal(withQa.qa, true);
  const withoutQa = buildClientProfile({ touchActive: false, viewportWidth: 100, viewportHeight: 100, buildSha: null, qa: false });
  assert.equal('qa' in withoutQa, false);
  const omitted = buildClientProfile({ touchActive: false, viewportWidth: 100, viewportHeight: 100, buildSha: null });
  assert.equal('qa' in omitted, false);
});

test('InputActivityTracker: firstInputMs is null until a non-neutral tick, then latches', () => {
  const tracker = new InputActivityTracker();
  assert.equal(tracker.getFirstInputMs(), null);
  assert.equal(tracker.getInputTicks(), 0);

  tracker.recordTick(false, 100); // neutral tick before any input -- must not count
  assert.equal(tracker.getFirstInputMs(), null);
  assert.equal(tracker.getInputTicks(), 0);

  tracker.recordTick(true, 2500.7);
  assert.equal(tracker.getFirstInputMs(), 2501);
  assert.equal(tracker.getInputTicks(), 1);

  tracker.recordTick(true, 3000); // a later input must not overwrite firstInputMs
  assert.equal(tracker.getFirstInputMs(), 2501);
  assert.equal(tracker.getInputTicks(), 2);
});

test('InputActivityTracker: a session with no input at all reports firstInputMs null and zero ticks -- the "never pressed a key" case', () => {
  const tracker = new InputActivityTracker();
  for (let i = 0; i < 50; i++) tracker.recordTick(false, i * 16.7);
  assert.equal(tracker.getFirstInputMs(), null);
  assert.equal(tracker.getInputTicks(), 0);
});

test('InputUsageTracker: attributes ticks to the source that actually produced them', () => {
  const tracker = new InputUsageTracker();
  tracker.recordTick(true, 'keyboard');
  tracker.recordTick(true, 'keyboard');
  tracker.recordTick(true, 'touch');
  tracker.recordTick(true, 'gamepad');
  tracker.recordTick(false, 'touch'); // no input this tick -- must not count under any source
  assert.equal(tracker.getKeyboardTicks(), 2);
  assert.equal(tracker.getTouchTicks(), 1);
  assert.equal(tracker.getGamepadTicks(), 1);
});

test('InputUsageTracker: a session with no input at all reports zero for every source, not undefined', () => {
  const tracker = new InputUsageTracker();
  for (let i = 0; i < 20; i++) tracker.recordTick(false, 'keyboard');
  assert.equal(tracker.getKeyboardTicks(), 0);
  assert.equal(tracker.getTouchTicks(), 0);
  assert.equal(tracker.getGamepadTicks(), 0);
});

test('FrameTimeTracker: median/p95 of a known distribution', () => {
  const tracker = new FrameTimeTracker();
  for (const ms of [16, 16, 16, 16, 16, 16, 16, 16, 16, 100]) tracker.record(ms);
  assert.equal(tracker.getMedianMs(), 16);
  assert.equal(tracker.getP95Ms(), 100);
});

test('FrameTimeTracker: an empty tracker reports 0, never NaN or throws', () => {
  const tracker = new FrameTimeTracker();
  assert.equal(tracker.getMedianMs(), 0);
  assert.equal(tracker.getP95Ms(), 0);
});

test('FrameTimeTracker: rejects negative/non-finite samples instead of corrupting the distribution', () => {
  const tracker = new FrameTimeTracker();
  tracker.record(16);
  tracker.record(-5);
  tracker.record(NaN);
  tracker.record(Infinity);
  assert.equal(tracker.getMedianMs(), 16);
});

test('FrameTimeTracker: caps its rolling window rather than growing unbounded across a long match', () => {
  const tracker = new FrameTimeTracker();
  for (let i = 0; i < 10_000; i++) tracker.record(16.7);
  assert.equal((tracker as unknown as { samples: number[] }).samples.length <= 300, true);
});

test('buildSessionReportMessage: constructs exactly the documented wire shape', () => {
  const msg = buildSessionReportMessage({ firstInputMs: 1234, inputTicks: 40, frameMedianMs: 16.7, frameP95Ms: 33.3 });
  assert.deepEqual(msg, { t: 'sessionReport', firstInputMs: 1234, inputTicks: 40, frameMedianMs: 16.7, frameP95Ms: 33.3 });
});

test('buildSessionReportMessage: preserves a null firstInputMs (never pressed a key) rather than coercing to 0', () => {
  const msg = buildSessionReportMessage({ firstInputMs: null, inputTicks: 0, frameMedianMs: 16, frameP95Ms: 20 });
  assert.equal(msg.firstInputMs, null);
});

test('buildClientProfile: device-capability buckets are omitted when the underlying API is unavailable', () => {
  const profile = buildClientProfile({ touchActive: false, viewportWidth: 100, viewportHeight: 100, buildSha: null });
  assert.equal('hwConcurrencyBucket' in profile, false);
  assert.equal('deviceMemoryBucket' in profile, false);
  assert.equal('dprBucket' in profile, false);
});

test('buildClientProfile: device-capability readings are bucketed, not sent raw', () => {
  const profile = buildClientProfile({
    touchActive: false,
    viewportWidth: 100,
    viewportHeight: 100,
    buildSha: null,
    hardwareConcurrency: 6,
    deviceMemory: 3,
    devicePixelRatio: 2.6,
  });
  assert.equal(profile.hwConcurrencyBucket, 8);
  assert.equal(profile.deviceMemoryBucket, 4);
  assert.equal(profile.dprBucket, 3);
});

test('bucketHardwareConcurrency/bucketDeviceMemory/bucketDevicePixelRatio: reject non-finite/non-positive input', () => {
  assert.equal(bucketHardwareConcurrency(undefined), undefined);
  assert.equal(bucketHardwareConcurrency(0), undefined);
  assert.equal(bucketHardwareConcurrency(-4), undefined);
  assert.equal(bucketHardwareConcurrency(NaN), undefined);
  assert.equal(bucketDeviceMemory(undefined), undefined);
  assert.equal(bucketDevicePixelRatio(undefined), undefined);
});

test('bucketHardwareConcurrency: exact boundary values map to themselves, values above the top ceiling clamp to it', () => {
  assert.equal(bucketHardwareConcurrency(2), 2);
  assert.equal(bucketHardwareConcurrency(4), 4);
  assert.equal(bucketHardwareConcurrency(200), 64);
});

test('frameHistogramBucketIndex: matches the documented [<20, 20-33, 33-50, 50-100, 100-250, >250] boundaries', () => {
  assert.equal(frameHistogramBucketIndex(10), 0);
  assert.equal(frameHistogramBucketIndex(19.9), 0);
  assert.equal(frameHistogramBucketIndex(20), 1);
  assert.equal(frameHistogramBucketIndex(32.9), 1);
  assert.equal(frameHistogramBucketIndex(33), 2);
  assert.equal(frameHistogramBucketIndex(49.9), 2);
  assert.equal(frameHistogramBucketIndex(50), 3);
  assert.equal(frameHistogramBucketIndex(99.9), 3);
  assert.equal(frameHistogramBucketIndex(100), 4);
  assert.equal(frameHistogramBucketIndex(249.9), 4);
  assert.equal(frameHistogramBucketIndex(250), 5);
  assert.equal(frameHistogramBucketIndex(10_000), 5);
});

test('FrameTimeTracker: builds a cumulative histogram alongside the rolling median/p95', () => {
  const tracker = new FrameTimeTracker();
  for (const ms of [10, 15, 25, 60, 120, 300]) tracker.record(ms);
  assert.deepEqual(tracker.getHistogram(), [2, 1, 0, 1, 1, 1]);
});

test('FrameTimeTracker: a steady-71ms session and a mostly-smooth-with-one-huge-stall session produce a similar p95 but a very different histogram', () => {
  const steady = new FrameTimeTracker();
  for (let i = 0; i < 20; i++) steady.record(71);
  const stally = new FrameTimeTracker();
  for (let i = 0; i < 19; i++) stally.record(16);
  stally.record(3000);
  // Both read as "not great" on p95 alone -- median/p95 collapse the two
  // very different failure modes into similar-looking numbers.
  assert.equal(steady.getMedianMs(), 71);
  assert.notDeepEqual(steady.getHistogram(), stally.getHistogram());
  assert.equal(steady.getHistogram()[3], 20); // all 20 frames in the 50-100ms bucket
  assert.equal(stally.getHistogram()[5], 1); // exactly one frame in the >250ms bucket
  assert.equal(stally.getHistogram().slice(0, 5).reduce((a, b) => a + b, 0), 19); // the rest are fine
});

test('FrameTimeTracker: frames recorded while hidden are excluded from samples/histogram and only bump hiddenFrames', () => {
  const tracker = new FrameTimeTracker();
  tracker.record(16, false);
  tracker.record(3000, true); // a backgrounded tab's coalesced huge delta
  tracker.record(17, false);
  assert.equal(tracker.getHiddenFrames(), 1);
  assert.equal(tracker.getMedianMs(), 17); // percentile() floors idx=1 of [16,17]
  assert.deepEqual(tracker.getHistogram(), [2, 0, 0, 0, 0, 0]); // the 3000ms hidden frame never enters bucket 5
});

test('FrameTimeTracker: hidden defaults to false so the existing no-second-arg call sites are unaffected', () => {
  const tracker = new FrameTimeTracker();
  tracker.record(16); // no second argument, same as every pre-existing call site
  assert.equal(tracker.getHiddenFrames(), 0);
  assert.equal(tracker.getHistogram()[0], 1);
});

test('NetworkHitchTracker: counts only gaps strictly above the threshold', () => {
  const tracker = new NetworkHitchTracker();
  tracker.record(50); // normal snapshot interval
  tracker.record(250); // exactly at the threshold -- not a hitch
  tracker.record(251); // just over -- a hitch
  tracker.record(5000); // a big one -- a hitch
  assert.equal(tracker.getCount(), 2);
});

test('NetworkHitchTracker: ignores non-finite gaps rather than corrupting the count', () => {
  const tracker = new NetworkHitchTracker();
  tracker.record(NaN);
  tracker.record(Infinity);
  tracker.record(300);
  assert.equal(tracker.getCount(), 1);
});

test('buildSessionReportMessage: new fields are omitted when absent, matching contextLostCount/renderStalled\'s convention', () => {
  const msg = buildSessionReportMessage({ firstInputMs: null, inputTicks: 0, frameMedianMs: 16, frameP95Ms: 20 });
  assert.equal('frameHistogram' in msg, false);
  assert.equal('hiddenFrames' in msg, false);
  assert.equal('networkHitchCount' in msg, false);
});

test('buildSessionReportMessage: carries the histogram/hiddenFrames/networkHitchCount fields when provided', () => {
  const msg = buildSessionReportMessage({
    firstInputMs: 100,
    inputTicks: 10,
    frameMedianMs: 16,
    frameP95Ms: 71,
    frameHistogram: [1, 2, 3, 4, 5, 6],
    hiddenFrames: 7,
    networkHitchCount: 3,
  });
  assert.deepEqual(msg.frameHistogram, [1, 2, 3, 4, 5, 6]);
  assert.equal(msg.hiddenFrames, 7);
  assert.equal(msg.networkHitchCount, 3);
});

test('buildSessionReportMessage: input-usage fields omitted when absent, carried when provided', () => {
  const omitted = buildSessionReportMessage({ firstInputMs: null, inputTicks: 0, frameMedianMs: 16, frameP95Ms: 20 });
  assert.equal('keyboardInputTicks' in omitted, false);
  assert.equal('touchInputTicks' in omitted, false);
  assert.equal('gamepadInputTicks' in omitted, false);

  const carried = buildSessionReportMessage({
    firstInputMs: 100,
    inputTicks: 10,
    frameMedianMs: 16,
    frameP95Ms: 20,
    keyboardInputTicks: 8,
    touchInputTicks: 0,
    gamepadInputTicks: 2,
  });
  assert.equal(carried.keyboardInputTicks, 8);
  assert.equal(carried.touchInputTicks, 0);
  assert.equal(carried.gamepadInputTicks, 2);
});

test('bucketScreenDimension: rounds up to the nearest public ceiling', () => {
  assert.equal(bucketScreenDimension(390), 480);
  assert.equal(bucketScreenDimension(1920), 1920);
  assert.equal(bucketScreenDimension(4000), 7680);
  assert.equal(bucketScreenDimension(undefined), undefined);
});

test('detectUaFamily: picks the right family and checks more specific tokens first', () => {
  assert.equal(detectUaFamily('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'), 'chrome');
  assert.equal(detectUaFamily('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0'), 'firefox');
  assert.equal(detectUaFamily('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'), 'safari');
  assert.equal(detectUaFamily('SomeWeirdBot/1.0'), 'other');
  assert.equal(detectUaFamily(undefined), 'other');
  assert.equal(detectUaFamily(''), 'other');
});

test('bucketFighterCount/bucketEffectsLoad: fixed 4-bucket boundaries', () => {
  assert.equal(bucketFighterCount(0), 0);
  assert.equal(bucketFighterCount(5), 0);
  assert.equal(bucketFighterCount(6), 1);
  assert.equal(bucketFighterCount(15), 2);
  assert.equal(bucketFighterCount(20), 3);
  assert.equal(bucketEffectsLoad(0), 0);
  assert.equal(bucketEffectsLoad(20), 0);
  assert.equal(bucketEffectsLoad(21), 1);
  assert.equal(bucketEffectsLoad(120), 2);
  assert.equal(bucketEffectsLoad(121), 3);
});

test('buildClientProfile: canvas pixel size, screen buckets, and ua family are carried when provided', () => {
  const profile = buildClientProfile({
    touchActive: true,
    viewportWidth: 390,
    viewportHeight: 844,
    buildSha: null,
    canvasWidthPx: 1080,
    canvasHeightPx: 2340,
    screenWidth: 390,
    screenHeight: 844,
    userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15',
  });
  assert.equal(profile.canvasWidthPx, 1080);
  assert.equal(profile.canvasHeightPx, 2340);
  assert.equal(profile.screenWidthBucket, 480);
  assert.equal(profile.screenHeightBucket, 1024);
  assert.equal(profile.uaFamily, 'safari');
});

test('buildClientProfile: omits canvas/screen/ua fields when not provided (backward compatible)', () => {
  const profile = buildClientProfile({ touchActive: false, viewportWidth: 100, viewportHeight: 100, buildSha: null });
  assert.equal('canvasWidthPx' in profile, false);
  assert.equal('screenWidthBucket' in profile, false);
  assert.equal('uaFamily' in profile, false);
});

test('NetworkHitchTracker: getLastHitchAtMs is null until a hitch is recorded, then latches to the atMs given', () => {
  const tracker = new NetworkHitchTracker();
  assert.equal(tracker.getLastHitchAtMs(), null);
  tracker.record(100, 5000); // below threshold, ignored
  assert.equal(tracker.getLastHitchAtMs(), null);
  tracker.record(400, 6000); // above threshold, recorded
  assert.equal(tracker.getLastHitchAtMs(), 6000);
  tracker.record(50, 7000); // below threshold again, does not overwrite
  assert.equal(tracker.getLastHitchAtMs(), 6000);
});

test('SlowFrameTracker: ignores frames below the threshold entirely', () => {
  const tracker = new SlowFrameTracker();
  tracker.record(SLOW_FRAME_THRESHOLD_MS - 1, { fightersAlive: 20, fightersOnScreen: 20, effectsLoad: 200, hitchRecent: true, transitionRecent: true });
  assert.equal(tracker.getCount(), 0);
  assert.deepEqual(tracker.getFightersAliveBuckets(), [0, 0, 0, 0]);
  assert.equal(tracker.getHitchCoincidentCount(), 0);
});

test('SlowFrameTracker: buckets a qualifying frame by fighters alive/on-screen and effects load, and counts hitch/transition coincidence', () => {
  const tracker = new SlowFrameTracker();
  tracker.record(50, { fightersAlive: 18, fightersOnScreen: 12, effectsLoad: 130, hitchRecent: true, transitionRecent: false });
  tracker.record(60, { fightersAlive: 3, fightersOnScreen: 3, effectsLoad: 5, hitchRecent: false, transitionRecent: true });
  assert.equal(tracker.getCount(), 2);
  assert.deepEqual(tracker.getFightersAliveBuckets(), [1, 0, 0, 1]); // 3 -> bucket 0, 18 -> bucket 3
  assert.deepEqual(tracker.getFightersOnScreenBuckets(), [1, 0, 1, 0]); // 3 -> bucket 0, 12 -> bucket 2
  assert.deepEqual(tracker.getEffectsLoadBuckets(), [1, 0, 0, 1]); // 5 -> bucket 0, 130 -> bucket 3
  assert.equal(tracker.getHitchCoincidentCount(), 1);
  assert.equal(tracker.getTransitionCoincidentCount(), 1);
});

test('buildSessionReportMessage: slowFrame* fields omitted when absent, carried when provided', () => {
  const omitted = buildSessionReportMessage({ firstInputMs: null, inputTicks: 0, frameMedianMs: 16, frameP95Ms: 20 });
  assert.equal('slowFrameCount' in omitted, false);
  assert.equal('slowFrameFightersAliveBuckets' in omitted, false);

  const carried = buildSessionReportMessage({
    firstInputMs: null,
    inputTicks: 0,
    frameMedianMs: 16,
    frameP95Ms: 20,
    slowFrameCount: 4,
    slowFrameFightersAliveBuckets: [0, 1, 1, 2],
    slowFrameFightersOnScreenBuckets: [0, 1, 1, 2],
    slowFrameEffectsLoadBuckets: [1, 1, 1, 1],
    slowFrameHitchCoincidentCount: 2,
    slowFrameTransitionCoincidentCount: 1,
  });
  assert.equal(carried.slowFrameCount, 4);
  assert.deepEqual(carried.slowFrameFightersAliveBuckets, [0, 1, 1, 2]);
  assert.equal(carried.slowFrameHitchCoincidentCount, 2);
  assert.equal(carried.slowFrameTransitionCoincidentCount, 1);
});
