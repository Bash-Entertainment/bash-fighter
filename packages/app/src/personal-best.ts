// Personal best Timed Brawl KO count, kept in localStorage.
export const BEST_KEY = 'bash-fighter:best-timed-kos';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readBest(storage: StorageLike): number | null {
  try {
    const raw = storage.getItem(BEST_KEY);
    if (raw === null || !/^\d+$/.test(raw)) return null;
    return Number(raw);
  } catch {
    return null;
  }
}

const knockouts = (n: number): string => `${n} ${n === 1 ? 'knockout' : 'knockouts'}`;

/** Compares kos against the stored best, stores the new best, returns the line to show. */
export function recordAndDescribe(storage: StorageLike, kos: number): string {
  const best = readBest(storage);
  if (kos > (best ?? 0)) {
    try {
      storage.setItem(BEST_KEY, String(kos));
    } catch {
      /* storage unavailable: still show the line */
    }
    return `New personal best: ${knockouts(kos)}.`;
  }
  if (best === null) return 'Your first knockout is waiting. Next match starts below.';
  if (kos === best) return `You matched your best: ${knockouts(best)}.`;
  return `Your best: ${knockouts(best)}. You got ${kos}.`;
}
