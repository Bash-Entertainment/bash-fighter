// Early-match clustering diagnosis (2026-09-09). Measures mean pairwise
// distance among all alive fighters over the first 30 real-time seconds,
// at t=0 (spawn) separately from t>0 (post-movement), to separate "spawn
// layout is already tight" from "AI pulls fighters together".
import { Sim } from '../packages/sim/src/sim.ts';
import { BotController, BotDifficulty, deriveBotSeed } from '../packages/sim/src/ai/bot.ts';
import { ALL_ARENAS } from '../packages/content/src/arenas.ts';
import * as fx from '../packages/sim/src/math/fixed.ts';
import { assignServerCharacters } from './lib/bot-character-assignment.mjs';

const N = 20;
const SEEDS = parseInt(process.argv[2] || '5', 10);
const SECONDS = 30;

function meanPairwiseDist(sim) {
  const pts = [];
  for (let i = 0; i < N; i++) {
    const f = sim.getFighter(i);
    if (!f.eliminated) pts.push([fx.toFloat(f.posX), fx.toFloat(f.posY)]);
  }
  let sum = 0, cnt = 0;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      sum += Math.hypot(pts[i][0]-pts[j][0], pts[i][1]-pts[j][1]);
      cnt++;
    }
  }
  return cnt > 0 ? sum / cnt : 0;
}

function minTightCluster(sim, radius) {
  // largest count of fighters mutually within `radius` of a common point (simple grid pass)
  const pts = [];
  for (let i = 0; i < N; i++) {
    const f = sim.getFighter(i);
    if (!f.eliminated) pts.push([fx.toFloat(f.posX), fx.toFloat(f.posY)]);
  }
  let best = 0;
  for (let i = 0; i < pts.length; i++) {
    let c = 0;
    for (let j = 0; j < pts.length; j++) {
      if (Math.hypot(pts[i][0]-pts[j][0], pts[i][1]-pts[j][1]) <= radius) c++;
    }
    if (c > best) best = c;
  }
  return best;
}

for (const arenaEntry of ALL_ARENAS) {
  console.log(`\n=== ${arenaEntry.id} ===`);
  const t0dists = [], t5dists = [], t15dists = [], t30dists = [];
  const t0clusters = [], t30clusters = [];
  for (let s = 0; s < SEEDS; s++) {
    const seed = 500000 + s * 331 + arenaEntry.id.length;
    // FIX (see docs/MEASUREMENT.md, wiki "Resolution Guarantee and Harness
    // Trust"): `undefined` silently resolves to moveless DEFAULT_CHARACTER.
    const characters = assignServerCharacters(seed, N);
    const moveless = characters.filter((c) => !c.moves || c.moves.length === 0);
    if (moveless.length > 0) {
      console.error(`FATAL: ${moveless.length}/${N} assigned characters have no moves -- refusing to report a measurement that would silently reproduce the moveless-bot bug.`);
      process.exit(1);
    }
    const sim = new Sim(seed, N, characters, arenaEntry.arena);
    const bots = Array.from({ length: N }, (_, i) => new BotController(i, BotDifficulty.HARD, deriveBotSeed(seed, i)));
    t0dists.push(meanPairwiseDist(sim));
    t0clusters.push(minTightCluster(sim, 60));
    for (let t = 0; t < SECONDS * 60; t++) {
      const inputs = bots.map((b) => b.nextInput(sim));
      sim.advance(inputs);
      if (t === 5*60-1) t5dists.push(meanPairwiseDist(sim));
      if (t === 15*60-1) t15dists.push(meanPairwiseDist(sim));
      if (t === 30*60-1) { t30dists.push(meanPairwiseDist(sim)); t30clusters.push(minTightCluster(sim, 60)); }
    }
  }
  const avg = (a) => (a.reduce((x,y)=>x+y,0)/a.length).toFixed(1);
  console.log(`mean pairwise dist: t=0s:${avg(t0dists)}  t=5s:${avg(t5dists)}  t=15s:${avg(t15dists)}  t=30s:${avg(t30dists)}`);
  console.log(`max fighters within 60 units of one another: t=0s avg=${avg(t0clusters)} max=${Math.max(...t0clusters)}   t=30s avg=${avg(t30clusters)} max=${Math.max(...t30clusters)}`);
}
