import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// No jsdom here, so the wiring is pinned at source level (see the other
// UI tests in this directory).
const startScreen = readFileSync(new URL('../src/ui/start-screen.ts', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

test('the start screen can replace its keyboard control line with touch wording', () => {
  assert.match(startScreen, /useTouchControls\(\): void \{/);
  assert.match(startScreen, /Drag the stick to move/);
  assert.match(startScreen, /\.how-to-play-controls/);
});

test('main.ts calls it for touch-capable devices only', () => {
  assert.match(main, /if \(touchCapable\) startScreen\.useTouchControls\(\);/);
});

test('the attract window and its caption are hidden when attract mode cannot run', () => {
  assert.match(startScreen, /setAttractVisible\(visible: boolean\): void \{/);
  assert.match(startScreen, /#attract-frame/);
  assert.match(startScreen, /\.attract-caption/);
  assert.match(main, /startScreen\.setAttractVisible\(supported\);/);
});
