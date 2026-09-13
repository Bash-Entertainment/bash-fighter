// Regression tests for the 2026-09-09 arena-shrink rework (see wiki "Arena
// Collapse Cascade: Why Matches End With Nobody Left 2026-09-09" and
// "Arena Shrink Rework: Fighting Decides Matches 2026-09-09"). These
// assert outcomes a player would notice, not implementation details:
// a full field is never squeezed by the boundary, matches resolve to one
// winner, and a fighter who never presses a button does not win.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Sim } from '../src/sim.ts';
import { BotController, BotDifficulty, deriveBotSeed } from '../src/ai/bot.ts';
import { makeInputFrame } from '../src/types.ts';
import {
  computeCurrentBlastRect,
  computeGroundHalfExtents,
  computeSafeExtents,
  computeShrinkProgress,
} from '../src/arena-shrink.ts';
import { resolveMatchSettings } from '../src/match-settings.ts';
import { ALL_ARENAS } from '../../content/src/arenas.ts';
import * as fx from '../src/math/fixed.ts';

const N = 20;
const SETTINGS = resolveMatchSettings({});

function pickArena(seed: number) {
  const entry = ALL_ARENAS[seed % ALL_ARENAS.length]!;
  return entry;
}

function runBotMatch(seed: number, tickCeiling: number, passiveIndex = -1) {
  const arena = pickArena(seed).arena;
  const sim = new Sim(seed, N, undefined, arena);
  const idle = makeInputFrame(0, 0, 0);
  const bots = Array.from({ length: N }, (_, i) =>
    i === passiveIndex ? null : new BotController(i, BotDifficulty.HARD, deriveBotSeed(seed, i)),
  );
  let ticks = 0;
  while (!sim.isMatchOver() && ticks < tickCeiling) {
    const inputs = bots.map((b) => (b ? b.nextInput(sim) : idle));
    sim.advance(inputs);
    ticks++;
  }
  return { sim, ticks, arena };
}

describe('Arena shrink: boundary never crosses standing ground while the field is full', () => {
  it('at full alive count, the current blast rect always contains every platform, for every arena and every tick of the schedule', () => {
    for (const { id, arena } of ALL_ARENAS) {
      const ground = computeGroundHalfExtents(arena);
      for (let tick = 0; tick <= SETTINGS.shrinkFullyClosedTick; tick += 500) {
        const rect = computeCurrentBlastRect(arena, tick, N, N, SETTINGS);
        assert.ok(
          fx.toFloat(rect.minX) <= fx.toFloat(ground.minX) + 1e-6,
          `${id}: rect.minX ${fx.toFloat(rect.minX)} crossed ground.minX ${fx.toFloat(ground.minX)} at tick ${tick} with full field alive`,
        );
        assert.ok(
          fx.toFloat(rect.maxX) >= fx.toFloat(ground.maxX) - 1e-6,
          `${id}: rect.maxX ${fx.toFloat(rect.maxX)} crossed ground.maxX ${fx.toFloat(ground.maxX)} at tick ${tick} with full field alive`,
        );
      }
    }
  });

  it('a fighter standing at the arena centre, doing nothing, is never eliminated by the boundary across the whole shrink schedule for any alive count', () => {
    for (const { id, arena } of ALL_ARENAS) {
      for (let alive = N; alive >= 1; alive--) {
        for (let tick = 0; tick <= SETTINGS.shrinkFullyClosedTick; tick += 1000) {
          const rect = computeCurrentBlastRect(arena, tick, alive, N, SETTINGS);
          assert.ok(fx.toFloat(rect.minX) < 0, `${id} alive=${alive} tick=${tick}: centre not inside rect`);
          assert.ok(fx.toFloat(rect.maxX) > 0, `${id} alive=${alive} tick=${tick}: centre not inside rect`);
        }
      }
    }
  });
});

describe('Arena shrink: the elimination-driven term cannot cascade on its own', () => {
  it('at tick 0, no matter how many fighters have already been eliminated, shrink progress never exceeds the alive-term cap (0.6)', () => {
    for (let eliminated = 0; eliminated < N; eliminated++) {
      const progress = computeShrinkProgress(0, N - eliminated, N, SETTINGS);
      assert.ok(fx.toFloat(progress) <= 0.6 + 1e-3, `progress ${fx.toFloat(progress)} exceeded cap with ${eliminated} eliminated at tick 0`);
    }
  });

  it('progress is monotonically non-decreasing in eliminations at a fixed tick', () => {
    let prev = -1;
    for (let eliminated = 0; eliminated < N; eliminated++) {
      const progress = fx.toFloat(computeShrinkProgress(1000, N - eliminated, N, SETTINGS));
      assert.ok(progress >= prev - 1e-9, `progress decreased: ${progress} < ${prev} at eliminated=${eliminated}`);
      prev = progress;
    }
  });
});

describe('Arena shrink: full 20-fighter bot matches resolve decisively', () => {
  const SEEDS = [1001, 1002, 1003, 1004, 1005];
  // 8 minute hard ceiling: generous beyond the 4-minute shrink clock so a
  // legitimate stalemate (two cautious survivors both declining to engage
  // in the final ring) still has time to be forced together and decided,
  // rather than the test racing the schedule.
  const TICK_CEILING = 60 * 60 * 10;

  it('every match ends with Sim.isMatchOver() true and exactly one survivor (ties on simultaneous elimination are rare, checked separately)', () => {
    let noSurvivorCount = 0;
    for (const seed of SEEDS) {
      const { sim, ticks } = runBotMatch(seed, TICK_CEILING);
      assert.ok(sim.isMatchOver(), `seed ${seed} did not end within ${TICK_CEILING} ticks (ran ${ticks})`);
      let survivors = 0;
      for (let i = 0; i < N; i++) if (!sim.getFighter(i).eliminated) survivors++;
      if (survivors === 0) noSurvivorCount++;
      assert.ok(survivors <= 1, `seed ${seed} ended with ${survivors} survivors, expected at most 1`);
    }
    // "Nobody survived" should be rare, not routine.
    assert.ok(noSurvivorCount <= 1, `${noSurvivorCount}/${SEEDS.length} seeds ended with no survivor -- too common`);
  });
});

describe('Arena shrink: a passive fighter does not win', () => {
  const SEEDS = [2001, 2002, 2003];
  const TICK_CEILING = 60 * 60 * 6;

  it('a fighter that never presses a button does not end the match as the winner, across several seeds', () => {
    for (const seed of SEEDS) {
      const { sim } = runBotMatch(seed, TICK_CEILING, /* passiveIndex */ 0);
      const passive = sim.getFighter(0);
      assert.notStrictEqual(passive.placement, 1, `seed ${seed}: passive fighter won (placement 1)`);
    }
  });
});

describe('Arena shrink: fully-closed floor keeps shrinking below FINAL_RING_FIGHTERS (regression for the-foundry seed 1003)', () => {
  it('the floor for a 2-fighter endgame is narrower than the floor for a 6-fighter endgame, on every stage', () => {
    // Regression for the 2026-09-10 defect: once the field thinned below
    // FINAL_RING_FIGHTERS (6), the fully-closed ring floor used to stay
    // pinned at the 6-fighter size forever (or wider, if a stage's
    // convergence platform was roomier), so the last couple of survivors
    // could circle safely inside it indefinitely and the match would
    // never resolve (see scripts/repro/repro-foundry-1003.ts). The floor
    // must keep contracting as fewer fighters remain, all the way down to
    // a true final-duel size.
    const fighterCount = 20;
    const tick = 0; // tick 0 so the time-based schedule (t) plays no role -- isolates the alive-count effect
    for (const entry of ALL_ARENAS) {
      const settings = resolveMatchSettings({});
      const sixLeft = computeSafeExtents(entry.arena, 6, fighterCount, tick, settings);
      const twoLeft = computeSafeExtents(entry.arena, 2, fighterCount, tick, settings);
      const sixWidth = sixLeft.maxX - sixLeft.minX;
      const twoWidth = twoLeft.maxX - twoLeft.minX;
      assert.ok(
        twoWidth < sixWidth,
        `${entry.id}: expected the 2-survivor floor (${twoWidth}) to be narrower than the 6-survivor floor (${sixWidth})`,
      );
    }
  });

  it('the-foundry seed 1003 at HARD resolves to exactly one survivor within the tick ceiling', () => {
    const seed = 1003;
    // Look this up by id, not by `seed % ALL_ARENAS.length` -- that modulo
    // trick is exactly the kind of thing that silently breaks whenever a
    // new stage is registered (see docs/ADDING_A_STAGE.md's gate-fragility
    // note, added when The Quarry became the sixth arena and shifted every
    // index-derived pick in this suite).
    const entry = ALL_ARENAS.find((a) => a.id === 'the-foundry')!;
    assert.ok(entry, 'the-foundry must remain registered in ALL_ARENAS for this regression test');
    const N = 20;
    const sim = new Sim(seed, N, undefined, entry.arena);
    const bots = Array.from({ length: N }, (_, i) => new BotController(i, BotDifficulty.HARD, deriveBotSeed(seed, i)));
    const TICK_CEILING = 60 * 60 * 10;
    let ticks = 0;
    while (!sim.isMatchOver() && ticks < TICK_CEILING) {
      const inputs = bots.map((b) => b.nextInput(sim));
      sim.advance(inputs);
      ticks++;
    }
    assert.ok(sim.isMatchOver(), `match did not end within ${TICK_CEILING} ticks`);
    let survivors = 0;
    for (let i = 0; i < N; i++) if (!sim.getFighter(i).eliminated) survivors++;
    assert.equal(survivors, 1, `expected exactly one survivor, got ${survivors}`);
  });
});
