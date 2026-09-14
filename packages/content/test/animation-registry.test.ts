// ANIMATION_BY_CHARACTER_NAME is keyed by CharacterData.name, not by the
// roster id, because packages/render only ever holds a CharacterData.
// That coupling is invisible and silent: rename a character and every
// fighter of that character quietly falls back to the placeholder
// animation params, with no error and no failing test. Renaming
// 'Placeholder' to 'Slate' on 2026-09-14 could have done exactly that,
// so the coupling is now pinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_CHARACTERS } from '../src/characters.ts';
import { ANIMATION_BY_CHARACTER_NAME, resolveAnimation } from '../src/animation-registry.ts';
import { PLACEHOLDER_ANIMATION } from '../src/characters/placeholder/animation.ts';

test('every roster character has animation params registered under its display name', () => {
  for (const entry of ALL_CHARACTERS) {
    assert.ok(
      entry.character.name in ANIMATION_BY_CHARACTER_NAME,
      `${entry.id} ("${entry.character.name}") has no animation registered under its display name -- ` +
        'it would silently fall back to the placeholder animation',
    );
  }
});

test('the registry has no entries for names no character uses', () => {
  const rosterNames = new Set(ALL_CHARACTERS.map((e) => e.character.name));
  for (const key of Object.keys(ANIMATION_BY_CHARACTER_NAME)) {
    assert.ok(rosterNames.has(key), `animation registered for "${key}", which no roster character is named`);
  }
});

test('each non-baseline character resolves to its own params, not the shared fallback', () => {
  const nonBaseline = ALL_CHARACTERS.filter((e) => e.id !== 'placeholder');
  assert.ok(nonBaseline.length >= 7, 'roster shrank unexpectedly');
  for (const entry of nonBaseline) {
    assert.notEqual(
      resolveAnimation(entry.character.name),
      PLACEHOLDER_ANIMATION,
      `${entry.character.name} resolved to the placeholder animation -- registry key drift`,
    );
  }
});

test('an unknown or missing name still resolves to something drawable', () => {
  assert.equal(resolveAnimation('NoSuchCharacter'), PLACEHOLDER_ANIMATION);
  assert.equal(resolveAnimation(undefined), PLACEHOLDER_ANIMATION);
  assert.equal(resolveAnimation(null), PLACEHOLDER_ANIMATION);
});

test('no player-facing character name is developer scaffolding', () => {
  const banned = /placeholder|todo|tbd|test|dummy|temp|wip|unnamed|character \d/i;
  for (const entry of ALL_CHARACTERS) {
    assert.ok(
      !banned.test(entry.character.name),
      `"${entry.character.name}" reads as unfinished to a player (roster id "${entry.id}" may keep any internal name)`,
    );
  }
});
