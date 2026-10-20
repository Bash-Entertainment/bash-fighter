// Timed Brawl crown: the sole KO leader is worth CROWN_KO_VALUE when knocked out.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Sim, FighterField, CROWN_KO_VALUE, crownHolderOf } from '../src/sim.ts';
import * as fx from '../src/math/fixed.ts';
import { PLACEHOLDER_CHARACTER } from '../../content/src/characters/placeholder/data.ts';

const CHARS = [PLACEHOLDER_CHARACTER, PLACEHOLDER_CHARACTER, PLACEHOLDER_CHARACTER] as const;

describe('crownHolderOf', () => {
  it('needs a sole leader with at least one KO', () => {
    assert.equal(crownHolderOf([0, 0, 0]), null);
    assert.equal(crownHolderOf([1, 0, 0]), 0);
    assert.equal(crownHolderOf([1, 3, 2]), 1);
    assert.equal(crownHolderOf([3, 1, 3]), null);
  });
});

function setKo(sim: Sim, i: number, n: number): void {
  const d = (sim as unknown as { data: Int32Array }).data;
  d[i * FighterField.FIELD_COUNT + FighterField.KO_COUNT] = n;
}

function knockOut(sim: Sim, victim: number, attacker: number): number {
  const d = (sim as unknown as { data: Int32Array }).data;
  const vb = victim * FighterField.FIELD_COUNT;
  d[vb + FighterField.LAST_ATTACKER] = attacker;
  d[vb + FighterField.LAST_HIT_TICK] = sim.getTick();
  const before = sim.getFighter(attacker).koCount;
  d[vb + FighterField.POS_X] = fx.fromInt(100000);
  (sim as unknown as { checkBlastZone(i: number): void }).checkBlastZone(victim);
  return sim.getFighter(attacker).koCount - before;
}

describe('crown bonus', () => {
  const make = (winCondition: 'timedKO' | 'battleRoyale') => new Sim(1, 3, CHARS, undefined, { winCondition });

  it('knocking out the sole leader is worth the bonus', () => {
    const sim = make('timedKO');
    setKo(sim, 0, 2);
    assert.equal(sim.getCrownHolder(), 0);
    assert.equal(knockOut(sim, 0, 1), CROWN_KO_VALUE);
  });
  it('a tied lead has no crown, so a knockout is worth 1', () => {
    const sim = make('timedKO');
    setKo(sim, 0, 2);
    setKo(sim, 2, 2);
    assert.equal(knockOut(sim, 0, 1), 1);
  });
  it('no crown outside Timed Brawl', () => {
    const sim = make('battleRoyale');
    setKo(sim, 0, 2);
    assert.equal(sim.getCrownHolder(), null);
    assert.equal(knockOut(sim, 0, 1), 1);
  });
});
