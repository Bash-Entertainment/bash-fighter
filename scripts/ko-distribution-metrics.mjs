
// Measures the distribution of knockout credit across seats in headless
// 20-fighter matches at production's actual default bot difficulty (EASY --
// see server/src/match-defaults.ts / PRODUCTION_DEFAULT_BOT_DIFFICULTY_NAME,
// confirmed by reading server/src/match.ts, not assumed) for both
// battleRoyale and timedKO win conditions. Added 2026-09-21 for the
// "framing-and-ko-distribution" measurement task -- MEASUREMENT ONLY, no
// balance/behavior changes.
//
// "KOs per seat" = eliminationEvents credited to that seat as attacker
// with cause 'knockout' (see packages/sim/src/sim.ts EliminationEvent).
//
// Run: node --experimental-strip-types scripts/ko-distribution-metrics.mjs
import { BotController, BotDifficulty, deriveBotSeed } from '../packages/sim/src/ai/bot.ts';
import { assignServerCharacters } from './lib/bot-character-assignment.mjs';
import { createMatchSim, pickArenaId } from '../packages/content/src/index.ts';

const N = 20;
const TICKS_CAP = 10800; // 3 min @ 60hz, matches bot-brawl-metrics.mjs cap
const SEEDS = Array.from({ length: 20 }, (_, i) => 424242 + i * 1000);
const MODES = ['battleRoyale', 'timedKO'];

function runMatch(seed, winCondition) {
  const characters = assignServerCharacters(seed, N);
  // Use createMatchSim (packages/content), not the bare Sim constructor, so this
  // harness gets production's real arena geometry (via pickArenaId, same seed ->
  // same stage the server would choose) and production's item/hazard sets instead
  // of Sim's tiny 2-fighter DEFAULT_ARENA and DEFAULT_ITEM_SET/DEFAULT_HAZARD_CONFIG.
  // Found 2026-09-21: the bare-constructor version crammed 20 fighters onto a
  // 400-unit-wide, 2-spawn-point platform meant for physics unit tests, which
  // inflated timedKO knockout counts roughly 4x versus real production matches.
  const arenaId = pickArenaId(seed);
  const sim = createMatchSim(seed, N, { winCondition }, characters, arenaId);
  // No human seats in this harness, so no protectedIndices set -- matches a bot-only
  // production match; real matches with a human seat pass that seat's slot here too
  // (see server/src/match.ts), which this harness does not model.
  const bots = Array.from({ length: N }, (_, i) => new BotController(i, BotDifficulty.EASY, deriveBotSeed(seed, i)));
  const kos = new Array(N).fill(0);

  for (let t = 0; t < TICKS_CAP; t++) {
    const inputs = bots.map((b) => b.nextInput(sim));
    sim.advance(inputs);
    for (const ev of sim.eliminationEvents) {
      if (ev.cause === 'knockout' && ev.attacker >= 0) kos[ev.attacker]++;
    }
    if (sim.isMatchOver && sim.isMatchOver()) break;
  }
  return kos;
}

function mean(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function percentile(sortedAsc, p) {
  const idx = Math.min(sortedAsc.length - 1, Math.floor(p * sortedAsc.length));
  return sortedAsc[idx];
}

for (const mode of MODES) {
  const topSeatKOs = [];
  const top2Shares = [];
  const lowKOSeatsCounts = [];
  for (const seed of SEEDS) {
    const kos = runMatch(seed, mode);
    const sorted = [...kos].sort((a, b) => b - a);
    const total = sorted.reduce((a, b) => a + b, 0);
    topSeatKOs.push(sorted[0]);
    top2Shares.push(total > 0 ? (sorted[0] + sorted[1]) / total : 0);
    lowKOSeatsCounts.push(kos.filter((k) => k <= 1).length);
  }
  const topSeatSorted = [...topSeatKOs].sort((a, b) => a - b);
  console.log(JSON.stringify({
    mode,
    seeds: SEEDS,
    matches: SEEDS.length,
    topSeatKOs_mean: Number(mean(topSeatKOs).toFixed(2)),
    topSeatKOs_p90: percentile(topSeatSorted, 0.9),
    top2SeatShareOfKOs_mean: Number((mean(top2Shares) * 100).toFixed(1)) + '%',
    seatsWith0or1KOs_mean: Number(mean(lowKOSeatsCounts).toFixed(2)),
  }, null, 2));
}
