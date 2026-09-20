import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildStandings, tiedHeadline } from '../src/timed-brawl.ts';

const scores = [
  { slot: 0, koCount: 14, deathCount: 4 },
  { slot: 1, koCount: 14, deathCount: 4 },
  { slot: 2, koCount: 9, deathCount: 3 },
  { slot: 3, koCount: 0, deathCount: 6 },
];
const leaderboard = [0, 1, 2, 3];
const standings = buildStandings(leaderboard, scores);
const nameFor = (slot: number) => ['Fuzz', 'Grit', 'Wisp', 'Sweeper'][slot] as string;

// The defect this pins: a player who finished last was shown the headline
// "Time out - tied for first", the biggest text on the screen.
test('a tied headline never claims first place for a player who did not tie', () => {
  const headline = tiedHeadline(standings, 3, nameFor);
  assert.ok(!headline.includes('you'), headline);
  assert.equal(headline, 'Time out — Fuzz and Grit tied');
});

test('a tied headline says "you" when the player is one of the leaders', () => {
  assert.equal(tiedHeadline(standings, 0, nameFor), 'Time out — you tied for first');
});

test('three or more tied leaders collapse to a count', () => {
  const many = buildStandings([0, 1, 2], [
    { slot: 0, koCount: 3, deathCount: 1 },
    { slot: 1, koCount: 3, deathCount: 1 },
    { slot: 2, koCount: 3, deathCount: 1 },
  ]);
  assert.equal(tiedHeadline(many, 5, nameFor), 'Time out — Fuzz and 2 others tied');
});

test('a spectator with no slot still gets a truthful headline', () => {
  assert.equal(tiedHeadline(standings, undefined, nameFor), 'Time out — Fuzz and Grit tied');
});

const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
const hud = readFileSync(new URL('../src/ui/hud.ts', import.meta.url), 'utf8');
const tbEnd = readFileSync(new URL('../src/ui/timed-brawl-end-screen.ts', import.meta.url), 'utf8');
const winScreen = readFileSync(new URL('../src/ui/win-screen.ts', import.meta.url), 'utf8');

test('the connection chip stands down while an end screen is up', () => {
  assert.match(css, /body\.end-screen-open #net-status/);
  assert.match(tbEnd, /classList\.add\('end-screen-open'\)/);
  assert.match(tbEnd, /classList\.remove\('end-screen-open'\)/);
  assert.match(winScreen, /classList\.add\('end-screen-open'\)/);
  assert.match(winScreen, /classList\.remove\('end-screen-open'\)/);
});

test('Timed Brawl does not print the same clock twice', () => {
  assert.match(hud, /matchClockLine\.style\.display\s*=\s*matchInfo\.winCondition === 'timedKO' \? 'none' : ''/);
});
