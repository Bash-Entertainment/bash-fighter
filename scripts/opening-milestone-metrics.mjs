// Measures median seconds-to-population-milestone (15/10/7/5/3/1 alive)
// and elimination cause split, per stage, for the default 20-fighter
// production-faithful roster/difficulty (EASY). Used for the 2026-09-15
// opening-quarter pacing investigation (see wiki "Bot Engagement Pacing
// Pass 2026-09-10"). Deterministic: fixed seeds, no Math.random.
//   node --experimental-strip-types scripts/opening-milestone-metrics.mjs [arenaId] [seeds] [ticks]
import { Sim } from '../packages/sim/src/sim.ts';
import { BotController, BotDifficulty, deriveBotSeed } from '../packages/sim/src/ai/bot.ts';
import { makeInputFrame } from '../packages/sim/src/types.ts';
import { ALL_ARENAS } from '../packages/content/src/arenas.ts';
import { PRODUCTION_DEFAULT_BOT_DIFFICULTY_NAME } from '../server/src/match-defaults.ts';
import { assignServerCharacters } from './lib/bot-character-assignment.mjs';

const arenaArg = process.argv[2] || 'all';
const SEEDS = parseInt(process.argv[3] || '12', 10);
const TICKS = parseInt(process.argv[4] || '21600', 10);
const N = 20;
const MILESTONES = [15, 10, 7, 5, 3, 1];
const DIFFICULTY = BotDifficulty[PRODUCTION_DEFAULT_BOT_DIFFICULTY_NAME.toUpperCase()];

const arenaEntries = arenaArg === 'all' ? ALL_ARENAS : ALL_ARENAS.filter((a) => a.id === arenaArg);
if (arenaEntries.length === 0) { console.error(`unknown arena: ${arenaArg}`); process.exit(1); }

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function runMatch(arenaEntry, seed) {
  const characters = assignServerCharacters(seed, N, new Set());
  const sim = new Sim(seed, N, characters, arenaEntry.arena);
  const bots = Array.from({ length: N }, (_, i) => new BotController(i, DIFFICULTY, deriveBotSeed(seed, i)));
  const idleInput = makeInputFrame(0, 0, 0);
  const milestoneTicks = {};
  let knockout = 0, ring = 0, fall = 0;
  const seen = new Set();
  let resolved = false;

  for (let t = 0; t < TICKS; t++) {
    const inputs = bots.map((b, i) => b.nextInput(sim));
    sim.advance(inputs);
    for (const ev of sim.eliminationEvents) {
      if (seen.has(ev.fighterIndex)) continue;
      seen.add(ev.fighterIndex);
      if (ev.cause === 'knockout') knockout++;
      else if (ev.cause === 'fall') fall++;
      else ring++;
    }
    let alive = 0;
    for (let i = 0; i < N; i++) if (!sim.getFighter(i).eliminated) alive++;
    for (const m of MILESTONES) {
      if (alive <= m && milestoneTicks[m] === undefined) milestoneTicks[m] = t;
    }
    if (sim.isMatchOver && sim.isMatchOver()) { resolved = true; break; }
  }
  return { milestoneTicks, knockout, ring, fall, resolved };
}

for (const arenaEntry of arenaEntries) {
  const results = [];
  for (let s = 0; s < SEEDS; s++) results.push(runMatch(arenaEntry, 5000 + s));
  const line = { arena: arenaEntry.id, resolved: results.filter((r) => r.resolved).length, seeds: SEEDS };
  for (const m of MILESTONES) {
    const vals = results.map((r) => r.milestoneTicks[m]).filter((v) => v !== undefined);
    line[`t${m}_median_s`] = vals.length ? +(median(vals) / 60).toFixed(1) : null;
  }
  const totalElims = results.reduce((a, r) => a + r.knockout + r.ring + r.fall, 0);
  const ko = results.reduce((a, r) => a + r.knockout, 0);
  const rg = results.reduce((a, r) => a + r.ring, 0);
  const fl = results.reduce((a, r) => a + r.fall, 0);
  line.ko_pct = totalElims ? +(100 * ko / totalElims).toFixed(1) : null;
  line.ring_pct = totalElims ? +(100 * rg / totalElims).toFixed(1) : null;
  line.fall_pct = totalElims ? +(100 * fl / totalElims).toFixed(1) : null;
  console.log(JSON.stringify(line));
}
