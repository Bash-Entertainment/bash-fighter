// A real session loaded the game, spent 15s in a live match and pressed
// nothing. The quiet hint strip is easy to read past, so after 5s of silence
// it escalates. Pinned at source level: this repo has no DOM in tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/ui/controls-hint.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');

test('the hint escalates after a few seconds of no input', () => {
  assert.match(src, /URGENT_AFTER_MS = 5000/);
  assert.match(src, /setTimeout\(\(\) => this\.escalate\(\), URGENT_AFTER_MS\)/);
  assert.match(src, /classList\.add\('urgent'\)/);
  assert.match(src, /You are in the match/);
});

test('acknowledging input drops the urgent state', () => {
  const ack = src.slice(src.indexOf('private acknowledge'));
  assert.match(ack, /classList\.remove\('urgent'\)/);
});

test('the urgent state has its own CSS rule', () => {
  assert.match(css, /\.controls-hint\.urgent\s*\{/);
});
