// Our first real player: "the match starting right away without a countdown
// made finding the ball/arrow pointing to my dude harder than it should" and
// "took a minute to even find my dude". MatchIntro names their fighter for the
// first couple of seconds. No jsdom here (see "Sim Core Implementation
// Notes"), so behaviour is pinned at source level, plus the CSS contract that
// keeps it out of the player's way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const intro = readFileSync(new URL('../src/ui/match-intro.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');

test('starts hidden and hides itself again after the timeout', () => {
  assert.match(intro, /className = 'match-intro hidden'/);
  assert.match(intro, /this\.timer = setTimeout\(\(\) => this\.hide\(\), durationMs\)/);
  assert.match(intro, /hide\(\)[\s\S]*classList\.add\('match-intro hidden'\.split\(' '\)\[1\]\)|classList\.add\('hidden'\)/);
});

test('a re-show cancels the previous timer instead of racing it', () => {
  const show = intro.slice(intro.indexOf('  show('));
  assert.match(show.slice(0, show.indexOf('this.root.appendChild')), /clearTimeout\(this\.timer\)/);
});

test('names the local player and shows their fighter colour', () => {
  assert.match(intro, /You are \$\{name\}/);
  assert.match(intro, /swatch\.style\.background = colour/);
});

test('says so when the fight was already running', () => {
  assert.match(intro, /joinedLate\s*\n?\s*\?\s*'The fight is already going\./);
});

test('never swallows a player input', () => {
  const block = css.slice(css.indexOf('.match-intro {'));
  assert.match(block.slice(0, block.indexOf('}')), /pointer-events: none/);
});

test('defines its own hidden rule (there is no global .hidden)', () => {
  assert.match(css, /\.match-intro\.hidden \{\s*display: none;/);
});

test('honours reduced motion by dropping the fade animation', () => {
  const reduced = css.slice(css.lastIndexOf('prefers-reduced-motion'));
  assert.match(reduced, /\.match-intro-card \{ animation: none; \}/);
});
