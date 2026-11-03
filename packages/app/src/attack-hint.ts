// Trigger rule for the contextual attack hint: a first-match newcomer who
// has not pressed attack or special yet gets pointed at the attack control
// once something makes attacking relevant. Pure and presentation-only.
/** World-unit reach within which an enemy counts as "close enough to hit". */
export const HINT_ENEMY_RANGE_X = 24;
export const HINT_ENEMY_RANGE_Y = 18;
/** Time after GO with no attack before the hint appears regardless. */
export const HINT_IDLE_AFTER_GO_MS = 5000;

export interface AttackHintSample {
  /** Ms since the GO countdown ended; null while the countdown still runs. */
  msSinceGo: number | null;
  attackOrSpecialPressed: boolean;
  /** A live enemy is within hitting reach (see isEnemyInRange). */
  enemyInRange: boolean;
  tookDamage: boolean;
}

export function isEnemyInRange(dx: number, dy: number): boolean {
  return Math.abs(dx) <= HINT_ENEMY_RANGE_X && Math.abs(dy) <= HINT_ENEMY_RANGE_Y;
}

/** Whether a not-yet-showing hint should start showing. */
export function shouldShowAttackHint(s: AttackHintSample): boolean {
  if (s.msSinceGo === null || s.attackOrSpecialPressed) return false;
  return s.enemyInRange || s.tookDamage || s.msSinceGo >= HINT_IDLE_AFTER_GO_MS;
}
