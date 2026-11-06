// The local player's damage readout is drawn in the bottom-left corner of
// the canvas (computeLocalDamageReadout). The connection chip #net-status
// used to be pinned to that same corner, so during an online match the
// "In match" badge sat on top of the percent number. This pins the chip
// to the top-right, where nothing else in the HUD is drawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '../src/style.css'), 'utf8');

function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `expected a ${selector} rule`);
  return css.slice(start, css.indexOf('}', start));
}

test('#net-status is anchored top-right, never bottom-left', () => {
  const body = ruleBody('#net-status');
  assert.match(body, /\btop:\s*84px;/);
  assert.match(body, /\bright:\s*12px;/);
  assert.doesNotMatch(body, /\bbottom:/);
  assert.doesNotMatch(body, /\bleft:/);
});
