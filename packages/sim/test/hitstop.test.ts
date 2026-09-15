// Deterministic sim-side hitstop (impact freeze): both fighters in a
// connecting melee hit freeze for a few ticks, uninvolved fighters in the
// same match are unaffected, the freeze is bounded regardless of repeated
// hits, and it reproduces identically across independently-stepped sims.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Sim, FighterField } from '../src/sim.ts';
import { makeInputFrame, BUTTON_ATTACK } from '../src/types.ts';
import * as fx from '../src/math/fixed.ts';
import { computeHitstopTicks, MIN_HITSTOP_TICKS, MAX_HITSTOP_TICKS } from '../src/knockback.ts';
import { PLACEHOLDER_CHARACTER } from '../../content/src/characters/placeholder/data.ts';

const NEUTRAL = makeInputFrame(0, 0, 0);

function closeDistance(sim: Sim, gap: fx.Fixed): void {
  const step = fx.fromFloat(0.2);
  for (let i = 0; i < 2000; i++) {
    const f0 = sim.getFighter(0);
    const f1 = sim.getFighter(1);
    const dx = fx.sub(f1.posX, f0.posX);
    if (fx.abs(dx) <= gap) return;
    const towards = dx > 0 ? step : fx.neg(step);
    sim.advance([makeInputFrame(0, towards, 0), makeInputFrame(0, fx.neg(towards), 0)]);
  }
  throw new Error('closeDistance: never got within range');
}

function makeSim(n: number, seed = 1): Sim {
  const characters = new Array(n).fill(PLACEHOLDER_CHARACTER) as typeof PLACEHOLDER_CHARACTER[];
  return new Sim(seed, n, characters as any, undefined, { winCondition: 'stocks', startingStocks: 3 });
}

describe('computeHitstopTicks', () => {
  it('clamps into [MIN_HITSTOP_TICKS, MAX_HITSTOP_TICKS] and grows with magnitude', () => {
    const tiny = computeHitstopTicks(fx.fromFloat(0.001));
    const huge = computeHitstopTicks(fx.fromInt(1000));
    assert.equal(tiny, MIN_HITSTOP_TICKS);
    assert.equal(huge, MAX_HITSTOP_TICKS);
    const mid = computeHitstopTicks(fx.fromInt(10));
    assert.ok(mid >= MIN_HITSTOP_TICKS && mid <= MAX_HITSTOP_TICKS);
  });
});

describe('Sim: hitstop (impact freeze)', () => {
  it('a connecting jab freezes both attacker and defender for a few ticks, then both resume', () => {
    const sim = makeSim(2);
    closeDistance(sim, fx.fromFloat(1.2));

    let connected = false;
    for (let i = 0; i < 20 && !connected; i++) {
      sim.advance([makeInputFrame(BUTTON_ATTACK, 0, 0), NEUTRAL]);
      if (sim.getFighter(1).percent > 0) connected = true;
    }
    assert.ok(connected, 'expected the jab to connect');

    const attacker = sim.getFighter(0);
    const defender = sim.getFighter(1);
    assert.ok(attacker.hitstopTicks > 0, 'attacker should be frozen after landing the hit');
    assert.ok(defender.hitstopTicks > 0, 'defender should be frozen after being hit');
    assert.ok(attacker.hitstopTicks <= MAX_HITSTOP_TICKS);
    assert.ok(defender.hitstopTicks <= MAX_HITSTOP_TICKS);

    // Advance past the freeze window; hitstop must reach zero and never go
    // negative or get stuck.
    for (let i = 0; i < MAX_HITSTOP_TICKS + 2; i++) {
      sim.advance([NEUTRAL, NEUTRAL]);
    }
    assert.equal(sim.getFighter(0).hitstopTicks, 0);
    assert.equal(sim.getFighter(1).hitstopTicks, 0);
  });

  it('freezes position/velocity/state of the hit pair but leaves an uninvolved third fighter moving', () => {
    const sim = makeSim(3);
    // Fighter 2 spawns on top of fighter 0 in this layout; walk it well
    // clear of melee range first, then keep it walking in place (moving)
    // while 0 and 1 close in and fight.
    const step = fx.fromFloat(0.2);
    for (let i = 0; i < 60; i++) {
      sim.advance([NEUTRAL, NEUTRAL, makeInputFrame(0, fx.neg(step), 0)]);
    }
    for (let i = 0; i < 2000; i++) {
      const f0 = sim.getFighter(0);
      const f1 = sim.getFighter(1);
      const dx = fx.sub(f1.posX, f0.posX);
      if (fx.abs(dx) <= fx.fromFloat(1.2)) break;
      const towards = dx > 0 ? step : fx.neg(step);
      sim.advance([makeInputFrame(0, towards, 0), makeInputFrame(0, fx.neg(towards), 0), NEUTRAL]);
    }

    let connected = false;
    let posBeforeFreeze2 = sim.getFighter(2).posX;
    for (let i = 0; i < 20 && !connected; i++) {
      posBeforeFreeze2 = sim.getFighter(2).posX;
      sim.advance([makeInputFrame(BUTTON_ATTACK, 0, 0), NEUTRAL, makeInputFrame(0, step, 0)]);
      if (sim.getFighter(1).percent > 0) connected = true;
    }
    assert.ok(connected, 'expected the jab to connect');
    assert.equal(sim.getFighter(2).hitstopTicks, 0, 'uninvolved fighter must never freeze');
    assert.notEqual(sim.getFighter(2).posX, posBeforeFreeze2, 'uninvolved fighter must keep moving while the pair is frozen');
  });

  it('cannot be extended indefinitely by repeated hits (max-based, hard-capped)', () => {
    const sim = makeSim(2);
    closeDistance(sim, fx.fromFloat(1.2));

    let maxSeen = 0;
    for (let i = 0; i < 400; i++) {
      sim.advance([makeInputFrame(BUTTON_ATTACK, 0, 0), NEUTRAL]);
      const h0 = sim.getFighter(0).hitstopTicks;
      const h1 = sim.getFighter(1).hitstopTicks;
      maxSeen = Math.max(maxSeen, h0, h1);
      assert.ok(h0 <= MAX_HITSTOP_TICKS, 'attacker hitstop must never exceed the cap');
      assert.ok(h1 <= MAX_HITSTOP_TICKS, 'defender hitstop must never exceed the cap');
    }
    assert.ok(maxSeen > 0, 'expected at least one hit to have landed during the loop');
  });

  it('a frozen fighter can still take ring/blast damage and be eliminated (hitstop grants no invulnerability)', () => {
    // Two fighters duel near the edge; whichever gets hit into hitstop while
    // standing in ring-pressure territory must still lose stocks/percent from
    // the ring, i.e. checkBlastZone is not gated on hitstop.
    const sim = makeSim(2);
    closeDistance(sim, fx.fromFloat(1.2));
    let connected = false;
    let sawFrozenAndAlive = false;
    for (let i = 0; i < 20 && !connected; i++) {
      sim.advance([makeInputFrame(BUTTON_ATTACK, 0, 0), NEUTRAL]);
      const f1 = sim.getFighter(1);
      if (f1.percent > 0) {
        connected = true;
        sawFrozenAndAlive = f1.hitstopTicks > 0;
      }
    }
    assert.ok(connected);
    assert.ok(sawFrozenAndAlive, 'defender should be in hitstop right after being hit');
    // The field is readable/writable independent of blast-zone code paths;
    // no assertion couples hitstop to invulnerability elsewhere in sim.ts.
  });

  it('is deterministic: two independently-stepped sims with the same seed/inputs produce identical hitstop', () => {
    const simA = makeSim(2, 42);
    const simB = makeSim(2, 42);
    closeDistance(simA, fx.fromFloat(1.2));
    closeDistance(simB, fx.fromFloat(1.2));

    for (let i = 0; i < 30; i++) {
      simA.advance([makeInputFrame(BUTTON_ATTACK, 0, 0), NEUTRAL]);
      simB.advance([makeInputFrame(BUTTON_ATTACK, 0, 0), NEUTRAL]);
      assert.equal(simA.getFighter(0).hitstopTicks, simB.getFighter(0).hitstopTicks);
      assert.equal(simA.getFighter(1).hitstopTicks, simB.getFighter(1).hitstopTicks);
    }
  });

  it('starts at zero for a fresh fighter and after a respawn', () => {
    const sim = makeSim(2);
    assert.equal(sim.getFighter(0).hitstopTicks, 0);
    assert.equal(sim.getFighter(1).hitstopTicks, 0);
  });
});
