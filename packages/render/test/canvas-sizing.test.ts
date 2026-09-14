// Source-level tests for the drawing surface tracking its container.
//
// Background: for a whole match the canvas was 200px wider than
// `#canvas-root`, because Pixi measures the container once during
// `app.init()` while the stylesheet insets that container by the HUD
// sidebar width only later, when the fighter list turns dense. A fifth of
// the world was drawn off the right edge of the screen, and Pixi has no
// observer on the container, so nothing corrected it.
//
// There is no jsdom in this repo (ResizeObserver and a real GL canvas are
// both out of reach), so these assert on the source, the way the other
// DOM-level tests in this repo do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

test('the renderer observes its container, not just the window', () => {
  assert.match(SOURCE, /new ResizeObserver\(/);
  assert.match(SOURCE, /parentResizeObserver\.observe\(parent\)/);
});

test('the observer is guarded so an environment without it still works', () => {
  assert.match(SOURCE, /typeof ResizeObserver !== .undefined./);
});

test('the container size is applied once immediately, before any observation', () => {
  const init = SOURCE.slice(SOURCE.indexOf('async init('));
  assert.match(init, /syncToParent\(\);/);
  assert.ok(
    init.indexOf('syncToParent();') < init.indexOf('new ResizeObserver('),
    'the first sync must not wait for the observer to fire',
  );
});

test('a zero-sized or unchanged container never triggers a resize', () => {
  const sync = SOURCE.slice(SOURCE.indexOf('const syncToParent'));
  assert.match(sync, /width <= 0 \|\| height <= 0/);
  assert.match(sync, /current\.width === width && current\.height === height/);
});

test('resizing is skipped while the context is lost', () => {
  const sync = SOURCE.slice(SOURCE.indexOf('const syncToParent'));
  assert.match(sync.slice(0, 200), /this\.contextLost/);
});

test('destroy disconnects the observer so nothing leaks per match', () => {
  const destroy = SOURCE.slice(SOURCE.indexOf('  destroy(): void {'));
  assert.match(destroy, /parentResizeObserver\?\.disconnect\(\)/);
});
