// Draws every platform of the arena and the blast-zone boundary from
// arena data — dimensions always come from StageBounds, never a
// hardcoded size, so this reads correctly whether it's a single flat
// stage or a multi-platform 20-player arena. Blast zones are drawn as an
// obvious dashed line + darker outer wash so a player always knows how
// far offstage is safe.
import { Graphics } from 'pixi.js';
import { PALETTE } from './palette.ts';
import type { CameraView } from './camera.ts';
import { worldToScreen } from './camera.ts';
import { drawBackdrop } from './backdrop.ts';

/** One flat platform in world units — mirrors @bash-fighter/sim's
 * Platform (minX/maxX/y as floats instead of Fixed) so the renderer
 * doesn't need the fixed-point type, only the numbers. */
export interface StagePlatform {
  minX: number;
  maxX: number;
  y: number;
  /** Mirrors sim Platform.kind. Drawn distinctly (see drawStage) so a
   * player can tell at a glance which platforms they can drop through. */
  kind?: 'solid' | 'pass-through';
}

/** One vertical wall segment in world units — mirrors sim Wall. */
export interface StageWall {
  x: number;
  minY: number;
  maxY: number;
}

export interface StageBounds {
  /** Every platform to draw. A single-platform stage is just a
   * one-element array — there is no separate "flat stage" code path. */
  platforms: readonly StagePlatform[];
  /** Vertical wall segments to draw and (in-sim) collide against.
   * Defaults to none for stages/tests that predate walls. */
  walls?: readonly StageWall[];
  blastMinX: number;
  blastMaxX: number;
  blastMinY: number;
  blastMaxY: number;
  /** Optional per-stage accent (0xRRGGBB) for the platform edge highlight
   * only. Falls back to PALETTE.stageEdge when absent. This is the whole
   * visual-identity budget a stage gets beyond its own geometry: no fill
   * colour change, no gradients, nothing that touches the danger/warning
   * palette. */
  accentColor?: number;
  /** Which backdrop (see backdrop.ts) to draw behind this stage's
   * platforms. Presentation-only, derived from the arena's display name
   * in arena-adapter.ts -- see backdrop.ts's seam note. Optional so
   * tests/callers that predate the depth pass still validate; drawBackdrop
   * falls back to the neutral colosseum backdrop when absent. */
  backdropId?: import('./backdrop.ts').BackdropId;
}

/** Where the blast-zone boundary will be at a fixed lookahead from now
 * (see PREVIEW_LOOKAHEAD_TICKS in the app layer). Lets a player see the
 * boundary they need to react to, not just the one they're already at.
 * Optional and separate from StageBounds because callers without a live
 * shrink schedule (menus, tests) have nothing to put here. */
 export interface BlastPreview {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

// How thick the platform slab reads, in world units — scales with the
// camera like everything else, so it stays proportionally chunky whether
// we're zoomed into a 400-unit stage or a much bigger one later.
const PLATFORM_DEPTH_WORLD = 22;

export function drawStage(
  g: Graphics,
  bounds: StageBounds,
  cam: CameraView,
  viewWidth: number,
  viewHeight: number,
  preview?: BlastPreview | null,
  suppressOuterWash = false,
  backdropTimeMs = 0,
  backdropReducedMotion = false,
): void {
  g.clear();

  // DEPTH PASS (2026-09-14): drawn onto this same Graphics object, first,
  // so every platform/wash/boundary drawn below it lands on top in the
  // same draw call. An earlier version used a separate Graphics layer
  // added behind stageLayer in index.ts's container tree; that layer's
  // draws never composited to the screen in this renderer/browser combo
  // (confirmed by isolation testing: identical rect+fill calls painted
  // fine on this object but not on a sibling layer at the same
  // container depth) even though geometry/instructions were present and
  // correct. Drawing backdrop content directly into stageLayer's own
  // Graphics sidesteps that entirely and is the seam that's actually
  // verified working by looking at the game.
  drawBackdrop(g, bounds.backdropId ?? 'colosseum', cam, viewWidth, viewHeight, backdropTimeMs, backdropReducedMotion);

  // Darker wash outside the blast zone so "offstage" reads as a distinct
  // zone even before the dashed line registers.
  // The wash goes OUTSIDE the blast zone, not inside it. Filling the inside
  // tinted the entire playable area red, which read as a permanent damage
  // vignette and made the whole game look like it was in an error state.
  //
  // `suppressOuterWash` (attract mode only, see index.ts's
  // setAttractFraming): the start screen's demo camera frames tightly on
  // the bot cluster rather than the whole arena floor, but a tight-zoomed
  // camera can still have a lot of outside-blast-zone area in frame on a
  // wide/tall stage -- for a first-time visitor that read as a permanent
  // red error wash, not "danger zone". This is presentation-only: the
  // real per-player edge-danger warning and the boundary dashed line
  // below are untouched, and no real match ever sets this flag.
  const insideTL = worldToScreen(bounds.blastMinX, bounds.blastMaxY, cam, viewWidth, viewHeight);
  const insideBR = worldToScreen(bounds.blastMaxX, bounds.blastMinY, cam, viewWidth, viewHeight);

  // DEPTH PASS (2026-09-14): this used to be a full-screen "outer wash"
  // rect followed by an opaque background-colour rect painted over the
  // entire inside-blast-zone area to erase it back out. That inside
  // erase is exactly what made the arena read as flat black no matter
  // what sat behind it -- see backdrop.ts/backdropLayer in index.ts,
  // drawn immediately before this function runs, which the erase used to
  // paint straight over. Four border strips covering only the area
  // strictly outside the blast rect give the identical on-screen "danger
  // wash outside, clean playable area inside" result without ever
  // touching (and hiding) the inside-blast-zone pixels the backdrop now
  // occupies.
  if (!suppressOuterWash) {
    const pad = 2000 * cam.scale;
    const stripColor = PALETTE.blastZone;
    const stripAlpha = 0.28;
    // Left
    g.rect(insideTL.x - pad, 0, pad, viewHeight);
    g.fill({ color: stripColor, alpha: stripAlpha });
    // Right
    g.rect(insideBR.x, 0, pad, viewHeight);
    g.fill({ color: stripColor, alpha: stripAlpha });
    // Top (between the left/right strips only, so corners aren't double-drawn)
    g.rect(insideTL.x, 0, insideBR.x - insideTL.x, insideTL.y);
    g.fill({ color: stripColor, alpha: stripAlpha });
    // Bottom
    g.rect(insideTL.x, insideBR.y, insideBR.x - insideTL.x, viewHeight - insideBR.y);
    g.fill({ color: stripColor, alpha: stripAlpha });
  }

  // Anticipation band: the strip of ground that is currently safe but
  // will be outside the boundary by the time `preview` is reached (see
  // PREVIEW_LOOKAHEAD_TICKS in the app layer). Drawn as a low-alpha amber
  // fill between the current boundary and the future one, then punched
  // back out to background colour inside the future boundary -- same
  // outer/inner overlay technique as the blast-zone wash above, so it's
  // just two more rects, not a shader or a mask. Skipped entirely once
  // the future boundary is (numerically) the same as the current one --
  // late in a match the shrink has already finished and a zero-width
  // band would just be visual noise.
  const hasPreview =
    !!preview &&
    (Math.abs(preview.minX - bounds.blastMinX) > 0.5 ||
      Math.abs(preview.maxX - bounds.blastMaxX) > 0.5 ||
      Math.abs(preview.minY - bounds.blastMinY) > 0.5 ||
      Math.abs(preview.maxY - bounds.blastMaxY) > 0.5);

  if (hasPreview && preview) {
    // DEPTH PASS (2026-09-14): this used to fill the whole current-blast
    // rect with the amber tint, then punch an opaque PALETTE.background
    // rect over the future-safe sub-area to remove the tint there. That
    // opaque punch painted straight over the backdrop for almost the
    // entire playable area (the future boundary is close to the current
    // one early in a match), which is exactly the "why is it all black"
    // bug this pass is fixing elsewhere. Same border-strip technique as
    // the outer wash: draw the amber tint only in the four strips that
    // are inside the current boundary but outside the future one, and
    // never paint over the inside-future area at all.
    const futureTL = worldToScreen(preview.minX, preview.maxY, cam, viewWidth, viewHeight);
    const futureBR = worldToScreen(preview.maxX, preview.minY, cam, viewWidth, viewHeight);
    const tintColor = PALETTE.hazardWarning;
    const tintAlpha = 0.16;
    // Left
    g.rect(insideTL.x, insideTL.y, futureTL.x - insideTL.x, insideBR.y - insideTL.y);
    g.fill({ color: tintColor, alpha: tintAlpha });
    // Right
    g.rect(futureBR.x, insideTL.y, insideBR.x - futureBR.x, insideBR.y - insideTL.y);
    g.fill({ color: tintColor, alpha: tintAlpha });
    // Top (between the left/right strips only)
    g.rect(futureTL.x, insideTL.y, futureBR.x - futureTL.x, futureTL.y - insideTL.y);
    g.fill({ color: tintColor, alpha: tintAlpha });
    // Bottom
    g.rect(futureTL.x, futureBR.y, futureBR.x - futureTL.x, insideBR.y - futureBR.y);
    g.fill({ color: tintColor, alpha: tintAlpha });
  }

  // Solid platform slabs, each drawn with a visible top edge and a
  // darker underside so every one reads as a floating platform, not a
  // flat line. A single-slab stage is just this loop running once.
  for (const platform of bounds.platforms) {
    const topL = worldToScreen(platform.minX, platform.y, cam, viewWidth, viewHeight);
    const topR = worldToScreen(platform.maxX, platform.y, cam, viewWidth, viewHeight);
    const depthPx = PLATFORM_DEPTH_WORLD * cam.scale;
    const width = topR.x - topL.x;
    const passThrough = platform.kind === 'pass-through';

    // Pass-through platforms read thinner and lower-alpha than solid
    // ground -- the same silhouette shorthand as the rest of the genre:
    // a platform you can see through (a little) is one you can fall
    // through. Solid ground stays fully opaque.
    const slabDepth = passThrough ? depthPx * 0.55 : depthPx;
    g.rect(topL.x, topL.y, width, slabDepth);
    g.fill({ color: PALETTE.stageFill, alpha: passThrough ? 0.7 : 1 });
    if (!passThrough) {
      g.rect(topL.x, topL.y + depthPx * 0.55, width, depthPx * 0.45);
      g.fill({ color: PALETTE.background, alpha: 0.35 });
    }
    g.rect(topL.x, topL.y, width, Math.max(3, depthPx * 0.08));
    g.fill({ color: bounds.accentColor ?? PALETTE.stageEdge });
  }

  // Walls: solid vertical bars, drawn full-height across their y-range so
  // "you cannot walk through this" reads unambiguously -- deliberately
  // more solid-looking than any platform, since a wall blocks from both
  // sides with no "land on top" reading to preserve.
  const WALL_WIDTH_WORLD = 10;
  for (const wall of bounds.walls ?? []) {
    const top = worldToScreen(wall.x, wall.maxY, cam, viewWidth, viewHeight);
    const bottom = worldToScreen(wall.x, wall.minY, cam, viewWidth, viewHeight);
    const widthPx = WALL_WIDTH_WORLD * cam.scale;
    g.rect(top.x - widthPx / 2, top.y, widthPx, bottom.y - top.y);
    g.fill({ color: bounds.accentColor ?? PALETTE.stageEdge });
    g.rect(top.x - widthPx / 2 + widthPx * 0.2, top.y, widthPx * 0.6, bottom.y - top.y);
    g.fill({ color: PALETTE.stageFill });
  }

  // Future boundary: a fainter amber dashed line at where the current
  // boundary is headed. Drawn before the current (red) boundary so the
  // red line stays visually on top -- "this already hurts you" always
  // reads stronger than "this will hurt you soon".
  if (hasPreview && preview) {
    const futureTL = worldToScreen(preview.minX, preview.maxY, cam, viewWidth, viewHeight);
    const futureBR = worldToScreen(preview.maxX, preview.minY, cam, viewWidth, viewHeight);
    drawDashedRect(
      g,
      futureTL.x,
      futureTL.y,
      futureBR.x - futureTL.x,
      futureBR.y - futureTL.y,
      PALETTE.hazardWarning,
      0.55,
    );
  }

  // Blast zone boundary: dashed rectangle around the whole arena.
  drawDashedRect(g, insideTL.x, insideTL.y, insideBR.x - insideTL.x, insideBR.y - insideTL.y, PALETTE.danger, 0.8);
}

function drawDashedRect(g: Graphics, x: number, y: number, w: number, h: number, color: number, alpha: number): void {
  const dash = 10;
  const gap = 8;
  const segments: [number, number, number, number][] = [
    [x, y, x + w, y],
    [x + w, y, x + w, y + h],
    [x + w, y + h, x, y + h],
    [x, y + h, x, y],
  ];
  for (const [x0, y0, x1, y1] of segments) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.floor(len / (dash + gap)));
    for (let i = 0; i < steps; i++) {
      const t0 = (i * (dash + gap)) / len;
      const t1 = Math.min(1, t0 + dash / len);
      g.moveTo(x0 + dx * t0, y0 + dy * t0);
      g.lineTo(x0 + dx * t1, y0 + dy * t1);
    }
  }
  g.stroke({ color, width: 2, alpha });
}
