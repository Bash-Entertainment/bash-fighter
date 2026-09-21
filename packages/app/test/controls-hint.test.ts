import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// No jsdom in this repo, so the hint's behaviour is pinned at source level.
const hint = readFileSync(new URL('../src/ui/controls-hint.ts', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');

// The defect this pins: the hint used to mark itself "seen" the moment it
// appeared, so a visitor who took a seat and pressed nothing never saw the
// controls again. The flag must only be written once input has happened.
test('the seen flag is written from the input acknowledgement, not from showing', () => {
  const setIndex = hint.indexOf("setItem(STORAGE_KEY");
  assert.ok(setIndex > 0, 'expected the flag to be written somewhere');
  const acknowledgeIndex = hint.indexOf('private acknowledge(');
  const showIndex = hint.indexOf('private show(');
  assert.ok(acknowledgeIndex > 0 && showIndex > 0);
  assert.ok(setIndex > acknowledgeIndex, 'the flag must be written inside acknowledge()');
  assert.ok(setIndex > showIndex, 'the flag must not be written inside show()');
});

test('the hint listens for real input and stops listening once it sees some', () => {
  assert.match(hint, /addEventListener\('keydown', this\.onInput\)/);
  assert.match(hint, /addEventListener\('pointerdown', this\.onInput\)/);
  assert.match(hint, /removeEventListener\('keydown', this\.onInput\)/);
  assert.match(hint, /removeEventListener\('pointerdown', this\.onInput\)/);
});

// The defect this pins: 82% of real sessions are on touch devices, and all
// of them were told to press WASD and Space.
test('touch players are pointed at the on-screen controls, not at keys', () => {
  assert.match(hint, /const TOUCH_TEXT = '[^']*stick[^']*'/);
  assert.ok(!hint.includes("TOUCH_TEXT = 'A/D"));
  assert.equal(main.split('controlsHint.maybeShow(touchCapable)').length - 1, 2);
  assert.ok(!main.includes('controlsHint.maybeShow()'));
});

// The touch buttons own the bottom-centre of a phone screen.
test('the touch variant of the hint is moved off the bottom of the screen', () => {
  const rule = css.slice(css.indexOf('.controls-hint.touch {'));
  assert.ok(rule.startsWith('.controls-hint.touch {'));
  assert.match(rule.slice(0, 160), /bottom: auto;/);
});
