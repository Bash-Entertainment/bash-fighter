// The online pre-match countdown: the sim holds still for introFreezeTicks.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Sim } from '../src/sim.ts';
import { hashStateBuffer } from '../src/hash.ts';
import { makeInputFrame, BUTTON_ATTACK } from '../src/types.ts';
import { PLACEHOLDER_CHARACTER } from '../../content/src/characters/placeholder/data.ts';

const CHARACTERS = [PLACEHOLDER_CHARACTER, PLACEHOLDER_CHARACTER] as const;
const NEUTRAL = makeInputFrame(0, 0, 0);
const BUSY = makeInputFrame(BUTTON_ATTACK, 127, 0);
const FREEZE = 30;

function stateHash(sim: Sim): string {
  const buf = sim.createStateBuffer();
  sim.saveState(buf);
  return hashStateBuffer(buf);
}

function makeSim(timeLimitTicks = 50): Sim {
  return new Sim(7, 2, CHARACTERS, undefined, { winCondition: 'timedKO', timeLimitTicks, introFreezeTicks: FREEZE });
}

describe('intro freeze', () => {
  it('inputs during the freeze have no effect on the sim', () => {
    const idle = makeSim();
    const busy = makeSim();
    for (let t = 0; t < FREEZE; t++) {
      idle.advance([NEUTRAL, NEUTRAL]);
      busy.advance([BUSY, BUSY]);
    }
    assert.equal(stateHash(busy), stateHash(idle));
  });

  it('fighters respond to input once the freeze ends', () => {
    const idle = makeSim();
    const busy = makeSim();
    for (let t = 0; t < FREEZE + 10; t++) {
      idle.advance([NEUTRAL, NEUTRAL]);
      busy.advance([BUSY, BUSY]);
    }
    assert.notEqual(stateHash(busy), stateHash(idle));
  });

  it('a timed match still lasts its configured length after the freeze', () => {
    const sim = makeSim(50);
    let ticks = 0;
    while (!sim.isMatchOver()) {
      sim.advance([NEUTRAL, NEUTRAL]);
      ticks++;
    }
    assert.equal(ticks, FREEZE + 50);
  });
});
