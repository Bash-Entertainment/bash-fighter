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
