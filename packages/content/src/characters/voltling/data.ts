// Voltling: the third real character, authored the same way as
// packages/content/src/characters/{placeholder,ballast}/data.ts. A
// lightweight, fast glass cannon -- the speed/fragility archetype that
// contrasts with both the placeholder's balanced baseline and Ballast's
// slow heavyweight bruiser.
//
// Weight: 70 (vs the placeholder's baseline 100 and Ballast's 140, see
// [[Combat Model: Knockback, Hitstun, and DI]]). weightTerm = 150 / (weight + 50):
//   placeholder: 150 / 150 = 1.0    (the project's defined baseline)
//   ballast:     150 / 190 = 0.789  (~21% LESS knockback than baseline)
//   voltling:    150 / 120 = 1.25   (~25% MORE knockback than baseline)
// so Voltling is launched noticeably harder and dies to combos/edgeguards
// that a heavier fighter would survive -- the "glass" half of glass cannon.
//
// The "cannon" half is speed, not raw power: every move has lower
// startup AND lower endlag than the placeholder's equivalent slot (it
// gets its hits out faster and is exposed to punishment for less time
// afterward), and knockback growth per hit is a little HIGHER than the
// placeholder's despite Voltling's own damage numbers being LOWER --
// so a landed hit still threatens a kill at moderate percent even though
// each individual hit does less raw damage than the baseline. Net
// archetype: hard to punish on offense, dies fast on defense -- a
// deliberately different playstyle bucket from both Ballast (slow/tanky/
// hard-hitting) and the placeholder (balanced), not just re-scaled
// numbers.
import { fromFloat, fromInt } from '../../../../sim/src/math/fixed.ts';
import { MoveId, type CharacterData, type MoveDef } from '../../../../sim/src/moves/types.ts';

const jab: MoveDef = {
  id: MoveId.JAB,
  name: 'Jab',
  windows: [
    { kind: 'startup', duration: 2, hitboxes: [] },
    {
      kind: 'active',
      duration: 2,
      hitboxes: [
        {
          id: 0,
          offsetX: fromFloat(8),
          offsetY: fromFloat(3),
          width: fromFloat(8),
          height: fromFloat(8),
          angleIdx: 80,
          damage: fromInt(2),
          baseKnockback: fromFloat(2.0),
          knockbackGrowth: fromFloat(0.4),
          priority: 1,
        },
      ],
    },
    { kind: 'endlag', duration: 6, hitboxes: [] },
  ],
};

const forwardTilt: MoveDef = {
  id: MoveId.FTILT,
  name: 'Forward Tilt',
  windows: [
    { kind: 'startup', duration: 4, hitboxes: [] },
    {
      kind: 'active',
      duration: 3,
      hitboxes: [
        {
          id: 0,
          offsetX: fromFloat(11),
          offsetY: fromFloat(2),
          width: fromFloat(10),
          height: fromFloat(9),
          angleIdx: 100,
          damage: fromInt(5),
          baseKnockback: fromFloat(5.5),
          knockbackGrowth: fromFloat(0.65),
          priority: 2,
        },
      ],
    },
    { kind: 'endlag', duration: 10, hitboxes: [] },
  ],
};

const upAir: MoveDef = {
  id: MoveId.UAIR,
  name: 'Up Air',
  windows: [
    { kind: 'startup', duration: 6, hitboxes: [] },
    {
      kind: 'active',
      duration: 4,
      hitboxes: [
        {
          id: 0,
          offsetX: fromFloat(0),
          offsetY: fromFloat(14),
          width: fromFloat(12),
          height: fromFloat(9),
          angleIdx: 256, // straight up
          damage: fromInt(7),
          baseKnockback: fromFloat(7.5),
          knockbackGrowth: fromFloat(0.85),
          priority: 2,
        },
      ],
    },
    { kind: 'endlag', duration: 16, hitboxes: [] },
  ],
};

const downAir: MoveDef = {
  id: MoveId.DAIR,
  name: 'Down Air',
  windows: [
    { kind: 'startup', duration: 8, hitboxes: [] },
    {
      kind: 'active',
      duration: 6,
      hitboxes: [
        {
          id: 0,
          offsetX: fromFloat(0),
          offsetY: fromFloat(-14),
          width: fromFloat(12),
          height: fromFloat(11),
          angleIdx: 768, // straight down
          damage: fromInt(8),
          baseKnockback: fromFloat(9.0),
          knockbackGrowth: fromFloat(1.0),
          priority: 3,
        },
      ],
    },
    { kind: 'endlag', duration: 18, hitboxes: [] },
  ],
};

export const VOLTLING_CHARACTER: CharacterData = {
  name: 'Voltling',
  blurb: 'glass cannon · fragile',
  weight: fromFloat(70),
  hurtboxWidth: fromFloat(12),
  hurtboxHeight: fromFloat(26),
  moves: [jab, forwardTilt, upAir, downAir],
};
