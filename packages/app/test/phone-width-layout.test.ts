import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');

/** Pull the body of the last @media block whose condition matches. */
function mediaBlock(condition: string): string {
  const start = css.lastIndexOf(`@media (${condition})`);
  assert.ok(start >= 0, `no @media (${condition}) block`);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error('unterminated media block');
}

// 2026-09-19: three real touch sessions recorded 21-72s of match time with
// zero input. Measured at 256 CSS px (a size real sessions reported): the
// dense HUD's reserved 128px column left the game half the screen, and the
// stick, shifted clear of that column, sat on top of the action buttons.
test('phone widths give the canvas the full width and keep the dense list out of it', () => {
  const phone = mediaBlock('max-width: 480px');
  assert.match(phone, /#app:has\(\.hud-list\.dense\) #canvas-root \{\s*left: 0;/);
  assert.match(phone, /\.hud-list\.dense \{\s*display: none;/);
  assert.match(phone, /#app:has\(\.hud-list\.dense\) \.touch-stick-base \{\s*left: max\(20px/);
  // #top-right-controls wraps onto two rows at phone width; the status block
  // has to clear them or "5 / 20 remaining" is struck through by "Sound off".
  assert.match(phone, /#hud:has\(\.hud-list\.dense\) \{[^}]*top: 80px;/);
});

test('on the narrowest phones the stick and the button cluster cannot overlap', () => {
  const narrow = mediaBlock('max-width: 330px');
  const size = (sel: string): number => {
    const m = narrow.match(new RegExp(`${sel} \\{[^}]*width: (\\d+)px`));
    assert.ok(m, `no width for ${sel}`);
    return Number(m[1]);
  };
  const stick = size('\\.touch-stick-base');
  const cluster = size('\\.touch-buttons');
  const btn = size('\\.touch-btn');
  // Layout at the narrowest width this tier has to survive.
  const viewport = 256;
  const stickRight = 20 + stick;
  const clusterLeft = viewport - 16 - cluster;
  assert.ok(stickRight <= clusterLeft, `stick ends at ${stickRight}, buttons start at ${clusterLeft}`);
  // Two same-size circles only avoid overlapping when spacing >= diameter.
  for (const offset of narrow.matchAll(/\.touch-btn-\w+ \{ right: (\d+)px?/g)) {
    const px = Number(offset[1]);
    assert.ok(px === 0 || px >= btn, `offset ${px} is under the ${btn}px diameter`);
  }
  assert.ok(btn >= 44, 'tap targets stay at least 44px');
});

// The 700px tier set a width on .match-overlay -- the full-screen inset:0
// backdrop -- which the browser ignores as over-constrained, so on a real
// 256x493 phone the elimination panel measured 220x414: 71% of the screen,
// behind a near-opaque backdrop, while offering "keep watching this one
// play out".
test('the phone elimination overlay is a compact sheet that leaves the match visible', () => {
  assert.doesNotMatch(css, /\n  \.match-overlay, \.win-panel \{/, 'width must go on the panel, not the backdrop');
  const phone = mediaBlock('max-width: 480px');
  assert.match(phone, /\.match-overlay \{[^}]*align-items: flex-end;[^}]*background: transparent;/);
  assert.match(phone, /\.match-overlay-panel \{[^}]*width: 100%;/);
});

// Playing at 256px: the spectate chip ("You finished 14th of 20") sat
// directly on top of the Attack and Special buttons.
test('the spectate chip clears the touch controls on a phone', () => {
  const phone = mediaBlock('max-width: 480px');
  const m = phone.match(/\.spectate-chip \{[^}]*bottom: (\d+)px/);
  assert.ok(m, 'no phone rule for the spectate chip');
  const narrow = mediaBlock('max-width: 330px');
  const cluster = Number(narrow.match(/\.touch-buttons \{[^}]*height: (\d+)px/)![1]);
  assert.ok(Number(m[1]) >= cluster + 16, `chip at ${m[1]}px does not clear a ${cluster}px cluster`);
});

// At 256px the win headline ("CPU Pixel won") ran off both edges at 32px and
// the body copy sat hard against x = 0.
test('phone widths keep the win headline and screen copy inside the screen', () => {
  const phone = mediaBlock('max-width: 480px');
  const headline = Number(phone.match(/\.win-headline \{[^}]*font-size: (\d+)px/)![1]);
  assert.ok(headline <= 24, `win headline is ${headline}px at phone width`);
  assert.match(phone, /\.screen \{[^}]*padding-left: \d+px;/);
});
