// Zephyr: acrobatic, mobility-focused lightweight, the roster's seventh
// character. The sim has no per-character jump/air-speed stats (jump
// velocity and gravity are global constants in packages/sim/src/sim.ts),
// so Zephyr's "acrobatic" identity is expressed through its moveset: both
// aerials have the fastest startup of any character's aerials AND a long
// active window (a lingering spin/sweep rather than a single instant),
// so it threatens throughout more of its airtime than any other
// character -- the closest this schema allows to "unusual air options".
// Ground moves are quick but the weakest single hits in the cast; Zephyr
// wins by staying airborne and mobile, not by out-lasting or out-hitting.
//
// Distinct from Voltling: Voltling is a ground/air glass cannon whose
// identity is raw speed + high knockback growth (dies fast, kills a
// little faster than baseline too). Zephyr's knockback growth sits BELOW
// baseline on every move -- it is not trying to kill off one read, it is
// trying to out-stay an opponent in the air and pick fights it controls.
//
// Weight: 75 (light, between Voltling's 70 and Reed's 90). weightTerm =
// 150/(75+50) = 1.2 -- 20% more knockback than baseline, fragile but not
// the single most fragile fighter in the cast.
//
// Hurtbox: 13x24 -- the shortest hurtbox in the entire cast (shorter than
// Voltling's 12x26), a low, crouched, coiled-to-jump stance (see
// render/fighter-shape-zephyr.ts).
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
          offsetX: fromFloat(7),
          offsetY: fromFloat(2),
          width: fromFloat(7),
          height: fromFloat(7),
          angleIdx: 80,
          damage: fromInt(2),
          baseKnockback: fromFloat(2.2),
          knockbackGrowth: fromFloat(0.35),
          priority: 1,
        },
      ],
    },
    { kind: 'endlag', duration: 7, hitboxes: [] },
  ],
};

const forwardTilt: MoveDef = {
  id: MoveId.FTILT,
  name: 'Forward Tilt',
  windows: [
    { kind: 'startup', duration: 5, hitboxes: [] },
    {
      kind: 'active',
      duration: 3,
      hitboxes: [
        {
          id: 0,
          offsetX: fromFloat(9),
          offsetY: fromFloat(2),
          width: fromFloat(8),
          height: fromFloat(8),
          angleIdx: 100,
          damage: fromInt(4),
          baseKnockback: fromFloat(4.5),
          knockbackGrowth: fromFloat(0.5),
          priority: 2,
        },
      ],
    },
    { kind: 'endlag', duration: 11, hitboxes: [] },
  ],
};

const upAir: MoveDef = {
  id: MoveId.UAIR,
  name: 'Up Air',
  windows: [
    { kind: 'startup', duration: 3, hitboxes: [] },
    {
      kind: 'active',
      duration: 6,
      hitboxes: [
        {
          id: 0,
          offsetX: fromFloat(0),
          offsetY: fromFloat(11),
          width: fromFloat(9),
          height: fromFloat(12),
          angleIdx: 256,
          damage: fromInt(5),
          baseKnockback: fromFloat(5.0),
          knockbackGrowth: fromFloat(0.55),
          priority: 2,
        },
      ],
    },
    { kind: 'endlag', duration: 10, hitboxes: [] },
  ],
};

const downAir: MoveDef = {
  id: MoveId.DAIR,
  name: 'Down Air',
  windows: [
    { kind: 'startup', duration: 4, hitboxes: [] },
    {
      kind: 'active',
      duration: 6,
      hitboxes: [
        {
          id: 0,
          offsetX: fromFloat(0),
          offsetY: fromFloat(-11),
          width: fromFloat(9),
          height: fromFloat(12),
          angleIdx: 768,
          damage: fromInt(6),
          baseKnockback: fromFloat(6.0),
          knockbackGrowth: fromFloat(0.6),
          priority: 2,
        },
      ],
    },
    { kind: 'endlag', duration: 12, hitboxes: [] },
  ],
};

export const ZEPHYR_CHARACTER: CharacterData = {
  name: 'Zephyr',
  blurb: 'acrobat · fast aerials',
  weight: fromFloat(75),
  hurtboxWidth: fromFloat(13),
  hurtboxHeight: fromFloat(24),
  moves: [jab, forwardTilt, upAir, downAir],
};
