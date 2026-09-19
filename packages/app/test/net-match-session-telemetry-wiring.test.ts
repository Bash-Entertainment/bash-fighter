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

// 2026-09-19. A real player's session reported eleven network hitches
// across 34 seconds of backgrounded tab time while the server was idle at
// 0.1 load. They were all phantoms: the first snapshot after the tab
// returns to the foreground measures a gap spanning the whole background
// period, and document.hidden is false again by then, so the old
// visible-only check counted one hitch per tab switch. Pinned at source
// level because there is no jsdom in this repo.
test('a snapshot gap straddling a background period is not counted as a network hitch', () => {
  const src = readFileSync(new URL('../src/net-match.ts', import.meta.url), 'utf8');
  assert.match(
    src,
    /visibilityChangedAtMs = performance\.now\(\)/,
    'the visibility handler must record when visibility last changed',
  );
  assert.match(
    src,
    /straddledBackground[\s\S]{0,200}visibilityChangedAtMs !== null && this\.visibilityChangedAtMs >= previousSnapAt/,
    'a gap must be classed as straddling the background when a visibility change falls inside it',
  );
  assert.match(
    src,
    /if \(!document\.hidden && !straddledBackground\) \{\s*\n\s*this\.networkHitchTracker\.record/,
    'the hitch counter must skip both hidden frames and gaps straddling a background period',
  );
  assert.match(
    src,
    /this\.networkHitchTracker = new NetworkHitchTracker\(\);\s*\n\s*this\.visibilityChangedAtMs = null;/,
    'the straddle marker must reset with the hitch counter at match start',
  );
});
