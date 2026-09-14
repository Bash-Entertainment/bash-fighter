// Engagement telemetry only (2026-09-13, see docs/MEASUREMENT.md). Pure,
// DOM-free helpers so the shape of what we send can be pinned in tests
// without jsdom -- net-match.ts and main.ts wire these to the real
// browser/window/performance APIs, but nothing in this file touches
// them, which is also why it is safe to unit test at the source level.
import type { ClientSessionProfile, SessionReportMessage } from '@bash-fighter/net';

const MAX_BUILD_SHA_LENGTH = 64;

/** Builds the small, non-identifying `hello.profile` snapshot sent once
 *  per connection. No IP, no user agent, no persistent id -- just enough
 *  to distinguish "this seat had no touch input source", "this seat's
 *  viewport was tiny", and "this seat was on an old build" from a plain
 *  fun/pacing loss. See docs/MEASUREMENT.md. */
export function buildClientProfile(input: {
  touchActive: boolean;
  viewportWidth: number;
  viewportHeight: number;
  buildSha: string | null;
}): ClientSessionProfile {
  const profile: ClientSessionProfile = {
    touchActive: input.touchActive,
    viewportWidth: Math.max(0, Math.round(input.viewportWidth)),
    viewportHeight: Math.max(0, Math.round(input.viewportHeight)),
  };
  if (input.buildSha) profile.buildSha = input.buildSha.slice(0, MAX_BUILD_SHA_LENGTH);
  return profile;
}

/** Tracks, for one seat's local input across a match, the elapsed time to
 *  the first non-neutral input (null if none yet) and how many ticks
 *  carried any input at all. Deliberately dumb and cheap: called once
 *  per local tick, never allocates, never touches the sim. */
export class InputActivityTracker {
  private firstInputMs: number | null = null;
  private inputTicks = 0;

  /** Call once per local simulation tick with whether this tick's local
   *  input frame was non-neutral, and the elapsed ms since match start. */
  recordTick(hadInput: boolean, elapsedMs: number): void {
    if (!hadInput) return;
    this.inputTicks += 1;
    if (this.firstInputMs === null) this.firstInputMs = Math.max(0, Math.round(elapsedMs));
  }

  getFirstInputMs(): number | null {
    return this.firstInputMs;
  }

  getInputTicks(): number {
    return this.inputTicks;
  }
}

const MAX_FRAME_SAMPLES = 300; // ~5s at 60fps -- plenty for a median/p95, capped so this never grows unbounded across a long match.

/** Tracks a rolling window of client frame times (ms between rAF calls)
 *  so we can tell a 15fps session from a 60fps one without recording
 *  every single frame for the whole match. Presentation-only: nothing
 *  here feeds the simulation. */
export class FrameTimeTracker {
  private samples: number[] = [];

  record(deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) return;
    this.samples.push(deltaMs);
    if (this.samples.length > MAX_FRAME_SAMPLES) this.samples.shift();
  }

  private percentile(p: number): number {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx]!;
  }

  getMedianMs(): number {
    return this.percentile(50);
  }

  getP95Ms(): number {
    return this.percentile(95);
  }
}

/** Builds the small, infrequent `sessionReport` message. Pure function of
 *  its inputs so the wire shape can be pinned exactly in tests. */
export function buildSessionReportMessage(input: {
  firstInputMs: number | null;
  inputTicks: number;
  frameMedianMs: number;
  frameP95Ms: number;
}): SessionReportMessage {
  return {
    t: 'sessionReport',
    firstInputMs: input.firstInputMs,
    inputTicks: input.inputTicks,
    frameMedianMs: input.frameMedianMs,
    frameP95Ms: input.frameP95Ms,
  };
}
