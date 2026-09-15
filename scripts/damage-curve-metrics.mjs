// Damage-curve measurement for task: percent distribution over time at 20p BR.
// Usage: node --experimental-strip-types scripts/damage-curve-metrics.mjs [seeds]
import { Sim } from '../packages/sim/src/sim.ts';
import { BotController, BotDifficulty, deriveBotSeed } from '../packages/sim/src/ai/bot.ts';
import { ALL_ARENAS } from '../packages/content/src/arenas.ts';
import * as fx from '../packages/sim/src/math/fixed.ts';
import { assignServerCharacters } from './lib/bot-character-assignment.mjs';

const SEEDS = parseInt(process.argv[2] || '10', 10);
const N = 20;
const CEIL = 42000; // 700s
const SAMPLE_TICKS = [600, 1200, 1800, 3600]; // 10s,20s,30s,60s

function pctile(arr, p) {
  const s = [...arr].sort((a,b)=>a-b);
  const idx = Math.min(s.length-1, Math.floor(p/100*s.length));
  return s[idx];
}

const arenaEntry = ALL_ARENAS.find(a => a.id === 'battle-royale-20') || ALL_ARENAS[0];
console.log('arena used:', arenaEntry.id);

const samples = {600:[],1200:[],1800:[],3600:[]};
let hitsTaken = 0, damageDealtSum = 0, hitCount = 0;
let firstKoTicks = [];
let matchLens = [];
let elimCounts = {knockout:0, fall:0, ring:0, ring_lethal:0};
let fighterTicksAlive = 0;

for (let s = 0; s < SEEDS; s++) {
  const seed = 500000 + s * 977;
  const chars = assignServerCharacters(seed, N);
  const sim = new Sim(seed, N, chars, arenaEntry.arena);
  const bots = Array.from({length:N}, (_,i) => new BotController(i, BotDifficulty.EASY, deriveBotSeed(seed,i)));
  const lastPercent = new Array(N).fill(0);
  let firstKo = null;
  let endTick = CEIL;
  for (let t = 0; t < CEIL; t++) {
    const inputs = bots.map(b => b.nextInput(sim));
    sim.advance(inputs);
    for (let i = 0; i < N; i++) {
      const f = sim.getFighter(i);
      if (!f.eliminated) fighterTicksAlive++;
      const pct = fx.toFloat(f.percent);
      if (pct > lastPercent[i] + 0.01) {
        const delta = pct - lastPercent[i];
        damageDealtSum += delta;
        hitCount++; // approx: counts percent-increase events as hits
      }
      lastPercent[i] = pct;
    }
    if (SAMPLE_TICKS.includes(t)) {
      for (let i = 0; i < N; i++) {
        const f = sim.getFighter(i);
        if (!f.eliminated) samples[t].push(fx.toFloat(f.percent));
      }
    }
    for (const ev of sim.eliminationEvents) {
      if (firstKo === null) firstKo = t;
      if (ev.cause === 'knockout') elimCounts.knockout++;
      else if (ev.cause === 'fall') elimCounts.fall++;
      else if (ev.cause === 'ring_lethal') elimCounts.ring_lethal++;
      else elimCounts.ring++;
    }
    if (sim.isMatchOver && sim.isMatchOver()) { endTick = t; break; }
  }
  firstKoTicks.push(firstKo);
  matchLens.push(endTick);
}

console.log('\n=== Percent distribution (median/p95), N seeds =', SEEDS, '===');
for (const t of SAMPLE_TICKS) {
  const arr = samples[t];
  console.log(`t=${t/60}s: n=${arr.length} median=${pctile(arr,50)?.toFixed(1)} p95=${pctile(arr,95)?.toFixed(1)} max=${Math.max(...arr).toFixed(1)}`);
}

console.log('\nfirst KO tick (median s):', pctile(firstKoTicks.filter(x=>x!==null),50)/60);
console.log('match length median s:', pctile(matchLens,50)/60, 'mean s:', (matchLens.reduce((a,b)=>a+b,0)/matchLens.length/60).toFixed(1));
console.log('mean damage per hit-event:', (damageDealtSum/hitCount).toFixed(2));
console.log('hits per fighter per second (approx):', (hitCount/(fighterTicksAlive/60)).toFixed(3));
console.log('elimination split:', elimCounts);
