// One-tap "Fun / Meh / Confusing" rating. Pure parts: the options and the
// once-per-session rule. The DOM lives in ui/quick-rating.ts. Taps post the
// existing leave-reason record, so the server stores them like any other.
export const QUICK_RATINGS = [
  { id: 'fun', label: 'Fun' },
  { id: 'meh', label: 'Meh' },
  { id: 'confusing', label: 'Confusing' },
] as const;
export type QuickRatingId = (typeof QUICK_RATINGS)[number]['id'];

export const QUICK_RATED_KEY = 'bash-fighter:quick-rated';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function sessionStore(): Store | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** True once the visitor has rated in this browser session (or storage is unavailable). */
export function wasRatedThisSession(store: Store | null = sessionStore()): boolean {
  try {
    return store === null || store.getItem(QUICK_RATED_KEY) !== null;
  } catch {
    return true;
  }
}

export function markRatedThisSession(store: Store | null = sessionStore()): void {
  try {
    store?.setItem(QUICK_RATED_KEY, '1');
  } catch {
    // storage denied: the prompt is still shown at most once per page
  }
}
