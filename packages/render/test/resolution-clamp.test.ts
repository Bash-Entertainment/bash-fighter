// Regression test for the DPR resolution clamp added 2026-09-15.
//
// Background: Pixi's Application defaults `resolution` to the raw
// `window.devicePixelRatio` when unspecified. On desktop that's DPR 1-2,
// fine, but production has seen DPR-3 phones -- exactly the devices
// already struggling (82% of real sessions are touch, p95 client frame
// time 71ms vs ~17ms desktop, per Real Player Measurements 2026-09-14).
// An unclamped DPR-3 canvas renders 9x the pixel-shader samples of DPR1
// (3x3, because both canvas dimensions scale), not 3x -- a direct
// fill-rate cost that got worse the moment camera zoom went up in
// c4a4f52 (phone scale 0.406 -> 0.720, ~3.15x more screen area per
// fighter/effect). Capping resolution to 2 removes a further 2.25x of
// that cost ((3/2)^2) on exactly the DPR-3 devices, while leaving
// DPR 1-2 desktops and phones untouched.
//
// Imports only from resolution.ts, not index.ts: index.ts's transitive
// graph includes spectator-camera.ts's TypeScript parameter-property
// syntax, unsupported by Node's --experimental-strip-types (used by
// scripts/run-tests.mjs). The second test below instead greps
// index.ts's source to confirm the clamp is actually wired into init().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clampRenderResolution } from '../src/resolution.ts';

test('DPR at or below the cap passes through unchanged', () => {
  assert.equal(clampRenderResolution(1, 2), 1);
  assert.equal(clampRenderResolution(2, 2), 2);
});

test('DPR above the cap is clamped, not left at the raw device value', () => {
  assert.equal(clampRenderResolution(3, 2), 2);
  assert.equal(clampRenderResolution(4, 2), 2);
});

test('a DPR-3 phone gets 2.25x fewer shaded pixels than the unclamped default', () => {
  const before = 3;
  const after = clampRenderResolution(3, 2);
  const pixelAreaRatio = (before / after) ** 2;
  assert.ok(pixelAreaRatio > 2.2 && pixelAreaRatio < 2.3, `expected ~2.25x, got ${pixelAreaRatio}`);
});

test('non-finite or zero/negative DPR (unusual test/embedded environments) falls back to 1', () => {
  assert.equal(clampRenderResolution(Number.NaN, 2), 1);
  assert.equal(clampRenderResolution(0, 2), 1);
  assert.equal(clampRenderResolution(-1, 2), 1);
});

test('Renderer.init() actually wires the clamp in with a cap of 2, and uses autoDensity so CSS size stays correct', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /static readonly MAX_RESOLUTION = 2;/);
  assert.match(source, /resolution: clampRenderResolution\(dpr, Renderer\.MAX_RESOLUTION\)/);
  assert.match(source, /autoDensity: true/);
});
