import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HINT_IDLE_AFTER_GO_MS,
  isEnemyInRange,
  shouldShowAttackHint,
  type AttackHintSample,
} from '../src/attack-hint.ts';

const quiet: AttackHintSample = { msSinceGo: 1000, attackOrSpecialPressed: false, enemyInRange: false, tookDamage: false };

test('attack hint: stays hidden while nothing relevant has happened', () => {
  assert.equal(shouldShowAttackHint(quiet), false);
});

test('attack hint: never shows during the countdown', () => {
  assert.equal(shouldShowAttackHint({ ...quiet, msSinceGo: null, enemyInRange: true, tookDamage: true }), false);
});

test('attack hint: shows for a nearby enemy, damage taken, or the idle timeout', () => {
  assert.equal(shouldShowAttackHint({ ...quiet, enemyInRange: true }), true);
  assert.equal(shouldShowAttackHint({ ...quiet, tookDamage: true }), true);
  assert.equal(shouldShowAttackHint({ ...quiet, msSinceGo: HINT_IDLE_AFTER_GO_MS - 1 }), false);
  assert.equal(shouldShowAttackHint({ ...quiet, msSinceGo: HINT_IDLE_AFTER_GO_MS }), true);
});

test('attack hint: an attack or special press suppresses every trigger', () => {
  const pressed = { ...quiet, attackOrSpecialPressed: true };
  assert.equal(shouldShowAttackHint({ ...pressed, enemyInRange: true, tookDamage: true, msSinceGo: 99999 }), false);
});

test('attack hint: enemy range is a box around the local fighter', () => {
  assert.equal(isEnemyInRange(20, -10), true);
  assert.equal(isEnemyInRange(30, 0), false);
  assert.equal(isEnemyInRange(0, 25), false);
});
