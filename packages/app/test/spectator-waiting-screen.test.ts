// Source-level pin (no jsdom here): a spectator arriving on ?watch=CODE was
// shown the host's share link and a "Start now" button that would have
// started someone else's match. Found on production 2026-09-22.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const waiting = readFileSync(new URL('../src/ui/waiting-screen.ts', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

test('a spectator gets no Start now button and no share link', () => {
  assert.match(waiting, /setSpectating\(spectating: boolean\): void \{/);
  assert.match(waiting, /this\.setShareLink\(null\);/);
  // Later lobby updates must not hand the button back.
  assert.match(waiting, /if \(!this\.spectating\) this\.startBtn\.classList\.remove\('hidden'\);/);
  assert.match(waiting, /if \(this\.spectating\) this\.startBtn\.classList\.add\('hidden'\);/);
  assert.match(waiting, /#waiting-hint'\) as HTMLDivElement\)\.classList\.add\('hidden'\)/);
});

test('main wires spectating from the seatless local slot', () => {
  assert.match(main, /const watching = \(netMatch\?\.localSlot\(\) \?\? 0\) < 0;/);
  assert.match(main, /waitingScreen\.setSpectating\(watching\);/);
  assert.match(main, /!watching && currentJoinCode \? buildShareLink/);
});

test('the Timed Brawl objective line does not say "you" to a spectator', async () => {
  const { objectiveLineText } = await import('../src/ui/hud-text.ts');
  assert.match(objectiveLineText('timedKO', true), /fighters respawn when knocked out/);
  assert.doesNotMatch(objectiveLineText('timedKO', true), /\byou\b/);
  assert.match(objectiveLineText('timedKO'), /you respawn when knocked out/);
});
