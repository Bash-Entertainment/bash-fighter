// Frame-time-driven adaptive render resolution governor.
//
// Background: MAX_RESOLUTION (see index.ts) already clamps Pixi's
// resolution to at most 2, but that clamp is static -- a phone whose
// real p95 frame time is 71ms (Real Player Measurements 2026-09-14) is
// still too slow at resolution 2. This module watches real frame
// durations and asks for a lower pixel resolution once frames stay slow
// for a sustained window, and cautiously offers it back if frames stay
// fast for long enough. It has no DOM/Pixi dependency: index.ts owns
// applying whatever resolution this returns to the actual renderer.
//
// Presentation-only, same as the static clamp: camera/world math reads
// app.renderer.width/height (CSS space), never affected by resolution.

/** The only resolutions the governor will ever choose between, high to
 *  low. 1.5 sits between the phone-typical DPR-2/3 case and the DPR-1
 *  floor so a downgrade from 2 does not have to jump straight to 1. */
const STEPS = [2, 1.5, 1] as const;
export type ResolutionStep = (typeof STEPS)[number];

const DOWNGRADE_WINDOW = 120;
const DOWNGRADE_P95_THRESHOLD_MS = 45;
const DOWNGRADE_COOLDOWN_SAMPLES = 180;

const UPGRADE_WINDOW = 240;
const UPGRADE_P95_THRESHOLD_MS = 22;
const MAX_UPGRADES = 2;

const BOGUS_MIN_MS = 0;
const BOGUS_MAX_MS = 2000;

function p95(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

/** Index of `value` in STEPS (the initial/device cap need not itself be
 *  a member of STEPS -- e.g. an unusual devicePixelRatio clamp -- so
 *  this finds the first step at or below it). */
function stepIndexAtOrBelow(value: number): number {
  const idx = STEPS.findIndex((s) => s <= value);
  return idx === -1 ? STEPS.length - 1 : idx;
}

export class AdaptiveResolutionGovernor {
  private readonly initial: number;
  private readonly maxStepIndex: number;
  private stepIndex: number;
  private readonly recent: number[] = [];
  private samplesSeen = 0;
  private lastDowngradeAtSample = -Infinity;
  downgrades = 0;
  upgrades = 0;

  /** `initialResolution` is the device's already-clamped starting value
   *  (e.g. clampRenderResolution's result) -- the governor never steps
   *  above it, only ever at or below. */
  constructor(initialResolution: number) {
    this.initial = initialResolution;
    this.maxStepIndex = stepIndexAtOrBelow(initialResolution);
    this.stepIndex = this.maxStepIndex;
  }

  get resolution(): ResolutionStep {
    return STEPS[this.stepIndex]!;
  }

  /** Feed one frame duration in milliseconds. Returns the resolution the
   *  governor wants right now (unchanged unless this sample tips a
   *  decision). Bogus samples (<=0 or >2000ms, e.g. a backgrounded tab)
   *  are ignored entirely -- not counted toward any window or cooldown. */
  sample(ms: number): ResolutionStep {
    if (!Number.isFinite(ms) || ms <= BOGUS_MIN_MS || ms > BOGUS_MAX_MS) {
      return this.resolution;
    }

    this.samplesSeen++;
    this.recent.push(ms);
    if (this.recent.length > UPGRADE_WINDOW) this.recent.shift();

    this.maybeDowngrade();
    this.maybeUpgrade();

    return this.resolution;
  }

  private maybeDowngrade(): void {
    if (this.stepIndex >= STEPS.length - 1) return; // already at floor
    if (this.samplesSeen - this.lastDowngradeAtSample < DOWNGRADE_COOLDOWN_SAMPLES) return;
    const window = this.recent.slice(-DOWNGRADE_WINDOW);
    if (window.length < DOWNGRADE_WINDOW) return;
    if (p95(window) > DOWNGRADE_P95_THRESHOLD_MS) {
      this.stepIndex++;
      this.downgrades++;
      this.lastDowngradeAtSample = this.samplesSeen;
    }
  }

  private maybeUpgrade(): void {
    if (this.stepIndex <= this.maxStepIndex) return; // already at device cap
    if (this.upgrades >= MAX_UPGRADES) return;
    if (this.recent.length < UPGRADE_WINDOW) return;
    if (p95(this.recent) < UPGRADE_P95_THRESHOLD_MS) {
      this.stepIndex--;
      this.upgrades++;
    }
  }
}
