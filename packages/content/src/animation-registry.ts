// Maps a roster entry to its AnimationParams, same lookup pattern as
// characters.ts's ALL_CHARACTERS -- a contributor adding a character adds
// one line here alongside their characters.ts entry. Keyed by the same
// stable `id` as CharacterEntry, not by display name.
import type { AnimationParams } from './animation/types.ts';
import { PLACEHOLDER_ANIMATION } from './characters/placeholder/animation.ts';
import { BALLAST_ANIMATION } from './characters/ballast/animation.ts';
import { VOLTLING_ANIMATION } from './characters/voltling/animation.ts';
import { REED_ANIMATION } from './characters/reed/animation.ts';
import { WISP_ANIMATION } from './characters/wisp/animation.ts';
import { ZEPHYR_ANIMATION } from './characters/zephyr/animation.ts';
import { ANCHOR_ANIMATION } from './characters/anchor/animation.ts';
import { SCRAPPER_ANIMATION } from './characters/scrapper/animation.ts';

// Keyed by CharacterData.name (not the roster `id` from characters.ts):
// packages/render only ever has a CharacterData in hand (from the sim's
// per-fighter state), never the roster id, so this is the lookup render
// actually needs. characters.ts's roster ids remain the wire/UI identity.
export const ANIMATION_BY_CHARACTER_NAME: Readonly<Record<string, AnimationParams>> = {
  Slate: PLACEHOLDER_ANIMATION,
  Ballast: BALLAST_ANIMATION,
  Voltling: VOLTLING_ANIMATION,
  Reed: REED_ANIMATION,
  Wisp: WISP_ANIMATION,
  Zephyr: ZEPHYR_ANIMATION,
  Anchor: ANCHOR_ANIMATION,
  Scrapper: SCRAPPER_ANIMATION,
};

/** Falls back to placeholder's params for any unknown/missing name. */
export function resolveAnimation(characterName: string | null | undefined): AnimationParams {
  if (characterName && characterName in ANIMATION_BY_CHARACTER_NAME) {
    return ANIMATION_BY_CHARACTER_NAME[characterName] as AnimationParams;
  }
  return PLACEHOLDER_ANIMATION;
}
