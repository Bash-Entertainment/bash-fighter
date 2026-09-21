// Regression tests for the frame-time-driven adaptive resolution
// governor added 2026-09-21 (see wiki: Real Player Measurements
// 2026-09-14 -- 82% of real sessions are touch, p95 71ms, and the
// static MAX_RESOLUTION clamp cannot help a phone still too slow at
// resolution 2). Pure module, no DOM/Pixi -- see adaptive-resolution.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveResolutionGovernor } from '../src/adaptive-resolution.ts';

function feed(gov: AdaptiveResolutionGovernor, ms: number, times: number): void {
  for (let i = 0; i < times; i++) gov.sample(ms);
}

test('downgrades once after 120 sustained slow frames (p95 > 45ms)', () => {
  const gov = new AdaptiveResolutionGovernor(2);
  assert.equal(gov.resolution, 2);
  feed(gov, 60, 120);
  assert.equal(gov.resolution, 1.5);
  assert.equal(gov.downgrades, 1);
});

test('does not downgrade again inside the 180-sample cooldown', () => {
  const gov = new AdaptiveResolutionGovernor(2);
  feed(gov, 60, 120);
  assert.equal(gov.downgrades, 1);
  // still slow, but within cooldown of the first downgrade
  feed(gov, 60, 150);
  assert.equal(gov.downgrades, 1);
  assert.equal(gov.resolution, 1.5);
});

test('downgrades a second time once the cooldown has fully elapsed', () => {
  const gov = new AdaptiveResolutionGovernor(2);
  feed(gov, 60, 120);
  assert.equal(gov.downgrades, 1);
  feed(gov, 60, 180);
  feed(gov, 60, 120);
  assert.equal(gov.downgrades, 2);
  assert.equal(gov.resolution, 1);
});

test('upgrades one level after 240 sustained fast frames (p95 < 22ms)', () => {
  const gov = new AdaptiveResolutionGovernor(2);
  feed(gov, 60, 120);
  assert.equal(gov.resolution, 1.5);
  feed(gov, 10, 240);
  assert.equal(gov.resolution, 2);
  assert.equal(gov.upgrades, 1);
});

test('never upgrades more than twice in a session', () => {
  const gov = new AdaptiveResolutionGovernor(2);
  feed(gov, 60, 120); // -> 1.5
  feed(gov, 300, 180); // cooldown elapses without tripping upgrade (bogus-free but slow-ish? use fast below)
  feed(gov, 60, 120); // -> 1, downgrade #2
  feed(gov, 10, 240); // -> 1.5, upgrade #1
  feed(gov, 10, 240); // -> 2, upgrade #2 (already at device cap, should be no-op)
  assert.ok(gov.upgrades <= 2);
  assert.equal(gov.resolution, 2);
});

test('never goes below resolution 1', () => {
  const gov = new AdaptiveResolutionGovernor(2);
  feed(gov, 500, 120);
  feed(gov, 500, 180);
  feed(gov, 500, 120);
  feed(gov, 500, 500);
  assert.equal(gov.resolution, 1);
});

test('never goes above the device initial resolution', () => {
  const gov = new AdaptiveResolutionGovernor(1);
  feed(gov, 5, 1000);
  assert.equal(gov.resolution, 1);
  assert.equal(gov.upgrades, 0);
});

test('a device initial resolution below 2 caps the starting step accordingly', () => {
  const gov = new AdaptiveResolutionGovernor(1.5);
  assert.equal(gov.resolution, 1.5);
});

test('bogus samples (<=0ms or >2000ms) are ignored, not counted', () => {
  const gov = new AdaptiveResolutionGovernor(2);
  feed(gov, 0, 500);
  feed(gov, -5, 500);
  feed(gov, 5000, 500);
  assert.equal(gov.resolution, 2);
  assert.equal(gov.downgrades, 0);
});
