import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// No jsdom in this repo, so the character-select blurb is pinned at source
// level, same approach as controls-hint.test.ts.
const CHARACTER_FOLDERS = [
  'placeholder',
  'ballast',
  'voltling',
  'reed',
  'wisp',
  'zephyr',
  'anchor',
  'scrapper',
];

const characterSelect = readFileSync(
  new URL('../src/ui/character-select.ts', import.meta.url),
  'utf8',
);
const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');

// The defect this pins: a raw "weight 90" number meant nothing to a
// newcomer, and the real differences between characters were documented
// only in source comments, so a first-time player picked blind.
test('every character data file sets a non-empty blurb', () => {
  for (const folder of CHARACTER_FOLDERS) {
    const data = readFileSync(
      new URL(`../../content/src/characters/${folder}/data.ts`, import.meta.url),
      'utf8',
    );
    const match = data.match(/blurb:\s*'([^']+)'/);
    assert.ok(match, `expected ${folder}/data.ts to set a blurb`);
    assert.ok((match?.[1] ?? '').trim().length > 0, `expected ${folder} blurb to be non-empty`);
  }
});

test('character-select renders the blurb underneath the name and above the weight', () => {
  assert.match(characterSelect, /roster-blurb/);
  assert.match(characterSelect, /entry\.character\.blurb/);
  assert.ok(
    characterSelect.includes('card.append(swatch, name, blurb, weight)'),
    'expected name, blurb, then weight to be appended in that order',
  );
});

test('the card exposes the blurb to screen readers via aria-label', () => {
  assert.match(characterSelect, /card\.setAttribute\(\s*'aria-label'/);
  assert.match(characterSelect, /entry\.character\.blurb/g);
});

test('style.css defines .roster-blurb consistently with .roster-weight', () => {
  assert.match(css, /\.roster-blurb\s*{/);
  const rule = css.slice(css.indexOf('.roster-blurb {'));
  assert.ok(rule.startsWith('.roster-blurb {'));
  // Muted colour like the weight line, no uppercase micro-caps, no emoji.
  assert.match(rule.slice(0, 300), /color: var\(--ink-dim\);/);
  assert.ok(!rule.slice(0, 300).includes('text-transform'));
});
