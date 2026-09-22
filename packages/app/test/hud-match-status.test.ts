// Regression coverage for the match-status block added below the chip
// grid 2026-09-14 (previously permanently empty dead space in the
// sidebar on every match, see wiki "Camera Framing" era layout docs),
// and for the ordering bug found in production the same day: a
// newest-first elimination feed rendered in slot order instead of true
// elimination order. No jsdom in this repo, so DOM wiring is pinned by
// source inspection (same convention as hud-survivors.test.ts); the
// pure text/ordering helpers get real unit tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  modeLabelText,
  winConditionText,
  objectiveLineText,
  koStandingLineText,
  eliminationFeedLine,
  chipDisplayName,
  sortFeedEntriesNewestFirst,
} from '../src/ui/hud-text.ts';

const here = dirname(fileURLToPath(import.meta.url));
const hudSrc = readFileSync(join(here, '../src/ui/hud.ts'), 'utf8');
const mainSrc = readFileSync(join(here, '../src/main.ts'), 'utf8');

test('modeLabelText names all three win conditions', () => {
  assert.equal(modeLabelText('battleRoyale'), 'Battle Royale');
  assert.equal(modeLabelText('timedKO'), 'Timed Brawl');
  assert.equal(modeLabelText('stocks'), 'Stocks');
});

test('winConditionText describes how each mode is won', () => {
  assert.equal(winConditionText('battleRoyale'), 'last fighter standing');
  assert.equal(winConditionText('timedKO'), 'most KOs when time expires');
  assert.equal(winConditionText('stocks'), 'last stock standing');
});

test('eliminationFeedLine reports a win at 1st place, not "eliminated"', () => {
  assert.equal(eliminationFeedLine('CPU Rook', 1), 'CPU Rook wins');
});

test('eliminationFeedLine includes ordinal placement when known', () => {
  assert.equal(eliminationFeedLine('CPU Wisp', 12), 'CPU Wisp eliminated · 12th');
  assert.equal(eliminationFeedLine('CPU Talon', 3), 'CPU Talon eliminated · 3rd');
  assert.equal(eliminationFeedLine('CPU Bramble', 11), 'CPU Bramble eliminated · 11th');
});

test('eliminationFeedLine falls back to a plain line with no placement', () => {
  assert.equal(eliminationFeedLine('CPU Fuzz', null), 'CPU Fuzz eliminated');
});

test('eliminationFeedLine falls back to a generic name for an empty display name', () => {
  assert.equal(eliminationFeedLine('', 5), 'Fighter eliminated · 5th');
});

test('chipDisplayName drops the "CPU " prefix for the chip column only', () => {
  assert.equal(chipDisplayName('CPU Squall'), 'Squall');
  assert.equal(chipDisplayName('Squall'), 'Squall');
  assert.equal(chipDisplayName('CPU'), 'CPU');
});

// This is the exact bug reported from production: spectating an 8/20
// Battle Royale, the on-screen feed (top to bottom) read
//   CPU Squall eliminated · 11th
//   CPU Pixel eliminated · 15th
//   CPU Marble eliminated · 17th
//   CPU Junco eliminated · 9th
// which cannot be newest-first, since placements are handed out in
// strictly descending order over time (first death = worst/highest
// placement, most recent death = best/lowest placement among those
// eliminated so far). Junco at 9th was the most recent of the four and
// had sunk to the bottom because the feed was ordered by the slot index
// the client happened to observe eliminations in, not by placement.
test('feed reproduction: entries observed in slot order sort newest-first by placement', () => {
  const observedInSlotOrder = [
    { name: 'CPU Squall', placement: 11, observedOrder: 0 },
    { name: 'CPU Pixel', placement: 15, observedOrder: 1 },
    { name: 'CPU Marble', placement: 17, observedOrder: 2 },
    { name: 'CPU Junco', placement: 9, observedOrder: 3 },
  ];
  const ordered = sortFeedEntriesNewestFirst(observedInSlotOrder);
  assert.deepEqual(
    ordered.map((e) => e.name),
    ['CPU Junco', 'CPU Squall', 'CPU Pixel', 'CPU Marble'],
    'lowest placement (most recent elimination) must sort first regardless of observation order',
  );
});

test('sortFeedEntriesNewestFirst keeps the cap to the N most recent, not an arbitrary N', () => {
  const entries = [
    { name: 'A', placement: 20, observedOrder: 0 },
    { name: 'B', placement: 5, observedOrder: 1 },
    { name: 'C', placement: 12, observedOrder: 2 },
    { name: 'D', placement: 2, observedOrder: 3 },
    { name: 'E', placement: 18, observedOrder: 4 },
  ];
  const top3 = sortFeedEntriesNewestFirst(entries).slice(0, 3).map((e) => e.name);
  assert.deepEqual(top3, ['D', 'B', 'C'], 'the 3 lowest placements (most recent) must be kept, in newest-first order');
});

test('ties (or missing placement) fall back to most-recently-observed first, deterministically', () => {
  const entries = [
    { name: 'first-observed', placement: null, observedOrder: 0 },
    { name: 'second-observed', placement: null, observedOrder: 1 },
  ];
  const ordered = sortFeedEntriesNewestFirst(entries);
  assert.deepEqual(ordered.map((e) => e.name), ['second-observed', 'first-observed']);
});

test('the feed is sorted by true elimination order, not observation/slot order, and capped after sorting', () => {
  assert.match(hudSrc, /ELIMINATION_FEED_LIMIT/, 'hud.ts must cap the elimination feed length');
  assert.match(
    hudSrc,
    /sortFeedEntriesNewestFirst\(this\.feedEntries\)\.slice\(0,\s*ELIMINATION_FEED_LIMIT\)/,
    'the feed must be sorted by placement before the cap is applied, otherwise the cap keeps an arbitrary N again',
  );
});

test('show() resets the elimination feed so a rematch starts clean', () => {
  assert.match(
    hudSrc,
    /show\(\):\s*void\s*\{[^}]*seenEliminated\s*=\s*\[\][^}]*feedEntries\s*=\s*\[\][^}]*feedObservedCounter\s*=\s*0/s,
    "Hud.show() must clear seenEliminated/feedEntries/feedObservedCounter, otherwise a rematch would show the previous match's eliminations",
  );
});

test('the chip name element uses chipDisplayName, not the raw (possibly "CPU "-prefixed) name', () => {
  assert.match(hudSrc, /nameEl\.textContent\s*=\s*name\s*&&\s*name\.length\s*>\s*0\s*\?\s*chipDisplayName\(name\)/);
});

test('the match-status block gets real match settings on both online and local paths', () => {
  assert.match(mainSrc, /winCondition:\s*onlineSettings\.winCondition/, 'online hud.update() call must pass the real win condition');
  assert.match(mainSrc, /winCondition:\s*localSettings\.winCondition/, 'local hud.update() call must pass the real win condition');
});


test('objectiveLineText states a full sentence for each mode, derived from the same mode/win-condition text the sidebar already used', () => {
  assert.equal(objectiveLineText('battleRoyale'), 'Battle Royale: the last fighter standing wins.');
  assert.equal(
    objectiveLineText('timedKO'),
    'Timed Brawl: you respawn when knocked out, and most knockouts when the clock runs out wins.',
  );
  assert.equal(objectiveLineText('stocks'), 'Stocks: the last stock standing wins.');
});

test('koStandingLineText reports own KOs and rank, omitting the redundant leader clause when already 1st', () => {
  assert.equal(koStandingLineText(7, 1, 20, 7), '7 KOs \u00b7 1st of 20');
  assert.equal(koStandingLineText(3, 5, 20, 9), '3 KOs \u00b7 5th of 20 \u00b7 leader has 9 KOs');
  assert.equal(koStandingLineText(1, 1, 20, 1), '1 KO \u00b7 1st of 20');
});

test('the persistent objective line is derived from the mode via objectiveLineText, not hardcoded per call site', () => {
  assert.match(
    hudSrc,
    /matchModeLine\.textContent\s*=\s*objectiveLineText\(matchInfo\.winCondition[,)]/,
    'hud.ts must build the objective line from objectiveLineText(matchInfo.winCondition) so it can never drift from the sidebar mode/win-condition source of truth',
  );
});

test('the knockout standing line only shows for Timed Brawl (winCondition timedKO)', () => {
  assert.match(
    hudSrc,
    /if \(matchInfo\.winCondition === 'timedKO'[\s\S]*?koStandingLine\.style\.display = ''/,
    "koStandingLine must only be un-hidden inside a winCondition === 'timedKO' branch",
  );
});
