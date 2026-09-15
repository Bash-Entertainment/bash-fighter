// Unit tests for detectFighterEvents/detectItemEvents against hand-built
// snapshot pairs (no real Sim needed -- these functions only read plain
// snapshot fields). Covers the new coverage added for the audio-depth
// pass: hit damage/weight-independent data, elimination own/other,
// finalTwo, and victory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixed as fx, FighterStateId, type FighterSnapshot, type ItemSnapshot } from '@bash-fighter/sim';
import { detectFighterEvents, detectItemEvents } from '../src/effects-events.ts';

function baseFighter(overrides: Partial<FighterSnapshot> = {}): FighterSnapshot {
  return {
    posX: fx.fromFloat(0),
    posY: fx.fromFloat(0),
    velX: fx.fromFloat(0),
    velY: fx.fromFloat(0),
    state: FighterStateId.IDLE,
    facing: 1,
    grounded: true,
    moveId: -1,
    moveFrame: 0,
    hitstopTicks: 0,
    percent: fx.fromFloat(0),
    stocks: 3,
    shieldHealth: fx.fromFloat(100),
    shieldStun: 0,
    hitstun: 0,
    koCount: 0,
    deathCount: 0,
    invulnTicks: 0,
    eliminated: false,
    eliminatedTick: -1,
    placement: 0,
    jumpsUsed: 0,
    inRingDanger: false,
    ...overrides,
  };
}

test('detectFighterEvents: a landed hit reports its damage delta', () => {
  const prev = [baseFighter({ percent: fx.fromFloat(0), velX: fx.fromFloat(0) })];
  const curr = [baseFighter({ percent: fx.fromFloat(9), velX: fx.fromFloat(3) })];
  const events = detectFighterEvents(prev, curr, 1);
  const hit = events.find((e) => e.type === 'hit');
  assert.ok(hit && hit.type === 'hit');
  assert.ok(Math.abs((hit as { damage: number }).damage - 9) < 0.01);
});

test('detectFighterEvents: a shield-absorbed hit is a block, not a hit', () => {
  const prev = [baseFighter({ state: FighterStateId.SHIELD, shieldHealth: fx.fromFloat(100) })];
  const curr = [baseFighter({ state: FighterStateId.SHIELD, shieldHealth: fx.fromFloat(90) })];
  const events = detectFighterEvents(prev, curr, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'block');
});

test('detectFighterEvents: elimination fires once, on the falling edge', () => {
  const prev = [baseFighter({ eliminated: false })];
  const curr = [baseFighter({ eliminated: true })];
  const events = detectFighterEvents(prev, curr, 1);
  assert.deepEqual(events, [{ type: 'eliminated', fighterIndex: 0 }]);

  const curr2 = [baseFighter({ eliminated: true })];
  const noRepeat = detectFighterEvents(curr, curr2, 1);
  assert.equal(noRepeat.length, 0);
});

test('detectFighterEvents: victory fires when a fighter resolves to placement 1', () => {
  const prev = [baseFighter({ placement: 0 }), baseFighter({ placement: 0 })];
  const curr = [baseFighter({ placement: 1 }), baseFighter({ placement: 0 })];
  const events = detectFighterEvents(prev, curr, 2);
  assert.ok(events.some((e) => e.type === 'victory' && e.fighterIndex === 0));
});

test('detectFighterEvents: finalTwo fires once when alive count drops from >2 to 2', () => {
  const prev = [
    baseFighter({ eliminated: false }),
    baseFighter({ eliminated: false }),
    baseFighter({ eliminated: false }),
  ];
  const curr = [
    baseFighter({ eliminated: false }),
    baseFighter({ eliminated: false }),
    baseFighter({ eliminated: true }),
  ];
  const events = detectFighterEvents(prev, curr, 3);
  assert.ok(events.some((e) => e.type === 'finalTwo'));

  // Does not fire again once already at 2.
  const prev2 = curr;
  const curr2 = curr.map((f) => ({ ...f }));
  const repeat = detectFighterEvents(prev2, curr2, 3);
  assert.ok(!repeat.some((e) => e.type === 'finalTwo'));
});

test('detectFighterEvents: a 1v1 match never fires finalTwo', () => {
  const prev = [baseFighter(), baseFighter()];
  const curr = [baseFighter(), baseFighter({ eliminated: true })];
  const events = detectFighterEvents(prev, curr, 2);
  assert.ok(!events.some((e) => e.type === 'finalTwo'));
});

function baseItem(overrides: Partial<ItemSnapshot> = {}): ItemSnapshot {
  return {
    active: true,
    typeId: 0,
    posX: fx.fromFloat(0),
    posY: fx.fromFloat(0),
    velX: fx.fromFloat(0),
    velY: fx.fromFloat(0),
    state: 0,
    holder: -1,
    fuseTicks: 0,
    ...overrides,
  } as ItemSnapshot;
}

test('detectItemEvents: pickup fires when an item transitions into held state', () => {
  const prev = [baseItem({ state: 0, holder: -1 })];
  const curr = [baseItem({ state: 1, holder: 2 })];
  const events = detectItemEvents(prev, curr, 1);
  assert.deepEqual(events, [{ type: 'itemPickup', fighterIndex: 2 }]);
});

test('detectItemEvents: use fires when an armed item stops being armed', () => {
  const prev = [baseItem({ state: 3, active: true })];
  const curr = [baseItem({ state: 0, active: false })];
  const events = detectItemEvents(prev, curr, 1);
  assert.deepEqual(events, [{ type: 'itemUse', slot: 0 }]);
});
