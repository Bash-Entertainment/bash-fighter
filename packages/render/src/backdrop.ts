// Presentation-only backdrop pass (this task, 2026-09-14): production
// reads as a thin ground line, a few grey slabs and otherwise pure
// black -- "unfinished prototype", the single biggest hit to how the
// game looks in a screenshot or to a first-time player. This module
// draws a low-contrast, desaturated backdrop *behind* everything else
// (stageLayer, fighters, HUD) so each of the six arenas reads as a real
// place, while staying strictly out of the way of fighter legibility.
//
// THE SEAM: backdrop identity is derived from `ArenaData.name` (already
// existing, already display-only, never read by packages/sim) via
// ARENA_NAME_TO_BACKDROP below, set onto `StageBounds.backdropId` in
// arena-adapter.ts. `name` -- not a new sim field -- is the seam because
// packages/sim is off-limits to this task and this keeps the
// presentation vocabulary entirely inside packages/render: the sim's
// ArenaData is never touched, no new field crosses the sim/render
// boundary, and adding a stage's backdrop later means an entry here,
// nothing in packages/content or packages/sim.
//
// Motion rule: every ambient element below is a pure function of
// `timeMs` (wall-clock, passed in by the renderer from performance.now())
// and the camera view (position/scale) -- never of sim tick count, never
// fed back into anything. When `reducedMotion` is true all amplitudes
// collapse to 0, matching the existing camera/effects reduced-motion
// convention (see camera.ts's isCameraReducedMotion).
import { Graphics } from 'pixi.js';
import type { CameraView } from './camera.ts';

export type BackdropId =
  | 'colosseum'
  | 'undercroft'
  | 'spire'
  | 'foundry'
  | 'atoll'
  | 'quarry';

/** ArenaData.name -> backdrop. Keyed on the display name already present
 * on every stage's data file (see the seam note above). Falls back to
 * the neutral colosseum backdrop for any unrecognised/absent name, so a
 * future stage that forgets to register here still renders (just
 * without a bespoke backdrop) rather than crashing. */
const ARENA_NAME_TO_BACKDROP: Record<string, BackdropId> = {
  'Bash Colosseum (20p)': 'colosseum',
  'The Undercroft': 'undercroft',
  'The Spire': 'spire',
  'The Foundry': 'foundry',
  'The Atoll': 'atoll',
  'The Quarry': 'quarry',
};

export function backdropIdForArenaName(name: string): BackdropId {
  return ARENA_NAME_TO_BACKDROP[name] ?? 'colosseum';
}

// Muted, desaturated tones only -- deliberately far dimmer than
// PALETTE.stageFill/stageEdge and nowhere near PALETTE.danger/hazardWarning
// (amber/red stay reserved for warning/danger, per the design language
// note in the task brief). These never touch packages/render/src/palette.ts's
// exported PALETTE object because none of them are part of the shared
// gameplay-meaning vocabulary -- they are backdrop-only set dressing.
const TONE = {
  colosseumStand: 0x22252a,
  colosseumStandDim: 0x15171b,
  undercroftPillar: 0x141a1f,
  undercroftMist: 0x1c2530,
  spireSky: 0x120f0d,
  spireTower: 0x1d1512,
  spireEmber: 0x3a2419,
  foundryGirder: 0x1c2228,
  foundryTruss: 0x262e36,
  foundryGlow: 0x2b3a44,
  atollSky: 0x0d1518,
  atollWater: 0x14262a,
  atollIsland: 0x11201f,
  quarryStrata: 0x3d3424,
  quarryStrataDim: 0x2a2418,
  quarryDust: 0x3a3222,
} as const;

/** Draws the backdrop for one frame. Called from drawStage(), first
 * thing after g.clear(), onto the same Graphics object (stageLayer) as
 * every other stage element -- platforms, walls and the blast-zone
 * boundary are drawn after this call in painter's-algorithm order, so
 * the backdrop always sits strictly behind them. */
export function drawBackdrop(
  g: Graphics,
  backdropId: BackdropId,
  cam: CameraView,
  viewWidth: number,
  viewHeight: number,
  timeMs: number,
  reducedMotion: boolean,
): void {
  g.clear();
  // Base fill -- same near-black as PALETTE.background so a backdrop
  // with no bespoke geometry in view still reads as "the void", not a
  // colour clash.
  g.rect(0, 0, viewWidth, viewHeight);
  g.fill({ color: 0x0b0d10 });
  // Slow amplitude, in px, for any drifting element. Zeroed under
  // reduced motion rather than merely slowed -- the brief asks for
  // parallax/ambient motion to stop there, not just damp.
  const amp = reducedMotion ? 0 : 1;
  const t = timeMs / 1000;

  // Gentle parallax: background elements pan a fraction of the camera's
  // own horizontal travel, purely a function of cam.centerX/scale (never
  // sim ticks), so panning the camera makes the backdrop feel like it
  // has depth without ever moving faster than the foreground.
  const parallaxX = -cam.centerX * cam.scale * 0.06;
  const parallaxY = cam.centerY * cam.scale * 0.04;

  switch (backdropId) {
    case 'colosseum':
      drawColosseum(g, viewWidth, viewHeight, parallaxX, parallaxY);
      break;
    case 'undercroft':
      drawUndercroft(g, viewWidth, viewHeight, parallaxX, parallaxY, t, amp);
      break;
    case 'spire':
      drawSpire(g, viewWidth, viewHeight, parallaxX, parallaxY, t, amp);
      break;
    case 'foundry':
      drawFoundry(g, viewWidth, viewHeight, parallaxX, parallaxY, t, amp);
      break;
    case 'atoll':
      drawAtoll(g, viewWidth, viewHeight, parallaxX, parallaxY, t, amp);
      break;
    case 'quarry':
      drawQuarry(g, viewWidth, viewHeight, parallaxX, parallaxY, t, amp);
      break;
  }
}

// Bash Colosseum: neutral baseline stage -- a dark bowl of crowd-less
// tiers seen slightly from below, curving inward and dimming as they
// rise, not a uniform grid of grey boxes. Fully static.
function drawColosseum(g: Graphics, vw: number, vh: number, px: number, py: number): void {
  // Tiers are trapezoids, not full-width rects: each one is narrower and
  // shorter than the one below it, so the stack reads as a bowl curving
  // away overhead rather than a stack of equal shelves. Curvature is a
  // simple quadratic taper (approximates the "seen from below" look
  // without needing an actual curved-path primitive).
  const tiers = 7;
  const bowlTop = vh * 0.62;
  let prevBottom = bowlTop + py * 0.1;
  for (let i = 0; i < tiers; i++) {
    const frac = i / tiers; // 0 = lowest tier (nearest), 1 = highest (farthest/up)
    const h = (vh * 0.5) / tiers * (1 - frac * 0.55); // shrinks toward the top
    const top = prevBottom - h;
    const inset = frac * frac * vw * 0.22; // curves inward quadratically, not linearly
    const alpha = 0.85 - frac * 0.45; // dims toward the top
    g.moveTo(inset, top);
    g.lineTo(vw - inset, top);
    g.lineTo(vw - inset * 0.55, prevBottom);
    g.lineTo(inset * 0.55, prevBottom);
    g.closePath();
    g.fill({ color: i % 2 === 0 ? TONE.colosseumStand : TONE.colosseumStandDim, alpha });
    prevBottom = top;
  }
  // A few short aisle dividers, irregularly placed and confined to the
  // lower two tiers only -- breaks up flatness without marching a full
  // grid of even verticals across the whole frame.
  const aisleXFractions = [0.12, 0.31, 0.68, 0.87];
  for (const f of aisleXFractions) {
    const x = f * vw + px * 0.3;
    g.rect(x, bowlTop * 0.55 + py * 0.1, 5, bowlTop * 0.45);
    g.fill({ color: TONE.colosseumStandDim, alpha: 0.5 });
  }
}

// The Undercroft: cold, sunken stonework -- a receding row of arched
// pillars plus a slow drifting mist band (the stage's own "cold
// blue-grey" identity from stage.ts's accent colour, carried into the
// backdrop).
function drawUndercroft(g: Graphics, vw: number, vh: number, px: number, py: number, t: number, amp: number): void {
  const pillarW = 34;
  const gap = 150;
  for (let i = -1; i < Math.ceil(vw / gap) + 1; i++) {
    const x = i * gap + px * 0.5 + (gap / 2);
    g.rect(x, vh * 0.15 + py * 0.2, pillarW, vh * 0.85);
    g.fill({ color: TONE.undercroftPillar, alpha: 0.8 });
    g.rect(x - 6, vh * 0.15 + py * 0.2, pillarW + 12, 14);
    g.fill({ color: TONE.undercroftPillar, alpha: 0.9 });
  }
  const drift = Math.sin(t * 0.15) * 40 * amp;
  for (let i = 0; i < 3; i++) {
    const y = vh * (0.35 + i * 0.18);
    g.rect(-80 + drift + i * 60, y, vw + 160, 26);
    g.fill({ color: TONE.undercroftMist, alpha: 0.35 });
  }
}

// The Spire: tall vertical tower -- converging perspective lines
// pulling the eye upward, plus faint rising embers (the "warm ember
// accent" from stage.ts). Motion is a slow upward drift only.
function drawSpire(g: Graphics, vw: number, vh: number, px: number, py: number, t: number, amp: number): void {
  g.rect(0, 0, vw, vh);
  g.fill({ color: TONE.spireSky, alpha: 1 });
  const cx = vw / 2 + px * 0.4;
  for (let i = -3; i <= 3; i++) {
    const topX = cx + i * 26;
    const botX = cx + i * 130;
    g.moveTo(topX, -py * 0.1);
    g.lineTo(botX, vh);
    g.stroke({ color: TONE.spireTower, width: 5, alpha: 0.72 });
  }
  const emberCount = 20;
  for (let i = 0; i < emberCount; i++) {
    const seed = i * 37.13;
    const cycle = ((t * 18 * amp + seed) % vh + vh) % vh;
    const x = ((Math.sin(seed) * 0.5 + 0.5) * vw + px * 0.2) % vw;
    const y = vh - cycle;
    g.rect(x, y, 3, 3);
    g.fill({ color: TONE.spireEmber, alpha: 0.65 });
  }
}

// The Foundry: industrial chamber -- a cool dark-grey structural truss
// (deliberately off the arena's own warm orange platform hue, so the
// backdrop never gets mistaken for more platforms) plus a distant,
// cool-toned glow that pulses gently.
function drawFoundry(g: Graphics, vw: number, vh: number, px: number, py: number, t: number, amp: number): void {
  // Diagonal cross-braces read as "truss/lattice" rather than "platform",
  // which a plain horizontal bar could be mistaken for.
  const bayWidth = 220;
  const trussTop = vh * 0.12 + py * 0.1;
  const trussBottom = vh * 0.58 + py * 0.1;
  for (let x = -bayWidth + (px * 0.4) % bayWidth; x < vw + bayWidth; x += bayWidth) {
    g.moveTo(x, trussTop);
    g.lineTo(x + bayWidth, trussBottom);
    g.stroke({ color: TONE.foundryTruss, width: 5, alpha: 0.5 });
    g.moveTo(x + bayWidth, trussTop);
    g.lineTo(x, trussBottom);
    g.stroke({ color: TONE.foundryTruss, width: 5, alpha: 0.5 });
  }
  // Top and bottom chords of the truss.
  g.rect(0, trussTop - 4, vw, 8);
  g.fill({ color: TONE.foundryGirder, alpha: 0.8 });
  g.rect(0, trussBottom - 4, vw, 8);
  g.fill({ color: TONE.foundryGirder, alpha: 0.8 });
  const pulse = (Math.sin(t * 0.6) * 0.5 + 0.5) * amp;
  const glowX = vw * 0.5 + px * 0.5;
  g.rect(glowX - 220, vh * 0.6, 440, 140);
  g.fill({ color: TONE.foundryGlow, alpha: 0.1 + 0.07 * pulse });
}

// The Atoll: open water and distant islands -- a horizon, a couple of
// low island silhouettes, and shimmering water lines (the stage's teal
// identity), drifting slowly sideways like a tide.
function drawAtoll(g: Graphics, vw: number, vh: number, px: number, py: number, t: number, amp: number): void {
  g.rect(0, 0, vw, vh);
  g.fill({ color: TONE.atollSky, alpha: 1 });
  const horizonY = vh * 0.62 + py * 0.15;
  g.rect(0, horizonY, vw, vh - horizonY);
  g.fill({ color: TONE.atollWater, alpha: 0.7 });
  const islandXs = [vw * 0.15, vw * 0.75];
  for (const ix of islandXs) {
    const x = ix + px * 0.35;
    g.moveTo(x - 70, horizonY);
    g.lineTo(x - 20, horizonY - 26);
    g.lineTo(x + 40, horizonY - 10);
    g.lineTo(x + 80, horizonY);
    g.closePath();
    g.fill({ color: TONE.atollIsland, alpha: 0.75 });
  }
  const drift = Math.sin(t * 0.25) * 24 * amp;
  for (let i = 0; i < 4; i++) {
    const y = horizonY + 18 + i * 22;
    g.rect(drift - 40 + i * 30, y, vw + 80, 2);
    g.fill({ color: TONE.atollWater, alpha: 0.35 });
  }
}

// The Quarry: exposed rock strata -- static horizontal sediment bands
// (a quarry wall doesn't sway) plus a very faint drift of dust motes.
// Lifted noticeably brighter than the first pass (which measured as
// invisible on a normal screen, ~lum 18-23) while still kept dimmer
// than PALETTE.stageFill (the platform colour, ~lum 31) via alpha.
function drawQuarry(g: Graphics, vw: number, vh: number, px: number, py: number, t: number, amp: number): void {
  const bands = 7;
  for (let i = 0; i < bands; i++) {
    const y = (i / bands) * vh + py * 0.1;
    const h = vh / bands + 2;
    g.rect(0, y, vw, h);
    g.fill({ color: i % 2 === 0 ? TONE.quarryStrata : TONE.quarryStrataDim, alpha: 0.85 });
  }
  const dustCount = 12;
  for (let i = 0; i < dustCount; i++) {
    const seed = i * 53.7;
    const x = ((Math.sin(seed) * 0.5 + 0.5) * vw + px * 0.15 + t * 6 * amp) % vw;
    const y = ((Math.cos(seed * 1.3) * 0.5 + 0.5) * vh + py * 0.1) % vh;
    g.rect(x, y, 3, 3);
    g.fill({ color: TONE.quarryDust, alpha: 0.4 });
  }
}
