// Shared fighter-size constants used by the camera's legibility floor
// (camera.ts) and by scripts/camera-framing-metrics.mjs, which measures
// against the exact same numbers the camera enforces at runtime. Kept in
// one file so the two never drift into two different "how tall is a
// fighter" answers.

/** Approximate fighter world-space height (capsule), matching
 * fighter-shape-placeholder.ts. Used only to convert a camera scale into
 * an apparent on-screen pixel height for legibility purposes -- never
 * consulted by packages/sim, so it cannot affect simulation truth. */
export const FIGHTER_WORLD_HEIGHT = 36;

/** Camera legibility floor (2026-09-19, see wiki "Real Player
 * Measurements 2026-09-14: Phones Are the Primary Platform" and
 * "Camera Framing: Ground Anchor and Jump-Space Bias 2026-09-14"):
 * scripts/camera-framing-metrics.mjs measured a fighter rendered only
 * 12.5-17.6px tall on a 390x844 phone viewport with 20 fighters spread
 * across the arena (fine at 41-58px on 1280x720 desktop) -- two real
 * players rated camera readability 1/5. No fighter should ever render
 * shorter than this on screen; below it the camera gives up on framing
 * everyone and follows the local player (or the living centroid when
 * spectating) at this fixed minimum scale instead. */
export const MIN_FIGHTER_PX = 26;
