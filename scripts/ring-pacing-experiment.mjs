// Ring-pacing attribution experiment (2026-09-09 task item 2): does
// delaying/lengthening the shrink clock (shrinkFullyClosedTick) alone
// raise combat share because fights get time to resolve, or does the
// match simply get longer with the same ending? Isolated change: only
// shrinkFullyClosedTick varies; everything else (population-aware safe
// extents, bot tuning) is untouched.
import { Sim } from '../packages/sim/src/sim.ts';
import { BotController, BotDifficulty, deriveBotSeed } from '../packages/sim/src/ai/bot.ts';
import { ALL_ARENAS } from '../packages/content/src/arenas.ts';
import * as fx from '../packages/sim/src/math/fixed.ts';
import { PRODUCTION_DEFAULT_BOT_DIFFICULTY_NAME } from '../server/src/match-defaults.ts';
import { assignServerCharacters } from './lib/bot-character-assignment.mjs';

// Task #28195: defaults to production's real bot difficulty (see
// server/src/match-defaults.ts) instead of the hardcoded HARD this
// script originally shipped with, so this experiment's own numbers are
// comparable to what a live player actually experiences. Override with a
// 3rd CLI arg.
const N = 20;
const SEEDS = parseInt(process.argv[2] || '6', 10);
const diffArg = (process.argv[3] || PRODUCTION_DEFAULT_BOT_DIFFICULTY_NAME).toUpperCase();
const DIFFICULTY = BotDifficulty[diffArg] ?? BotDifficulty.MEDIUM;
const CEIL = 48000; // 800s, generous
const BASE = 60 * 60 * 4; // default 4min
const VARIANTS = [
  ['baseline-4min', BASE],
  ['1.5x-6min', Math.round(BASE * 1.5)],
  ['2x-8min', BASE * 2],
];

function runMatch(arena, seed, shrinkFullyClosedTick) {
  // FIX (see docs/MEASUREMENT.md, wiki "Resolution Guarantee and Harness
  // Trust"): `undefined` silently resolves every seat to moveless
  // DEFAULT_CHARACTER; the old damage-heuristic classifier below has also
  // been replaced with the real Sim.eliminationEvents[].cause field --
  // the same ground truth production's own [elimination] log line uses.
  const characters = assignServerCharacters(seed, N);
  const moveless = characters.filter((c) => !c.moves || c.moves.length === 0);
  if (moveless.length > 0) {
    console.error(`FATAL: ${moveless.length}/${N} assigned characters have no moves -- refusing to report a measurement that would silently reproduce the moveless-bot bug.`);
    process.exit(1);
  }
  const sim = new Sim(seed, N, characters, arena, { shrinkFullyClosedTick });
  const bots = Array.from({ length: N }, (_, i) => new BotController(i, DIFFICULTY, deriveBotSeed(seed, i)));
  const wasEliminated = new Array(N).fill(false);
  let boundaryElims = 0, combatElims = 0, endTick = CEIL, matchEnded = false;
  for (let t = 0; t < CEIL; t++) {
    const inputs = bots.map((b) => b.nextInput(sim));
    sim.advance(inputs);
    for (const ev of sim.eliminationEvents) {
      if (!wasEliminated[ev.fighterIndex]) {
        wasEliminated[ev.fighterIndex] = true;
        if (ev.cause === 'knockout') combatElims++; else boundaryElims++;
      }
    }
    if (sim.isMatchOver && sim.isMatchOver()) { endTick = t; matchEnded = true; break; }
  }
  let survivors = 0;
  for (let i = 0; i < N; i++) if (!sim.getFighter(i).eliminated) survivors++;
  return { durationSec: endTick/60, boundaryElims, combatElims, matchEnded, timeout: survivors >= 2 && !matchEnded };
}

for (const arenaEntry of ALL_ARENAS) {
  console.log(`\n=== ${arenaEntry.id} ===`);
  for (const [name, tick] of VARIANTS) {
    const rs = [];
    for (let s = 0; s < SEEDS; s++) rs.push(runMatch(arenaEntry.arena, 600000 + s*911 + arenaEntry.id.length, tick));
    const durs = rs.map(r=>r.durationSec).sort((a,b)=>a-b);
    const combat = rs.reduce((a,r)=>a+r.combatElims,0);
    const boundary = rs.reduce((a,r)=>a+r.boundaryElims,0);
    const timeouts = rs.filter(r=>r.timeout).length;
    console.log(`${name}: dur[min/med/max]=${durs[0].toFixed(0)}/${durs[Math.floor(durs.length/2)].toFixed(0)}/${durs[durs.length-1].toFixed(0)}s combat=${(100*combat/Math.max(1,combat+boundary)).toFixed(1)}% boundary=${(100*boundary/Math.max(1,combat+boundary)).toFixed(1)}% timeouts=${timeouts}/${SEEDS}`);
  }
}
