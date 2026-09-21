// Ballast: the second real character, authored the same way as
// packages/content/src/characters/placeholder/data.ts (Engine Architecture
// part 2 section 7). A heavy, deliberate bruiser -- a round, riveted iron
// weight with a single stubby limb -- built to read as a completely
// different silhouette from the placeholder's capsule-plus-head at a
// glance in a 20-fighter FFA, and to play like a slow, hard-hitting
// heavyweight rather than the placeholder's balanced baseline.
//
// Weight: 140 (vs the placeholder's baseline 100, see [[Combat Model:
// Knockback, Hitstun, and DI]]). weightTerm = 150 / (weight + 50):
//   placeholder: 150 / 150 = 1.0   (the project's defined baseline)
//   ballast:     150 / 190 = 0.789 -- Ballast takes ~21% less knockback
// magnitude than the placeholder from an identical hit, the standard
// "heavyweight is harder to launch" trade-off. In exchange every one of
// its own moves is both slower (higher startup/endlag) and hits for more
// damage and knockback than the placeholder's equivalent slot, so it
// plays as a slow, hard-punishing bruiser rather than a faster/weaker or
// floatier archetype -- a deliberately different playstyle bucket from
// the placeholder, not just re-skinned numbers.
import { fromFloat, fromInt } from '../../../../sim/src/math/fixed.ts';
import { MoveId, type CharacterData, type MoveDef } from '../../../../sim/src/moves/types.ts';

const jab: MoveDef = {
  id: MoveId.JAB,
  name: 'Jab',
  windows: [
    { kind: 'startup', duration: 5, hitboxes: [] },
    {
      kind: 'active',
      duration: 3,
      hitboxes: [
        {
          id: 0,
          offsetX: fromFloat(11),
          offsetY: fromFloat(3),
          width: fromFloat(11),
          height: fromFloat(11),
          angleIdx: 80,
          damage: fromInt(4),
          baseKnockback: fromFloat(4.0),
          knockbackGrowth: fromFloat(0.4),
          priority: 1,
        },
      ],
    },
    { kind: 'endlag', duration: 12, hitboxes: [] },
  ],
};

const forwardTilt: MoveDef = {
  id: MoveId.FTILT,
  name: 'Forward Tilt',
  windows: [
    { kind: 'startup', duration: 9, hitboxes: [] },
    {
      kind: 'active',
      duration: 4,
      hitboxes: [
        {
          id: 0,
          offsetX: fromFloat(14),
          offsetY: fromFloat(2),
          width: fromFloat(14),
          height: fromFloat(11),
          angleIdx: 100,
          damage: fromInt(9),
          baseKnockback: fromFloat(9.0),
          knockbackGrowth: fromFloat(0.85),
          priority: 2,
        },
      ],
    },
    { kind: 'endlag', duration: 20, hitboxes: [] },
  ],
};

const upAir: MoveDef = {
  id: MoveId.UAIR,
  name: 'Up Air',
  windows: [
    { kind: 'startup', duration: 12, hitboxes: [] },
    {
      kind: 'active',
      duration: 5,
      hitboxes: [
        {
          id: 0,
          offsetX: fromFloat(0),
          offsetY: fromFloat(18),
          width: fromFloat(16),
          height: fromFloat(11),
          angleIdx: 256, // straight up
          damage: fromInt(11),
          baseKnockback: fromFloat(11.0),
          knockbackGrowth: fromFloat(1.0),
          priority: 2,
        },
      ],
    },
    { kind: 'endlag', duration: 26, hitboxes: [] },
  ],
};

const downAir: MoveDef = {
  id: MoveId.DAIR,
  name: 'Down Air',
  windows: [
    { kind: 'startup', duration: 14, hitboxes: [] },
    {
      kind: 'active',
      duration: 7,
      hitboxes: [
        {
          id: 0,
          offsetX: fromFloat(0),
          offsetY: fromFloat(-18),
          width: fromFloat(16),
          height: fromFloat(13),
          angleIdx: 768, // straight down
          damage: fromInt(14),
          baseKnockback: fromFloat(14.0),
          knockbackGrowth: fromFloat(1.15),
          priority: 3,
        },
      ],
    },
    { kind: 'endlag', duration: 30, hitboxes: [] },
  ],
};

export const BALLAST_CHARACTER: CharacterData = {
  name: 'Ballast',
  blurb: 'heavyweight · slow, hits hard',
  weight: fromFloat(140),
  hurtboxWidth: fromFloat(20),
  hurtboxHeight: fromFloat(30),
  moves: [jab, forwardTilt, upAir, downAir],
};
