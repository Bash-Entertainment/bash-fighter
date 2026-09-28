// Adapted from rookie-ko-metrics.mjs (2026-09-26) for the 90s Timed Brawl
// length (was 180s / 60s window). Also fixes a param-name bug: createMatchSim
// takes `rookieScales` (parallel array to rookieSlots), not
// `rookieKnockbackScale` -- the original script's scale argument was
// silently ignored after the taper refactor (56b0903).
//
// USAGE: node --experimental-strip-types scripts/timed-brawl-90s-metrics.mjs [trials] [scale]
import { createMatchSim } from '../packages/content/src/match-sim.ts';
import { DEFAULT_ARENA_ID } from '../packages/content/src/arenas.ts';
import { assignServerCharacters } from './lib/bot-character-assignment.mjs';
import { mulberry32, makeHumanAnalogController } from './lib/human-analog-controller.mjs';
import { BotController, BotDifficulty, deriveBotSeed } from '../packages/sim/src/ai/bot.ts';
import * as fx from '../packages/sim/src/math/fixed.ts';
import { TIMED_BRAWL_TIME_LIMIT_TICKS } from '../server/src/mode-rotation.ts';

const N = 20;
const HUMAN_SLOT = 0;
const TICKS_90S = TIMED_BRAWL_TIME_LIMIT_TICKS; // 5400 @ 90s
const PARAMS = { reactionTicks: 10, aimJitter: 0.35, idleProb: 0.1, attackProb: 0.12 };
const trials = parseInt(process.argv[2] || '20', 10);
const scale = Number(process.argv[3] || '1.75');

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

function runTrial(seed) {
  const protectedSlots = new Set([HUMAN_SLOT]);
  const characters = assignServerCharacters(seed, N, protectedSlots);
  const botSlots = [];
  for (let i = 1; i < N; i++) botSlots.push(i);
  const sim = createMatchSim(seed, N, {
    winCondition: 'timedKO',
    timeLimitTicks: TICKS_90S,
    rookieSlots: [HUMAN_SLOT],
    botSlots,
    rookieScales: [fx.fromFloat(scale)],
  }, characters, DEFAULT_ARENA_ID);
  const bots = botSlots.map((i) => new BotController(i, BotDifficulty.EASY, deriveBotSeed(seed, i), protectedSlots));
  const humanInput = makeHumanAnalogController(mulberry32(seed ^ 0x51ed270b), HUMAN_SLOT, PARAMS);
  let resolvedAtTick = null;
  let t = 0;
  const HARD_CAP = 60 * 60 * 10; // safety cap, 10 min
  for (; t < HARD_CAP; t++) {
    if (sim.isMatchOver()) { resolvedAtTick = t; break; }
    const inputs = [humanInput(sim)];
    for (const b of bots) inputs.push(b.nextInput(sim));
    sim.advance(inputs);
  }
  const allKos = Array.from({ length: N }, (_, i) => sim.getFighter(i).koCount);
  const botKos = botSlots.map((i) => sim.getFighter(i).koCount);
  return {
    resolvedAtTick,
    resolvedAt90: resolvedAtTick !== null && resolvedAtTick <= TICKS_90S + 1,
    humanKos: sim.getFighter(HUMAN_SLOT).koCount,
    maxBotKos: Math.max(...botKos),
    totalKos: allKos.reduce((a, b) => a + b, 0),
  };
}

const runs = [];
for (let k = 0; k < trials; k++) runs.push(runTrial(910001 + k * 7919));
const withKo = runs.filter((r) => r.humanKos >= 1).length;
console.log(JSON.stringify({
  trials,
  scale,
  windowSec: 90,
  allResolvedAt90: runs.every((r) => r.resolvedAt90),
  pctResolvedAt90: Number(((100 * runs.filter(r=>r.resolvedAt90).length)/trials).toFixed(1)),
  pctNoviceWithKo: Number(((100 * withKo) / trials).toFixed(1)),
  meanNoviceKos: Number((runs.reduce((a, r) => a + r.humanKos, 0) / trials).toFixed(2)),
  meanTopBotKos: Number((runs.reduce((a, r) => a + r.maxBotKos, 0) / trials).toFixed(2)),
  meanTotalKosPerMatch: Number((runs.reduce((a, r) => a + r.totalKos, 0) / trials).toFixed(2)),
  resolvedTicks: runs.map(r => r.resolvedAtTick),
}, null, 2));
