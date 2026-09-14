// The black-screen bug of 2026-09-14, pinned at source level.
//
// Symptom on production: press Play, get a black screen. #canvas-root was
// empty (the match renderer never attached a canvas), while the *attract
// mode* demo canvas was still in the DOM presenting frames. Cause: the
// player pressed Play during attract mode's awaited `Match.init()`, so
// the cancelled demo went on to attach its canvas and run its loop
// forever, holding a WebGL context the real match then could not get.
//
// There is no jsdom here (Pixi and a real GL context are out of reach),
// so these assert on the source, as the other DOM-level tests do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ATTRACT = readFileSync(new URL('../src/attract-mode.ts', import.meta.url), 'utf8');
const MAIN = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

test('attract mode carries a generation token that stop() invalidates', () => {
  assert.match(ATTRACT, /private generation = 0;/);
  const destroy = ATTRACT.slice(ATTRACT.indexOf('private destroyMatch()'));
  assert.match(destroy, /this\.generation\+\+;/);
});

test('the token is bumped even when no match has been constructed yet', () => {
  const destroy = ATTRACT.slice(ATTRACT.indexOf('private destroyMatch()'));
  assert.ok(
    destroy.indexOf('this.generation++;') < destroy.indexOf('if (!this.match) return;'),
    'an in-flight init must be invalidated before the early return',
  );
});

test('a spawn cancelled during init tears itself down instead of drawing', () => {
  const spawn = ATTRACT.slice(ATTRACT.indexOf('private async spawnMatch'));
  const guard = spawn.indexOf('generation !== this.generation');
  assert.ok(guard > 0, 'the post-await guard must exist');
  assert.ok(
    spawn.indexOf('await match.init(this.parent);') < guard,
    'the guard must come after the await it is protecting',
  );
  const body = spawn.slice(guard, guard + 400);
  assert.match(body, /match\.stop\(\)/);
  assert.match(body, /match\.renderer\.destroy\(\)/);
  assert.ok(
    spawn.indexOf('match.start();', guard) > guard,
    'the cancelled path must return before starting the loop',
  );
});

test('a renderer that fails to initialise says so instead of showing a black screen', () => {
  assert.match(MAIN, /function onRendererInitFailed\(/);
  const handler = MAIN.slice(MAIN.indexOf('function onRendererInitFailed('));
  assert.match(handler.slice(0, 400), /showContextLostOverlay\(\)/);
  assert.match(handler.slice(0, 400), /if \(contextLostOverlayShowing\) return;/);
});

test('both match start paths catch a failed renderer init', () => {
  assert.match(MAIN, /try \{\s*await net\.init\(canvasRoot\);\s*\} catch/);
  assert.match(MAIN, /try \{\s*await localMatch\.init\(canvasRoot\);\s*\} catch/);
  assert.equal((MAIN.match(/onRendererInitFailed\('/g) ?? []).length, 2);
});
