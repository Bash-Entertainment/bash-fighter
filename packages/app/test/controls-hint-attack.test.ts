import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Real newcomers moved for 25-30s and never attacked: the hint vanished on
// the first key of any kind. Only an actual attack may dismiss it now.
const hint = readFileSync(new URL('../src/ui/controls-hint.ts', import.meta.url), 'utf8');
const net = readFileSync(new URL('../src/net-match.ts', import.meta.url), 'utf8');

test('controls hint: movement points at attack, only the attack event acknowledges', () => {
  assert.match(hint, /onInput = \(\): void => this\.noteMovement\(\)/);
  assert.match(hint, /onAttack = \(\): void => this\.acknowledge\(\)/);
  assert.match(hint, /addEventListener\(LOCAL_ATTACK_EVENT, this\.onAttack\)/);
  assert.match(hint, /Now press F to attack/);
  assert.match(hint, /Now tap Attack to hit/);
});

test('net match: announces the local seat\'s first attack press', () => {
  assert.match(net, /local\.buttons & BUTTON_ATTACK\) !== 0[\s\S]{0,120}dispatchEvent\(new Event\(LOCAL_ATTACK_EVENT\)\)/);
});
