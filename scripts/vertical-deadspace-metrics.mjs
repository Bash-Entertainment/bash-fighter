
// Measures, over the course of a full headless 20-fighter match per stage,
// what fraction of a 1280x720 viewport lies BELOW the lowest walkable ground
// surface (y=0, screen area that can never hold a standing fighter) and what
// fraction lies ABOVE the highest platform, using the real damped camera
// pipeline (computeCamera). Companion to scripts/camera-framing-metrics.mjs,
// which only checks static synthetic poses; this one samples a real running
// match's whole camera trajectory. Added 2026-09-21 for the
// "framing-and-ko-distribution" measurement task -- MEASUREMENT ONLY, no
// balance/behavior changes.
//
// Run: node --experimental-strip-types scripts/vertical-deadspace-metrics.mjs
import { Sim } from '../packages/sim/src/sim.ts';
import { BotController, BotDifficulty, deriveBotSeed } from '../packages/sim/src/ai/bot.ts';
import * as fx from '../packages/sim/src/math/fixed.ts';
import { ALL_ARENAS } from '../packages/content/src/arenas.ts';
import { arenaDataToStageBounds } from '../packages/render/src/arena-adapter.ts';
import { computeCamera, resetCameraSmoothing, worldToScreen } from '../packages/render/src/camera.ts';
import { computePopulationAwareFramingFloor } from '../packages/render/src/framing.ts';
import { assignServerCharacters } from './lib/bot-character-assignment.mjs';

const N = 20;
const SEED = 424242;
const TICKS = 10800; // 3 min cap @ 60hz, same as bot-brawl-metrics.mjs
const VW = 1280, VH = 720;

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function cameraConfig(stage, livingCount) {
  return {
    viewWidth: VW,
    viewHeight: VH,
    minScale: 1.6,
    maxScale: 5.5,
    paddingWorld: 20,
    arena: computePopulationAwareFramingFloor(stage, VW, VH, livingCount),
    clampBounds: {
      minX: stage.blastMinX,
      maxX: stage.blastMaxX,
      minY: stage.blastMinY,
      maxY: stage.blastMaxY,
    },
  };
}

const results = [];
for (const entry of ALL_ARENAS) {
  const stage = arenaDataToStageBounds(entry.arena);
  const groundPlatforms = stage.platforms.filter((p) => p.y === 0);
  const groundY = groundPlatforms.length > 0 ? 0 : Math.min(...stage.platforms.map((p) => p.y));
  const topY = Math.max(...stage.platforms.map((p) => p.y));

  const characters = assignServerCharacters(SEED, N);
  const sim = new Sim(SEED, N, characters);
  const bots = Array.from({ length: N }, (_, i) => new BotController(i, BotDifficulty.EASY, deriveBotSeed(SEED, i)));
  resetCameraSmoothing();

  const belowFracs = [];
  const aboveFracs = [];
  let matchOverTick = -1;

  for (let t = 0; t < TICKS; t++) {
    const inputs = bots.map((b) => b.nextInput(sim));
    sim.advance(inputs);

    const positions = [];
    for (let i = 0; i < N; i++) {
      const f = sim.getFighter(i);
      if (!f.eliminated) positions.push({ x: fx.toFloat(f.posX), y: fx.toFloat(f.posY) });
    }
    if (positions.length === 0) { matchOverTick = t; break; }

    const cfg = cameraConfig(stage, positions.length);
    const cam = computeCamera(positions, cfg, 1000 / 60, positions[0]);

    if (t % 15 === 0) {
      const groundScreenY = worldToScreen(0, groundY, cam, VW, VH).y;
      const topScreenY = worldToScreen(0, topY, cam, VW, VH).y;
      belowFracs.push(Math.max(0, Math.min(1, (VH - groundScreenY) / VH)));
      aboveFracs.push(Math.max(0, Math.min(1, topScreenY / VH)));
    }

    if (matchOverTick < 0 && sim.isMatchOver && sim.isMatchOver()) {
      matchOverTick = t;
      break;
    }
  }

  belowFracs.sort((a, b) => a - b);
  aboveFracs.sort((a, b) => a - b);
  results.push({
    stage: entry.id,
    samples: belowFracs.length,
    durationSec: Number(((matchOverTick >= 0 ? matchOverTick : TICKS) / 60).toFixed(1)),
    belowFloorMedianPct: Number((percentile(belowFracs, 0.5) * 100).toFixed(2)),
    belowFloorP90Pct: Number((percentile(belowFracs, 0.9) * 100).toFixed(2)),
    aboveTopMedianPct: Number((percentile(aboveFracs, 0.5) * 100).toFixed(2)),
    aboveTopP90Pct: Number((percentile(aboveFracs, 0.9) * 100).toFixed(2)),
  });
}

console.log(JSON.stringify(results, null, 2));
