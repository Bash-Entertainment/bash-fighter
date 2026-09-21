// Wisp: hit-and-run ranged skirmisher, the roster's eighth character.
// The sim has no traveling-projectile entity, so a "projectile zoner" is
// expressed the same way Reed's zoning is: a disjointed hitbox pushed far
// from the body. Wisp deliberately does NOT duplicate Reed's niche --
// Reed wins neutral by committing to long, slow, high-endlag pokes that
// punish a whiff hard (space control). Wisp is the opposite half of
// zoning: the FASTEST startup+endlag of any ranged hitbox in the cast
// (faster even than Scrapper's close-range jab), for the lowest damage/
// knockback growth in the game -- poke, retreat, repeat, never truly
// committing. A caught Wisp also dies fast: it is the lightest fighter
// in the roster.
//
// 2026-09-10 balance correction: every offset originally matched or beat
// Reed's own reach (e.g. forward tilt tip at 33 units vs Reed's 30) while
// also being more than twice as fast start-to-finish -- Wisp had no real
// weakness relative to Reed's archetype, just a strictly better version
// of it (same or greater range, comparable or higher damage-per-frame,
// far less punishable). Offsets pulled in on all four moves so every one
// now reaches clearly *shorter* than the equivalent Reed move (jab tip
// 17 vs Reed 19, forward tilt 26 vs 30, up/down air 25 vs 25.5) while
// keeping Wisp's real identity -- still faster and safer than Reed on
// every move, still longer-ranged than the placeholder baseline -- so
// speed is traded against range instead of getting both for free.
//
// Weight: 65 (lightest in the cast, below Voltling's 70). weightTerm =
// 150/(65+50) = 1.304 -- the most knockback of any fighter, ~30% more
// than baseline. The tradeoff for the cast's fastest, safest pokes.
//
// Hurtbox: 11x30 -- narrower than Reed's 10x36 is tall-for-narrow, but
// Wisp is shorter and slighter overall, reading as a small drifting
// silhouette rather than Reed's upright stalk (see
// render/fighter-shape-wisp.ts).
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
          offsetX: fromFloat(13),
          offsetY: fromFloat(2),
          width: fromFloat(8),
          height: fromFloat(5),
          angleIdx: 80,
          damage: fromInt(1),
          baseKnockback: fromFloat(1.5),
          knockbackGrowth: fromFloat(0.25),
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
      duration: 4,
      hitboxes: [
        {
          id: 0,
          offsetX: fromFloat(19),
          offsetY: fromFloat(2),
          width: fromFloat(14),
          height: fromFloat(5),
          angleIdx: 100,
          damage: fromInt(3),
          baseKnockback: fromFloat(3.5),
          knockbackGrowth: fromFloat(0.35),
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
    { kind: 'startup', duration: 4, hitboxes: [] },
    {
      kind: 'active',
      duration: 4,
      hitboxes: [
        {
          id: 0,
          offsetX: fromFloat(0),
          offsetY: fromFloat(18),
          width: fromFloat(7),
          height: fromFloat(14),
          angleIdx: 256,
          damage: fromInt(4),
          baseKnockback: fromFloat(4.5),
          knockbackGrowth: fromFloat(0.4),
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
          offsetY: fromFloat(-18),
          width: fromFloat(7),
          height: fromFloat(14),
          angleIdx: 768,
          damage: fromInt(5),
          baseKnockback: fromFloat(5.5),
          knockbackGrowth: fromFloat(0.45),
          priority: 2,
        },
      ],
    },
    { kind: 'endlag', duration: 14, hitboxes: [] },
  ],
};

export const WISP_CHARACTER: CharacterData = {
  name: 'Wisp',
  blurb: 'poker · quickest pokes, feeble damage',
  weight: fromFloat(65),
  hurtboxWidth: fromFloat(11),
  hurtboxHeight: fromFloat(30),
  moves: [jab, forwardTilt, upAir, downAir],
};
