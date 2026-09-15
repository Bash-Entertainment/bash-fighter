// Regression test for a real WebGL-context leak found live on production
// (2026-09-15): the start screen's character-select grid calls
// renderCharacterIcon() once per roster entry in a synchronous loop, with
// no `await` between calls (see packages/app/src/ui/character-select.ts).
// getSharedApp() used to do a plain synchronous `if (sharedApp) return
// sharedApp;` check and only then `await app.init(...)` -- every call in
// that loop saw the cache still empty (the first call's init had not
// resolved yet) and built its *own* `new Application()`, each opening a
// real WebGL context. With an 8-character roster that was 8 contexts
// spent on invisible icons before a player touched anything, on top of
// the start screen's attract-mode match and the eventual real match
// renderer -- more than enough to exhaust a browser's per-page budget
// (observed live: "WebGL context was lost" plus a run of PixiJS
// transparency warnings on a single fresh page load).
//
// There is no jsdom or real GL context available in this test run (see
// attract-mode-teardown.test.ts for the same constraint), so this pins
// the fix at source level: the shared app is cached as an in-flight
// *promise*, assigned before any await, so concurrent callers race to
// read the same promise instead of each starting their own construction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../src/character-icon.ts', import.meta.url), 'utf8');

test('the shared app is cached as a promise, not a resolved value', () => {
  assert.match(SRC, /let sharedAppPromise: Promise<Application> \| null = null;/);
  assert.doesNotMatch(
    SRC,
    /let sharedApp: Application \| null = null;/,
    'caching the resolved Application (not the promise) reopens the race: every ' +
      'concurrent caller sees the cache empty until the first init resolves',
  );
});

test('the promise slot is assigned before any await, so a second caller sees it immediately', () => {
  const fn = SRC.slice(SRC.indexOf('async function getSharedApp'));
  const assignIdx = fn.indexOf('sharedAppPromise = (async () => {');
  const awaitIdx = fn.indexOf('await app.init(');
  assert.ok(assignIdx > 0, 'must assign sharedAppPromise synchronously inside the guarded branch');
  assert.ok(
    assignIdx < awaitIdx,
    'sharedAppPromise must be assigned before the await that resolves it -- otherwise a ' +
      'second synchronous call still races in ahead of the assignment',
  );
});

test('getSharedApp only ever constructs one Application', () => {
  const fn = SRC.slice(SRC.indexOf('async function getSharedApp'), SRC.indexOf('export async function renderCharacterIcon'));
  const constructions = fn.match(/new Application\(\)/g) ?? [];
  assert.equal(constructions.length, 1, 'exactly one `new Application()` call in the whole shared-app path');
});

test('every concurrent caller awaits the same cached promise, guarded by one null check', () => {
  const fn = SRC.slice(SRC.indexOf('async function getSharedApp'), SRC.indexOf('export async function renderCharacterIcon'));
  assert.match(fn, /if \(!sharedAppPromise\) \{/);
  assert.match(fn, /return sharedAppPromise;/);
});

test('the icon app does not pass the transparent-background string that always warns', () => {
  // Pixi's BackgroundSystem applies `background` before `backgroundAlpha`
  // during init(), so `background: 'transparent'` warns "Cannot set a
  // transparent background on an opaque canvas" regardless of what
  // backgroundAlpha is also passed -- this was firing on every icon init
  // live. Leaving `background` unset (default opaque, alpha already 1)
  // and setting only `backgroundAlpha: 0` gets the same transparent
  // output with no warning.
  const fn = SRC.slice(SRC.indexOf('async function getSharedApp'), SRC.indexOf('export async function renderCharacterIcon'));
  const initCall = fn.slice(fn.indexOf('await app.init({'), fn.indexOf('await app.init({') + fn.slice(fn.indexOf('await app.init({')).indexOf('});') + 3);
  assert.doesNotMatch(initCall, /background:\s*'transparent'/);
  assert.match(initCall, /backgroundAlpha:\s*0/);
});
