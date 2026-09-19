// 2026-09-14: a lost WebGL context (GPU switch, phone backgrounding the
// tab, driver reset, too many live contexts) used to turn the whole
// canvas into a permanently black rectangle -- the console filled with
// "this.app.renderer is null" every frame and the player was never told
// anything. Renderer now listens for webglcontextlost/restored, fails
// safe instead of throwing, and main.ts shows an honest dismissible
// message with a Reload action, replaced on restore. No jsdom is
// available here (see "Sim Core Implementation Notes"), so this pins the
// wiring at source level, same convention as spectate-chip.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const renderer = readFileSync(new URL('../../render/src/index.ts', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const match = readFileSync(new URL('../src/match.ts', import.meta.url), 'utf8');
const netMatch = readFileSync(new URL('../src/net-match.ts', import.meta.url), 'utf8');
const protocol = readFileSync(new URL('../../net/src/protocol.ts', import.meta.url), 'utf8');

test('Renderer.init prevents default on webglcontextlost, which is required for restoration to ever be possible', () => {
  const region = renderer.slice(renderer.indexOf("addEventListener('webglcontextlost'"));
  const body = region.slice(0, region.indexOf('});') + 3);
  assert.match(body, /event\.preventDefault\(\)/);
  assert.match(body, /this\.contextLost = true/);
  assert.match(body, /this\.onContextLost\?\.\(\)/);
});

test('webglcontextrestored clears the flag and fires the restored hook', () => {
  const region = renderer.slice(renderer.indexOf("addEventListener('webglcontextrestored'"));
  const body = region.slice(0, region.indexOf('});') + 3);
  assert.match(body, /this\.contextLost = false/);
  assert.match(body, /this\.onContextRestored\?\.\(\)/);
});

test('render() bails out while the context is lost, instead of touching a dead renderer', () => {
  const idx = renderer.indexOf('render(frame: RenderFrame): void {');
  const body = renderer.slice(idx, idx + 200);
  assert.match(body, /if \(!this\.ready \|\| this\.contextLost\) return;/);
});

test('viewSize never dereferences a null renderer', () => {
  const idx = renderer.indexOf('get viewSize()');
  const body = renderer.slice(idx, idx + 700);
  assert.match(body, /if \(!this\.app\.renderer\) return \{ width: 0, height: 0 \};/);
});

test('both Match and NetMatch wire the renderer context events to their own event hooks', () => {
  for (const src of [match, netMatch]) {
    assert.match(src, /this\.renderer\.onContextLost = \(\) => /);
    assert.match(src, /this\.renderer\.onContextRestored = \(\) => /);
  }
});

test('main.ts shows a calm, jargon-free message with a Reload action, and replaces it on restore', () => {
  const idx = main.indexOf('function showContextLostOverlay()');
  const body = main.slice(idx, idx + 700);
  assert.match(body, /title: 'The game stopped drawing'/);
  // An uppercase micro-caps eyebrow label above the heading is banned by
  // this project's design language, and this is the only caller that has
  // ever been tempted to use the overlay's kicker slot.
  assert.doesNotMatch(body, /kicker:/);
  assert.doesNotMatch(body, /!/); // no exclamation marks, per voice guidelines
  assert.doesNotMatch(body, /[\u{1F300}-\u{1FAFF}]/u); // no emoji
  assert.match(body, /label: 'Reload'/);
  assert.match(body, /location\.reload\(\)/);

  const restoreIdx = main.indexOf('function onRendererContextRestored()');
  const restoreBody = main.slice(restoreIdx, restoreIdx + 300);
  assert.match(restoreBody, /matchOverlay\.hide\(\)/);
});

test('the online-match and local-match constructors both hook the shared context-lost/restored callbacks', () => {
  assert.equal(main.match(/onContextLost: onRendererContextLost/g)?.length, 2);
  assert.equal(main.match(/onContextRestored: onRendererContextRestored/g)?.length, 2);
});

test('SessionReportMessage.contextLostCount is optional, clamped, and rounded like the other counters', () => {
  assert.match(protocol, /contextLostCount\?: number;/);
  const idx = protocol.indexOf('function sanitiseSessionReport');
  const body = protocol.slice(idx, idx + 4400); // widened 2026-09-15 for slow-frame-attribution fields, again 2026-09-19 for devicePixelRatio
  assert.match(body, /clampFiniteNumber\(obj\.contextLostCount, 0, 10_000_000\)/);
  assert.match(body, /Math\.round\(contextLostCount\)/);
});

test('no new personal data is introduced alongside the context-loss field', () => {
  // Same intent as the existing sessionReport fields: a plain count, no
  // IP, no user agent, no cookie, no persistent id.
  assert.doesNotMatch(protocol, /contextLostCount.*(ip|userAgent|cookie)/i);
});

// 2026-09-14 follow-up: production hit the other half of the same
// symptom -- a renderer that never becomes able to draw at all (dead or
// blocklisted GPU context, WebGL exhausted after a prior context died).
// No webglcontextlost event ever fires for that, so isContextLost()
// stayed false while the canvas stayed black and stuck at Pixi's 800x600
// default. The fix is a watchdog on frames genuinely presented, not on
// the renderer's own opinion of its health.

test('Renderer.getFramesPresented only counts frames that both actually ran the draw path and had a live native WebGL context', () => {
  const idx = renderer.indexOf('render(frame: RenderFrame): void {');
  const body = renderer.slice(idx, idx + 500);
  assert.match(body, /if \(!this\.ready \|\| this\.contextLost\) return;/);
  assert.match(body, /if \(this\.hasLiveGlContext\(\)\) this\.framesPresented\+\+;/);
});

test('hasLiveGlContext reads the browser\'s own gl.isContextLost(), not our own event-driven flag', () => {
  const idx = renderer.indexOf('hasLiveGlContext()');
  const body = renderer.slice(idx, idx + 300);
  assert.match(body, /context\?\.isLost/);
});

test('Match and NetMatch both arm a render watchdog when a match starts, and disarm it on stop', () => {
  for (const src of [match, netMatch]) {
    assert.match(src, /RENDER_WATCHDOG_MS = 6000/);
    assert.match(src, /getFramesPresented\(\) === 0/);
    // Never fires for the same failure onContextLost already caught.
    assert.match(src, /if \(this\.renderer\.isContextLost\(\)\) return;/);
    assert.match(src, /clearTimeout\(this\.renderWatchdogTimer\)/);
  }
});

test('onRenderStalled uses the same overlay as onContextLost and never stacks a second one', () => {
  const idx = main.indexOf('function onRendererRenderStalled()');
  const body = main.slice(idx, idx + 300);
  assert.match(body, /if \(contextLostOverlayShowing\) return;/);
  assert.match(body, /showContextLostOverlay\(\);/);
  assert.equal(main.match(/onRenderStalled: onRendererRenderStalled/g)?.length, 2);
});

test('SessionReportMessage.renderStalled is optional, a plain boolean, validated server-side, and carries no new personal data', () => {
  assert.match(protocol, /renderStalled\?: boolean;/);
  const idx = protocol.indexOf('function sanitiseSessionReport');
  const body = protocol.slice(idx, idx + 1600);
  assert.match(body, /typeof obj\.renderStalled === 'boolean'/);
  assert.doesNotMatch(protocol, /renderStalled.*(ip|userAgent|cookie)/i);
});
