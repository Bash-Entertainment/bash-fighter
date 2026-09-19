// One shared visual language for the whole game: dark, high-contrast,
// slightly austere. No gradients, no neon glow — flat fills, crisp edges.
export const PALETTE = {
  background: 0x0b0d10,
  // Raised from 0x1c2026 on 2026-09-19. The old fill sat at a 1.19:1
  // contrast ratio against the background, so platform bodies were
  // invisible and a stage read as a few thin bright edge lines floating in
  // black -- a plausible reading of the two "camera readability 1/5"
  // reports. This sits at 1.72:1 against the background (mass visible),
  // still 9:1 under the bright stage edge, and 2.47:1 against the darkest
  // fighter colour so fighters stay separate from the ground they stand on.
  stageFill: 0x333b45,
  stageEdge: 0xe8e6df,
  blastZone: 0x3a1418,
  gridLine: 0x14171b,
  hud: 0xe8e6df,
  hudDim: 0x8a8f98,
  danger: 0xd7593f,
  fighters: [0xe8b23c, 0x4fa3c4] as const, // P1 amber, P2 cyan-blue -- kept for any code that still only knows two slots
  // 20-entry FFA player palette. Hues are spread roughly every ~18deg
  // around the wheel (no two adjacent slots reading as the same colour) at
  // high saturation and a lightness tuned for strong contrast against the
  // #0a0a0a-class background and against each other. Two meanings are
  // reserved elsewhere in this vocabulary -- danger (red, ~6deg hue) and
  // hazardWarning/amber (~38deg) -- so every entry here is deliberately
  // pushed clear of those hues; none of these should read as "you are
  // being hit" or "incoming hazard" at a glance.
  playerColors: [
    0xf2c94c, // 0  gold-yellow
    0x9bd94c, // 1  lime
    0x4cd97a, // 2  green
    0x4cd9b0, // 3  teal
    0x4cc9d9, // 4  cyan
    0x4cb3d9, // 5  sky blue (shifted 2026-09-10: was 0x4c9ed9, identical hue to hazardWarning)
    0x4c6fd9, // 6  blue
    0x7a4cd9, // 7  indigo
    0xac4cd9, // 8  violet
    0xd94cc9, // 9  magenta
    0xd94c8f, // 10 rose
    0xc98a6a, // 11 dusty coral (shifted 2026-09-10: was 0xc97a6a, only ~0.2deg from danger's hue)
    0xd9a34c, // 12 ochre
    0xc9d94c, // 13 chartreuse
    0x6fd94c, // 14 grass green
    0x4cd9d0, // 15 aqua
    0x4c88d9, // 16 azure (shifted 2026-09-10: was 0x4c8fd9, too close to hazardWarning's hue)
    0x8f4cd9, // 17 purple
    0xd94ca3, // 18 pink
    0xe6e6e6, // 19 near-white (last slot, still reads flat against near-black)
  ] as const,
  fighterOutline: 0x0b0d10,
  hitbox: 0xd7593f,
  hurtbox: [0xf0cf7c, 0x9cc9de] as const, // per-owner, dimmer than fill
  debugText: 0xe8e6df,
  // Items/hazards (this task): kept in the same austere flat-fill
  // vocabulary as everything else -- distinct per item type by silhouette
  // first, colour second, never by colour alone.
  itemThrown: 0xc9c3b4, // Debug Rock: pale stone
  itemBat: 0xb7803e, // wood-brown bat
  itemBomb: 0x2c2f33, // dark shell, danger stripe drawn separately
  itemHeal: 0x6fae72, // muted green cross
  itemOutline: 0x0b0d10,
  hazardFill: 0x5a5f66, // falling debris: cold grey rock
  hazardOutline: 0x0b0d10,
  // Telegraph marker for "about to hurt you" (hazard/edge warning), as
  // distinct from `danger` ("already hurting you", red). Was amber
  // (0xe8b23c) until the 2026-09-09 colour-accessibility audit: amber and
  // this palette's red collapse into very similar mid-tone yellows/oranges
  // under protanopia and deuteranopia simulation (see the wiki page for
  // the simulated screenshots), which is exactly the pair this project
  // leans on hardest for "about to hurt you" vs "hurting you". Blue keeps
  // clean separation from red across every common colour-vision
  // deficiency, so the two severities never collapse into "which one was
  // this again". Width/pulse-speed escalation (see fighter-sprite.ts's
  // drawEdgeWarning) still carries the same information as a second,
  // colour-independent channel.
  hazardWarning: 0x4c9ed9,
} as const;

export const FONT_FAMILY = '"Iosevka", "JetBrains Mono", ui-monospace, monospace';
export const UI_FONT_FAMILY = '"Inter", "Segoe UI", system-ui, sans-serif';
