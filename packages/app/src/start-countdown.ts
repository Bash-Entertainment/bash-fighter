// Pure mapping from a tick to the pre-match countdown label. The sim itself
// holds still for the first `introFreezeTicks` ticks (see match-settings.ts);
// this only decides what to show. Presentation-only.
export const GO_LABEL = 'GO!';

/** Ticks "GO!" stays up after the freeze ends, including its fade. */
export const GO_DISPLAY_TICKS = 60;

const TICKS_PER_NUMBER = 60;

/** "3", "2", "1" while frozen, "GO!" just after, null otherwise
 * (including matches with no freeze, and late joins past the countdown). */
export function countdownLabel(tick: number, introFreezeTicks: number): string | null {
  if (introFreezeTicks <= 0 || tick < 0) return null;
  if (tick < introFreezeTicks) {
    return String(Math.ceil((introFreezeTicks - tick) / TICKS_PER_NUMBER));
  }
  return tick < introFreezeTicks + GO_DISPLAY_TICKS ? GO_LABEL : null;
}
