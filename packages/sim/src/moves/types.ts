// Frame data as data (Engine Architecture section 3 / part 2 section 7).
import type { Fixed } from '../math/fixed.ts';

export const MoveId = {
  JAB: 0,
  FTILT: 1,
  UAIR: 2,
  DAIR: 3,
} as const;
export type MoveIdValue = (typeof MoveId)[keyof typeof MoveId];

export interface HitboxDef {
  id: number;
  offsetX: Fixed;
  offsetY: Fixed;
  width: Fixed;
  height: Fixed;
  angleIdx: number;
  damage: Fixed;
  baseKnockback: Fixed;
  knockbackGrowth: Fixed;
  priority: number;
}

export type FrameWindowKind = 'startup' | 'active' | 'endlag';

export interface FrameWindow {
  kind: FrameWindowKind;
  duration: number;
  hitboxes: readonly HitboxDef[];
  flags?: { cancellable?: boolean };
}

export interface MoveDef {
  id: MoveIdValue;
  name: string;
  windows: readonly FrameWindow[];
}

export interface CharacterData {
  name: string;
  /** Short newcomer-facing archetype line shown on the character select card. */
  blurb?: string;
  weight: Fixed;
  hurtboxWidth: Fixed;
  hurtboxHeight: Fixed;
  moves: readonly MoveDef[];
}

export function moveTotalDuration(move: MoveDef): number {
  let total = 0;
  for (const w of move.windows) total += w.duration;
  return total;
}

export function windowAtFrame(
  move: MoveDef,
  frame: number,
): { window: FrameWindow; frameInWindow: number } | null {
  let acc = 0;
  for (const w of move.windows) {
    if (frame < acc + w.duration) {
      return { window: w, frameInWindow: frame - acc };
    }
    acc += w.duration;
  }
  return null;
}

export function findMove(character: CharacterData, id: MoveIdValue): MoveDef | undefined {
  return character.moves.find((m) => m.id === id);
}
