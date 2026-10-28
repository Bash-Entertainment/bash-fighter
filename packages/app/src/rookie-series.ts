// "Rookie series": a newcomer's first three played matches framed as one
// short series, so the end screen of match 2 has a reason to start match 3.
// Pure logic over a storage-like object; the UI lives in ui/rookie-series-panel.ts.
import type { StorageLike } from './personal-best.ts';

export const SERIES_KEY = 'bash-fighter:rookie-series';
export const SERIES_LENGTH = 3;
/** An unfinished series older than this restarts rather than continues. */
export const SERIES_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface SeriesState {
  /** Knockouts of each match played so far, in order. */
  kos: number[];
  /** Last time a match was recorded (or the series started). */
  updatedAt: number;
  /** True once the result card has been shown; the series is then over for good. */
  done: boolean;
}

function parse(raw: string | null): SeriesState | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<SeriesState>;
    if (!Array.isArray(v.kos) || v.kos.length > SERIES_LENGTH) return null;
    if (!v.kos.every((n) => Number.isInteger(n) && n >= 0)) return null;
    if (typeof v.updatedAt !== 'number' || typeof v.done !== 'boolean') return null;
    return { kos: v.kos, updatedAt: v.updatedAt, done: v.done };
  } catch {
    return null;
  }
}

function save(storage: StorageLike, state: SeriesState): void {
  try {
    storage.setItem(SERIES_KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable: the series just does not persist */
  }
}

function read(storage: StorageLike): SeriesState | null {
  try {
    return parse(storage.getItem(SERIES_KEY));
  } catch {
    return null;
  }
}

/**
 * The series in progress, or null when none applies. A new series only
 * begins for a visitor with no stored series who is still `isNewcomer`.
 * A finished series (done) stays finished.
 */
export function activeSeries(storage: StorageLike, now: number, isNewcomer: boolean): SeriesState | null {
  const stored = read(storage);
  if (stored?.done) return null;
  if (stored && stored.kos.length < SERIES_LENGTH && now - stored.updatedAt <= SERIES_MAX_AGE_MS) return stored;
  if (stored && stored.kos.length >= SERIES_LENGTH) return stored;
  return isNewcomer ? { kos: [], updatedAt: now, done: false } : null;
}

/** Which match of the series is next (1-based). */
export function nextMatchNumber(state: SeriesState): number {
  return Math.min(state.kos.length + 1, SERIES_LENGTH);
}

/** Adds a played match's knockouts and persists. */
export function recordSeriesMatch(state: SeriesState, storage: StorageLike, kos: number, now: number): SeriesState {
  if (state.kos.length >= SERIES_LENGTH) return state;
  const next = { ...state, kos: [...state.kos, kos], updatedAt: now };
  save(storage, next);
  return next;
}

export function isComplete(state: SeriesState): boolean {
  return state.kos.length >= SERIES_LENGTH;
}

/** Ends the series for good; call when the result card is put on screen. */
export function markResultShown(state: SeriesState, storage: StorageLike): void {
  save(storage, { ...state, done: true });
}

export function totalKos(state: SeriesState): number {
  return state.kos.reduce((a, b) => a + b, 0);
}

const koWord = (n: number): string => `${n} ${n === 1 ? 'KO' : 'KOs'}`;

/** "Match 1: 2 KO" lines for every match of the series; unplayed ones show a dash. */
export function matchLines(state: SeriesState): string[] {
  return Array.from({ length: SERIES_LENGTH }, (_, i) => {
    const n = state.kos[i];
    return `Match ${i + 1}: ${n === undefined ? '\u2014' : `${n} KO`}`;
  });
}

export function progressLine(state: SeriesState): string {
  const left = SERIES_LENGTH - state.kos.length;
  return left === 1 ? 'One more to finish the series' : `${left} more to finish the series`;
}

export function resultLine(state: SeriesState): string {
  return `Series complete: ${koWord(totalKos(state))} across ${SERIES_LENGTH} matches`;
}

export function bestMatchLine(state: SeriesState): string {
  const best = Math.max(...state.kos);
  return `Best match: ${koWord(best)} (match ${state.kos.indexOf(best) + 1})`;
}

export function introLabel(state: SeriesState): string {
  return `Rookie series \u00b7 match ${nextMatchNumber(state)} of ${SERIES_LENGTH}`;
}
