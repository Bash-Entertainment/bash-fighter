// Two defects found by playing production on 2026-09-14.
//
// 1. Clicking "Play online" showed a completely black screen -- no
//    wordmark, no words, only a small "Connecting..." chip in the far
//    bottom-left corner -- until the server's first lobby message. The
//    composed waiting screen appeared on net state 'waiting' only, so the
//    one moment a first-time player is most likely to read as "broken"
//    was the one moment we showed them nothing.
// 2. The elimination overlay had no feedback route. In a 20-player
//    free-for-all 19 of every 20 players finish their match on THAT
//    overlay rather than the win screen, so the win screen's feedback
//    link was reaching almost nobody -- while elimination is exactly when
//    a player's opinion of how the fight felt is sharpest.
//
// There is no jsdom in this repo, so both are pinned at source level.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(join(here, '../src/main.ts'), 'utf8');
const waiting = readFileSync(join(here, '../src/ui/waiting-screen.ts'), 'utf8');

test("net state 'connecting' shows the waiting screen in its connecting state", () => {
  assert.match(main, /state === 'connecting'\)\s*waitingScreen\.showConnecting\(\)/);
  assert.match(waiting, /showConnecting\(\)\s*:\s*void/);
});

test('showConnecting hides the player count and Start now, which have no meaning before a lobby exists', () => {
  const body = waiting.slice(waiting.indexOf('showConnecting(): void'), waiting.indexOf('hide(): void'));
  assert.match(body, /this\.connecting = true/);
  assert.match(body, /this\.countLine\.textContent = ''/);
  assert.match(body, /this\.startBtn\.classList\.add\('hidden'\)/);
});

test('the first lobby message leaves the connecting state and restores Start now', () => {
  const body = waiting.slice(waiting.indexOf('setCount(players'), waiting.indexOf('private renderCountdown'));
  assert.match(body, /this\.connecting = false/);
  assert.match(body, /this\.startBtn\.classList\.remove\('hidden'\)/);
});

test('the connecting state never invents a countdown', () => {
  const body = waiting.slice(waiting.indexOf('private renderCountdown'));
  const guard = body.slice(0, body.indexOf('this.lastServerTicks < 0'));
  assert.match(guard, /if \(this\.connecting\)/, 'the connecting branch must come before any countdown maths');
  assert.ok(
    !/Match starts in/.test(guard),
    'the connecting branch must not render a match-start countdown -- the server has told us nothing yet',
  );
});

test('hide() clears the connecting state so a later reuse does not show stale connecting text', () => {
  const body = waiting.slice(waiting.indexOf('hide(): void'), waiting.indexOf('setMode(modeName'));
  assert.match(body, /this\.connecting = false/);
});

test('the hidden class actually hides Start now (there is no global .hidden rule in this stylesheet)', () => {
  const css = readFileSync(join(here, '../src/style.css'), 'utf8');
  assert.match(css, /\.waiting-start-btn\.hidden \{\s*display: none;\s*\}/);
});

test('the elimination overlay offers a feedback route alongside Play again and Keep spectating', () => {
  const onEliminated = main.slice(main.indexOf('onEliminated:'), main.indexOf('}, audio, isQaSession())'));
  assert.match(onEliminated, /label: 'Say what felt wrong'/);
  assert.match(onEliminated, /feedbackPanel\.show\(/);
  // It must be a quiet alternative, never competing with Play again.
  const action = onEliminated.slice(onEliminated.indexOf("label: 'Say what felt wrong'"));
  assert.match(action.slice(0, 400), /kind: 'plain'/);
});

test('the elimination feedback carries the placement as context', () => {
  const onEliminated = main.slice(main.indexOf('onEliminated:'), main.indexOf('}, audio, isQaSession())'));
  assert.match(onEliminated, /result: `eliminated \$\{placement\} of \$\{totalFighters\}`/);
});

test('announceWinner only strips Keep spectating, so the feedback route survives the match ending', () => {
  const overlay = readFileSync(join(here, '../../render/../app/src/ui/match-overlay.ts'), 'utf8');
  const body = overlay.slice(overlay.indexOf('announceWinner('));
  assert.match(body, /btn\.textContent === 'Keep spectating'/);
  assert.ok(
    !/Say what felt wrong/.test(body),
    'announceWinner must not remove the feedback action -- a player who just watched the match end is a good person to hear from',
  );
});
