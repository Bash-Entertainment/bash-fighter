// Telemetry-only per-second trace of what a human seat experienced
// (2026-10-17). Read-only on the sim; never sent to clients, never served
// over HTTP -- it only lands in the sessionEnd record in stats.jsonl.
//
// SessionEnd `trace`: at most TRACE_MAX_ENTRIES entries, one per match
// second, each a tuple:
//   [tSec, x, y, damagePct, nearestEnemyDist, enemiesWithin300,
//    hitsTakenThisSec, hitsDealtThisSec, hadInputThisSec (0|1), alive (0|1)]
// x/y/dist are world units rounded to ints, damagePct is the fighter's
// percent rounded; nearestEnemyDist is -1 when no enemy is alive.
import type { Sim } from '@bash-fighter/sim/src/index.ts';

export const TRACE_MAX_ENTRIES = 90;
const FIXED_ONE = 65536;
const NEAR_RADIUS = 300;

export type TraceEntry = [number, number, number, number, number, number, number, number, 0 | 1, 0 | 1];

export interface SeatTrace {
  entries: TraceEntry[];
  hitsTaken: number;
  hitsDealt: number;
  hadInput: boolean;
  lastPercent: number;
  lastHitsLanded: number;
}

export function newSeatTrace(): SeatTrace {
  return { entries: [], hitsTaken: 0, hitsDealt: 0, hadInput: false, lastPercent: 0, lastHitsLanded: 0 };
}

/** Per-tick bookkeeping: cheap counters only. */
export function observeTick(t: SeatTrace, percent: number, hitsLanded: number): void {
  if (percent > t.lastPercent) t.hitsTaken++;
  t.lastPercent = percent;
  t.hitsDealt += hitsLanded - t.lastHitsLanded;
  t.lastHitsLanded = hitsLanded;
}

/** Once per match second: append one entry and reset the per-second counters. */
export function sampleSecond(t: SeatTrace, sim: Sim, slot: number, aliveSlots: number[], tSec: number): void {
  if (t.entries.length >= TRACE_MAX_ENTRIES) return;
  const me = sim.getFighter(slot);
  let nearest = Infinity;
  let within = 0;
  for (const other of aliveSlots) {
    if (other === slot) continue;
    const o = sim.getFighter(other);
    const d = Math.hypot(o.posX - me.posX, o.posY - me.posY) / FIXED_ONE;
    if (d < nearest) nearest = d;
    if (d <= NEAR_RADIUS) within++;
  }
  t.entries.push([
    tSec,
    Math.round(me.posX / FIXED_ONE),
    Math.round(me.posY / FIXED_ONE),
    Math.round(me.percent / FIXED_ONE),
    nearest === Infinity ? -1 : Math.round(nearest),
    within,
    t.hitsTaken,
    t.hitsDealt,
    t.hadInput ? 1 : 0,
    me.eliminated ? 0 : 1,
  ]);
  t.hitsTaken = 0;
  t.hitsDealt = 0;
  t.hadInput = false;
}
