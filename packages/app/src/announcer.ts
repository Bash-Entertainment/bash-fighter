// Decides which announcer callouts the local player has earned: quick
// multi-KOs and streaks of KOs without being knocked out. Fed by the
// 'knockout' / 'death' events detected from server-confirmed snapshots
// (the sim credits a KO to a fighter's koCount from its lastAttacker
// attribution). Presentation-only: never feeds anything back into the sim.

/** KOs closer together than this chain into Double / Triple / Rampage. */
export const MULTI_KO_WINDOW_MS = 4000;

const MULTI_KO_TEXT = ['Double KO!', 'Triple KO!', 'Rampage!'];
const STREAK_TEXT = new Map([
  [3, 'On a roll'],
  [5, 'Unstoppable'],
  [8, 'Legendary'],
]);

export interface AnnouncerCall {
  text: string;
  /** 1 = lowest. Drives how big the audio sting is. */
  tier: number;
}

export class AnnouncerTracker {
  private recentKoTimes: number[] = [];
  private streak = 0;

  /** The local player just knocked someone out at `nowMs`. */
  onLocalKnockout(nowMs: number): AnnouncerCall[] {
    this.recentKoTimes = this.recentKoTimes.filter((t) => nowMs - t <= MULTI_KO_WINDOW_MS);
    this.recentKoTimes.push(nowMs);
    this.streak++;

    const calls: AnnouncerCall[] = [];
    const multi = this.recentKoTimes.length;
    if (multi >= 2) {
      const tier = Math.min(multi, 4) - 1;
      calls.push({ text: MULTI_KO_TEXT[tier - 1] as string, tier });
    }
    const streakText = STREAK_TEXT.get(this.streak);
    if (streakText) calls.push({ text: streakText, tier: this.streak >= 8 ? 5 : this.streak >= 5 ? 4 : 3 });
    return calls;
  }

  /** The local player was knocked out or lost a stock. */
  onLocalDeath(): void {
    this.streak = 0;
    this.recentKoTimes = [];
  }
}
