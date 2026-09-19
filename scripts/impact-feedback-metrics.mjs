// Impact-feedback measurement: before/after distribution of the
// presentation "strength" signal (screen shake / pop size / sound
// gain / thump) across the knockback range a real 20p bot brawl
// produces. Usage: node --experimental-strip-types scripts/impact-feedback-metrics.mjs [seeds]
import { Sim } from '../packages/sim/src/sim.ts';
import { BotController, BotDifficulty, deriveBotSeed } from '../packages/sim/src/ai/bot.ts';
import { ALL_ARENAS } from '../packages/content/src/arenas.ts';
import * as fx from '../packages/sim/src/math/fixed.ts';
import { assignServerCharacters } from './lib/bot-character-assignment.mjs';

const SEEDS = parseInt(process.argv[2] || '10', 10);
const N = 20;
const CEIL = 10800; // 180s, plenty of hits

function pctile(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[idx];
}

// --- OLD strength formula (damage-delta based), lifted from
// packages/app/src/effects-events.ts damageToStrength, for comparison. ---
function oldStrength(damageDelta) {
  return Math.max(0, Math.min(1, damageDelta / 18));
}

// --- NEW strength formula: knockback-magnitude based (see
// effects-events.ts knockbackToStrength). ---
const KB_NORM = 20; // matches the sim's documented ~1-20 magnitude range
const STRENGTH_FLOOR = 0.12;
function newStrength(kbMagnitude) {
  // Any registered hit (caller already filtered to damageDelta > 0.05)
  // gets at least the floor so light hits still read.
  const raw = Math.max(0, Math.min(1, kbMagnitude / KB_NORM));
  return Math.max(STRENGTH_FLOOR, raw);
}

const arenaEntry = ALL_ARENAS.find((a) => a.id === 'battle-royale-20') || ALL_ARENAS[0];
console.log('arena used:', arenaEntry.id);

const damageDeltas = [];
const kbMagnitudes = [];

for (let s = 0; s < SEEDS; s++) {
  const seed = 700000 + s * 977;
  const chars = assignServerCharacters(seed, N);
  const sim = new Sim(seed, N, chars, arenaEntry.arena);
  const bots = Array.from({ length: N }, (_, i) => new BotController(i, BotDifficulty.EASY, deriveBotSeed(seed, i)));
  const lastPercent = new Array(N).fill(0);
  const lastVelX = new Array(N).fill(0);
  const lastVelY = new Array(N).fill(0);
  for (let t = 0; t < CEIL; t++) {
    const inputs = bots.map((b) => b.nextInput(sim));
    sim.advance(inputs);
    for (let i = 0; i < N; i++) {
      const f = sim.getFighter(i);
      if (f.eliminated) continue;
      const pct = fx.toFloat(f.percent);
      const damageDelta = pct - lastPercent[i];
      if (damageDelta > 0.05) {
        damageDeltas.push(damageDelta);
        const vx = fx.toFloat(f.velX);
        const vy = fx.toFloat(f.velY);
        // Knockback magnitude proxy: velocity delta this tick (the sim
        // sets velocity directly to the knockback vector on a landed
        // hit -- see Sim.tryApplyHit/applyItemDamage).
        const dvx = vx - lastVelX[i];
        const dvy = vy - lastVelY[i];
        kbMagnitudes.push(Math.hypot(dvx, dvy));
      }
      lastPercent[i] = pct;
      lastVelX[i] = fx.toFloat(f.velX);
      lastVelY[i] = fx.toFloat(f.velY);
    }
    if (sim.isMatchOver && sim.isMatchOver()) break;
  }
}

console.log(`\nn hits sampled: ${damageDeltas.length}`);
console.log('damage delta: p10=%s p50=%s p90=%s p99=%s max=%s',
  pctile(damageDeltas, 10).toFixed(2), pctile(damageDeltas, 50).toFixed(2),
  pctile(damageDeltas, 90).toFixed(2), pctile(damageDeltas, 99).toFixed(2),
  Math.max(...damageDeltas).toFixed(2));
console.log('kb magnitude:  p10=%s p50=%s p90=%s p99=%s max=%s',
  pctile(kbMagnitudes, 10).toFixed(2), pctile(kbMagnitudes, 50).toFixed(2),
  pctile(kbMagnitudes, 90).toFixed(2), pctile(kbMagnitudes, 99).toFixed(2),
  Math.max(...kbMagnitudes).toFixed(2));

const oldS = damageDeltas.map(oldStrength);
const newS = kbMagnitudes.map(newStrength);

function summarize(name, arr) {
  console.log(`${name}: p10=${pctile(arr,10).toFixed(3)} p50=${pctile(arr,50).toFixed(3)} p90=${pctile(arr,90).toFixed(3)} p99=${pctile(arr,99).toFixed(3)} spread(p90/p10)=${(pctile(arr,90)/Math.max(0.001,pctile(arr,10))).toFixed(2)}x`);
}
console.log('\n=== strength signal (feeds shake amplitude, pop size, sound gain/thump) ===');
summarize('old (damage-delta based)', oldS);
summarize('new (knockback-magnitude based)', newS);

// Concretely: light poke on a fresh fighter vs a hit at high percent
// with the same move -- pick the 10th and 90th percentile hits by
// knockback magnitude and show what each strength value drives
// downstream (shake add, spark count, pop length, sound gain/thump).
function downstream(strength) {
  const shakeAdd = 3 + strength * 10; // effects.ts addShake
  const sparkCount = 3 + Math.round(strength * 6);
  const popLen = 8 + strength * 28;
  const soundGain = 0.35 + strength * 0.55;
  const thumpGain = strength > 0.25 ? Math.min(0.6, (strength - 0.25) ** 2 * 1.1) : 0;
  return { shakeAdd, sparkCount, popLen, soundGain, thumpGain };
}
const lowS = newStrength(pctile(kbMagnitudes, 10));
const highS = newStrength(pctile(kbMagnitudes, 90));
console.log('\nlight hit (kb p10) strength=%s ->', lowS.toFixed(3), downstream(lowS));
console.log('heavy hit (kb p90) strength=%s ->', highS.toFixed(3), downstream(highS));
const lowSOld = oldStrength(pctile(damageDeltas, 10));
const highSOld = oldStrength(pctile(damageDeltas, 90));
console.log('\n[old] light hit (dmg p10) strength=%s ->', lowSOld.toFixed(3), downstream(lowSOld));
console.log('[old] heavy hit (dmg p90) strength=%s ->', highSOld.toFixed(3), downstream(highSOld));
