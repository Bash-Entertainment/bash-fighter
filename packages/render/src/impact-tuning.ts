// Pure tuning for the "hit impact" presentation layer (victim hit-pause,
// squash, screen kick, KO burst). No Pixi, no clock: EffectsLayer and the
// Renderer feed these numbers into wall-clock timers. Presentation only --
// nothing here reads or writes sim state.

/** Hits at or above this normalized strength (knockback magnitude ~10+ of the
 * 20 normalisation in effects-events.ts) count as "big": only they kick the
 * screen. Smaller hits keep their flash/sparks but leave the camera alone. */
export const BIG_HIT_STRENGTH = 0.5;
/** Hits below this get no victim hit-pause at all (jabs stay snappy). */
export const PAUSE_MIN_STRENGTH = 0.25;
export const PAUSE_BASE_MS = 25;
export const PAUSE_PER_STRENGTH_MS = 55;
/** Squash keeps easing out for this long after the freeze itself ends. */
export const SQUASH_RECOVER_MS = 60;
export const SQUASH_MAX = 0.28;

/** How long the victim's picture is held still. 0 for light hits, 25-80ms above. */
export function victimPauseMs(strength: number): number {
  const s = Math.max(0, Math.min(1, strength));
  return s < PAUSE_MIN_STRENGTH ? 0 : PAUSE_BASE_MS + s * PAUSE_PER_STRENGTH_MS;
}

export function isBigHit(strength: number): boolean {
  return strength >= BIG_HIT_STRENGTH;
}

/** Squash/stretch for a victim `remainingMs` before its impact timer ends:
 * compresses along the dominant knockback axis and stretches across it,
 * full while frozen, easing to 1 during the recovery window. */
export function squashScale(
  remainingMs: number,
  totalMs: number,
  strength: number,
  dirX: number,
  dirY: number,
): { x: number; y: number } {
  if (totalMs <= 0 || remainingMs <= 0) return { x: 1, y: 1 };
  const ease = Math.min(1, remainingMs / SQUASH_RECOVER_MS);
  const amount = SQUASH_MAX * Math.max(0, Math.min(1, strength)) * ease;
  const horizontal = Math.abs(dirX) >= Math.abs(dirY);
  return horizontal ? { x: 1 - amount, y: 1 + amount } : { x: 1 + amount, y: 1 - amount };
}

/** Spark count for a hit: grows with both knockback strength and the damage
 * dealt (percent points), capped so one hit never floods the screen. */
export function sparkCount(strength: number, damage: number): number {
  const s = Math.max(0, Math.min(1, strength));
  const d = Math.max(0, Math.min(1, damage / 20));
  return 3 + Math.round(s * 4 + d * 4);
}

export const KO_BURST_LIFE_MS = 450;
export const KO_BURST_RAYS = 14;
export const MAX_KO_BURSTS = 3;
const KO_EDGE_INSET_PX = 28;

/** Where the KO burst is drawn: the fighter's last position pulled onto the
 * visible screen (inset), i.e. the edge it left through. `inwardX/Y` is the
 * unit direction from that edge point toward the screen centre. */
export function koBurstAnchor(
  x: number,
  y: number,
  vw: number,
  vh: number,
): { x: number; y: number; inwardX: number; inwardY: number } {
  const ax = Math.max(KO_EDGE_INSET_PX, Math.min(vw - KO_EDGE_INSET_PX, x));
  const ay = Math.max(KO_EDGE_INSET_PX, Math.min(vh - KO_EDGE_INSET_PX, y));
  const dx = vw / 2 - ax;
  const dy = vh / 2 - ay;
  const len = Math.hypot(dx, dy) || 1;
  return { x: ax, y: ay, inwardX: dx / len, inwardY: dy / len };
}
