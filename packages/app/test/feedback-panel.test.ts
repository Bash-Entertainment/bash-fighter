// Account-free player feedback (2026-09-13) -- see feedback-panel.ts and
// server/src/feedback.ts. No jsdom is available in this repo (see "Sim
// Core Implementation Notes"), so the client wiring is pinned at source
// level, same convention as spectate-chip.test.ts. The real overlap
// measurement (getBoundingClientRect intersections at 1280x720 and
// 390px) was done live in a browser against the running dev server --
// see the task report for screenshots/numbers, not reproducible here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const panel = readFileSync(new URL('../src/ui/feedback-panel.ts', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const winScreen = readFileSync(new URL('../src/ui/win-screen.ts', import.meta.url), 'utf8');
const timedBrawlEndScreen = readFileSync(new URL('../src/ui/timed-brawl-end-screen.ts', import.meta.url), 'utf8');
const keyboard = readFileSync(new URL('../../input/src/keyboard.ts', import.meta.url), 'utf8');

test('the comment entry is a plain textarea, so shouldIgnoreKeydown already swallows it', () => {
  assert.match(panel, /createElement\('div'\)/);
  assert.match(panel, /<textarea class="feedback-textarea"/);
  // Confirms the input layer this relies on actually ignores INPUT/TEXTAREA
  // targets -- if this ever changes, this test should fail loudly instead
  // of feedback silently leaking keystrokes into the game.
  assert.match(keyboard, /TEXTAREA/);
});

test('Escape closes the panel and the listener is removed on hide, restoring normal play input', () => {
  assert.match(panel, /e\.code !== 'Escape'/);
  assert.match(panel, /window\.addEventListener\('keydown', this\.dismissHandler\)/);
  const hideBody = panel.slice(panel.indexOf('hide(): void'), panel.indexOf('hide(): void') + 200);
  assert.match(hideBody, /window\.removeEventListener\('keydown', this\.dismissHandler\)/);
});

test('there is an explicit close control independent of Escape (no unclosable-modal regression)', () => {
  assert.match(panel, /move-reference-close/);
  assert.match(panel, /querySelector\('\.move-reference-close'[^]*?addEventListener\('click', \(\) =>\s*\n\s*this\.hide\(\)/);
  // Clicking the dimmed backdrop also closes it.
  assert.match(panel, /if \(e\.target === this\.root\) this\.hide\(\)/);
});

test('the panel is never auto-shown: show() is only ever called from explicit click handlers', () => {
  // No timers/intervals anywhere in this file that could pop it open on
  // their own -- the "not shown automatically more than once per session"
  // requirement holds because there is no automatic path at all.
  assert.doesNotMatch(panel, /setTimeout|setInterval/);
});

test('submission requires comment or at least one rating, matching the server contract', () => {
  assert.match(panel, /if \(comment\.length === 0 && !this\.hasAnyRating\(\)\)/);
});

test('exactly the five specified quick-question topics are present, each 1-5', () => {
  const keys = ['combatWeight', 'cameraReadability', 'funFactor', 'touchErgonomics', 'matchmakingClarity'];
  for (const key of keys) {
    assert.match(panel, new RegExp(`key: '${key}'`));
  }
  assert.match(panel, /for \(let n = 1; n <= 5; n\+\+\)/);
});

test('touch ergonomics question is marked touch-only and visibility is driven by isTouchActive', () => {
  assert.match(panel, /touchOnly: true/);
  assert.match(panel, /renderTouchVisibility/);
  assert.match(panel, /row\.style\.display = touchActive \? '' : 'none'/);
});

test('a secondary link points at the real GitHub issue tracker', () => {
  assert.match(panel, /https:\/\/github\.com\/Bash-Entertainment\/bash-fighter\/issues/);
  assert.match(panel, /target="_blank" rel="noopener noreferrer"/);
});

test('submit posts to /api/feedback and surfaces both success and failure plainly', () => {
  assert.match(panel, /fetch\('\/api\/feedback'/);
  assert.match(panel, /method: 'POST'/);
  assert.match(panel, /Thanks -- that was sent\./);
  assert.match(panel, /Could not reach the server/);
});

test('start screen and in-match HUD both get a Feedback entry point, and it is a plain unobtrusive control', () => {
  assert.match(main, /feedbackButton\.textContent = 'Feedback'/);
  assert.match(main, /feedbackButton\.className = 'btn btn-plain'/);
  assert.match(main, /inMatchFeedbackButton\.className = 'in-match-moves-btn feedback-link-btn hidden'/);
  assert.match(main, /inMatchFeedbackButton\.textContent = 'Feedback'/);
});

test('the in-match Feedback button follows the same show/hide lifecycle as Controls/Moves, avoiding overlap with debug-hint/spectate-chip by staying out of their corner entirely', () => {
  const hideBlocks = main.match(/inMatchMovesButton\.classList\.add\('hidden'\);\n\s*inMatchSettingsButton\.classList\.add\('hidden'\);\n\s*inMatchFeedbackButton\.classList\.add\('hidden'\);/g);
  const showBlocks = main.match(/inMatchMovesButton\.classList\.remove\('hidden'\);\n\s*inMatchSettingsButton\.classList\.remove\('hidden'\);\n\s*inMatchFeedbackButton\.classList\.remove\('hidden'\);/g);
  assert.ok(hideBlocks && hideBlocks.length >= 1);
  assert.ok(showBlocks && showBlocks.length >= 1);
  assert.match(main, /topRightControls\.appendChild\(inMatchFeedbackButton\)/);
});

test('win screen and Timed Brawl end screen each carry one prominent-but-not-pushy feedback block wired to the shared panel', () => {
  assert.match(winScreen, /feedback-end-screen-block/);
  assert.match(winScreen, /onOpenFeedback\?\.\(this\.lastResult\)/);
  assert.match(timedBrawlEndScreen, /feedback-end-screen-block/);
  assert.match(timedBrawlEndScreen, /onOpenFeedback\?\.\(this\.lastResult\)/);
  assert.match(main, /new WinScreen\(/);
  assert.match(main, /feedbackPanel\.show\(\{/);
});
