// Scrapper: rushdown brawler, the roster's fifth character. Everyone else
// wins by out-ranging (Reed), out-lasting (Ballast/Anchor) or fleeing
// (Voltling/Zephyr/Wisp). Scrapper's game plan is the opposite of all of
// them: get in close and stay there. Every move is the shortest-range,
// fastest-startup, fastest-endlag hit in the entire cast -- shorter reach
// than even the placeholder's baseline -- traded for the ability to throw
// out another hit again almost immediately. Damage per hit is modest;
// the threat is frequency, not a single big read.
//
// Weight: 95 (just under baseline). weightTerm = 150/(95+50) = 1.034 --
// close to neutral, because Scrapper's defensive tradeoff isn't fragility
// (like Voltling/Wisp), it's committing to close range against a whole
// FFA lobby, which is dangerous enough on its own.
//
// Hurtbox: 18x28 -- wider and squatter than the placeholder's 16x32, a
// low, stocky brawler stance, a genuinely different silhouette from the
// tall capsule/stalk shapes elsewhere in the cast (see
// render/fighter-shape-scrapper.ts).
import { fromFloat, fromInt } from '../../../../sim/src/math/fixed.ts';
import { MoveId, type CharacterData, type MoveDef } from '../../../../sim/src/moves/types.ts';

const jab: MoveDef = {
  id: MoveId.JAB,
  name: 'Jab',
  windows: [
    { kind: 'startup', duration: 1, hitboxes: [] },
    {
      kind: 'active',
      duration: 2,
      hitboxes: [
        {
          id: 0,
          offsetX: fromFloat(9),
          offsetY: fromFloat(2),
          width: fromFloat(8),
          height: fromFloat(8),
          angleIdx: 80,
          damage: fromInt(2),
          baseKnockback: fromFloat(1.8),
          knockbackGrowth: fromFloat(0.3),
          priority: 1,
        },
      ],
    },
    { kind: 'endlag', duration: 5, hitboxes: [] },
  ],
};

const forwardTilt: MoveDef = {
  id: MoveId.FTILT,
  name: 'Forward Tilt',
  windows: [
    { kind: 'startup', duration: 3, hitboxes: [] },
    {
      kind: 'active',
      duration: 3,
      hitboxes: [
        {
          id: 0,
          offsetX: fromFloat(9),
          offsetY: fromFloat(2),
          width: fromFloat(10),
          height: fromFloat(9),
          angleIdx: 100,
          damage: fromInt(4),
          baseKnockback: fromFloat(4.5),
          knockbackGrowth: fromFloat(0.5),
          priority: 2,
        },
      ],
    },
    { kind: 'endlag', duration: 8, hitboxes: [] },
  ],
};

const upAir: MoveDef = {
  id: MoveId.UAIR,
  name: 'Up Air',
  windows: [
    { kind: 'startup', duration: 4, hitboxes: [] },
    {
      kind: 'active',
      duration: 3,
      hitboxes: [
        {
          id: 0,
          offsetX: fromFloat(0),
          offsetY: fromFloat(10),
          width: fromFloat(10),
          height: fromFloat(8),
          angleIdx: 256,
          damage: fromInt(5),
          baseKnockback: fromFloat(5.5),
          knockbackGrowth: fromFloat(0.55),
          priority: 2,
        },
      ],
    },
    { kind: 'endlag', duration: 12, hitboxes: [] },
  ],
};

const downAir: MoveDef = {
  id: MoveId.DAIR,
  name: 'Down Air',
  windows: [
    { kind: 'startup', duration: 5, hitboxes: [] },
    {
      kind: 'active',
      duration: 4,
      hitboxes: [
        {
          id: 0,
          offsetX: fromFloat(0),
          offsetY: fromFloat(-10),
          width: fromFloat(10),
          height: fromFloat(9),
          angleIdx: 768,
          damage: fromInt(6),
          baseKnockback: fromFloat(6.5),
          knockbackGrowth: fromFloat(0.6),
          priority: 2,
        },
      ],
    },
    { kind: 'endlag', duration: 14, hitboxes: [] },
  ],
};

export const SCRAPPER_CHARACTER: CharacterData = {
  name: 'Scrapper',
  blurb: 'brawler · fastest jab',
  weight: fromFloat(95),
  hurtboxWidth: fromFloat(18),
  hurtboxHeight: fromFloat(28),
  moves: [jab, forwardTilt, upAir, downAir],
};
