// First-match knockout boost: the rookie knockback multiplier applies only
// when a rookie slot hits a bot slot.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Sim } from '../src/sim.ts';
import { ROOKIE_KNOCKBACK_SCALE, type MatchSettings } from '../src/match-settings.ts';
import { makeInputFrame, BUTTON_ATTACK } from '../src/types.ts';
import * as fx from '../src/math/fixed.ts';
import { PLACEHOLDER_CHARACTER } from '../../content/src/characters/placeholder/data.ts';

/** Fighter 0 walks up to fighter 1 and jabs; returns fighter 1's knockback speed on the hit tick. */
function jabSpeed(settings: Partial<MatchSettings>): number {
  const sim = new Sim(1, 2, [PLACEHOLDER_CHARACTER, PLACEHOLDER_CHARACTER], undefined, {
    winCondition: 'stocks', startingStocks: 3, rookieKnockbackScale: ROOKIE_KNOCKBACK_SCALE, ...settings,
  });
  const step = fx.fromFloat(0.2);
  for (let i = 0; i < 2000; i++) {
    const dx = fx.sub(sim.getFighter(1).posX, sim.getFighter(0).posX);
    if (fx.abs(dx) <= fx.fromFloat(1.2)) break;
    const towards = dx > 0 ? step : fx.neg(step);
    sim.advance([makeInputFrame(0, towards, 0), makeInputFrame(0, fx.neg(towards), 0)]);
  }
  for (let i = 0; i < 20; i++) {
    sim.advance([makeInputFrame(BUTTON_ATTACK, 0, 0), makeInputFrame(0, 0, 0)]);
    const v = sim.getFighter(1);
    if (v.percent > 0) return Math.hypot(fx.toFloat(v.velX), fx.toFloat(v.velY));
  }
  throw new Error('jab never connected');
}

describe('Rookie knockback boost', () => {
  const base = jabSpeed({});

  it('scales knockback when a rookie hits a bot', () => {
    const boosted = jabSpeed({ rookieSlots: [0], botSlots: [1] });
    assert.ok(Math.abs(boosted / base - fx.toFloat(ROOKIE_KNOCKBACK_SCALE)) < 0.02, `${boosted} vs ${base}`);
  });

  it('does not apply to a rookie hitting a human, or a non-rookie hitting a bot', () => {
    assert.equal(jabSpeed({ rookieSlots: [0], botSlots: [] }), base);
    assert.equal(jabSpeed({ rookieSlots: [1], botSlots: [0, 1] }), base);
  });
});
