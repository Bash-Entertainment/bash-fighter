// Engagement telemetry only (2026-09-13, see docs/MEASUREMENT.md). Pure,
// DOM-free helpers so the shape of what we send can be pinned in tests
// without jsdom -- net-match.ts and main.ts wire these to the real
// browser/window/performance APIs, but nothing in this file touches
// them, which is also why it is safe to unit test at the source level.
import { FRAME_HISTOGRAM_BOUNDARIES_MS } from '@bash-fighter/net';
import type { ClientSessionProfile, SessionReportMessage } from '@bash-fighter/net';

const MAX_BUILD_SHA_LENGTH = 64;

/** Rounds a coarse capability reading up to the nearest ceiling in a
 *  fixed bucket list, e.g. `hardwareConcurrency: 6` -> `8`. Never
 *  identifying on its own: these are the exact buckets a large fraction
 *  of all devices share. Returns undefined for anything not a positive
 *  finite number (including "API not supported", which callers pass as
 *  undefined) -- absence must mean "not tracked", never "smallest
 *  bucket". */
function bucketCeiling(value: number | undefined, ceilings: readonly number[]): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  for (const ceiling of ceilings) {
    if (value <= ceiling) return ceiling;
  }
  return ceilings[ceilings.length - 1];
}

const HW_CONCURRENCY_CEILINGS = [2, 4, 8, 16, 32, 64] as const;
const DEVICE_MEMORY_CEILINGS = [0.25, 0.5, 1, 2, 4, 6, 8, 16, 32] as const;
const DPR_CEILINGS = [1, 1.5, 2, 3, 4] as const;

/** Buckets `navigator.hardwareConcurrency` -- see
 *  `ClientSessionProfile.hwConcurrencyBucket`'s doc comment for why this
 *  is safe to send. Exported for direct testing. */
export function bucketHardwareConcurrency(value: number | undefined): number | undefined {
  return bucketCeiling(value, HW_CONCURRENCY_CEILINGS);
}

/** Buckets `navigator.deviceMemory` (GB) -- see
 *  `ClientSessionProfile.deviceMemoryBucket`. Undefined on browsers that
 *  don't implement the Device Memory API (notably Safari); callers must
 *  pass undefined in that case, never 0. */
export function bucketDeviceMemory(value: number | undefined): number | undefined {
  return bucketCeiling(value, DEVICE_MEMORY_CEILINGS);
}

/** Buckets `window.devicePixelRatio` -- see
 *  `ClientSessionProfile.dprBucket`. */
export function bucketDevicePixelRatio(value: number | undefined): number | undefined {
  return bucketCeiling(value, DPR_CEILINGS);
}

/** Builds the small, non-identifying `hello.profile` snapshot sent once
 *  per connection. No IP, no user agent, no persistent id -- just enough
 *  to distinguish "this seat had no touch input source", "this seat's
 *  viewport was tiny", "this seat was on an old build", and (2026-09-14)
 *  "this seat's device reported itself as low-powered" from a plain
 *  fun/pacing loss. See docs/MEASUREMENT.md. */
export function buildClientProfile(input: {
  touchActive: boolean;
  viewportWidth: number;
  viewportHeight: number;
  buildSha: string | null;
  /** Self-declared QA hint from `?qa=1` -- see docs/MEASUREMENT.md and
   *  ClientSessionProfile.qa. Omitted entirely (not sent as `false`)
   *  when the tester did not opt in, matching every other optional
   *  profile field's "absent means unknown/not set" convention. */
  qa?: boolean;
  /** Raw `navigator.hardwareConcurrency`, or undefined if unavailable.
   *  Bucketed here before sending -- see bucketHardwareConcurrency. */
  hardwareConcurrency?: number;
  /** Raw `navigator.deviceMemory` (GB), or undefined on a browser that
   *  doesn't implement the Device Memory API. Bucketed here before
   *  sending -- see bucketDeviceMemory. */
  deviceMemory?: number;
  /** Raw `window.devicePixelRatio`. Bucketed here before sending -- see
   *  bucketDevicePixelRatio. */
  devicePixelRatio?: number;
}): ClientSessionProfile {
  const profile: ClientSessionProfile = {
    touchActive: input.touchActive,
    viewportWidth: Math.max(0, Math.round(input.viewportWidth)),
    viewportHeight: Math.max(0, Math.round(input.viewportHeight)),
  };
  if (input.buildSha) profile.buildSha = input.buildSha.slice(0, MAX_BUILD_SHA_LENGTH);
  if (input.qa) profile.qa = true;
  const hwConcurrencyBucket = bucketHardwareConcurrency(input.hardwareConcurrency);
  if (hwConcurrencyBucket !== undefined) profile.hwConcurrencyBucket = hwConcurrencyBucket;
  const deviceMemoryBucket = bucketDeviceMemory(input.deviceMemory);
  if (deviceMemoryBucket !== undefined) profile.deviceMemoryBucket = deviceMemoryBucket;
  const dprBucket = bucketDevicePixelRatio(input.devicePixelRatio);
  if (dprBucket !== undefined) profile.dprBucket = dprBucket;
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

/** Counts local input ticks by which real source produced them --
 *  keyboard, touch, or gamepad -- observed *usage*, not device
 *  capability (see packages/input/src/index.ts InputSourceKind and
 *  docs/MEASUREMENT.md). One counter per source, allocation-free per
 *  tick, same spirit as InputActivityTracker above. Ticks with no
 *  input at all (hadInput === false in the caller) are not counted
 *  under any source -- this measures which control scheme was driving,
 *  not raw poll count. */
export class InputUsageTracker {
  private keyboardTicks = 0;
  private touchTicks = 0;
  private gamepadTicks = 0;

  /** Call once per local simulation tick with whether this tick's local
   *  input frame was non-neutral and which source produced it. */
  recordTick(hadInput: boolean, source: 'keyboard' | 'touch' | 'gamepad'): void {
    if (!hadInput) return;
    if (source === 'touch') this.touchTicks += 1;
    else if (source === 'gamepad') this.gamepadTicks += 1;
    else this.keyboardTicks += 1;
  }

  getKeyboardTicks(): number {
    return this.keyboardTicks;
  }

  getTouchTicks(): number {
    return this.touchTicks;
  }

  getGamepadTicks(): number {
    return this.gamepadTicks;
  }
}

const MAX_FRAME_SAMPLES = 300; // ~5s at 60fps -- plenty for a median/p95, capped so this never grows unbounded across a long match.

/** Number of buckets in the frame-time histogram: one per boundary in
 *  FRAME_HISTOGRAM_BOUNDARIES_MS, plus one for "above the last
 *  boundary". Kept in lockstep with `packages/net/src/protocol.ts`'s
 *  FRAME_HISTOGRAM_BUCKET_COUNT via the shared boundaries import above,
 *  rather than a second hardcoded constant. */
const FRAME_HISTOGRAM_BUCKET_COUNT = FRAME_HISTOGRAM_BOUNDARIES_MS.length + 1;

/** Which of the fixed buckets a frame-time sample (ms) falls into --
 *  `[<20, 20-33, 33-50, 50-100, 100-250, >250]`, matching
 *  FRAME_HISTOGRAM_BOUNDARIES_MS = [20, 33, 50, 100, 250]. Exported for
 *  direct testing. */
export function frameHistogramBucketIndex(deltaMs: number): number {
  for (let i = 0; i < FRAME_HISTOGRAM_BOUNDARIES_MS.length; i++) {
    if (deltaMs < FRAME_HISTOGRAM_BOUNDARIES_MS[i]!) return i;
  }
  return FRAME_HISTOGRAM_BOUNDARIES_MS.length;
}

/** Tracks a rolling window of client frame times (ms between rAF calls)
 *  so we can tell a 15fps session from a 60fps one without recording
 *  every single frame for the whole match, PLUS (2026-09-14) a
 *  match-cumulative histogram across six coarse buckets and a separate
 *  count of frames rendered while the tab was hidden/backgrounded.
 *
 *  The histogram exists because a median/p95 pair alone cannot tell a
 *  steady 14fps session (every frame ~71ms) from an otherwise-smooth
 *  60fps session with a handful of huge stalls (one 3-second GC pause,
 *  say) -- both can produce a similar p95. The two need completely
 *  different fixes, and right now production cannot tell them apart.
 *
 *  A frame recorded while the tab is hidden is excluded from both the
 *  rolling median/p95 samples AND the histogram, and instead only bumps
 *  `hiddenFrames`: a backgrounded tab is throttled by the browser on
 *  purpose (rAF fires rarely, sometimes with a huge coalesced delta),
 *  and folding that into the frame-time distribution would misreport a
 *  player who alt-tabbed as a device having a bad time. Presentation-
 *  only: nothing here feeds the simulation. */
export class FrameTimeTracker {
  private samples: number[] = [];
  private histogram: number[] = new Array(FRAME_HISTOGRAM_BUCKET_COUNT).fill(0);
  private hiddenFrames = 0;

  /** @param hidden Pass true when this frame's delta was measured while
   *  `document.hidden` (or `visibilityState !== 'visible'`) was true --
   *  see the class doc comment for why these are tracked separately. */
  record(deltaMs: number, hidden = false): void {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) return;
    if (hidden) {
      this.hiddenFrames += 1;
      return;
    }
    this.samples.push(deltaMs);
    if (this.samples.length > MAX_FRAME_SAMPLES) this.samples.shift();
    const idx = frameHistogramBucketIndex(deltaMs);
    this.histogram[idx] = (this.histogram[idx] ?? 0) + 1;
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

  /** Cumulative (not rolling-window) counts per bucket for the whole
   *  match so far, in the fixed order documented on
   *  frameHistogramBucketIndex. Returns a fresh copy every call. */
  getHistogram(): number[] {
    return [...this.histogram];
  }

  getHiddenFrames(): number {
    return this.hiddenFrames;
  }
}

/** Gaps between consecutive received server snapshots above this
 *  threshold (ms) count as a network hitch rather than ordinary jitter.
 *  Well above the ~50ms expected interval at SNAPSHOT_HZ (20Hz) and the
 *  4x-of-expected ceiling net-match.ts already clamps display
 *  interpolation to, so this only fires for a gap large enough that the
 *  player would have felt it as a stall regardless of render performance. */
export const NETWORK_HITCH_THRESHOLD_MS = 250;

/** Counts gaps between received server snapshots that exceed
 *  NETWORK_HITCH_THRESHOLD_MS -- a network-side stall signal, tracked
 *  independently of FrameTimeTracker's render-side histogram so a report
 *  of "the game felt like 14fps" can be attributed to the network or the
 *  renderer rather than guessed at. Deliberately dumb and cheap, same
 *  spirit as InputActivityTracker: one counter, no allocation. */
export class NetworkHitchTracker {
  private count = 0;

  /** Call once per received snapshot with the elapsed ms since the
   *  previous one (skip the very first snapshot of a match/reconnect,
   *  which has no previous one to diff against). */
  record(gapMs: number): void {
    if (!Number.isFinite(gapMs) || gapMs <= NETWORK_HITCH_THRESHOLD_MS) return;
    this.count += 1;
  }

  getCount(): number {
    return this.count;
  }
}

/** Builds the small, infrequent `sessionReport` message. Pure function of
 *  its inputs so the wire shape can be pinned exactly in tests. */
export function buildSessionReportMessage(input: {
  firstInputMs: number | null;
  inputTicks: number;
  frameMedianMs: number;
  frameP95Ms: number;
  /** See SessionReportMessage.contextLostCount. Optional/omitted (not
   *  sent as 0) when the caller has no count to report, matching every
   *  other optional field's "absent means not tracked" convention. */
  contextLostCount?: number;
  /** See SessionReportMessage.renderStalled. Same "absent means not
   *  tracked" convention as contextLostCount above. */
  renderStalled?: boolean;
  /** See SessionReportMessage.frameHistogram. Same convention. */
  frameHistogram?: number[];
  /** See SessionReportMessage.hiddenFrames. Same convention. */
  hiddenFrames?: number;
  /** See SessionReportMessage.networkHitchCount. Same convention. */
  networkHitchCount?: number;
  /** See SessionReportMessage.keyboardInputTicks. Same "absent means not
   *  tracked" convention. */
  keyboardInputTicks?: number;
  /** See SessionReportMessage.touchInputTicks. Same convention. */
  touchInputTicks?: number;
  /** See SessionReportMessage.gamepadInputTicks. Same convention. */
  gamepadInputTicks?: number;
}): SessionReportMessage {
  const msg: SessionReportMessage = {
    t: 'sessionReport',
    firstInputMs: input.firstInputMs,
    inputTicks: input.inputTicks,
    frameMedianMs: input.frameMedianMs,
    frameP95Ms: input.frameP95Ms,
  };
  if (input.contextLostCount !== undefined) msg.contextLostCount = input.contextLostCount;
  if (input.renderStalled !== undefined) msg.renderStalled = input.renderStalled;
  if (input.frameHistogram !== undefined) msg.frameHistogram = input.frameHistogram;
  if (input.hiddenFrames !== undefined) msg.hiddenFrames = input.hiddenFrames;
  if (input.networkHitchCount !== undefined) msg.networkHitchCount = input.networkHitchCount;
  if (input.keyboardInputTicks !== undefined) msg.keyboardInputTicks = input.keyboardInputTicks;
  if (input.touchInputTicks !== undefined) msg.touchInputTicks = input.touchInputTicks;
  if (input.gamepadInputTicks !== undefined) msg.gamepadInputTicks = input.gamepadInputTicks;
  return msg;
}
