// Human-analog match-measurement harness (2026-09-11, issue #31).
//
// PROBLEM: every offline harness we had before this one (full-sweep-metrics,
// bot-brawl-metrics, etc.) runs 20 bots, zero human seats. Every production
// match has at least one human seat. That gap is why the harness's 93%
// "timeout" reading (Task 28163) never happened live, and why
// elimination-cause splits measured offline have disagreed with production
// logs more than once. This harness does not fix that gap by assumption --
// it puts one seat under a deliberately imperfect controller ("human-analog"),
// measures it the same way production's own JSON log lines do, and reports
// the result side by side with real production data so the comparison is
// checkable rather than asserted. See docs/MEASUREMENT.md for the full
// writeup and the honest verdict on what this harness can and cannot stand
// in for.
//
// HUMAN-ANALOG CONTROLLER (explicit, documented, NOT the normal BotController):
// This is an approximation of an unskilled-to-average real player, not a
// model fit to data -- there is no source of raw human input traces to fit
// to. Parameters (all overridable via CLI flags, see below):
//   --reactionTicks=N   (default 10, ~166ms @60Hz) the controller only
//                        re-evaluates its target/decision every N ticks,
//                        holding its previous input in between -- a crude
//                        stand-in for human reaction latency. A real bot
//                        (BotController) re-decides every tick.
//   --aimJitter=F       (default 0.35) probability-weighted chance per
//                        decision that the controller picks a random
//                        direction/target instead of the "correct" one --
//                        stands in for imperfect aim/positioning.
//   --idleProb=F        (default 0.10) probability per decision window that
//                        the controller does nothing at all this window
//                        (no movement, no attack) -- stands in for a human
//                        who is looking at the minimap, distracted, or just
//                        not reacting.
//   --attackProb=F      (default 0.12) chance per active decision window
//                        the controller throws an attack, versus BotController's
//                        tuned-for-combat-share attack cadence.
// These numbers are guesses calibrated only to "clearly worse than
// BotController on every axis", not to any measured human population --
// say so in any report that cites this harness's absolute numbers, and lean
// on the harness-vs-production comparison table for whether that guess is
// even in the right neighborhood, not on the numbers alone.
//
// USAGE:
//   node --experimental-strip-types scripts/human-analog-metrics.mjs [trials] [difficulty] [ceilingTicks] [flags]
//   node --experimental-strip-types scripts/human-analog-metrics.mjs 30 easy 36000 --reactionTicks=10 --aimJitter=0.35 --idleProb=0.10 --attackProb=0.12
//
// Output: JSON to stdout (per-run rows + aggregated distributions), see
// bottom of file for shape. Uses createMatchSim (packages/content/src/match-sim.ts),
// the one sanctioned Sim builder, so the item set, hazard config and arena
// resolution match production exactly, not a hand-picked subset.
import { createMatchSim } from '../packages/content/src/match-sim.ts';
import { assignServerCharacters } from './lib/bot-character-assignment.mjs';
import { BotController, BotDifficulty, deriveBotSeed } from '../packages/sim/src/ai/bot.ts';
import { pickArenaId } from '../packages/content/src/arenas.ts';
import * as fx from '../packages/sim/src/math/fixed.ts';
import { mulberry32, makeHumanAnalogController } from './lib/human-analog-controller.mjs';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const a of argv) {
    const m = /^--([a-zA-Z]+)=(.+)$/.exec(a);
    if (m) flags[m[1]] = Number(m[2]);
    else positional.push(a);
  }
  return { positional, flags };
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const TRIALS = parseInt(positional[0] || '20', 10);
const diffArg = (positional[1] || 'easy').toUpperCase();
const difficulty = BotDifficulty[diffArg] ?? BotDifficulty.EASY;
// default: production shrinkFullyClosedTick (28800) + the ~2min stalemate-
// override relax window + margin (see full-sweep-metrics.mjs's own
// MIN_SAFE_CEIL warning -- a lower ceiling here previously made this
// harness read almost every match as a false 'timeout', an artifact of
// the harness's own ceiling rather than the game. Verified: at 28920 this
// harness saw ~100% timeouts; at 36000 matches resolve normally.
const TICKS_CEILING = parseInt(positional[2] || '36000', 10);
const N = 20;
const HUMAN_SLOT = 0;

const PARAMS = {
  reactionTicks: flags.reactionTicks ?? 10,
  aimJitter: flags.aimJitter ?? 0.35,
  idleProb: flags.idleProb ?? 0.10,
  attackProb: flags.attackProb ?? 0.12,
};

function runOneTrial(seed) {
  const arenaId = pickArenaId(seed);
  // Diagnosed 2026-09-11 (see docs/MEASUREMENT.md): passing `undefined`
  // here silently resolved to packages/sim's internal DEFAULT_CHARACTER
  // (moves: []) for every seat, so no fighter -- human-analog or bot --
  // could ever land a hit. Build the same per-seat roster the real
  // server does instead (mirrors server/src/rooms.ts's startBotFillTimer).
  const protectedSlots = new Set([HUMAN_SLOT]);
  const characters = assignServerCharacters(seed, N, protectedSlots);
  const sim = createMatchSim(seed, N, {}, characters, arenaId);
  const bots = [];
  for (let i = 1; i < N; i++) {
    bots.push(new BotController(i, difficulty, deriveBotSeed(seed, i), protectedSlots));
  }
  const rand = mulberry32(seed ^ 0x51ed270b);
  const humanInput = makeHumanAnalogController(rand, HUMAN_SLOT, PARAMS);

  let humanEliminatedAtTick = null;
  let humanDamageAtElimination = null;
  let humanCause = null;
  let firstEliminationTick = null; // time-to-first-elimination, any fighter
  const causeCounts = { fall: 0, knockout: 0, ring: 0, ring_lethal: 0 };
  const percentAtDeath = [];

  for (let t = 0; t < TICKS_CEILING; t++) {
    const inputs = [humanInput(sim)];
    for (const b of bots) inputs.push(b.nextInput(sim));
    sim.advance(inputs);

    for (const ev of sim.eliminationEvents) {
      if (firstEliminationTick === null) firstEliminationTick = t;
      causeCounts[ev.cause] = (causeCounts[ev.cause] || 0) + 1;
      percentAtDeath.push(Number(fx.toFloat(ev.percentAtDeath).toFixed(1)));
      if (ev.fighterIndex === HUMAN_SLOT && humanEliminatedAtTick === null) {
        humanEliminatedAtTick = t;
        humanDamageAtElimination = Number(fx.toFloat(ev.percentAtDeath).toFixed(1));
        humanCause = ev.cause;
      }
    }

    if (sim.isMatchOver()) {
      const human = sim.getFighter(HUMAN_SLOT);
      return {
        seed, arenaId,
        matchDurationSec: Number((t / 60).toFixed(1)),
        humanPlacement: human.placement, // 1 = winner, N = first out
        humanEliminatedAtSec: humanEliminatedAtTick === null ? null : Number((humanEliminatedAtTick / 60).toFixed(1)),
        humanDamageAtElimination,
        humanCause,
        timeToFirstEliminationSec: firstEliminationTick === null ? null : Number((firstEliminationTick / 60).toFixed(1)),
        causeCounts,
        percentAtDeath,
        timedOut: false,
      };
    }
  }
  // Ceiling hit with no resolution -- report honestly, do not synthesize a placement.
  const human = sim.getFighter(HUMAN_SLOT);
  return {
    seed, arenaId,
    matchDurationSec: Number((TICKS_CEILING / 60).toFixed(1)),
    humanPlacement: human.eliminated ? human.placement : null,
    humanEliminatedAtSec: humanEliminatedAtTick === null ? null : Number((humanEliminatedAtTick / 60).toFixed(1)),
    humanDamageAtElimination,
    humanCause,
    timeToFirstEliminationSec: firstEliminationTick === null ? null : Number((firstEliminationTick / 60).toFixed(1)),
    causeCounts,
    percentAtDeath,
    timedOut: true,
  };
}

console.log('=== Human-analog harness parameters (issue #31) ===');
console.log(JSON.stringify({ trials: TRIALS, difficulty: diffArg, ticksCeiling: TICKS_CEILING, ...PARAMS }));

const results = [];
for (let trial = 0; trial < TRIALS; trial++) {
  const seed = 810001 + trial * 5087;
  results.push(runOneTrial(seed));
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return null;
  const idx = Math.min(sortedArr.length - 1, Math.floor(p * sortedArr.length));
  return sortedArr[idx];
}

const durations = results.map((r) => r.matchDurationSec).sort((a, b) => a - b);
const placements = results.map((r) => r.humanPlacement).filter((p) => p !== null).sort((a, b) => a - b);
const timeouts = results.filter((r) => r.timedOut).length;
const ttfe = results.map((r) => r.timeToFirstEliminationSec).filter((x) => x !== null).sort((a, b) => a - b);

const aggCauseCounts = { fall: 0, knockout: 0, ring: 0, ring_lethal: 0 };
const allPercentAtDeath = [];
for (const r of results) {
  for (const k of Object.keys(aggCauseCounts)) aggCauseCounts[k] += r.causeCounts[k] || 0;
  allPercentAtDeath.push(...r.percentAtDeath);
}
const totalElims = Object.values(aggCauseCounts).reduce((a, b) => a + b, 0);
const causeSplitPct = Object.fromEntries(
  Object.entries(aggCauseCounts).map(([k, v]) => [k, totalElims ? Number(((100 * v) / totalElims).toFixed(1)) : null])
);
allPercentAtDeath.sort((a, b) => a - b);

const humanEliminatedSecs = results.map((r) => r.humanEliminatedAtSec).filter((x) => x !== null).sort((a, b) => a - b);

console.log('\nJSON_SUMMARY_START');
console.log(JSON.stringify({
  params: { trials: TRIALS, difficulty: diffArg, ticksCeiling: TICKS_CEILING, ...PARAMS },
  matchDurationSec: {
    min: durations[0] ?? null, median: percentile(durations, 0.5), max: durations[durations.length - 1] ?? null,
  },
  timeouts, timeoutPct: Number(((100 * timeouts) / TRIALS).toFixed(1)),
  humanPlacementDistribution: placements,
  humanPlacementMedian: percentile(placements, 0.5),
  humanPlacementMean: placements.length ? Number((placements.reduce((a, b) => a + b, 0) / placements.length).toFixed(2)) : null,
  timeToFirstEliminationSec: {
    min: ttfe[0] ?? null, median: percentile(ttfe, 0.5), max: ttfe[ttfe.length - 1] ?? null,
  },
  humanEliminatedAtSec: {
    min: humanEliminatedSecs[0] ?? null, median: percentile(humanEliminatedSecs, 0.5), max: humanEliminatedSecs[humanEliminatedSecs.length - 1] ?? null,
    count: humanEliminatedSecs.length, of: TRIALS,
  },
  eliminationCauseCounts: aggCauseCounts,
  eliminationCauseSplitPct: causeSplitPct,
  percentAtDeathDistribution: {
    min: allPercentAtDeath[0] ?? null,
    p25: percentile(allPercentAtDeath, 0.25),
    median: percentile(allPercentAtDeath, 0.5),
    p75: percentile(allPercentAtDeath, 0.75),
    max: allPercentAtDeath[allPercentAtDeath.length - 1] ?? null,
    n: allPercentAtDeath.length,
  },
  perTrial: results,
}, null, 2));
console.log('JSON_SUMMARY_END');
