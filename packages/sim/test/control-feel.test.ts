// Control feel (player report: "the movement and controls feel too clunky"):
// buffered jump/attack presses, coyote time, short hop and fast-fall. Each
// test sets a fighter up by poking the saved state, then drives inputs and
// asserts what the fighter actually does.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Sim,
  FighterField,
  COYOTE_TICKS,
  FAST_FALL_VELOCITY,
  INPUT_BUFFER_TICKS,
  JUMP_VELOCITY,
  MAX_JUMPS,
} from '../src/sim.ts';
import { FighterStateId } from '../src/entities/fighter.ts';
import * as fx from '../src/math/fixed.ts';
import { BUTTON_ATTACK, BUTTON_JUMP, makeInputFrame, type InputFrame } from '../src/types.ts';
import { PLACEHOLDER_CHARACTER } from '../../content/src/characters/placeholder/data.ts';

const IDLE = makeInputFrame();
const JUMP = makeInputFrame(BUTTON_JUMP);
const ATTACK = makeInputFrame(BUTTON_ATTACK);
const DOWN = makeInputFrame(0, 0, fx.neg(fx.ONE));
const step = (sim: Sim, input: InputFrame = IDLE) => sim.advance([input, IDLE]);

function groundedSim(): Sim {
  const sim = new Sim(1, 2, [PLACEHOLDER_CHARACTER, PLACEHOLDER_CHARACTER]);
  step(sim);
  assert.ok(sim.getFighter(0).grounded);
  return sim;
}

/** Overwrites fighter 0's state fields, leaving everything else untouched. */
function poke(sim: Sim, fields: Partial<Record<keyof typeof FighterField, number>>): void {
  const buf = sim.createStateBuffer();
  sim.saveState(buf);
  for (const [name, value] of Object.entries(fields)) buf[FighterField[name as keyof typeof FighterField]] = value;
  sim.loadState(buf);
}

/** Fighter 0 in the air `height` above the floor, at rest, not having jumped (as if it had just left a ledge). */
function airborneSim(height: number, jumpsUsed = 0): Sim {
  const sim = groundedSim();
  const y = sim.getFighter(0).posY;
  poke(sim, { POS_Y: fx.add(y, fx.fromInt(height)), GROUNDED: 0, STATE: FighterStateId.AIRBORNE, JUMPS_USED: jumpsUsed });
  step(sim); // the tick it leaves the ground
  return sim;
}

/** Fighter 0 in hitstun for `ticks` more ticks, standing on the floor. */
function hitstunSim(ticks: number): Sim {
  const sim = groundedSim();
  poke(sim, { HITSTUN: ticks, STATE: FighterStateId.HITSTUN });
  return sim;
}

function apexAfterHoldingJump(holdTicks: number): number {
  const sim = groundedSim();
  const floorY = sim.getFighter(0).posY;
  let top = floorY;
  for (let t = 0; t < 90; t++) {
    step(sim, t < holdTicks ? JUMP : IDLE);
    top = fx.max(top, sim.getFighter(0).posY);
  }
  return fx.toFloat(fx.sub(top, floorY));
}

describe('Sim: input buffer', () => {
  it('a jump tapped during the last ticks of hitstun fires on the first actionable tick', () => {
    const sim = hitstunSim(4);
    step(sim, JUMP); // tapped and released while still stunned
    step(sim);
    step(sim);
    assert.ok(sim.getFighter(0).hitstun > 0, 'still in hitstun when the press was made');
    step(sim); // hitstun ends this tick
    step(sim); // first actionable tick
    const f = sim.getFighter(0);
    assert.equal(f.jumpsUsed, 1);
    assert.ok(f.velY > 0, 'buffered jump should launch the fighter');
  });

  it('a press older than the buffer window is dropped', () => {
    const sim = hitstunSim(INPUT_BUFFER_TICKS + 4);
    step(sim, JUMP);
    for (let i = 0; i < INPUT_BUFFER_TICKS + 6; i++) step(sim);
    assert.equal(sim.getFighter(0).jumpsUsed, 0);
    assert.ok(sim.getFighter(0).grounded);
  });

  it('a jump pressed during attack recovery fires as soon as the move ends', () => {
    const ticksInAttack = (sim: Sim, tapJumpAt: number): number => {
      step(sim, ATTACK);
      let n = 0;
      while (sim.getFighter(0).state === FighterStateId.ATTACK && n < 120) step(sim, n++ === tapJumpAt ? JUMP : IDLE);
      return n;
    };
    const moveTicks = ticksInAttack(groundedSim(), -1);
    const sim = groundedSim();
    ticksInAttack(sim, moveTicks - 3);
    assert.equal(sim.getFighter(0).jumpsUsed, 0, 'no jump while the move plays out');
    step(sim);
    assert.equal(sim.getFighter(0).jumpsUsed, 1, 'buffered jump fires on the first free tick');
    assert.ok(sim.getFighter(0).velY > 0);
  });

  it('a jump pressed just before landing with no jumps left fires on landing', () => {
    const probe = airborneSim(60, MAX_JUMPS);
    let fallTicks = 0;
    while (!probe.getFighter(0).grounded) {
      step(probe);
      fallTicks++;
    }
    const sim = airborneSim(60, MAX_JUMPS);
    for (let i = 0; i < fallTicks - 3; i++) step(sim);
    step(sim, JUMP);
    for (let i = 0; i < 4; i++) step(sim);
    assert.equal(sim.getFighter(0).jumpsUsed, 1, 'jumped again after touching down');
    assert.ok(sim.getFighter(0).velY > 0);
  });

  it('an attack tapped during hitstun starts as soon as hitstun ends', () => {
    const sim = hitstunSim(3);
    step(sim, ATTACK);
    step(sim);
    step(sim); // hitstun ends
    step(sim);
    assert.equal(sim.getFighter(0).state, FighterStateId.ATTACK);
  });
});

describe('Sim: coyote time', () => {
  it('a jump shortly after leaving the ground unjumped is the full grounded jump', () => {
    const sim = airborneSim(150);
    for (let i = 0; i < COYOTE_TICKS - 2; i++) step(sim);
    step(sim, JUMP);
    assert.equal(sim.getFighter(0).jumpsUsed, 1);
    assert.ok(sim.getFighter(0).velY > fx.sub(JUMP_VELOCITY, fx.fromInt(1)), 'grounded jump velocity');
  });

  it('expires: a later jump is only the weaker aerial jump', () => {
    const sim = airborneSim(150);
    for (let i = 0; i < COYOTE_TICKS + 2; i++) step(sim);
    step(sim, JUMP);
    assert.equal(sim.getFighter(0).jumpsUsed, 1);
    assert.ok(sim.getFighter(0).velY < fx.sub(JUMP_VELOCITY, fx.fromInt(2)), 'not a grounded jump');
  });
});

describe('Sim: short hop', () => {
  it('releasing jump right after takeoff gives a hop about 55% as high as holding it', () => {
    const full = apexAfterHoldingJump(30);
    for (const hold of [1, 4]) {
      const ratio = apexAfterHoldingJump(hold) / full;
      assert.ok(ratio > 0.5 && ratio < 0.6, `held ${hold} ticks: ${ratio.toFixed(2)} of a full hop`);
    }
  });

  it('holding jump past the window is a full hop', () => {
    assert.equal(apexAfterHoldingJump(5), apexAfterHoldingJump(30));
  });
});

describe('Sim: fast-fall', () => {
  it('holding down past the apex falls faster and lands sooner', () => {
    const ticksToLand = (input: InputFrame): number => {
      const sim = airborneSim(200);
      let n = 0;
      while (!sim.getFighter(0).grounded && n < 200) {
        step(sim, input);
        n++;
        if (input === DOWN && !sim.getFighter(0).grounded) assert.equal(sim.getFighter(0).velY, FAST_FALL_VELOCITY);
      }
      return n;
    };
    assert.ok(ticksToLand(DOWN) < ticksToLand(IDLE));
  });

  it('holding down while still rising does nothing until the apex', () => {
    const sim = groundedSim();
    step(sim, JUMP);
    for (let i = 0; i < 5; i++) step(sim, makeInputFrame(BUTTON_JUMP, 0, fx.neg(fx.ONE)));
    assert.ok(sim.getFighter(0).velY > 0, 'still rising normally');
    while (sim.getFighter(0).velY > 0) step(sim, DOWN);
    step(sim, DOWN);
    assert.equal(sim.getFighter(0).velY, FAST_FALL_VELOCITY);
  });

  it('a down-air past the apex does not start a fast-fall', () => {
    const sim = airborneSim(200);
    step(sim, makeInputFrame(BUTTON_ATTACK, 0, fx.neg(fx.ONE)));
    assert.equal(sim.getFighter(0).state, FighterStateId.ATTACK);
    for (let i = 0; i < 3; i++) step(sim, DOWN);
    assert.ok(sim.getFighter(0).velY > FAST_FALL_VELOCITY, 'falls at normal speed during the aerial');
  });
});
