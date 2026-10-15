// One-tap "How was that match?" rating. Pure parts: the options, the request
// body, and the shown-once-per-match rule. DOM lives in ui/match-rating-row.ts.
export const MATCH_RATING_OPTIONS = [
  { id: 'bad', label: 'Bad' },
  { id: 'okay', label: 'Okay' },
  { id: 'good', label: 'Good' },
] as const;
export type MatchRatingId = (typeof MATCH_RATING_OPTIONS)[number]['id'];

/** Taps this soon after the screen opens are leftover match input, not an answer. */
export const RATING_GRACE_MS = 1500;

export function isRatingTapAllowed(openedAt: number, now: number, answered: boolean): boolean {
  return !answered && now - openedAt >= RATING_GRACE_MS;
}

export function buildMatchRatingBody(
  rating: MatchRatingId,
  mode: string,
  qa: boolean,
  viewport: { width: number; height: number },
  buildSha?: string,
): Record<string, unknown> {
  return {
    ...(qa ? { qa: true } : {}),
    kind: 'match-rating',
    rating,
    context: { mode, viewport, ...(buildSha ? { buildSha } : {}) },
  };
}
