// First-match knockout boost measurement (2026-09-26).
//
// Question: does a novice ("human-analog" controller, default params) in
// a 20-fighter Timed Brawl on the default stage land >=1 KO in the first
// 60s, and does the rookie knockback boost change that without making the
// novice out-KO the median bot? Bots run EASY and protect the human slot,
// exactly as the production server configures them.
//
// USAGE:
//   node --experimental-strip-types scripts/rookie-ko-metrics.mjs [trials] [scale...]
//   node --experimental-strip-types scripts/rookie-ko-metrics.mjs 20 1 1.5 2
import { createMatchSim } from '../packages/content/src/match-sim.ts';
import { DEFAULT_ARENA_ID } from '../packages/content/src/arenas.ts';
import { assignServerCharacters } from './lib/bot-character-assignment.mjs';
import { mulberry32, makeHumanAnalogController } from './lib/human-analog-controller.mjs';
import { BotController, BotDifficulty, deriveBotSeed } from '../packages/sim/src/ai/bot.ts';
import * as fx from '../packages/sim/src/math/fixed.ts';

const N = 20;
const HUMAN_SLOT = 0;
const WINDOW_TICKS = 60 * 60;
const PARAMS = { reactionTicks: 10, aimJitter: 0.35, idleProb: 0.1, attackProb: 0.12 };
const trials = parseInt(process.argv[2] || '20', 10);
const scales = process.argv.slice(3).map(Number);
if (scales.length === 0) scales.push(1);

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

function runTrial(seed, scale) {
  const protectedSlots = new Set([HUMAN_SLOT]);
  const characters = assignServerCharacters(seed, N, protectedSlots);
  const botSlots = [];
  for (let i = 1; i < N; i++) botSlots.push(i);
  const sim = createMatchSim(seed, N, {
    winCondition: 'timedKO',
    timeLimitTicks: 60 * 60 * 3,
    rookieSlots: [HUMAN_SLOT],
    botSlots,
    rookieKnockbackScale: fx.fromFloat(scale),
  }, characters, DEFAULT_ARENA_ID);
  const bots = botSlots.map((i) => new BotController(i, BotDifficulty.EASY, deriveBotSeed(seed, i), protectedSlots));
  const humanInput = makeHumanAnalogController(mulberry32(seed ^ 0x51ed270b), HUMAN_SLOT, PARAMS);
  let firstKoSec = null;
  for (let t = 0; t < WINDOW_TICKS && !sim.isMatchOver(); t++) {
    const inputs = [humanInput(sim)];
    for (const b of bots) inputs.push(b.nextInput(sim));
    sim.advance(inputs);
    if (firstKoSec === null && sim.getFighter(HUMAN_SLOT).koCount > 0) firstKoSec = t / 60;
  }
  const botKos = botSlots.map((i) => sim.getFighter(i).koCount);
  const humanKos60 = sim.getFighter(HUMAN_SLOT).koCount;
  for (let t = WINDOW_TICKS; !sim.isMatchOver(); t++) {
    const inputs = [humanInput(sim)];
    for (const b of bots) inputs.push(b.nextInput(sim));
    sim.advance(inputs);
  }
  const botKosFull = botSlots.map((i) => sim.getFighter(i).koCount);
  return {
    humanKosFull: sim.getFighter(HUMAN_SLOT).koCount,
    medianBotKosFull: median(botKosFull),
    meanBotKos: botKos.reduce((a, b) => a + b, 0) / botKos.length,
    maxBotKosFull: Math.max(...botKosFull),
    humanKos: humanKos60,
    humanDeaths: sim.getFighter(HUMAN_SLOT).deathCount,
    medianBotKos: median(botKos),
    maxBotKos: Math.max(...botKos),
    firstKoSec,
  };
}

const rows = [];
for (const scale of scales) {
  const runs = [];
  for (let k = 0; k < trials; k++) runs.push(runTrial(910001 + k * 7919, scale));
  const withKo = runs.filter((r) => r.humanKos >= 1).length;
  rows.push({
    scale,
    trials,
    pctWithKoIn60s: Number(((100 * withKo) / trials).toFixed(1)),
    trialsHumanAboveMedianBot: runs.filter((r) => r.humanKos > r.medianBotKos).length,
    meanHumanKos: Number((runs.reduce((a, r) => a + r.humanKos, 0) / trials).toFixed(2)),
    medianHumanKos: median(runs.map((r) => r.humanKos)),
    medianOfMedianBotKos: median(runs.map((r) => r.medianBotKos)),
    meanBotKos: Number((runs.reduce((a, r) => a + r.meanBotKos, 0) / trials).toFixed(2)),
    trialsHumanAboveTopBot: runs.filter((r) => r.humanKos > r.maxBotKos).length,
    fullMatchMeanMaxBotKos: Number((runs.reduce((a, r) => a + r.maxBotKosFull, 0) / trials).toFixed(2)),
    meanMaxBotKos: Number((runs.reduce((a, r) => a + r.maxBotKos, 0) / trials).toFixed(2)),
    medianFirstKoSec: withKo ? Number(median(runs.filter((r) => r.firstKoSec !== null).map((r) => r.firstKoSec)).toFixed(1)) : null,
    fullMatchMeanHumanKos: Number((runs.reduce((a, r) => a + r.humanKosFull, 0) / trials).toFixed(2)),
    fullMatchMedianOfMedianBotKos: median(runs.map((r) => r.medianBotKosFull)),
    fullMatchTrialsHumanAboveMedianBot: runs.filter((r) => r.humanKosFull > r.medianBotKosFull).length,
    meanHumanDeaths: Number((runs.reduce((a, r) => a + r.humanDeaths, 0) / trials).toFixed(2)),
  });
  console.log(JSON.stringify(rows[rows.length - 1]));
}
