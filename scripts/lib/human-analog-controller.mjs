// Human-analog controller shared by scripts/human-analog-metrics.mjs and
// scripts/rookie-ko-metrics.mjs. See human-analog-metrics.mjs's header for
// what each PARAMS field means and why the defaults are guesses.
import { BUTTON_ATTACK, BUTTON_JUMP, makeInputFrame } from '../../packages/sim/src/types.ts';
import * as fx from '../../packages/sim/src/math/fixed.ts';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Human-analog controller: re-decides only every `reactionTicks` ticks,
// with a chance of idling, misaiming, or attacking baked into each
// decision. Distinct from BotController by construction: BotController is
// tuned to be a competent opponent every tick; this is deliberately not.
export function makeHumanAnalogController(rand, HUMAN_SLOT, PARAMS) {
  let held = makeInputFrame();
  let ticksUntilDecision = 0;
  return function humanAnalogInput(sim) {
    if (ticksUntilDecision <= 0) {
      ticksUntilDecision = PARAMS.reactionTicks;
      held = makeInputFrame();
      if (rand() < PARAMS.idleProb) {
        // do nothing this window
      } else {
        const self = sim.getFighter(HUMAN_SLOT);
        let target = null;
        let bestD2 = Infinity;
        for (let i = 0; i < sim.numFighters; i++) {
          if (i === HUMAN_SLOT) continue;
          const f = sim.getFighter(i);
          if (f.eliminated) continue;
          const dx = f.posX - self.posX;
          const dy = f.posY - self.posY;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2) { bestD2 = d2; target = f; }
        }
        const misaimed = rand() < PARAMS.aimJitter;
        if (target && !misaimed) {
          held.stickX = target.posX > self.posX ? fx.ONE : -fx.ONE;
        } else if (rand() < 0.5) {
          held.stickX = rand() < 0.5 ? fx.ONE : -fx.ONE;
        }
        if (rand() < 0.02) held.buttons |= BUTTON_JUMP;
        if (rand() < PARAMS.attackProb) held.buttons |= BUTTON_ATTACK;
      }
    }
    ticksUntilDecision--;
    return held;
  };
}

