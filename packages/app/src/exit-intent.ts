// Desktop exit intent: the pointer leaving through the top edge of the
// window (towards the tab bar or close button) while playing a live match.
// Most players leave mid-match without ever coming back, so the next-visit
// prompt rarely fires; this asks at the moment they are leaving.
export function wasFeedbackPrompted(): boolean {
  try {
    return (globalThis.localStorage?.getItem(EXIT_INTENT_SHOWN_KEY) ?? null) !== null;
  } catch {
    return false;
  }
}

export const EXIT_INTENT_SHOWN_KEY = 'bash-fighter:exit-intent-shown';
export const EXIT_INTENT_MIN_MATCH_AGE_SEC = 3;

export interface ExitIntentState {
  clientY: number;
  leftDocument: boolean;
  playingLive: boolean;
  matchAgeSec: number;
  alreadyShown: boolean;
}

export function shouldShowExitIntent(s: ExitIntentState): boolean {
  return (
    s.leftDocument &&
    s.clientY <= 0 &&
    s.playingLive &&
    s.matchAgeSec >= EXIT_INTENT_MIN_MATCH_AGE_SEC &&
    !s.alreadyShown
  );
}
