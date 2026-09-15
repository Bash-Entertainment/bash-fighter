// One-off measurement script (task: endgame time-budget analysis 2026-09-15).
// Not part of any gate. Measures median tick at which alive-count drops to
// 15/10/7/5/3/1 for battle-royale-20, MEDIUM (production default) bots,
// plus elimination cause at each milestone. Ground truth: sim.eliminationEvents,
// same as production's [elimination] log line (see wiki "Resolution
// Guarantee and Harness Trust").
import { Sim } from '../packages/sim/src/sim.ts';
import { BotController, BotDifficulty, deriveBotSeed } from '../packages/sim/src/ai/bot.ts';
import { makeInputFrame } from '../packages/sim/src/types.ts';
import { ALL_ARENAS } from '../packages/content/src/arenas.ts';
import { assignServerCharacters } from './lib/bot-character-assignment.mjs';

const N = 20;
const SEEDS = parseInt(process.argv[2] || '20', 10);
const TICKS = 21600;
const arenaId = process.argv[3] || 'battle-royale-20';
const arenaEntry = ALL_ARENAS.find((a) => a.id === arenaId);
const MILESTONES = [15, 10, 7, 5, 3, 1];

function runMatch(seed) {
  const characters = assignServerCharacters(seed, N, new Set());
  const sim = new Sim(seed, N, characters, arenaEntry.arena);
  const bots = Array.from({ length: N }, (_, i) => new BotController(i, BotDifficulty.EASY, deriveBotSeed(seed, i)));
  const idleInput = makeInputFrame(0, 0, 0);
  let alive = N;
  const milestoneTicks = {};
  const milestoneCauses = {};
  const wasEliminated = new Array(N).fill(false);
  for (let t = 0; t < TICKS; t++) {
    const inputs = bots.map((b) => b.nextInput(sim));
    sim.advance(inputs);
    for (const ev of sim.eliminationEvents) {
      if (!wasEliminated[ev.fighterIndex]) {
        wasEliminated[ev.fighterIndex] = true;
        alive--;
        if (MILESTONES.includes(alive) && !(alive in milestoneTicks)) {
          milestoneTicks[alive] = t;
          milestoneCauses[alive] = ev.cause;
        }
      }
    }
    if (sim.isMatchOver && sim.isMatchOver()) break;
  }
  return { milestoneTicks, milestoneCauses };
}

const perMilestone = {};
for (const m of MILESTONES) perMilestone[m] = { ticks: [], causes: [] };

for (let s = 0; s < SEEDS; s++) {
  const seed = 200000 + s * 7919;
  const r = runMatch(seed);
  for (const m of MILESTONES) {
    if (m in r.milestoneTicks) {
      perMilestone[m].ticks.push(r.milestoneTicks[m]);
      perMilestone[m].causes.push(r.milestoneCauses[m]);
    }
  }
}

console.log(`=== ${arenaId}, ${SEEDS} seeds, MEDIUM ===`);
for (const m of MILESTONES) {
  const ticks = perMilestone[m].ticks.sort((a, b) => a - b);
  if (ticks.length === 0) { console.log(`alive=${m}: never reached`); continue; }
  const median = ticks[Math.floor(ticks.length / 2)];
  const causeCounts = {};
  for (const c of perMilestone[m].causes) causeCounts[c] = (causeCounts[c] || 0) + 1;
  console.log(`alive=${m}: median=${(median/60).toFixed(1)}s (n=${ticks.length}) causes=${JSON.stringify(causeCounts)}`);
}
