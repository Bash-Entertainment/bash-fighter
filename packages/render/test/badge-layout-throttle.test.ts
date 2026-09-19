// Source-level pin for the badge-layout render-perf throttle (2026-09-19):
// the *decision* computeBadgePlacements makes (collision solve + canvas
// text measurement) should not run every render frame, but badge
// *positions* must still be re-anchored to each fighter's current head
// position every frame, and an elimination (the candidate slot set
// changing) must force an immediate recompute rather than riding out a
// stale layout. No jsdom/Pixi here (see AGENTS.md) -- this is pinned at
// source level with readFileSync + regex, matching the project's other
// index.ts pins (see intro-emphasis.test.ts).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const indexSource = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts'),
  'utf8',
);

describe('badge layout throttle (render-perf pass 2026-09-19)', () => {
  it('does not re-run computeBadgePlacements every render frame', () => {
    assert.match(indexSource, /BADGE_LAYOUT_INTERVAL\s*=\s*\d+/);
    const layoutBadgesBody = indexSource.match(/private layoutBadges\([^]*?\n {2}\}/)?.[0];
    assert.ok(layoutBadgesBody, 'layoutBadges method not found');
    assert.match(layoutBadgesBody!, /dueForRecompute/);
    assert.match(layoutBadgesBody!, /badgeFrameCounter % Renderer\.BADGE_LAYOUT_INTERVAL/);
  });

  it('forces an immediate recompute when the alive-candidate set changes', () => {
    const layoutBadgesBody = indexSource.match(/private layoutBadges\([^]*?\n {2}\}/)?.[0];
    assert.ok(layoutBadgesBody);
    assert.match(layoutBadgesBody!, /structureChanged/);
    assert.match(layoutBadgesBody!, /slotsKey !== this\.lastBadgeCandidateSlotsKey/);
  });

  it('still re-anchors every badge to its fighter head position every frame', () => {
    const layoutBadgesBody = indexSource.match(/private layoutBadges\([^]*?\n {2}\}/)?.[0];
    assert.ok(layoutBadgesBody);
    // Position math (dx/dy from cached vs current head) must run
    // unconditionally in the per-placement loop, outside the
    // recompute-gated block, so a badge tracks its fighter every frame
    // even when the tier/collision decision is stale by up to
    // BADGE_LAYOUT_INTERVAL frames.
    assert.match(layoutBadgesBody!, /curHead\.x - cachedHead\.x/);
    assert.match(layoutBadgesBody!, /curHead\.y - cachedHead\.y/);
    assert.match(layoutBadgesBody!, /text\.position\.set\(x, y\)/);
  });
});
