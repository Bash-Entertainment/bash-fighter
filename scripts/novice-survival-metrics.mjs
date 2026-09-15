// Headless novice-survival harness -- see the task that produced this
// file: "First-Match Experience Problem", the most important defect the
// game had as of 2026-09-08. Measures how long a passive/mediocre human
// player survives a 20-fighter EASY match, as a repeatable proxy for
// "is easy actually easy".
//
// The novice input source (fighter slot 0) is intentionally dumb: it does
// not chase, does not read the arena shrink, and does not react to danger.
// It stands roughly still, drifts a little, and presses attack rarely.
// This is a *fair* proxy for a first-time player who hasn't learned
// anything about the game yet -- it is not a strawman that is impossible
// to keep alive; it is deliberately the worst realistic case: someone who
// clicked Play and is still finding the keys.
//
// Run via:
//   node --experimental-strip-types scripts/novice-survival-metrics.mjs [difficulty] [trials]
import { Sim } from '../packages/sim/src/sim.ts';
import { BotController, BotDifficulty, deriveBotSeed } from '../packages/sim/src/ai/bot.ts';
import { BUTTON_ATTACK, BUTTON_JUMP, makeInputFrame } from '../packages/sim/src/types.ts';
import * as fx from '../packages/sim/src/math/fixed.ts';
import { assignServerCharacters } from './lib/bot-character-assignment.mjs';

const diffArg = (process.argv[2] || 'easy').toUpperCase();
const TRIALS = parseInt(process.argv[3] || '15', 10);
const TICKS_CEILING = 21600; // 6 min @ 60hz -- generous, matches never run this long
const N = 20;
const NOVICE_SLOT = 0;
const difficulty = BotDifficulty[diffArg] ?? BotDifficulty.EASY;

// Simple deterministic PRNG local to this script (not the sim's, doesn't
// need to be -- the novice source is presentation of "a bad player", not
// part of the sim's own determinism-tested surface).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let noviceDriftDir = 0;
function noviceInput(rand) {
  const frame = makeInputFrame();
  // A mediocre-but-active player: wanders around fairly continuously
  // (unlike a frozen player, this one walks into the open and into other
  // fighters' space -- exactly what gets a newcomer caught by more than
  // one opponent at once), doesn't shield or aim, and swings without
  // reading who's around. Not a strawman that stands safely in a corner.
  if (rand() < 0.08) noviceDriftDir = rand() < 0.5 ? -1 : rand() < 0.9 ? 1 : 0;
  if (noviceDriftDir !== 0) frame.stickX = noviceDriftDir > 0 ? fx.ONE : -fx.ONE;
  if (rand() < 0.01) frame.buttons |= BUTTON_JUMP; // occasional aimless jump
  if (rand() < 0.05) frame.buttons |= BUTTON_ATTACK;
  return frame;
}

function runOneTrial(seed) {
  // FIX (see docs/MEASUREMENT.md, wiki "Resolution Guarantee and Harness
  // Trust"): `new Sim(seed, N)` with no roster silently resolves every
  // bot to moveless DEFAULT_CHARACTER -- bots that can never land a hit,
  // meaning this harness could never have measured "is easy actually
  // easy" against real combat, only against the ring/falls.
  const characters = assignServerCharacters(seed, N, new Set([NOVICE_SLOT]));
  const moveless = characters.filter((c) => !c.moves || c.moves.length === 0);
  if (moveless.length > 0) {
    console.error(`FATAL: ${moveless.length}/${N} assigned characters have no moves -- refusing to report a measurement that would silently reproduce the moveless-bot bug.`);
    process.exit(1);
  }
  const sim = new Sim(seed, N, characters);
  const protectedSlots = new Set([NOVICE_SLOT]);
  const bots = [];
  for (let i = 1; i < N; i++) {
    bots.push(new BotController(i, difficulty, deriveBotSeed(seed, i), protectedSlots));
  }
  const rand = mulberry32(seed ^ 0x51ed270b);
  for (let t = 0; t < TICKS_CEILING; t++) {
    const inputs = [noviceInput(rand)];
    for (const b of bots) inputs.push(b.nextInput(sim));
    sim.advance(inputs);
    const novice = sim.getFighter(NOVICE_SLOT);
    if (novice.eliminated) {
      return { survivedTicks: t, matchOver: false };
    }
    if (sim.isMatchOver && sim.isMatchOver()) {
      return { survivedTicks: t, matchOver: true }; // novice survived to the end
    }
  }
  return { survivedTicks: TICKS_CEILING, matchOver: false }; // hit ceiling, never eliminated
}

const results = [];
for (let trial = 0; trial < TRIALS; trial++) {
  const seed = 900001 + trial * 7919;
  results.push(runOneTrial(seed));
}

const survivalSecs = results.map((r) => Number((r.survivedTicks / 60).toFixed(2))).sort((a, b) => a - b);
const median = survivalSecs[Math.floor(survivalSecs.length / 2)];
const survivedToEnd = results.filter((r) => r.matchOver).length;

console.log(JSON.stringify({
  difficulty: diffArg,
  trials: TRIALS,
  survivalSecs,
  medianSurvivalSec: median,
  meanSurvivalSec: Number((survivalSecs.reduce((a, b) => a + b, 0) / survivalSecs.length).toFixed(2)),
  minSurvivalSec: survivalSecs[0],
  maxSurvivalSec: survivalSecs[survivalSecs.length - 1],
  trialsSurvivedToMatchEnd: survivedToEnd,
}, null, 2));
