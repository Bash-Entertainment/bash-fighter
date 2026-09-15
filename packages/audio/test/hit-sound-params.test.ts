import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeHitSoundParams } from '../src/index.ts';

describe('computeHitSoundParams: a hit sounds like what it was', () => {
  it('a heavy fighter hit is lower-pitched than a light fighter hit, same damage/strength', () => {
    const light = computeHitSoundParams({ damage: 8, strength: 0.5, weight: 70, seed: 1 });
    const heavy = computeHitSoundParams({ damage: 8, strength: 0.5, weight: 140, seed: 1 });
    assert.ok(heavy.freq < light.freq, `expected heavy freq ${heavy.freq} < light freq ${light.freq}`);
  });

  it('a harder hit (higher strength) rings out longer and louder than a soft one', () => {
    const soft = computeHitSoundParams({ damage: 3, strength: 0.1, weight: 100, seed: 2 });
    const hard = computeHitSoundParams({ damage: 15, strength: 0.9, weight: 100, seed: 2 });
    assert.ok(hard.duration > soft.duration, `expected hard duration ${hard.duration} > soft duration ${soft.duration}`);
    assert.ok(hard.gain > soft.gain, `expected hard gain ${hard.gain} > soft gain ${soft.gain}`);
  });

  it('a shield block is a distinct, weight-independent timbre from a body hit', () => {
    const block70 = computeHitSoundParams({ damage: 0, strength: 0.5, weight: 70, isShield: true, seed: 3 });
    const block140 = computeHitSoundParams({ damage: 0, strength: 0.5, weight: 140, isShield: true, seed: 3 });
    const hit = computeHitSoundParams({ damage: 8, strength: 0.5, weight: 100, seed: 3 });
    assert.equal(block70.freq, block140.freq, 'shield timbre should not depend on the struck fighter\'s weight');
    assert.notEqual(block70.waveform, undefined);
    assert.ok(block70.noiseMix < hit.noiseMix, 'a shield clang should be more tonal (less noisy) than a body hit');
  });

  it('is deterministic: same input always produces the same params (no Math.random leakage)', () => {
    const a = computeHitSoundParams({ damage: 8, strength: 0.5, weight: 100, seed: 42 });
    const b = computeHitSoundParams({ damage: 8, strength: 0.5, weight: 100, seed: 42 });
    assert.deepEqual(a, b);
  });

  it('different seeds give small but real variation, so repeated hits are not identical', () => {
    const a = computeHitSoundParams({ damage: 8, strength: 0.5, weight: 100, seed: 1 });
    const b = computeHitSoundParams({ damage: 8, strength: 0.5, weight: 100, seed: 2 });
    assert.notEqual(a.detuneCents, b.detuneCents);
  });

  it('clamps to sane audible ranges even for extreme inputs', () => {
    const extreme = computeHitSoundParams({ damage: 999, strength: 5, weight: 10000, seed: 4 });
    assert.ok(extreme.freq > 0);
    assert.ok(extreme.duration <= 0.35);
    assert.ok(extreme.gain <= 1);
  });

  it('a weak jab gets no sub-thump, a strong hit gets a real one -- so kill power reads as heavier, not just louder', () => {
    const weak = computeHitSoundParams({ damage: 3, strength: 0.1, weight: 100, seed: 5 });
    const strong = computeHitSoundParams({ damage: 18, strength: 0.95, weight: 100, seed: 5 });
    assert.equal(weak.thumpGain, 0, 'a weak jab should not add sub-thump weight');
    assert.ok(strong.thumpGain > 0.2, `expected a strong hit to have real thump gain, got ${strong.thumpGain}`);
    assert.ok(strong.thumpDuration > 0);
  });

  it('shield blocks never get a sub-thump (the shield absorbs the hit, not the body)', () => {
    const block = computeHitSoundParams({ damage: 0, strength: 0.95, isShield: true, seed: 6 });
    assert.equal(block.thumpGain, 0);
    assert.equal(block.thumpDuration, 0);
  });

  it('thump gain never exceeds sane bounds for extreme strength', () => {
    const extreme = computeHitSoundParams({ damage: 999, strength: 5, weight: 100, seed: 7 });
    assert.ok(extreme.thumpGain <= 0.6);
    assert.ok(extreme.thumpFreq > 0);
  });
});
