// The Quarry-specific geometry checks: the ziggurat's tiers are
// symmetric and every raised tier is pass-through (escapable straight
// down, no camp-forever perch) -- properties specific to this stage's
// design, on top of the generic checks in arenas.test.ts and
// spawn-clearance.test.ts that already run against every registered
// arena including this one.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { THE_QUARRY_ARENA } from '../src/arenas/the-quarry/data.ts';
import * as fx from '../../sim/src/math/fixed.ts';

describe('The Quarry', () => {
  it('is registered with a stable id', async () => {
    const { ALL_ARENAS } = await import('../src/arenas.ts');
    const entry = ALL_ARENAS.find((a) => a.arena === THE_QUARRY_ARENA);
    assert.ok(entry, 'The Quarry is not registered in ALL_ARENAS');
    assert.equal(entry!.id, 'the-quarry');
  });

  it('has one solid ground floor and every raised tier is pass-through', () => {
    const [ground, ...tiers] = THE_QUARRY_ARENA.platforms;
    assert.equal(ground!.kind, undefined, 'the ground floor should be solid (no kind), not pass-through');
    for (const tier of tiers) {
      assert.equal(tier!.kind, 'pass-through', 'every raised tier must be pass-through so it cannot be camped');
    }
  });

  it('the raised tiers are left/right symmetric around x=0', () => {
    const raised = THE_QUARRY_ARENA.platforms.filter((p) => fx.toFloat(p.y) !== 0);
    for (const p of raised) {
      const minX = fx.toFloat(p.minX);
      const maxX = fx.toFloat(p.maxX);
      const mirrored = raised.find((q) => {
        const qMinX = fx.toFloat(q.minX);
        const qMaxX = fx.toFloat(q.maxX);
        return fx.toFloat(q.y) === fx.toFloat(p.y) && Math.abs(qMinX - -maxX) < 1e-6 && Math.abs(qMaxX - -minX) < 1e-6;
      });
      assert.ok(mirrored, `platform [${minX},${maxX}]@y=${fx.toFloat(p.y)} has no left/right mirror (apex platforms spanning x=0 are exempt via self-match)`);
    }
  });

  it('has no walls (an open ziggurat, unlike The Foundry/The Spire)', () => {
    assert.deepEqual(THE_QUARRY_ARENA.walls ?? [], []);
  });
});
