// Source-level regression test for the "can't scroll the homepage" bug
// reported twice by a real visitor on a public Lemmy thread: "Still
// doesn't work. i have the cursor below the played game on the homepage
// and still can't scroll down."
//
// Root cause, confirmed live with real (non-synthetic-dispatch) wheel
// scroll ticks against a running dev build at 1280x600 and 1280x720:
// `.below-fold` had its own `overflow-y: auto` nested inside `.screen`,
// which also declares `overflow-y: auto`. A flex child with
// `flex: 1 1 auto` and `min-height: 0` shrinks to fit the space its
// parent gives it instead of forcing the parent to overflow, so once
// `.below-fold` owned its own scrolling, `.screen.scrollHeight` never
// exceeded `.screen.clientHeight` -- `.screen`'s overflow-y:auto became
// dead CSS with zero scrollable distance. `html, body { overflow:
// hidden; }` (by design, so the game canvas fills the viewport exactly)
// means there is nowhere left to chain a wheel/touch gesture once that
// happens. A cursor anywhere outside `.below-fold`'s own band -- over
// the attract-mode game canvas, over the hero text, anywhere else on
// the page -- produced a wheel event that reached a "scrollable"
// element with nothing to scroll, and nothing to fall back to.
//
// The rule this pins: `.screen` is the ONLY scroll container on the
// start/end screens. Nothing inside it (`.below-fold` in particular)
// may declare its own `overflow-y`, so `.screen`'s scrollable area
// always equals its actual overflowing content and a wheel or touch
// gesture scrolls the page from any cursor position.
//
// No jsdom in this repo (see other source-level tests in this package),
// so this is pinned as a source/regex check on the stylesheet, the
// established convention here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CSS = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');

function ruleBody(selector: string): string {
  const needle = `${selector} {`;
  const start = CSS.indexOf(needle);
  assert.ok(start >= 0, `expected to find a ${selector} rule`);
  const end = CSS.indexOf('}', start);
  return CSS.slice(start + needle.length, end);
}

test('.screen is a scroll container', () => {
  const body = ruleBody('.screen');
  assert.match(body, /overflow-y:\s*auto/);
});

test('.below-fold does not declare its own overflow-y, so .screen owns all of it', () => {
  const body = ruleBody('.below-fold');
  assert.doesNotMatch(
    body,
    /^\s*overflow-y\s*:/m,
    '.below-fold must not scroll on its own -- that traps scroll input ' +
      'behind whatever tiny band it collapses to, leaving .screen with ' +
      'nothing left to overflow and no cursor position outside that ' +
      'band able to scroll the page',
  );
});

test('html and body still own no scrolling of their own (by design, not a leftover)', () => {
  const htmlBodyStart = CSS.indexOf('html, body {');
  assert.ok(htmlBodyStart >= 0);
  const htmlBodyEnd = CSS.indexOf('}', htmlBodyStart);
  const body = CSS.slice(htmlBodyStart, htmlBodyEnd);
  assert.match(body, /overflow:\s*hidden/);
});
