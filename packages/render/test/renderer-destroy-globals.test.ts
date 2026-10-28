// Tearing one renderer down must not break another that is still drawing.
//
// Pixi's `destroy(true)` means removeView *and* releaseGlobalResources, and
// the global release destroys every Batch in Pixi's module-level pool --
// including batches a still-live Application's instruction set is using.
// That live renderer's next frame then throws
// `can't access property "geometry", batcher is null` and stops drawing
// (reproduced with two Applications in a browser, 2026-10-28; seen live in
// production client error reports). The page can hold more than one Pixi
// Application at once: the shared character-icon renderer, and an
// attract-mode demo whose init resolves after the real match started.
//
// No GL in node, so this asserts on the source like canvas-sizing.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

test('destroy removes the canvas without releasing Pixi global pools', () => {
  const destroy = SOURCE.slice(SOURCE.indexOf('  destroy(): void {'));
  const options = destroy.match(/this\.app\.destroy\(([^)]*\}|[^,)]*)/)?.[1] ?? '';
  assert.doesNotMatch(options, /^\s*true\s*$/);
  assert.doesNotMatch(options, /releaseGlobalResources:\s*true/);
  assert.match(options, /removeView:\s*true/);
});
