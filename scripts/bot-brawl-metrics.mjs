// Headless 20-bot match metrics harness. Run via:
//   node --experimental-strip-types scripts/bot-brawl-metrics.mjs [difficulty] [ticks]
// Measures: damage/sec, mean pairwise distance (clumping), target-switch
// rate (approximated via distance-to-nearest-opponent volatility is not
// tracked inside bot.ts publicly, so we track "engagement pairs" instead),
// self-destructs/falls, match duration. Deterministic (fixed seed).
import { Sim } from '../packages/sim/src/sim.ts';
import { BotController, BotDifficulty, deriveBotSeed } from '../packages/sim/src/ai/bot.ts';
import * as fx from '../packages/sim/src/math/fixed.ts';
import { assignServerCharacters } from './lib/bot-character-assignment.mjs';

const diffArg = (process.argv[2] || 'hard').toUpperCase();
const TICKS = parseInt(process.argv[3] || '10800', 10); // 3 min @ 60hz
const N = 20;
const SEED = 424242;
const difficulty = BotDifficulty[diffArg] ?? BotDifficulty.HARD;

// FIX (see docs/MEASUREMENT.md and wiki "Resolution Guarantee and Harness
// Trust"): this used to call `new Sim(SEED, N)` with no character roster,
// which silently resolves every seat to DEFAULT_CHARACTER (moves: []) --
// bots that can move and take damage but can never land a hit. Build the
// same production-faithful roster server/src/rooms.ts draws.
const characters = assignServerCharacters(SEED, N);
const moveless = characters.filter((c) => !c.moves || c.moves.length === 0);
if (moveless.length > 0) {
  console.error(`FATAL: ${moveless.length}/${N} assigned characters have no moves -- refusing to report a measurement that would silently reproduce the moveless-bot bug.`);
  process.exit(1);
}
const sim = new Sim(SEED, N, characters);
const bots = Array.from({ length: N }, (_, i) => new BotController(i, difficulty, deriveBotSeed(SEED, i)));

let totalDamageDealt = 0;
let lastPercents = new Array(N).fill(0);
let stockLossesByFall = 0; // eliminated tick while velY<0 offstage roughly
let lastStocks = new Array(N).fill(3);
let distanceSampleSum = 0;
let distanceSampleCount = 0;
let matchOverTick = -1;

for (let t = 0; t < TICKS; t++) {
  const inputs = bots.map((b) => b.nextInput(sim));
  sim.advance(inputs);

  // Damage tracking
  for (let i = 0; i < N; i++) {
    const f = sim.getFighter(i);
    const pct = fx.toFloat(f.percent);
    if (pct >= lastPercents[i]) totalDamageDealt += pct - lastPercents[i];
    lastPercents[i] = pct;
    if (f.stocks < lastStocks[i]) {
      stockLossesByFall += lastStocks[i] - f.stocks;
      lastStocks[i] = f.stocks;
      lastPercents[i] = 0;
    }
  }

  // Clumping: mean pairwise distance among alive fighters, sampled every 30 ticks
  if (t % 30 === 0) {
    const alive = [];
    for (let i = 0; i < N; i++) {
      const f = sim.getFighter(i);
      if (!f.eliminated) alive.push(f);
    }
    if (alive.length >= 2) {
      let sum = 0, cnt = 0;
      for (let i = 0; i < alive.length; i++) {
        for (let j = i + 1; j < alive.length; j++) {
          const dx = fx.toFloat(fx.sub(alive[i].posX, alive[j].posX));
          const dy = fx.toFloat(fx.sub(alive[i].posY, alive[j].posY));
          sum += Math.sqrt(dx * dx + dy * dy);
          cnt++;
        }
      }
      distanceSampleSum += sum / cnt;
      distanceSampleCount++;
    }
  }

  if (matchOverTick < 0 && sim.isMatchOver && sim.isMatchOver()) {
    matchOverTick = t;
    break;
  }
}

const durationTicks = matchOverTick >= 0 ? matchOverTick : TICKS;
const durationSec = durationTicks / 60;
console.log(JSON.stringify({
  difficulty: diffArg,
  ticksRun: durationTicks,
  matchDurationSec: Number(durationSec.toFixed(1)),
  matchEnded: matchOverTick >= 0,
  totalDamageDealt: Number(totalDamageDealt.toFixed(1)),
  damagePerSec: Number((totalDamageDealt / durationSec).toFixed(2)),
  meanPairwiseDistance: Number((distanceSampleSum / Math.max(1, distanceSampleCount)).toFixed(2)),
  stockLossesTotal: stockLossesByFall,
}, null, 2));
