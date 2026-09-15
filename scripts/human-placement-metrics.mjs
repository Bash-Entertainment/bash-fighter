// Human-placement distribution harness (2026-09-10, follow-up to
// novice-survival-metrics.mjs). That harness only measures *survival
// time* on Sim's DEFAULT_ARENA (a 2-point test stage cycled to fill 20
// slots) -- it never exercised the real production arenas or their
// spawn geometry, so it could not have caught the human-spawns-in-the-
// centre bug this pass fixed. This harness instead:
//   - uses the real production arena rotation (pickArenaId(seed), the
//     same three named content arenas production picks between)
//   - drives an *active* human input source (movement + attacks), not a
//     passive one -- this measures "how does an actively-playing human
//     place", per the production report that started this task (3rd of
//     20 eliminated at 47% while playing properly)
//   - records the human's final placement rank (1 = winner, 20 = first
//     out), not just a survival-time proxy, and reports the distribution
//     across many seeds
//
// Usage: node --experimental-strip-types scripts/human-placement-metrics.mjs [difficulty] [trials]
import { Sim } from '../packages/sim/src/sim.ts';
import { BotController, BotDifficulty, deriveBotSeed } from '../packages/sim/src/ai/bot.ts';
import { BUTTON_ATTACK, BUTTON_JUMP, makeInputFrame } from '../packages/sim/src/types.ts';
import { resolveArenaId, pickArenaId } from '../packages/content/src/arenas.ts';
import * as fx from '../packages/sim/src/math/fixed.ts';
import { assignServerCharacters } from './lib/bot-character-assignment.mjs';

const diffArg = (process.argv[2] || 'easy').toUpperCase();
const TRIALS = parseInt(process.argv[3] || '20', 10);
const TICKS_CEILING = parseInt(process.argv[4] || '28920', 10); // default: production shrinkFullyClosedTick (28800) + small buffer
const N = 20;
const HUMAN_SLOT = 0;
const difficulty = BotDifficulty[diffArg] ?? BotDifficulty.EASY;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// An actively-playing but unskilled human: moves toward the nearest
// visible opponent fairly often, attacks reasonably often, occasionally
// jumps -- meant to resemble "sustained movement and attacks" from a
// real player who hasn't learned matchup-specific tech, not a strawman
// standing still (that case is already covered by novice-survival).
function humanInput(sim, rand, driftRef) {
  const frame = makeInputFrame();
  const self = sim.getFighter(HUMAN_SLOT);
  let nearest = null;
  let nearestDistSq = Infinity;
  for (let i = 0; i < sim.numFighters; i++) {
    if (i === HUMAN_SLOT) continue;
    const f = sim.getFighter(i);
    if (f.eliminated) continue;
    const dx = f.posX - self.posX;
    const dy = f.posY - self.posY;
    const d2 = dx * dx + dy * dy;
    if (d2 < nearestDistSq) {
      nearestDistSq = d2;
      nearest = f;
    }
  }
  if (nearest) {
    frame.stickX = nearest.posX > self.posX ? fx.ONE : -fx.ONE;
  } else if (rand() < 0.08) {
    driftRef.dir = rand() < 0.5 ? -1 : 1;
  }
  if (driftRef.dir && !nearest) frame.stickX = driftRef.dir > 0 ? fx.ONE : -fx.ONE;
  if (rand() < 0.015) frame.buttons |= BUTTON_JUMP;
  if (rand() < 0.22) frame.buttons |= BUTTON_ATTACK; // sustained, active attacking
  return frame;
}

function runOneTrial(seed) {
  const arenaId = pickArenaId(seed);
  const arena = resolveArenaId(arenaId);
  // FIX (see docs/MEASUREMENT.md, wiki "Resolution Guarantee and Harness
  // Trust"): `undefined` silently resolves every seat to moveless
  // DEFAULT_CHARACTER. Human slot gets the placeholder fallback, bot seats
  // get the same seeded ALL_CHARACTERS draw production's rooms.ts uses.
  const characters = assignServerCharacters(seed, N, new Set([HUMAN_SLOT]));
  const moveless = characters.filter((c) => !c.moves || c.moves.length === 0);
  if (moveless.length > 0) {
    console.error(`FATAL: ${moveless.length}/${N} assigned characters have no moves -- refusing to report a measurement that would silently reproduce the moveless-bot bug.`);
    process.exit(1);
  }
  const sim = new Sim(seed, N, characters, arena);
  const protectedSlots = new Set([HUMAN_SLOT]);
  const bots = [];
  for (let i = 1; i < N; i++) {
    bots.push(new BotController(i, difficulty, deriveBotSeed(seed, i), protectedSlots));
  }
  const rand = mulberry32(seed ^ 0x9e3779b9);
  const driftRef = { dir: 0 };
  let humanEliminatedAtTick = null;
  let humanDamageAtElimination = null;
  for (let t = 0; t < TICKS_CEILING; t++) {
    const inputs = [humanInput(sim, rand, driftRef)];
    for (const b of bots) inputs.push(b.nextInput(sim));
    sim.advance(inputs);
    const human = sim.getFighter(HUMAN_SLOT);
    if (human.eliminated && humanEliminatedAtTick === null) {
      humanEliminatedAtTick = t;
      humanDamageAtElimination = human.percent;
    }
    if (sim.isMatchOver()) {
      const human2 = sim.getFighter(HUMAN_SLOT);
      return {
        arenaId,
        placement: human2.placement, // 1 = winner, 20 = first out
        eliminatedAtSec: humanEliminatedAtTick === null ? null : Number((humanEliminatedAtTick / 60).toFixed(1)),
        damageAtElimination: humanDamageAtElimination === null ? null : Number(fx.toFloat(humanDamageAtElimination).toFixed(0)),
        matchDurationSec: Number((t / 60).toFixed(1)),
      };
    }
  }
  return { arenaId, placement: null, eliminatedAtSec: null, damageAtElimination: null, matchDurationSec: null, timedOut: true };
}

const results = [];
for (let trial = 0; trial < TRIALS; trial++) {
  const seed = 700001 + trial * 6733;
  results.push(runOneTrial(seed));
}

const placements = results.map((r) => r.placement).filter((p) => p !== null).sort((a, b) => a - b);
const median = placements.length ? placements[Math.floor(placements.length / 2)] : null;
const top10 = placements.filter((p) => p <= 10).length; // reached middle of the field or better
const bottom5 = placements.filter((p) => p >= 16).length; // eliminated in the opening scrum roughly

console.log(JSON.stringify({
  difficulty: diffArg,
  trials: TRIALS,
  placements,
  medianPlacement: median,
  meanPlacement: placements.length ? Number((placements.reduce((a, b) => a + b, 0) / placements.length).toFixed(2)) : null,
  reachedTop10Count: top10,
  reachedTop10Pct: placements.length ? Number(((top10 / placements.length) * 100).toFixed(1)) : null,
  eliminatedBottom5Count: bottom5,
  perTrial: results,
}, null, 2));
