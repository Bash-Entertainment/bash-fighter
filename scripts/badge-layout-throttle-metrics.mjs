// 2026-09-19: counts the actual work avoided by throttling the badge
// *layout decision* (computeBadgePlacements: O(n^2) box-overlap checks
// plus however many canvas measureText calls each candidate needs to
// find a non-colliding label tier -- see badge-layout.ts) from every
// render frame (60Hz) to every BADGE_LAYOUT_INTERVAL-th frame (~20Hz),
// per the render-perf pass this script was written for. Drives a real
// bot match (same sim + badge-layout code the renderer calls, real
// fighter positions and percents, not synthetic spawn-row positions) so
// the "how many candidates actually needed a fallback tier this frame"
// input matches what production sees, not a worst case.
//
// This counts *work*, not milliseconds: no CPU throttling or timers
// exist in this container that would let us claim a phone frame-time
// number honestly. What's below is countable and true regardless of
// hardware: how many times the collision solver runs, and how many
// canvas text-measurement calls it makes, per second of match time.
import { Sim } from '../packages/sim/src/sim.ts';
import { BotController, BotDifficulty, deriveBotSeed } from '../packages/sim/src/ai/bot.ts';
import { ALL_ARENAS } from '../packages/content/src/arenas.ts';
import { assignServerCharacters } from './lib/bot-character-assignment.mjs';
import * as fx from '../packages/sim/src/math/fixed.ts';
import { computeCamera, resetCameraSmoothing, worldToScreen } from '../packages/render/src/camera.ts';
import { arenaDataToStageBounds } from '../packages/render/src/arena-adapter.ts';
import { computePopulationAwareFramingFloor } from '../packages/render/src/framing.ts';
import { BODY_WIDTH, BODY_HEIGHT, HEAD_RADIUS } from '../packages/render/src/fighter-shape-placeholder.ts';
import { FighterSprite } from '../packages/render/src/fighter-sprite.ts';
import { computeBadgePlacements } from '../packages/render/src/badge-layout.ts';
import { fakeMeasureText } from '../packages/render/test/fake-measure-text.ts';

const N = 20;
const BADGE_LAYOUT_INTERVAL = 3; // must match Renderer.BADGE_LAYOUT_INTERVAL in packages/render/src/index.ts
const arenaEntry = ALL_ARENAS.find((a) => a.id === 'battle-royale-20') ?? ALL_ARENAS[0];
const seed = 12345;
const chars = assignServerCharacters(seed, N);
const sim = new Sim(seed, N, chars, arenaEntry.arena);
const bots = Array.from({ length: N }, (_, i) => new BotController(i, BotDifficulty.EASY, deriveBotSeed(seed, i)));

const BODY_HALF_WIDTH_WORLD = BODY_WIDTH * 1.3;
const BODY_TOP_WORLD = BODY_HEIGHT + HEAD_RADIUS * 2;

let measureCalls = 0;
function countingMeasureText(text, style) {
  measureCalls += 1;
  return fakeMeasureText(text, style);
}

function buildCandidates(viewWidth, viewHeight) {
  const positions = [];
  const percents = [];
  const eliminated = [];
  for (let i = 0; i < N; i++) {
    const f = sim.getFighter(i);
    positions.push({ x: fx.toFloat(f.posX), y: fx.toFloat(f.posY) });
    percents.push(fx.toFloat(f.percent));
    eliminated.push(f.eliminated);
  }
  const stage = arenaDataToStageBounds(arenaEntry.arena);
  const living = positions.filter((_, i) => !eliminated[i]);
  const spanX = living.length ? Math.max(...living.map((p) => p.x)) - Math.min(...living.map((p) => p.x)) : 0;
  const cfg = {
    viewWidth, viewHeight, minScale: 1.6, maxScale: 5.5, paddingWorld: 20,
    arena: computePopulationAwareFramingFloor(stage, viewWidth, viewHeight, living.length, spanX),
    clampBounds: { minX: stage.blastMinX, maxX: stage.blastMaxX, minY: stage.blastMinY, maxY: stage.blastMaxY },
  };
  const cam = computeCamera(living.length ? living : positions, cfg);
  const halfW = BODY_HALF_WIDTH_WORLD * cam.scale;
  const topH = BODY_TOP_WORLD * cam.scale;
  const bodyBoxes = [];
  const candidates = [];
  for (let i = 0; i < N; i++) {
    if (eliminated[i]) continue;
    const p = positions[i];
    const s = worldToScreen(p.x, p.y, cam, viewWidth, viewHeight);
    bodyBoxes.push({ slot: i, left: s.x - halfW, right: s.x + halfW, top: s.y - topH, bottom: s.y });
    candidates.push({ slot: i, isLocalPlayer: i === 0, headX: s.x, headY: s.y - FighterSprite.HEAD_TOP_OFFSET_WORLD * cam.scale, percent: percents[i] });
  }
  return { candidates, bodyBoxes };
}

const TICKS_PER_SEC = 60;
const DURATION_SEC = 60;
let frame = 0;
let baselineLayoutCalls = 0;
let baselineMeasureCalls = 0;
let throttledLayoutCalls = 0;
let throttledMeasureCalls = 0;
let lastSlotsKey = '';

resetCameraSmoothing();
for (let sec = 0; sec < DURATION_SEC; sec++) {
  for (let t = 0; t < TICKS_PER_SEC; t++) {
    const inputs = bots.map((b) => b.nextInput(sim));
    sim.advance(inputs);
    frame += 1;
    const { candidates, bodyBoxes } = buildCandidates(1280, 720);

    // Baseline: today's behaviour, computeBadgePlacements every frame.
    measureCalls = 0;
    computeBadgePlacements(candidates, bodyBoxes, undefined, { width: 1280, height: 720 }, countingMeasureText);
    baselineLayoutCalls += 1;
    baselineMeasureCalls += measureCalls;

    // Throttled: this pass's behaviour -- recompute only every
    // BADGE_LAYOUT_INTERVAL frames, or immediately when who's alive changes.
    const slotsKey = candidates.map((c) => c.slot).join(',');
    const structureChanged = slotsKey !== lastSlotsKey;
    const due = frame % BADGE_LAYOUT_INTERVAL === 0;
    if (structureChanged || due || frame === 1) {
      measureCalls = 0;
      computeBadgePlacements(candidates, bodyBoxes, undefined, { width: 1280, height: 720 }, countingMeasureText);
      throttledLayoutCalls += 1;
      throttledMeasureCalls += measureCalls;
      lastSlotsKey = slotsKey;
    }
  }
  if (sim.isMatchOver()) break;
}

const seconds = frame / TICKS_PER_SEC;
console.log(`match duration sampled: ${seconds.toFixed(1)}s (${frame} frames)`);
console.log(`baseline (every frame):   layoutCalls=${baselineLayoutCalls} (${(baselineLayoutCalls / seconds).toFixed(1)}/s)  measureTextCalls=${baselineMeasureCalls} (${(baselineMeasureCalls / seconds).toFixed(1)}/s)`);
console.log(`throttled (this pass):    layoutCalls=${throttledLayoutCalls} (${(throttledLayoutCalls / seconds).toFixed(1)}/s)  measureTextCalls=${throttledMeasureCalls} (${(throttledMeasureCalls / seconds).toFixed(1)}/s)`);
console.log(`reduction: layoutCalls ${(100 * (1 - throttledLayoutCalls / baselineLayoutCalls)).toFixed(1)}%  measureTextCalls ${(100 * (1 - throttledMeasureCalls / baselineMeasureCalls)).toFixed(1)}%`);
