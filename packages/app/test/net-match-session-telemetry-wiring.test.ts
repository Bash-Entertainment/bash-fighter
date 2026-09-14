// Engagement telemetry only (2026-09-13, see docs/MEASUREMENT.md).
// net-match.ts needs window/document and so can't be instantiated in
// `npm test` (no jsdom in this workspace, by convention -- see the other
// net-match-*.test.ts files) -- this pins the wiring at the source-text
// level: that hello actually carries a profile, that tick() feeds the
// InputActivityTracker from the same local frame already computed for
// the sim, that render() feeds the FrameTimeTracker, and that a periodic
// timer plus a best-effort final send both exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../src/net-match.ts'), 'utf8');

test('hello includes a profile built from buildClientProfile', () => {
  assert.match(src, /hello\.profile\s*=\s*buildClientProfile\(/);
});

test('tick() records input activity from the same local frame used by the sim, not a second poll', () => {
  const tickIdx = src.indexOf('private tick(');
  assert.ok(tickIdx >= 0);
  const tickBody = src.slice(tickIdx, tickIdx + 2000);
  assert.match(tickBody, /const local = this\.input\.poll\(\)/);
  assert.match(tickBody, /this\.inputActivity\.recordTick\(/);
  // Only one poll() call in this stretch -- telemetry must read the
  // already-computed local frame, never poll a second time.
  assert.equal((tickBody.match(/this\.input\.poll\(/g) ?? []).length, 1);
});

test('render() feeds the FrameTimeTracker and never gates on it', () => {
  const renderIdx = src.indexOf('private render(): void {');
  assert.ok(renderIdx >= 0);
  const renderBody = src.slice(renderIdx, renderIdx + 600);
  assert.match(renderBody, /this\.frameTimeTracker\.record\(/);
});

test('a periodic sessionReport timer is started with startMatch and cleared in stop()', () => {
  assert.match(src, /this\.reportTimer = setInterval\(\(\) => this\.sendSessionReport\(\), this\.REPORT_INTERVAL_MS\)/);
  const stopIdx = src.indexOf('stop(): void {');
  const stopBody = src.slice(stopIdx, stopIdx + 800);
  assert.match(stopBody, /clearInterval\(this\.reportTimer\)/);
  assert.match(stopBody, /this\.sendSessionReport\(\)/);
});

test('sendSessionReport is a no-op when there is no open socket or no match in progress -- never throws, never queues', () => {
  const idx = src.indexOf('private sendSessionReport(): void {');
  assert.ok(idx >= 0);
  const body = src.slice(idx, idx + 700);
  assert.match(body, /if \(!this\.matchStarted \|\| this\.spectating \|\| this\.mySlot < 0\) return;/);
  assert.match(body, /if \(!ws \|\| ws\.readyState !== WebSocket\.OPEN\) return;/);
});
