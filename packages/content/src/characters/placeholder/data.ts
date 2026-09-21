// The one placeholder character, authored purely as data (Engine
// Architecture part 2 section 7). A contributor adding a new character
// copies this folder, edits the numbers, and never touches packages/sim.
import { fromFloat, fromInt } from '../../../../sim/src/math/fixed.ts';
import { MoveId, type CharacterData, type MoveDef } from '../../../../sim/src/moves/types.ts';

const jab: MoveDef = {
  id: MoveId.JAB,
  name: 'Jab',
  windows: [
    { kind: 'startup', duration: 3, hitboxes: [] },
    {
      kind: 'active',
      duration: 2,
      hitboxes: [
        {
          id: 0,
          offsetX: fromFloat(10),
          offsetY: fromFloat(3),
          width: fromFloat(10),
          height: fromFloat(10),
          angleIdx: 80,
          damage: fromInt(3),
          baseKnockback: fromFloat(3.0),
          knockbackGrowth: fromFloat(0.35),
          priority: 1,
        },
      ],
    },
    { kind: 'endlag', duration: 8, hitboxes: [] },
  ],
};

const forwardTilt: MoveDef = {
  id: MoveId.FTILT,
  name: 'Forward Tilt',
  windows: [
    { kind: 'startup', duration: 6, hitboxes: [] },
    {
      kind: 'active',
      duration: 3,
      hitboxes: [
        {
          id: 0,
          offsetX: fromFloat(13),
          offsetY: fromFloat(2),
          width: fromFloat(12),
          height: fromFloat(10),
          angleIdx: 100,
          damage: fromInt(6),
          baseKnockback: fromFloat(6.0),
          knockbackGrowth: fromFloat(0.6),
          priority: 2,
        },
      ],
    },
    { kind: 'endlag', duration: 14, hitboxes: [] },
  ],
};

const upAir: MoveDef = {
  id: MoveId.UAIR,
  name: 'Up Air',
  windows: [
    { kind: 'startup', duration: 8, hitboxes: [] },
    {
      kind: 'active',
      duration: 4,
      hitboxes: [
        {
          id: 0,
          offsetX: fromFloat(0),
          offsetY: fromFloat(16),
          width: fromFloat(14),
          height: fromFloat(10),
          angleIdx: 256, // straight up
          damage: fromInt(8),
          baseKnockback: fromFloat(8.0),
          knockbackGrowth: fromFloat(0.75),
          priority: 2,
        },
      ],
    },
    { kind: 'endlag', duration: 20, hitboxes: [] },
  ],
};

const downAir: MoveDef = {
  id: MoveId.DAIR,
  name: 'Down Air',
  windows: [
    { kind: 'startup', duration: 10, hitboxes: [] },
    {
      kind: 'active',
      duration: 6,
      hitboxes: [
        {
          id: 0,
          offsetX: fromFloat(0),
          offsetY: fromFloat(-16),
          width: fromFloat(14),
          height: fromFloat(12),
          angleIdx: 768, // straight down
          damage: fromInt(10),
          baseKnockback: fromFloat(10.0),
          knockbackGrowth: fromFloat(0.9),
          priority: 3,
        },
      ],
    },
    { kind: 'endlag', duration: 24, hitboxes: [] },
  ],
};

export const PLACEHOLDER_CHARACTER: CharacterData = {
  // Player-facing name. The roster id stays 'placeholder' (it is the wire
  // identity and the protocol's backward-compatibility fallback), but the
  // name a player reads must not be a developer's scaffolding word: this
  // is the roster's FIRST card and the default selection, so "Placeholder"
  // was the first thing a new player read about our game, and it said
  // "unfinished". Renamed 2026-09-14 after seeing it on the live start
  // screen. Keep in step with ANIMATION_BY_CHARACTER_NAME, which is keyed
  // by this string -- animation-registry.test.ts enforces that.
  name: 'Slate',
  blurb: 'all-rounder · no weakness',
  weight: fromFloat(100),
  hurtboxWidth: fromFloat(16),
  hurtboxHeight: fromFloat(32),
  moves: [jab, forwardTilt, upAir, downAir],
};
