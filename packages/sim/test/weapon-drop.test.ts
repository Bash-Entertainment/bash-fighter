// Weapon Drop: weapon slots are handed a Slam Bat while empty-handed, the
// refill follows a swing, and it all stops at weaponUntilTick.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Sim, MAX_ITEMS, FighterField } from '../src/sim.ts';
import { makeInputFrame, BUTTON_ATTACK } from '../src/types.ts';
import { ItemTypeId } from '../src/items/types.ts';
import * as fx from '../src/math/fixed.ts';
import { FighterStateId } from '../src/entities/fighter.ts';
import { PLACEHOLDER_CHARACTER } from '../../content/src/characters/placeholder/data.ts';
import { BASH_FIGHTER_ITEM_SET } from '../../content/src/items/data.ts';

const NEUTRAL = makeInputFrame(0, 0, 0);
const ATTACK = makeInputFrame(BUTTON_ATTACK);
const CHARS = [PLACEHOLDER_CHARACTER, PLACEHOLDER_CHARACTER];

function heldBy(sim: Sim, fighter: number): number | null {
  for (let s = 0; s < MAX_ITEMS; s++) {
    const it = sim.getItem(s);
    if (it.active && it.state === 1 && it.holder === fighter) return it.typeId;
  }
  return null;
}

function makeSim(): Sim {
  return new Sim(7, 2, CHARS, undefined, {
    winCondition: 'timedKO', weaponSlots: [0], weaponUntilTick: 600, weaponRefillTicks: 120, itemSpawnIntervalTicks: 1_000_000,
  }, BASH_FIGHTER_ITEM_SET);
}

function run(sim: Sim, ticks: number, input = NEUTRAL): void {
  for (let i = 0; i < ticks; i++) sim.advance([input, NEUTRAL]);
}

describe('Weapon Drop', () => {
  it('hands the weapon slot a bat, and only that slot', () => {
    const sim = makeSim();
    run(sim, 125);
    assert.equal(heldBy(sim, 0), ItemTypeId.BAT);
    assert.equal(heldBy(sim, 1), null);
  });

  it('refills after a swing and stops after weaponUntilTick', () => {
    const sim = makeSim();
    run(sim, 125);
    run(sim, 1, ATTACK);
    run(sim, 1);
    assert.equal(heldBy(sim, 0), null, 'the swing consumes the bat');
    run(sim, 125);
    assert.equal(heldBy(sim, 0), ItemTypeId.BAT, 'refilled within one refill period');
    run(sim, 600);
    run(sim, 1, ATTACK);
    run(sim, 300);
    assert.equal(heldBy(sim, 0), null, 'no refills after weaponUntilTick');
  });

  it('with weaponOnRespawn, a respawn comes with a bat after the first minute', () => {
    const sim = new Sim(7, 2, CHARS, undefined, {
      winCondition: 'timedKO', weaponSlots: [0], weaponUntilTick: 0, weaponOnRespawn: true,
      itemSpawnIntervalTicks: 1_000_000,
    }, BASH_FIGHTER_ITEM_SET);
    const buf = sim.createStateBuffer();
    sim.saveState(buf);
    buf[FighterField.POS_Y] = fx.fromInt(-500) as number;
    buf[FighterField.GROUNDED] = 0;
    sim.loadState(buf);
    let respawned = false;
    for (let t = 0; t < 1200 && !respawned; t++) {
      sim.advance([NEUTRAL, NEUTRAL]);
      respawned = sim.getFighter(0).deathCount > 0 && sim.getFighter(0).state !== FighterStateId.RESPAWN;
    }
    assert.ok(respawned, 'a blast-zone exit leads to a respawn');
    assert.equal(heldBy(sim, 0), ItemTypeId.BAT);
  });

  it('is off by default', () => {
    const sim = new Sim(7, 2, CHARS, undefined, { winCondition: 'timedKO' }, BASH_FIGHTER_ITEM_SET);
    run(sim, 300);
    assert.equal(heldBy(sim, 0), null);
  });
});
