// Aerial attacks used to zero horizontal velocity for their whole duration:
// holding forward through the placeholder's aerial moved the fighter 0 units
// in 33 ticks (a free fall drifts ~148). Genre convention (and this sim's own
// AIRBORNE handling) is full air control, so aerials now drift with the stick;
// grounded attacks still root the fighter.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Sim } from '../src/sim.ts';
import { FighterStateId } from '../src/entities/fighter.ts';
import { BUTTON_ATTACK, BUTTON_JUMP, makeInputFrame } from '../src/types.ts';
import * as fx from '../src/math/fixed.ts';
import { PLACEHOLDER_CHARACTER } from '../../content/src/characters/placeholder/data.ts';

const CHARACTERS = [PLACEHOLDER_CHARACTER, PLACEHOLDER_CHARACTER];

const IDLE = makeInputFrame();
const RIGHT = makeInputFrame(0, fx.ONE);
const step = (sim: Sim, input = IDLE) => sim.advance([input, IDLE]);

function settle(sim: Sim): void {
  for (let i = 0; i < 120 && !sim.getFighter(0).grounded; i++) step(sim);
  assert.ok(sim.getFighter(0).grounded, 'fighter should land before the test starts');
}

describe('Sim: attacks and horizontal movement', () => {
  it('an aerial drifts with the stick while it plays out', () => {
    const sim = new Sim(1, 2, CHARACTERS);
    settle(sim);
    step(sim, makeInputFrame(BUTTON_JUMP));
    for (let i = 0; i < 3; i++) step(sim);
    step(sim, makeInputFrame(BUTTON_ATTACK, fx.ONE));
    assert.equal(sim.getFighter(0).state, FighterStateId.ATTACK);
    const startX = sim.getFighter(0).posX;
    for (let i = 0; i < 6; i++) step(sim, RIGHT);
    const f = sim.getFighter(0);
    assert.equal(f.state, FighterStateId.ATTACK, 'still mid-aerial');
    assert.ok(f.posX > startX, 'holding forward moves the fighter during the aerial');
  });

  it('a grounded attack still roots the fighter', () => {
    const sim = new Sim(1, 2, CHARACTERS);
    settle(sim);
    step(sim, makeInputFrame(BUTTON_ATTACK, fx.ONE));
    const startX = sim.getFighter(0).posX;
    for (let i = 0; i < 4; i++) step(sim, RIGHT);
    assert.equal(sim.getFighter(0).state, FighterStateId.ATTACK);
    assert.equal(sim.getFighter(0).posX, startX);
  });
});
