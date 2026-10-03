import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/ui/touch-controls.ts', import.meta.url), 'utf8');

test('touch Attack button pulses until the first attack', () => {
  assert.match(src, /attackBtn\.classList\.toggle\('beckon', !hasAttackedBefore\(\)\)/);
  assert.match(src, /if \(name === 'attack'\) btn\.classList\.remove\('beckon'\)/);
  assert.match(src, /'bash-fighter:seen-controls-hint'/);
});
