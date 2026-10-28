// "Why did you leave last time?" prompt (see docs/MEASUREMENT.md). About
// 88% of real players leave mid-match; this asks them once, on their next
// visit, without blocking Play. Storage logic lives here, the panel DOM in
// ui/leave-prompt-panel.ts.
export const LEFT_MID_MATCH_KEY = 'bash-fighter:left-mid-match';
export const LEAVE_PROMPT_SHOWN_KEY = 'bash-fighter:leave-prompt-shown';

export const LEAVE_REASONS = [
  { id: 'too-hard', label: 'Too hard' },
  { id: 'confusing', label: 'Confusing' },
  { id: 'laggy', label: 'Laggy or slow' },
  { id: 'boring', label: 'Boring' },
  { id: 'bug', label: 'Found a bug' },
  { id: 'just-looking', label: 'Just looking' },
  { id: 'other', label: 'Other' },
] as const;
export type LeaveReasonId = (typeof LEAVE_REASONS)[number]['id'];

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStore(): Store | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function markLeftMidMatch(store: Store | null = defaultStore()): void {
  try {
    store?.setItem(LEFT_MID_MATCH_KEY, '1');
  } catch {
    // storage denied: the prompt simply never appears
  }
}

export function shouldShowLeavePrompt(store: Store | null = defaultStore()): boolean {
  try {
    if (!store) return false;
    return store.getItem(LEFT_MID_MATCH_KEY) === '1' && store.getItem(LEAVE_PROMPT_SHOWN_KEY) === null;
  } catch {
    return false;
  }
}

/** Called on send and on dismiss: the prompt never appears again. */
export function settleLeavePrompt(store: Store | null = defaultStore()): void {
  try {
    store?.setItem(LEAVE_PROMPT_SHOWN_KEY, '1');
    store?.removeItem(LEFT_MID_MATCH_KEY);
  } catch {
    // nothing to do
  }
}
