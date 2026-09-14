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
import { computeRawCamera, worldToScreen } from '../packages/render/src/camera.ts';
import { computePopulationAwareFramingFloor } from '../packages/render/src/framing.ts';

// Approximate fighter half-height in world units, matching
// fighter-shape-placeholder.ts's capsule (used only to convert a camera
// scale into an apparent on-screen pixel height, not simulation truth).
const FIGHTER_WORLD_HEIGHT = 36;

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
  const cam = computeRawCamera(positions, cfg);
  const ground = stage.platforms.find((p) => p.y === 0) ?? stage.platforms[0];
  const groundScreenY = worldToScreen(0, ground.y, cam, viewWidth, viewHeight).y;
  const belowFloorFrac = Math.max(0, Math.min(1, (viewHeight - groundScreenY) / viewHeight));
  const fighterPx = FIGHTER_WORLD_HEIGHT * cam.scale;
  return { groundScreenY, belowFloorFrac, fighterPx, scale: cam.scale };
}

const viewports = [
  { name: '1280x720', w: 1280, h: 720 },
  { name: '390x844', w: 390, h: 844 },
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
  console.log(
    `${r.stage.padEnd(18)} ${r.viewport.padEnd(10)} ${r.pack.padEnd(14)} belowFloor=${(r.belowFloorFrac * 100).toFixed(1)}%  fighterPx=${r.fighterPx.toFixed(1)}  scale=${r.scale.toFixed(3)}`,
  );
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
