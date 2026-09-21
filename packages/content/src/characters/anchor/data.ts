// Anchor: heavy grappler-styled bruiser, the roster's sixth character.
// The moveset schema (packages/sim/src/moves/types.ts) has no separate
// grab/throw mechanic -- only the same four-hitbox-move shape every
// character uses -- so Anchor's "grappler" identity is expressed the way
// the task allows: the single heaviest weight in the cast plus the
// biggest, slowest, most disjointed hitboxes of any character, reading
// as a fighter that swallows an opponent into a crushing hold rather
// than landing a clean strike. It is heavier and slower than Ballast in
// every stat -- not a re-skin, the actual floor of the cast's speed axis.
//
// Weight: 170 (heaviest in the cast, vs Ballast's 140). weightTerm =
// 150/(170+50) = 0.682 -- Anchor takes ~32% LESS knockback than baseline
// (vs Ballast's ~21% less), the least-launchable fighter in the game.
// Every move's startup+endlag is the slowest of any roster character, so
// that resistance is bought at the cost of huge whiff punishment windows.
//
// Hurtbox: 24x34 -- the widest AND tallest hurtbox in the cast (Ballast
// is 20x30), reading as a hulking mass rather than Ballast's compact
// riveted ball (see render/fighter-shape-anchor.ts for the silhouette).
import { fromFloat, fromInt } from '../../../../sim/src/math/fixed.ts';
import { MoveId, type CharacterData, type MoveDef } from '../../../../sim/src/moves/types.ts';

const jab: MoveDef = {
  id: MoveId.JAB,
  name: 'Jab',
  windows: [
    { kind: 'startup', duration: 8, hitboxes: [] },
    {
      kind: 'active',
      duration: 4,
      hitboxes: [
        {
          id: 0,
          offsetX: fromFloat(16),
          offsetY: fromFloat(3),
          width: fromFloat(18),
          height: fromFloat(16),
          angleIdx: 80,
          damage: fromInt(6),
          baseKnockback: fromFloat(6.0),
          knockbackGrowth: fromFloat(0.5),
          priority: 2,
        },
      ],
    },
    { kind: 'endlag', duration: 18, hitboxes: [] },
  ],
};

const forwardTilt: MoveDef = {
  id: MoveId.FTILT,
  name: 'Forward Tilt',
  windows: [
    { kind: 'startup', duration: 14, hitboxes: [] },
    {
      kind: 'active',
      duration: 6,
      hitboxes: [
        {
          id: 0,
          offsetX: fromFloat(22),
          offsetY: fromFloat(2),
          width: fromFloat(22),
          height: fromFloat(18),
          angleIdx: 100,
          damage: fromInt(13),
          baseKnockback: fromFloat(13.0),
          knockbackGrowth: fromFloat(1.0),
          priority: 3,
        },
      ],
    },
    { kind: 'endlag', duration: 30, hitboxes: [] },
  ],
};

const upAir: MoveDef = {
  id: MoveId.UAIR,
  name: 'Up Air',
  windows: [
    { kind: 'startup', duration: 16, hitboxes: [] },
    {
      kind: 'active',
      duration: 7,
      hitboxes: [
        {
          id: 0,
          offsetX: fromFloat(0),
          offsetY: fromFloat(24),
          width: fromFloat(20),
          height: fromFloat(20),
          angleIdx: 256,
          damage: fromInt(15),
          baseKnockback: fromFloat(15.0),
          knockbackGrowth: fromFloat(1.1),
          priority: 3,
        },
      ],
    },
    { kind: 'endlag', duration: 34, hitboxes: [] },
  ],
};

const downAir: MoveDef = {
  id: MoveId.DAIR,
  name: 'Down Air',
  windows: [
    { kind: 'startup', duration: 18, hitboxes: [] },
    {
      kind: 'active',
      duration: 8,
      hitboxes: [
        {
          id: 0,
          offsetX: fromFloat(0),
          offsetY: fromFloat(-24),
          width: fromFloat(20),
          height: fromFloat(22),
          angleIdx: 768,
          damage: fromInt(18),
          baseKnockback: fromFloat(18.0),
          knockbackGrowth: fromFloat(1.3),
          priority: 4,
        },
      ],
    },
    { kind: 'endlag', duration: 38, hitboxes: [] },
  ],
};

export const ANCHOR_CHARACTER: CharacterData = {
  name: 'Anchor',
  blurb: 'fortress · hard to launch',
  weight: fromFloat(170),
  hurtboxWidth: fromFloat(24),
  hurtboxHeight: fromFloat(34),
  moves: [jab, forwardTilt, upAir, downAir],
};
