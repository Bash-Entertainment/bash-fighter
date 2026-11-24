// Works out, from confirmed snapshots only, who knocked the local player out
// and whether the local player has since taken revenge. The sim clears
// lastAttacker the moment a fighter dies, so the attacker is remembered here
// from the snapshots seen while the hit was still live. Presentation-only:
// reads snapshots, never feeds anything back into the sim.
import { COMBAT_ATTRIBUTION_TICKS, type FighterSnapshot } from '@bash-fighter/sim';

type Observed = Pick<FighterSnapshot, 'percent' | 'deathCount' | 'eliminated' | 'lastAttacker'>;

/** Sim credits a KO for a hit up to COMBAT_ATTRIBUTION_TICKS before death; snapshots land a few ticks late. */
export const KO_ATTRIBUTION_TICKS = COMBAT_ATTRIBUTION_TICKS + 6;
/** How long a revenge marker lasts if the target is not knocked out first (20s at 60Hz). */
export const REVENGE_TICKS = 1200;

export type KoCalloutEvent =
  | { type: 'koedBy'; attacker: number }
  | { type: 'fell' }
  | { type: 'revenge' };

interface RecentHit {
  attacker: number;
  tick: number;
}

export class KoTracker {
  private readonly recentHits = new Map<number, RecentHit>();
  private revenge: { target: number; expiresTick: number } | null = null;

  /** Compares two consecutive confirmed snapshots; `tick` is the newer one's sim tick. */
  observe(prev: readonly Observed[], curr: readonly Observed[], localSlot: number, tick: number): KoCalloutEvent[] {
    const events: KoCalloutEvent[] = [];
    if (localSlot < 0) return events;

    for (let i = 0; i < curr.length; i++) {
      const p = prev[i];
      const c = curr[i];
      if (!p || !c) continue;
      if (c.deathCount > p.deathCount) this.onDeath(i, localSlot, tick, events);
      else if (c.lastAttacker >= 0 && c.lastAttacker !== i && (c.lastAttacker !== p.lastAttacker || c.percent > p.percent)) {
        this.recentHits.set(i, { attacker: c.lastAttacker, tick });
      }
    }
    if (curr[localSlot]?.eliminated) this.revenge = null;
    return events;
  }

  /** Slot to mark with the revenge indicator at `tick`, or null. */
  revengeSlot(tick: number): number | null {
    return this.revenge && tick < this.revenge.expiresTick ? this.revenge.target : null;
  }

  private onDeath(slot: number, localSlot: number, tick: number, events: KoCalloutEvent[]): void {
    const hit = this.recentHits.get(slot);
    this.recentHits.delete(slot);
    const attacker = hit && tick - hit.tick <= KO_ATTRIBUTION_TICKS ? hit.attacker : -1;

    if (slot === localSlot) {
      this.revenge = attacker >= 0 ? { target: attacker, expiresTick: tick + REVENGE_TICKS } : null;
      events.push(attacker >= 0 ? { type: 'koedBy', attacker } : { type: 'fell' });
    } else if (this.revenge?.target === slot) {
      this.revenge = null;
      if (attacker === localSlot) events.push({ type: 'revenge' });
    }
  }
}
