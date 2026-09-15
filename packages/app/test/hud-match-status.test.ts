// Regression coverage for the match-status block added below the chip
// grid 2026-09-14 (previously permanently empty dead space in the
// sidebar on every match, see wiki "Camera Framing" era layout docs).
// No jsdom in this repo, so DOM wiring is pinned by source inspection
// (same convention as hud-survivors.test.ts); the text-formatting
// helpers get real unit tests since they're pure functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { modeLabelText, winConditionText, eliminationFeedLine } from '../src/ui/hud-text.ts';

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

test('the elimination feed is capped so 20 fighters dying in ~90s never becomes a wall of text', () => {
  assert.match(hudSrc, /ELIMINATION_FEED_LIMIT/, 'hud.ts must cap the elimination feed length');
  assert.match(hudSrc, /feedLines\.length\s*=\s*Math\.min\(this\.feedLines\.length,\s*ELIMINATION_FEED_LIMIT\)/,
    'the feed array itself must be trimmed, not just visually clipped');
});

test('show() resets the elimination feed so a rematch starts clean', () => {
  assert.match(hudSrc, /show\(\):\s*void\s*\{[^}]*seenEliminated\s*=\s*\[\][^}]*feedLines\s*=\s*\[\]/s,
    'Hud.show() must clear seenEliminated/feedLines, otherwise a rematch would show the previous match\'s eliminations');
});

test('the match-status block gets real match settings on both online and local paths', () => {
  assert.match(mainSrc, /winCondition:\s*onlineSettings\.winCondition/, 'online hud.update() call must pass the real win condition');
  assert.match(mainSrc, /winCondition:\s*localSettings\.winCondition/, 'local hud.update() call must pass the real win condition');
});
