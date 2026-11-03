import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Sim, FighterField, COYOTE_TICKS, JUMP_BUFFER_TICKS, JUMP_VELOCITY, MAX_JUMPS } from '../src/sim.ts';
import * as fx from '../src/math/fixed.ts';
import { BUTTON_JUMP, makeInputFrame, type InputFrame } from '../src/types.ts';

const NO_INPUT: InputFrame[] = [makeInputFrame(), makeInputFrame()];
const JUMP: InputFrame[] = [makeInputFrame(BUTTON_JUMP), makeInputFrame()];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dataOf = (sim: Sim): Int32Array => (sim as any).data as Int32Array;

/** Settle on the ground, then put fighter 0 in the air at rest as if it had just left a ledge. */
function simJustOffLedge(): Sim {
  const sim = new Sim(1, 2);
  sim.advance(NO_INPUT);
  const d = dataOf(sim);
  d[FighterField.POS_Y] = fx.add(d[FighterField.POS_Y] as number, fx.fromInt(150));
  d[FighterField.GROUNDED] = 0;
  return sim;
}

/** Fighter 0 falling toward the floor with every jump already spent. */
function simFallingWithNoJumpsLeft(): Sim {
  const sim = new Sim(1, 2);
  sim.advance(NO_INPUT);
  const d = dataOf(sim);
  d[FighterField.POS_Y] = fx.add(d[FighterField.POS_Y] as number, fx.fromInt(60));
  d[FighterField.GROUNDED] = 0;
  d[FighterField.JUMPS_USED] = MAX_JUMPS;
  return sim;
}

describe('Sim: coyote time', () => {
  it('lets a jump pressed shortly after leaving the ground be a full grounded jump', () => {
    const sim = simJustOffLedge();
    for (let i = 0; i < COYOTE_TICKS / 2; i++) sim.advance(NO_INPUT);
    sim.advance(JUMP);
    const f = sim.getFighter(0);
    assert.equal(f.jumpsUsed, 1);
    assert.ok(f.velY > fx.sub(JUMP_VELOCITY, fx.fromInt(1)), 'should get the full grounded jump velocity');
  });

  it('gives only the weaker aerial jump once the coyote window has passed', () => {
    const sim = simJustOffLedge();
    for (let i = 0; i < COYOTE_TICKS + 4; i++) sim.advance(NO_INPUT);
    sim.advance(JUMP);
    assert.ok(sim.getFighter(0).velY < JUMP_VELOCITY - fx.fromInt(1), 'late press must not be a grounded jump');
  });

  it('never grants a third jump after a jump was already used', () => {
    const sim = new Sim(1, 2);
    sim.advance(JUMP); // grounded jump
    sim.advance(NO_INPUT);
    sim.advance(JUMP); // aerial jump
    sim.advance(NO_INPUT);
    assert.equal(sim.getFighter(0).jumpsUsed, MAX_JUMPS);
    sim.advance(JUMP);
    assert.equal(sim.getFighter(0).jumpsUsed, MAX_JUMPS);
  });
});

describe('Sim: jump buffer', () => {
  function ticksUntilLanding(): number {
    const sim = simFallingWithNoJumpsLeft();
    let n = 0;
    while (!sim.getFighter(0).grounded) {
      sim.advance(NO_INPUT);
      n++;
      assert.ok(n < 200, 'fighter never landed');
    }
    return n;
  }

  function jumpedAfterPressingTicksBeforeLanding(ticksBefore: number): boolean {
    const landing = ticksUntilLanding();
    const sim = simFallingWithNoJumpsLeft();
    for (let i = 0; i < landing - ticksBefore; i++) sim.advance(NO_INPUT);
    sim.advance(JUMP);
    for (let i = 0; i < ticksBefore + 2; i++) sim.advance(NO_INPUT);
    return sim.getFighter(0).jumpsUsed > 0 && sim.getFighter(0).velY > 0;
  }

  it('fires a jump pressed just before landing', () => {
    assert.equal(jumpedAfterPressingTicksBeforeLanding(JUMP_BUFFER_TICKS - 2), true);
  });

  it('forgets a jump pressed too long before landing', () => {
    assert.equal(jumpedAfterPressingTicksBeforeLanding(JUMP_BUFFER_TICKS + 4), false);
  });
});
