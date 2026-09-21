// Reed: the fourth real character, a zoner -- long disjointed reach on
// every move instead of Ballast's raw power or Voltling's raw speed.
// The fourth archetype bucket the roster was missing: none of Placeholder
// (balanced), Ballast (slow/tanky/hard-hitting) or Voltling (fast/frail/
// hits-and-runs) actually change *spacing* -- they all threaten from
// roughly the same distance. Reed doesn't: every hitbox's offsetX/offsetY
// is pushed noticeably farther from the body than the equivalent
// placeholder move, so Reed can hit an opponent who cannot hit back.
// The tradeoff for that reach is commitment: startup AND endlag are both
// longer than the placeholder's equivalent (whiffing a poke is genuinely
// punishable), and damage/knockback growth sit a little below baseline --
// Reed wins by controlling neutral and stacking pokes, not by landing one
// huge read.
//
// Weight: 90 (slightly under the placeholder's baseline 100, not down at
// Voltling's 70). weightTerm = 150 / (weight + 50):
//   placeholder: 150/150 = 1.0     (baseline)
//   reed:        150/140 = 1.071   (~7% MORE knockback than baseline --
//                                    a light "keep-away" fighter that
//                                    still can't fully tank a hit that
//                                    does land, but nowhere near as
//                                    fragile as Voltling)
//
// Hurtbox: narrower than the placeholder (width 10 vs 16) but taller
// (height 36 vs 32) -- a slim, upright "reed" silhouette that is a
// genuinely different shape to spot among 20 fighters (see render/
// fighter-shape-reed.ts), not just a recolour of an existing capsule.
import { fromFloat, fromInt } from '../../../../sim/src/math/fixed.ts';
import { MoveId, type CharacterData, type MoveDef } from '../../../../sim/src/moves/types.ts';

const jab: MoveDef = {
  id: MoveId.JAB,
  name: 'Jab',
  windows: [
    { kind: 'startup', duration: 4, hitboxes: [] },
    {
      kind: 'active',
      duration: 3,
      hitboxes: [
        {
          id: 0,
          offsetX: fromFloat(14), // vs placeholder jab's offsetX 8 -- a quick short jab that still out-reaches the baseline
          offsetY: fromFloat(3),
          width: fromFloat(10),
          height: fromFloat(6),
          angleIdx: 80,
          damage: fromInt(2),
          baseKnockback: fromFloat(2.5),
          knockbackGrowth: fromFloat(0.3),
          priority: 1,
        },
      ],
    },
    { kind: 'endlag', duration: 10, hitboxes: [] },
  ],
};

const forwardTilt: MoveDef = {
  id: MoveId.FTILT,
  name: 'Forward Tilt',
  windows: [
    { kind: 'startup', duration: 10, hitboxes: [] },
    {
      kind: 'active',
      // Long active window (poke lingers to control space) vs the
      // placeholder's 3 -- this is the signature "long disjointed poke".
      duration: 6,
      hitboxes: [
        {
          id: 0,
          offsetX: fromFloat(22), // vs placeholder's 11 -- roughly double the reach
          offsetY: fromFloat(2),
          width: fromFloat(16),
          height: fromFloat(6),
          angleIdx: 100,
          damage: fromInt(5),
          baseKnockback: fromFloat(5.0),
          knockbackGrowth: fromFloat(0.5),
          priority: 2,
        },
      ],
    },
    { kind: 'endlag', duration: 22, hitboxes: [] }, // long endlag: a whiffed poke is genuinely punishable
  ],
};

const upAir: MoveDef = {
  id: MoveId.UAIR,
  name: 'Up Air',
  windows: [
    { kind: 'startup', duration: 10, hitboxes: [] },
    {
      kind: 'active',
      duration: 5,
      hitboxes: [
        {
          id: 0,
          offsetX: fromFloat(0),
          offsetY: fromFloat(18), // vs placeholder's 8 -- a long vertical spike
          width: fromFloat(8),
          height: fromFloat(15),
          angleIdx: 256, // straight up
          damage: fromInt(6),
          baseKnockback: fromFloat(6.5),
          knockbackGrowth: fromFloat(0.6),
          priority: 2,
        },
      ],
    },
    { kind: 'endlag', duration: 22, hitboxes: [] },
  ],
};

const downAir: MoveDef = {
  id: MoveId.DAIR,
  name: 'Down Air',
  windows: [
    { kind: 'startup', duration: 12, hitboxes: [] },
    {
      kind: 'active',
      duration: 6,
      hitboxes: [
        {
          id: 0,
          offsetX: fromFloat(0),
          offsetY: fromFloat(-18), // vs placeholder's -8 -- reaches well below the body
          width: fromFloat(8),
          height: fromFloat(15),
          angleIdx: 768, // straight down
          damage: fromInt(7),
          baseKnockback: fromFloat(7.5),
          knockbackGrowth: fromFloat(0.65),
          priority: 3,
        },
      ],
    },
    { kind: 'endlag', duration: 26, hitboxes: [] },
  ],
};

export const REED_CHARACTER: CharacterData = {
  name: 'Reed',
  blurb: 'zoner · long reach, big commitment',
  weight: fromFloat(90),
  hurtboxWidth: fromFloat(10),
  hurtboxHeight: fromFloat(36),
  moves: [jab, forwardTilt, upAir, downAir],
};
