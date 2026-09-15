// 2026-09-15: two real players independently asked for a "5 4 3 2 1 GO"
// at match start. WaitingScreen already computed a real
// server-driven countdown (lastServerTicks/lastServerAt from the
// lobby message) but only ever showed it as one text line among
// several. This pins the big-digit final countdown to that same real
// clock -- there is no separate cosmetic timer -- and the choice of
// 3 seconds (not the 5 the player asked for) plus what a mid-match
// joiner sees. No jsdom here (see "Sim Core Implementation Notes"),
// so behaviour is pinned at source level with readFileSync + regex.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/ui/waiting-screen.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');

test('final countdown window is 3 seconds, not the 5 the player suggested', () => {
  assert.match(src, /FINAL_COUNTDOWN_SECONDS = 3/);
});

test('big digits are derived from the same real server ticks as the small countdown line, not a separate timer', () => {
  const body = src.slice(src.indexOf('private renderCountdown'));
  // Only one clock read (lastServerTicks/lastServerAt) feeds both the
  // ordinary "Match starts in Ns" line and the big-digit state.
  assert.match(body, /const ticksLeft = Math\.max\(0, this\.lastServerTicks - elapsedTicks\);/);
  assert.match(body, /secondsLeft > 0 && secondsLeft <= WaitingScreen\.FINAL_COUNTDOWN_SECONDS/);
  assert.match(body, /this\.countdownLine\.textContent = String\(secondsLeft\);/);
});

test('shows GO only once the real server countdown has actually reached zero', () => {
  const body = src.slice(src.indexOf('private renderCountdown'));
  assert.match(body, /if \(secondsLeft <= 0\) \{\s*\n\s*this\.countdownLine\.textContent = 'GO';/);
});

test('a client with no lobby countdown (mid-match join) never renders big digits', () => {
  // lastServerTicks stays < 0 until an actual lobby countdown message
  // is received; that branch returns before the big-digit logic can
  // run at all, and mid-match joiners never receive a lobby message.
  const body = src.slice(src.indexOf('private renderCountdown'));
  const earlyReturn = body.slice(0, body.indexOf('secondsLeft > 0 && secondsLeft <='));
  assert.match(earlyReturn, /if \(this\.lastServerTicks < 0\)/);
});

test('big-digit countdown has no motion of its own, so it needs no reduced-motion special case', () => {
  const block = css.slice(css.indexOf('.waiting-countdown.waiting-countdown-big'));
  const rule = block.slice(0, block.indexOf('}'));
  assert.doesNotMatch(rule, /animation|transition|transform/);
});
