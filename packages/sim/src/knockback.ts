// Knockback model (Engine Architecture section 3): f(damage, target_percent,
// move_base_kb, move_kb_growth, target_weight) -> fixed-point magnitude,
// applied along an angle (mirrored by facing, adjusted by DI) to produce a
// velocity. Hitstun duration is proportional to that magnitude. Constants
// below are Bash Entertainment's own invented tuning, not Melee's.
import type { Fixed } from './math/fixed.ts';
import * as fx from './math/fixed.ts';
import { LUT_SIZE } from './math/fixed.ts';

// Heavier fighters take less knockback: weightTerm = WEIGHT_NUM / (weight + WEIGHT_OFFSET).
export const WEIGHT_NUM: Fixed = fx.fromInt(150);
export const WEIGHT_OFFSET: Fixed = fx.fromInt(50);
// Current percent contributes half its value on top of the raw hit damage
// when scaling knockback growth, mirroring genre convention that a fighter
// already damaged flies further from the same hit.
export const PERCENT_DIVISOR: Fixed = fx.fromInt(2);
// Ticks of hitstun per unit of knockback magnitude (magnitude is in the same
// units as velocity, e.g. ~1-20 for a typical hit).
export const HITSTUN_PER_MAGNITUDE: Fixed = fx.fromFloat(0.6);
export const MIN_HITSTUN_TICKS = 2;
export const MAX_HITSTUN_TICKS = 240;

// Uniform multiplier on the *percent-scaled* portion of knockback only
// (never on baseKnockback). Applied identically to every character, so the
// authored per-move base/growth numbers and the existing weight-based
// scaling (150/(weight+50)) keep the roster's relative spread (light
// fighters still fly further than heavy ones, in the same ratio as before)
// -- this only raises how hard a landed, percent-scaled hit finishes
// someone, so combat can end matches before the ring does. 1.3 chosen as
// a moderate first step: see wiki page "Bot Combat Engagement Fix
// 2026-09-09" follow-up for before/after measurement.
// 2026-09-09: tried 1.3 to raise combat share; reverted to 1.0 by owner
// decision -- it bought ~3pp of combat share (inside measurement noise)
// at the cost of stalemate timeouts on two of three stages and a
// suspected rise in final-two double-KOs. See wiki "Ring Pressure Not
// Executioner: 2026-09-09 Rebalance" for the measurements. Left in place
// as a named lever (rather than removed outright) so future lethality
// tuning has one clear place to change, but do not raise it again without
// the final-two double-KO metric in place first.
// PACING REWORK 2026-09-10, LEVER 3 (see wiki "Match Pacing Rework"):
// lowered from 1.0 to 0.75. Prior passes only tried *raising* this (1.3,
// reverted for stalemates/double-KOs). Production evidence this pass shows
// matches ending almost entirely by combat inside ~30s with essentially no
// middle game, so this pass tries the opposite direction: fewer knockback
// units per point of damage means more hits are needed to finish a fighter,
// which should extend individual fights (a real middle game) rather than
// just delaying when they start (see Lever 2, spawn spacing). Measured via
// production journalctl, one lever at a time -- see wiki page for the
// keep/revert decision and numbers.
// PACING REWORK 2026-09-10, LEVER 7 (match-arc lengthening pass): lowered
// again from 0.75 to 0.6. Live-play evidence this pass (see wiki "Match
// Arc Lengthening Pass 2026-09-10") shows matches still resolving in
// 44-70s against a 150-180s target even with the 8-minute ring clock and
// the 0.75 scale/early dampener from prior passes -- the ring is not the
// bottleneck, individual fights ending too fast is. Lowering the fraction
// of damage/percent that converts into knockback growth means more
// exchanges are needed to build enough magnitude to launch a fighter off
// -stage, which directly lengthens fights without changing the damage
// percent a player sees per hit.
// PACING REWORK 2026-09-10, LEVER 9 -- TRIED AND REJECTED: lowering again
// 0.6 -> 0.5 was tested (production evidence post-Lever-7/8 deploy eaf24fa
// still showed 44-73s matches against the 150-180s target). It broke the
// non-negotiable match-resolution guarantee: `npm test`'s
// arena-shrink.test.ts seed 1003 ("full 20-fighter bot matches resolve
// decisively") timed out at the 36000-tick ceiling with no winner --
// fights got weak enough that combat could no longer reliably finish a
// stalemated pair before the ring's own stalemate override (itself tuned
// against real match lengths of 110-207s, not against a deliberately
// weakened knockback model) ran out of runway. Reverted to 0.6. See wiki
// "Match Pacing Pass 2026-09-10: Toward a 2.5-3 Minute Arc" for the full
// account. Do not lower this again without also re-deriving the
// stalemate-override timing in arena-shrink.ts against the new, weaker
// knockback model.
export const KB_GROWTH_SCALE: Fixed = fx.fromFloat(0.6);

// STRUCTURAL PACING LEVER (2026-09-10, see wiki "Match Pacing Rework
// 2026-09-10 Pass 3" and "Bot Difficulty Correction and Human-Survival
// Fix 2026-09-10"): every prior pass tuned constants (spacing,
// KB_GROWTH_SCALE, retarget cooldown, shrink ceiling) and plateaued
// around ~50s average / ~79s best against a 150-180s target, with
// run-to-run variance as large as any single lever's effect. Pass 3's
// own recommendation was a structural change rather than another
// constant nudge: this is that change.
//
// EARLY_MATCH_KB_DAMPENER softens knockback magnitude only, only for the
// first EARLY_MATCH_RAMP_TICKS of a match, ramping linearly back to 1.0x
// by the end of the window. It does not touch damage percent (so the
// percent race is unaffected) and it does not touch EASY's existing
// protection logic (bot.ts) at all -- this is a combat-model change,
// applied identically regardless of who is hit.
//
// Why knockback and not damage: damage percent is also what a player
// reads as progress, so half-damaging the opening would make early hits
// feel like they don't matter. Softening knockback keeps every early
// hit visibly connecting (same damage, slightly less hitstun) but stops
// the opening scrum from converting its first exchange directly into
// blast-zone kills -- which is what was collapsing the match into a
// single ~20-30s trade. As the window ends, full knockback returns and
// the middle/endgame plays exactly as before.
// PACING REWORK 2026-09-10, LEVER 8: widened the early-game dampener --
// start lower (0.45 -> 0.35) and ramp back to full over a minute instead
// of 30s (1800 -> 3600 ticks). The opening scrum was still converting
// into the first eliminations well inside a minute; a longer, deeper
// soft-start buys more of the "many fighters still alive, jockeying"
// phase the owner's 150-180s target arc describes before the first kills
// land, without touching damage percent at all.
//
// PACING CORRECTION 2026-09-15: Lever 8's widening (above) was tuned
// against pre-crowd-scale duel-strength damage, to buy time before the
// opening scrum's *first* exchange could convert straight into a kill.
// crowdDamageScale() (commit 1e96eee) now does that same job directly and
// far more precisely -- it scales percent accrual itself down to floor
// 0.2-0.4x whenever the lobby is still crowded, self-adjusting as players
// die, rather than a fixed 60 real-time seconds regardless of population.
// With both stacked, the opening quarter of a 20-player match (measured:
// 49s to reach 15 alive) was being double-suppressed: soft damage *and*
// soft knockback on top of it. Narrowed the ramp back to its pre-Lever-8
// 30s width (1800 ticks); crowdDamageScale now does the population-aware
// part of this job. Left the tick-0 dampener depth (0.35x) unchanged --
// content/test/spawn-clearance.test.ts's worst-case-early-hit-arc margin
// is computed at tick 0 and is load-bearing for a real fixed defect
// (see wiki "Spawn Clearance Audit: All Stages 2026-09-11"); raising the
// tick-0 floor back toward 0.45x reintroduced that shortfall on
// the-quarry when tried, so only the ramp *duration* changed here.
export const EARLY_MATCH_KB_DAMPENER_START = fx.fromFloat(0.35);
export const EARLY_MATCH_RAMP_TICKS = 1800; // 30s @ 60Hz

/** 0.45x at tick 0, ramping linearly to 1.0x at EARLY_MATCH_RAMP_TICKS and
 * beyond. Pure function of tick -- safe from both server and client sims,
 * determinism-preserving (same tick in, same scale out). */
export function earlyMatchKnockbackScale(tick: number): Fixed {
  if (tick >= EARLY_MATCH_RAMP_TICKS) return fx.fromInt(1);
  if (tick <= 0) return EARLY_MATCH_KB_DAMPENER_START;
  const progress = fx.div(fx.fromInt(tick), fx.fromInt(EARLY_MATCH_RAMP_TICKS));
  const range = fx.sub(fx.fromInt(1), EARLY_MATCH_KB_DAMPENER_START);
  return fx.add(EARLY_MATCH_KB_DAMPENER_START, fx.mul(range, progress));
}

/** magnitude = (baseKb + KB_GROWTH_SCALE * kbGrowth * (damage + percentAfterHit / 2) * (150 / (weight + 50))) * earlyMatchKnockbackScale(tick) */
export function computeKnockbackMagnitude(
  damage: Fixed,
  percentAfterHit: Fixed,
  baseKnockback: Fixed,
  knockbackGrowth: Fixed,
  weight: Fixed,
  tick: number = EARLY_MATCH_RAMP_TICKS,
): Fixed {
  const weightTerm = fx.div(WEIGHT_NUM, fx.add(weight, WEIGHT_OFFSET));
  const percentTerm = fx.add(damage, fx.div(percentAfterHit, PERCENT_DIVISOR));
  const scaled = fx.mul(fx.mul(knockbackGrowth, percentTerm), KB_GROWTH_SCALE);
  const raw = fx.add(baseKnockback, fx.mul(scaled, weightTerm));
  return fx.mul(raw, earlyMatchKnockbackScale(tick));
}

// CROWD-AWARE DAMAGE SCALE (2026-09-14, see wiki "20-Player Damage Curve
// Rework 2026-09-14"): in a 20-fighter free-for-all, a fighter can be hit by
// many attackers in the same window, so per-hit damage authored for a 1v1
// duel (Combat Model: Knockback, Hitstun, and DI) produces roughly an order
// of magnitude more incoming damage per second than the 1v1 model assumed.
// Measured before this change (scripts/damage-curve-metrics.mjs, EASY bots,
// battle-royale-20, 10 seeds): median percent already 34% at 10s and 61% at
// 20s, saturating the 0-150ish% kill-range curve inside the opening seconds
// -- production logs cross-checked the same match ended with the first
// knockout at 15.3s and the eventual winner still finishing around 78s
// (journalctl elimination events, matchId m1, 2026-09-15 03:06 UTC).
//
// This scales *only the damage number itself* -- not the knockback formula,
// not weight, not DI -- by how many fighters are alive right now, so a 1v1
// or small-lobby fight keeps exactly the tuning in the combat model doc
// (scale = 1.0 at CROWD_SCALE_REFERENCE_ALIVE or fewer alive) while a full
// 20-player lobby takes a fraction of that per hit. It converges back to
// 1.0 as the lobby thins out over the match, which is what makes percent
// climb through the *whole* match instead of saturating in the opening
// scrum: the same fighter that took 20%-scaled hits at 20 alive takes
// full-scale hits once only a handful of fighters remain.
export const CROWD_SCALE_REFERENCE_ALIVE = fx.fromInt(8);
export const CROWD_SCALE_MIN: Fixed = fx.fromFloat(0.2);

/** 1.0 at <= CROWD_SCALE_REFERENCE_ALIVE fighters alive (duel-tuned damage
 * is untouched), falling off toward CROWD_SCALE_MIN as more fighters are
 * alive simultaneously. Pure function of an integer count -- deterministic,
 * fixed-point, no wall clock, no RNG. */
export function crowdDamageScale(aliveCount: number): Fixed {
  const alive = aliveCount < 1 ? 1 : aliveCount;
  const scale = fx.div(CROWD_SCALE_REFERENCE_ALIVE, fx.fromInt(alive));
  const capped = (scale as number) > (fx.fromInt(1) as number) ? fx.fromInt(1) : scale;
  return (capped as number) < (CROWD_SCALE_MIN as number) ? CROWD_SCALE_MIN : capped;
}

export function computeHitstunTicks(magnitude: Fixed): number {
  const ticks = fx.toInt(fx.mul(magnitude, HITSTUN_PER_MAGNITUDE));
  if (ticks < MIN_HITSTUN_TICKS) return MIN_HITSTUN_TICKS;
  if (ticks > MAX_HITSTUN_TICKS) return MAX_HITSTUN_TICKS;
  return ticks;
}

// HITSTOP (2026-09-15): the brief freeze on contact that the presentation
// pass ([[Game Feel, Audio, and Reconnection]]) deliberately left out of
// the renderer and flagged as a real gameplay change requiring a decision.
// See wiki "Combat Model: Knockback, Hitstun, and DI" 2026-09-15 addendum
// for the full writeup (durations tried, match-length effect, why both
// attacker and defender freeze). Short version of what the constants
// below encode:
//
// - Scales with the same `magnitude` that already drives hitstun, so a
//   jab (magnitude ~3-5 for the placeholder's moveset) and a heavy aerial
//   (magnitude ~15-20) do not freeze for the same duration -- a light tap
//   should barely register as a freeze, a kill-range hit should read as a
//   real event.
// - Deliberately much shorter than hitstun (HITSTOP_PER_MAGNITUDE is
//   roughly 1/10th of HITSTUN_PER_MAGNITUDE): hitstop is the *impact*
//   instant, hitstun is what happens *after* it, and letting hitstop eat
//   into hitstun would mean strong hits (long hitstun already) also lose
//   proportionally more of it to the freeze, which is backwards -- weak
//   hits should feel snappy, not draggy.
// - Hard-capped at MAX_HITSTOP_TICKS regardless of magnitude or how many
//   hits land: this is what keeps a barrage of hits from ever stalling a
//   fighter indefinitely (see sim.ts tryApplyHit, which takes the max of
//   the current remaining freeze and each new hit's contribution rather
//   than summing them -- a second hit landing mid-freeze can *refresh*
//   the freeze up to the cap, never extend past it).
export const HITSTOP_PER_MAGNITUDE: Fixed = fx.fromFloat(0.32);
export const MIN_HITSTOP_TICKS = 2;
export const MAX_HITSTOP_TICKS = 8;

export function computeHitstopTicks(magnitude: Fixed): number {
  const ticks = fx.toInt(fx.mul(magnitude, HITSTOP_PER_MAGNITUDE));
  if (ticks < MIN_HITSTOP_TICKS) return MIN_HITSTOP_TICKS;
  if (ticks > MAX_HITSTOP_TICKS) return MAX_HITSTOP_TICKS;
  return ticks;
}

/** Mirror an angle index horizontally (flip X, keep Y) for an attacker
 * facing left, so authored hitbox angles are always written as if facing
 * right. */
export function mirrorAngleIdx(angleIdx: number): number {
  const half = LUT_SIZE / 2;
  const m = (half - angleIdx) % LUT_SIZE;
  return m < 0 ? m + LUT_SIZE : m;
}

// Directional influence used to be a one-shot angle nudge applied at the
// instant of the hit. It is now continuous instead: see
// HITSTUN_DI_ACCEL_PER_TICK and GROUND_FRICTION in sim.ts, applied every
// tick of hitstun directly to velocity based on the defender's current
// stick input, so DI curves the whole trajectory rather than being baked
// in once.
