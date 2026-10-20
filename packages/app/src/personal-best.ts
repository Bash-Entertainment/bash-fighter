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

export interface BestResult {
  kos: number;
  best: number;
  isNew: boolean;
}

/** Stores kos if it beats the stored best (0 never counts) and reports the outcome. */
export function recordKos(storage: StorageLike, kos: number): BestResult {
  const prev = readBest(storage) ?? 0;
  if (kos <= prev) return { kos, best: prev, isNew: false };
  try {
    storage.setItem(BEST_KEY, String(kos));
  } catch {
    /* storage unavailable: still report it */
  }
  return { kos, best: kos, isNew: true };
}

/** The "Next: beat N KOs" goal line, or '' when there is no best yet. */
export function nextGoalLine(storage: StorageLike): string {
  const best = readBest(storage);
  return best === null || best < 1 ? '' : `Next: beat ${best} ${best === 1 ? 'KO' : 'KOs'}`;
}
