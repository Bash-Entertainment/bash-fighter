// Engagement telemetry only (2026-09-13, see docs/MEASUREMENT.md). These
// pure, DOM-free helpers can be exercised directly with node:test --
// unlike net-match.ts itself (which needs window/document and so can
// only be pinned at the source-text level in this workspace's `npm
// test`), nothing here touches the browser, so we just run it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClientProfile, buildSessionReportMessage, InputActivityTracker, FrameTimeTracker } from '../src/session-report.ts';

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
