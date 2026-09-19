import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTimedBrawl, ticksRemaining, formatClock, buildStandings, placementOf, koStandingInfo } from '../src/timed-brawl.ts';

test('isTimedBrawl only true for winCondition timedKO', () => {
  assert.equal(isTimedBrawl({ winCondition: 'timedKO' }), true);
  assert.equal(isTimedBrawl({ winCondition: 'battleRoyale' }), false);
  assert.equal(isTimedBrawl({ winCondition: 'stocks' }), false);
  assert.equal(isTimedBrawl(null), false);
  assert.equal(isTimedBrawl(undefined), false);
});

test('ticksRemaining floors at 0 and never goes negative', () => {
  assert.equal(ticksRemaining(100, { timeLimitTicks: 600 }), 500);
  assert.equal(ticksRemaining(600, { timeLimitTicks: 600 }), 0);
  assert.equal(ticksRemaining(700, { timeLimitTicks: 600 }), 0);
});

test('formatClock renders M:SS with zero-padded seconds', () => {
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(60), '0:01');
  assert.equal(formatClock(65 * 60), '1:05');
  assert.equal(formatClock(59 * 60), '0:59');
  assert.equal(formatClock(1), '0:01', 'rounds up so the clock never reads 0:00 while ticks remain');
});

test('formatClock never goes negative on a small overshoot', () => {
  assert.equal(formatClock(-5), '0:00');
});

test('buildStandings assigns 1-based place in leaderboard order', () => {
  const scores = [
    { slot: 0, koCount: 3, deathCount: 1 },
    { slot: 1, koCount: 5, deathCount: 0 },
    { slot: 2, koCount: 1, deathCount: 4 },
  ];
  const standings = buildStandings([1, 0, 2], scores);
  assert.deepEqual(
    standings.map((s) => [s.slot, s.place]),
    [
      [1, 1],
      [0, 2],
      [2, 3],
    ],
  );
});

test('buildStandings shares a place across a tie in koCount and deathCount', () => {
  const scores = [
    { slot: 0, koCount: 2, deathCount: 1 },
    { slot: 1, koCount: 2, deathCount: 1 },
    { slot: 2, koCount: 0, deathCount: 3 },
  ];
  const standings = buildStandings([0, 1, 2], scores);
  assert.deepEqual(
    standings.map((s) => s.place),
    [1, 1, 3],
    'tied fighters share the same place number and the next distinct score resumes at the true rank',
  );
});

test('buildStandings tolerates a missing score (defaults to 0/0) rather than throwing', () => {
  const standings = buildStandings([0, 1], [{ slot: 0, koCount: 2, deathCount: 0 }]);
  assert.equal(standings[1]?.koCount, 0);
  assert.equal(standings[1]?.deathCount, 0);
});

test('placementOf finds the place for a given slot', () => {
  const standings = buildStandings([2, 0, 1], [
    { slot: 0, koCount: 1, deathCount: 0 },
    { slot: 1, koCount: 0, deathCount: 0 },
    { slot: 2, koCount: 2, deathCount: 0 },
  ]);
  assert.equal(placementOf(standings, 0), 2);
  assert.equal(placementOf(standings, 2), 1);
  assert.equal(placementOf(standings, 99), null);
});

test('koStandingInfo reports own KOs, own rank with ties, and the leader\'s count', () => {
  const scores = [
    { slot: 0, koCount: 5, deathCount: 1 },
    { slot: 1, koCount: 5, deathCount: 1 }, // tied with slot 0
    { slot: 2, koCount: 7, deathCount: 0 }, // leader
    { slot: 3, koCount: 1, deathCount: 3 },
  ];
  const leader = koStandingInfo(scores, 2);
  assert.deepEqual(leader, { ownKo: 7, ownRank: 1, totalFighters: 4, leaderKo: 7 });

  const tiedA = koStandingInfo(scores, 0);
  const tiedB = koStandingInfo(scores, 1);
  assert.deepEqual(tiedA, { ownKo: 5, ownRank: 2, totalFighters: 4, leaderKo: 7 });
  assert.deepEqual(tiedB, { ownKo: 5, ownRank: 2, totalFighters: 4, leaderKo: 7 }, 'ties share the same rank');

  const last = koStandingInfo(scores, 3);
  assert.deepEqual(last, { ownKo: 1, ownRank: 4, totalFighters: 4, leaderKo: 7 });
});

test('koStandingInfo returns null for an out-of-range slot', () => {
  const scores = [{ slot: 0, koCount: 1, deathCount: 0 }];
  assert.equal(koStandingInfo(scores, -1), null);
  assert.equal(koStandingInfo(scores, 5), null);
});
