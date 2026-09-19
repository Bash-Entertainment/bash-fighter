// 2026-09-18: measures how many living fighters show a visible damage
// numeral over the course of a real bot-driven 20-fighter match, running
// through the actual sim + the actual badge-layout collision code (no
// browser: production's websocket-tunnel limitation means a live online
// match can't be driven from here, so this drives a real Sim directly --
// same code path the renderer calls, real fighter positions and percents,
// not synthetic spawn-row positions). Reports min/median/worst per
// second, at 1280x720 and 390x844, using badge-layout.ts exactly as
// shipped (pass a git ref via BADGE_LAYOUT_REF env, or run this at two
// different commits and diff the printed distributions -- see the report
// for the before/after numbers this produced).
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
const arenaEntry = ALL_ARENAS.find((a) => a.id === 'battle-royale-20') ?? ALL_ARENAS[0];
const seed = 12345;
const chars = assignServerCharacters(seed, N);
const sim = new Sim(seed, N, chars, arenaEntry.arena);
const bots = Array.from({ length: N }, (_, i) => new BotController(i, BotDifficulty.EASY, deriveBotSeed(seed, i)));

const BODY_HALF_WIDTH_WORLD = BODY_WIDTH * 1.3;
const BODY_TOP_WORLD = BODY_HEIGHT + HEAD_RADIUS * 2;

function sampleAt(viewWidth, viewHeight) {
  resetCameraSmoothing();
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
  const placements = computeBadgePlacements(candidates, bodyBoxes, undefined, { width: viewWidth, height: viewHeight }, fakeMeasureText);
  const withDamage = placements.filter((p) => p.hasPercent).length;
  let overlapPairs = 0;
  for (let a = 0; a < placements.length; a++) {
    for (let b = a + 1; b < placements.length; b++) {
      const boxA = placements[a].box;
      const boxB = placements[b].box;
      if (boxA.left < boxB.right && boxA.right > boxB.left && boxA.top < boxB.bottom && boxA.bottom > boxB.top) {
        overlapPairs += 1;
      }
    }
  }
  return { living: candidates.length, withDamage, overlapPairs };
}

const TICKS_PER_SEC = 60;
const DURATION_SEC = 90;
const samples1280 = [];
const samples390 = [];
for (let sec = 0; sec < DURATION_SEC; sec++) {
  for (let t = 0; t < TICKS_PER_SEC; t++) {
    const inputs = bots.map((b) => b.nextInput(sim));
    sim.advance(inputs);
  }
  samples1280.push(sampleAt(1280, 720));
  samples390.push(sampleAt(390, 844));
  if (sim.isMatchOver()) break;
}

function report(label, samples) {
  const ratios = samples.map((s) => (s.living > 0 ? s.withDamage / s.living : 1));
  const sorted = [...ratios].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const min = sorted[0];
  const worstIdx = ratios.indexOf(min);
  const worst = samples[worstIdx];
  console.log(`${label}: samples=${samples.length} min=${(min * 100).toFixed(0)}% median=${(median * 100).toFixed(0)}% worst=${worst.withDamage}/${worst.living} at t=${worstIdx}s`);
  const overlaps = samples.map((s) => s.overlapPairs);
  const overlapsSorted = [...overlaps].sort((a, b) => a - b);
  const overlapMedian = overlapsSorted[Math.floor(overlapsSorted.length / 2)];
  const overlapWorst = Math.max(...overlaps);
  console.log(`${label} overlap pairs: median=${overlapMedian} worst=${overlapWorst} (frame-by-frame through the real placement path, injected deterministic measurer)`);
}
report('1280x720', samples1280);
report('390x844', samples390);
