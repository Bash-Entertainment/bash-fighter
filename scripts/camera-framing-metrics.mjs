// Measures dead space below the arena floor and apparent fighter height
// for the real camera pipeline (computeCamera + computePopulationAwareFramingFloor),
// across every real stage, at two viewport shapes, for a 20-scattered pack
// and a 3-clustered endgame. Written for the "dead space below floor" pass,
// 2026-09-14 (see wiki "Camera Framing: Ground Anchor and Jump-Space Bias
// 2026-09-14"). Deterministic, no wall clock, no Math.random.
//
// Run: node --experimental-strip-types scripts/camera-framing-metrics.mjs
import { ALL_ARENAS } from '../packages/content/src/arenas.ts';
import { arenaDataToStageBounds } from '../packages/render/src/arena-adapter.ts';
import { computeRawCamera, computeFitEveryoneCamera, computeCamera, resetCameraSmoothing, worldToScreen } from '../packages/render/src/camera.ts';
import { computePopulationAwareFramingFloor } from '../packages/render/src/framing.ts';
import { FIGHTER_WORLD_HEIGHT, MIN_FIGHTER_PX } from '../packages/render/src/fighter-scale.ts';

function scatteredPositions(stage, count) {
  // Spread across the full solid-ground span, standing on y=0 (or the
  // nearest platform), alternating a little vertical jitter so it is a
  // "spread pack" not a literal line. Some stages (the-undercroft) split
  // the ground into two platforms with a gap between -- union across all
  // y=0 platforms so the synthetic spread covers the true playable width.
  const groundPlatforms = stage.platforms.filter((p) => p.y === 0);
  const groundList = groundPlatforms.length > 0 ? groundPlatforms : [stage.platforms[0]];
  const minX = Math.min(...groundList.map((p) => p.minX)) + 10;
  const maxX = Math.max(...groundList.map((p) => p.maxX)) - 10;
  const ground = { y: 0 };
  const positions = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    positions.push({ x: minX + t * (maxX - minX), y: ground.y + (i % 3 === 0 ? 0 : 4) });
  }
  return positions;
}

function clusteredPositions(stage, count) {
  const groundPlatforms = stage.platforms.filter((p) => p.y === 0);
  const groundList = groundPlatforms.length > 0 ? groundPlatforms : [stage.platforms[0]];
  const minX = Math.min(...groundList.map((p) => p.minX));
  const maxX = Math.max(...groundList.map((p) => p.maxX));
  const cx = (minX + maxX) / 2;
  const positions = [];
  for (let i = 0; i < count; i++) {
    positions.push({ x: cx + (i - (count - 1) / 2) * 18, y: 0 });
  }
  return positions;
}

function cameraConfigLike(stage, viewWidth, viewHeight, livingCount) {
  return {
    viewWidth,
    viewHeight,
    minScale: 1.6,
    maxScale: 5.5,
    paddingWorld: 20,
    arena: computePopulationAwareFramingFloor(stage, viewWidth, viewHeight, livingCount),
    clampBounds: {
      minX: stage.blastMinX,
      maxX: stage.blastMaxX,
      minY: stage.blastMinY,
      maxY: stage.blastMaxY,
    },
  };
}

function measure(stage, positions, viewWidth, viewHeight) {
  const cfg = cameraConfigLike(stage, viewWidth, viewHeight, positions.length);
  // A stand-in local player, so the min-fighter-size floor's "follow the
  // local player" branch is exercised the same way it will be in a real
  // match (not just its spectator/centroid fallback).
  const localPlayerPos = positions[0];
  const fitCam = computeFitEveryoneCamera(positions, cfg);
  const cam = computeRawCamera(positions, cfg, localPlayerPos);
  const ground = stage.platforms.find((p) => p.y === 0) ?? stage.platforms[0];
  const groundScreenY = worldToScreen(0, ground.y, cam, viewWidth, viewHeight).y;
  const belowFloorFrac = Math.max(0, Math.min(1, (viewHeight - groundScreenY) / viewHeight));
  const fighterPx = FIGHTER_WORLD_HEIGHT * fitCam.scale;
  const fighterPxAfterFloor = FIGHTER_WORLD_HEIGHT * cam.scale;
  const floorPath = cam.minSizeFollow ? 'min-size-follow' : 'fit-all';

  // DAMPED-PATH CHECK (2026-09-14): the raw measurement above is exactly
  // what shipped in production for months while a real bug lived only in
  // the damped path (computeCamera's containFighters), invisible to
  // computeRawCamera and therefore invisible to this script -- see wiki
  // "Camera Framing: Ground Anchor and Jump-Space Bias 2026-09-14",
  // 2026-09-14 follow-up. containFighters re-clamped scale up to
  // cfg.minScale every damped frame after the first, discarding
  // computeRawCamera's own wider arenaFitScale-based floor on arenas
  // where that floor legitimately sits below minScale. Running a few
  // seconds of computeCamera (the real per-frame entry point, damping
  // included) and comparing its steady-state scale/ground-line to the
  // raw numbers above is what would have caught it. Positions are held
  // fixed here (no bots moving) specifically to isolate the damping
  // formula itself from sim noise.
  resetCameraSmoothing();
  let damped = null;
  for (let i = 0; i < 180; i++) {
    damped = computeCamera(positions, cfg, 1000 / 60, localPlayerPos);
  }
  const dampedGroundScreenY = worldToScreen(0, ground.y, damped, viewWidth, viewHeight).y;
  const dampedBelowFloorFrac = Math.max(0, Math.min(1, (viewHeight - dampedGroundScreenY) / viewHeight));
  const dampedScale = damped.scale;
  const dampedMismatch = Math.abs(dampedScale - cam.scale) > 0.01;

  return {
    groundScreenY,
    belowFloorFrac,
    fighterPx,
    fighterPxAfterFloor,
    floorPath,
    scale: cam.scale,
    dampedScale,
    dampedBelowFloorFrac,
    dampedMismatch,
  };
}

const viewports = [
  { name: '1280x720', w: 1280, h: 720 },
  { name: '390x844', w: 390, h: 844 },
  // 1024x520 is the narrowest/shortest viewport a real browser will give me
  // for live verification (the tooling refuses widths below 1024 and cannot
  // initialise WebGL under phone emulation), so it is the only viewport
  // where I can actually watch the legibility floor engage on production.
  { name: '1024x520', w: 1024, h: 520 },
];

const rows = [];
for (const entry of ALL_ARENAS) {
  const stage = arenaDataToStageBounds(entry.arena);
  for (const vp of viewports) {
    const pos20 = scatteredPositions(stage, 20);
    const pos3 = clusteredPositions(stage, 3);
    const m20 = measure(stage, pos20, vp.w, vp.h);
    const m3 = measure(stage, pos3, vp.w, vp.h);
    rows.push({ stage: entry.id, viewport: vp.name, pack: '20 scattered', ...m20 });
    rows.push({ stage: entry.id, viewport: vp.name, pack: '3 clustered', ...m3 });
  }
}

for (const r of rows) {
  const flag = r.dampedMismatch ? '  <-- DAMPED PATH DIVERGES FROM RAW' : '';
  console.log(
    `${r.stage.padEnd(18)} ${r.viewport.padEnd(10)} ${r.pack.padEnd(14)} belowFloor=${(r.belowFloorFrac * 100).toFixed(1)}%  fighterPx=${r.fighterPx.toFixed(1)}  scale=${r.scale.toFixed(3)}  dampedScale=${r.dampedScale.toFixed(3)}  dampedBelowFloor=${(r.dampedBelowFloorFrac * 100).toFixed(1)}%  fighterPxAfterFloor=${r.fighterPxAfterFloor.toFixed(1)}  floorPath=${r.floorPath}${flag}`,
  );
}

const anyMismatch = rows.some((r) => r.dampedMismatch);
if (anyMismatch) {
  console.log('\nFAIL: damped steady-state scale diverges from raw on at least one row above -- the deployed client (which always goes through the damped path) will not match this script'
    + " raw numbers. Do not trust the raw belowFloor/fighterPx columns as production truth until this is fixed.");
  process.exitCode = 1;
} else {
  console.log('\nOK: damped steady-state scale matches raw on every row -- raw numbers above are also what a settled live client shows.');
}

// --- debug: which axis binds the scale, and floor vs fighter span ---
if (process.env.DEBUG_SPAN) {
  for (const entry of ALL_ARENAS.slice(0,1)) {
    const stage = arenaDataToStageBounds(entry.arena);
    for (const count of [20,3]) {
      const pos = count===20 ? scatteredPositions(stage,20) : clusteredPositions(stage,3);
      const floor = computePopulationAwareFramingFloor(stage, 1280, 720, count);
      console.log(entry.id, count, 'floorSpanX', floor.maxX-floor.minX, 'floorSpanY', floor.maxY-floor.minY);
    }
  }
}
