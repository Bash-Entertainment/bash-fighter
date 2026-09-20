// Durable, private, server-side statistics aggregation (2026-09-14). No
// HTTP surface: nothing here is reachable from bashfighter.com. The
// owner reads these numbers by running scripts/stats-report.mjs over
// SSH on the production box, never through a browser. See
// docs/MEASUREMENT.md for the full privacy stance.
//
// Design mirrors feedback.ts and session-telemetry.ts on purpose: one
// append-only JSONL file under /srv/bash-fighter/shared (survives a
// restart and a deploy, because releases are swapped via a `current`
// symlink and /srv/bash-fighter/shared lives outside every release
// directory), path overridable via STATS_LOG_PATH exactly like
// FEEDBACK_LOG_PATH, and a write that can never crash the match server:
// on any filesystem error we fall back to a stdout line instead of
// throwing, so a bad disk or a bad path degrades logging, not the game.
import fs from 'node:fs';
import path from 'node:path';
import type { MatchSummary } from './match.ts';
import { computeDerivedPlayMetrics, type SessionEndConnLike } from './session-telemetry.ts';
import type { Match } from './match.ts';

/** Default log path: next to production's other shared-state files
 *  (/srv/bash-fighter/shared, see feedback.ts and match-defaults.ts) but
 *  always overridable via STATS_LOG_PATH -- e.g. for local dev/tests,
 *  which must never write into a real production directory just by
 *  running. */
export function defaultStatsLogPath(): string {
  return process.env.STATS_LOG_PATH ?? '/srv/bash-fighter/shared/stats.jsonl';
}

export interface StoredMatchEndRecord {
  type: 'matchEnd';
  ts: string;
  matchId: string;
  arenaId: string;
  winCondition: string;
  endReason: string;
  durationSec: number;
  totalSeats: number;
  humanSeats: number;
  totalKOs: number;
  maxKoCount: number;
  /** How many seats in this match had a self-declared QA hint (see
   *  server/src/match.ts's Seat.qa / MatchSummary.qaSeats). Absent from
   *  records written before this field existed -- the report treats
   *  those as "unknown", never as 0. */
  qaSeats: number;
}

export interface StoredSessionEndRecord {
  type: 'sessionEnd';
  ts: string;
  matchId: string;
  winCondition: string | null;
  eliminated: boolean;
  endReason: string;
  sessionDurationSec: number;
  touchActive: boolean | null;
  firstInputMs: number | null;
  inputTicks: number | null;
  frameMedianMs: number | null;
  frameP95Ms: number | null;
  devicePixelRatio: number | null;
  requeued: boolean | null;
  /** Self-declared QA hint for this seat (see Seat.qa / ClientSessionProfile.qa).
   *  Always present (true or false) on records written by this code;
   *  absent from records written before this field existed, which the
   *  report treats as "unknown", not as false. */
  qa: boolean;
  /** Coarse device-capability tags (2026-09-14, see docs/MEASUREMENT.md
   *  and ClientSessionProfile's doc comments) -- null when the client's
   *  browser/build didn't report that field, never a real "zero". */
  hwConcurrencyBucket: number | null;
  deviceMemoryBucket: number | null;
  dprBucket: number | null;
  /** Cumulative per-match frame-time histogram in six fixed buckets, see
   *  SessionReportMessage.frameHistogram. Null when not tracked (older
   *  client). */
  frameHistogram: number[] | null;
  /** See SessionReportMessage.hiddenFrames / networkHitchCount. */
  hiddenFrames: number | null;
  networkHitchCount: number | null;
  /** Observed input-device usage (2026-09-14, see docs/MEASUREMENT.md
   *  "Capability vs usage"): ticks actually driven by each real source,
   *  as counted client-side by InputUsageTracker. Null when the client
   *  build didn't report it -- never a fabricated zero, and never to be
   *  confused with `touchActive` above, which is a capability check. */
  keyboardInputTicks: number | null;
  touchInputTicks: number | null;
  gamepadInputTicks: number | null;
  /** Slow-frame attribution (2026-09-15, see docs/MEASUREMENT.md
   *  "Slow-frame attribution"). Device/canvas context is a once-per-
   *  connection snapshot from hello.profile; the slowFrame* fields are
   *  per-match histograms conditioned on frames whose delta met
   *  SLOW_FRAME_THRESHOLD_MS (33ms), from the periodic sessionReport.
   *  Null on every field means "this client build didn't report it",
   *  same convention as every field above -- never a fabricated zero or
   *  empty histogram. */
  canvasWidthPx: number | null;
  canvasHeightPx: number | null;
  screenWidthBucket: number | null;
  screenHeightBucket: number | null;
  uaFamily: string | null;
  slowFrameCount: number | null;
  slowFrameFightersAliveBuckets: number[] | null;
  slowFrameFightersOnScreenBuckets: number[] | null;
  slowFrameEffectsLoadBuckets: number[] | null;
  slowFrameHitchCoincidentCount: number | null;
  slowFrameTransitionCoincidentCount: number | null;
  /** "Actually playing" session-duration figures (2026-09-15, see
   *  docs/MEASUREMENT.md "Actually-playing session duration"). visibleMs/
   *  hiddenMs are client-reported (SessionReportMessage.visibleMs/
   *  hiddenMs); the match* figures are server-derived from tick state,
   *  see session-telemetry.ts's computeDerivedPlayMetrics. Null on every
   *  field means "not tracked / never left the lobby", never a
   *  fabricated zero, same convention as every field above. Absent on
   *  records written before this field existed -- the report treats
   *  those the same way. */
  visibleMs: number | null;
  hiddenMs: number | null;
  matchAgeAtLeaveSec: number | null;
  activePlayMs: number | null;
  spectatingMs: number | null;
  leftBeforeFirstElimination: boolean | null;
}

export type StatsRecord = StoredMatchEndRecord | StoredSessionEndRecord;

/** Appends one JSON line. Never throws -- see module docs. Exported
 *  separately from the recorder so tests can exercise the
 *  failure-fallback path directly against an unwritable path. */
export function appendStatsLine(logPath: string, record: StatsRecord): void {
  const line = JSON.stringify(record);
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, line + '\n');
  } catch (err) {
    console.log(`[stats] failed to write ${logPath}, falling back to stdout: ${(err as Error).message}`);
    console.log(`[stats:fallback] ${line}`);
  }
}

export interface StatsRecorderOptions {
  logPath?: string;
  now?: () => number;
}

export interface StatsRecorder {
  logPath: string;
  recordMatchSummary(summary: MatchSummary): void;
  recordSessionEnd(conn: SessionEndConnLike, match: Match): void;
}

/** Builds the recorder wired into server/src/index.ts. Kept as a small
 *  factory (rather than one module-scope instance) so tests can point it
 *  at a scratch path, same convention as createFeedbackHandler. */
export function createStatsRecorder(options: StatsRecorderOptions = {}): StatsRecorder {
  const logPath = options.logPath ?? defaultStatsLogPath();
  const now = options.now ?? Date.now;

  return {
    logPath,
    recordMatchSummary(summary: MatchSummary): void {
      try {
        recordMatchSummaryInner(summary);
      } catch (err) {
        console.log(`[stats] recordMatchSummary failed, dropping record: ${(err as Error).message}`);
      }
    },
    recordSessionEnd(conn: SessionEndConnLike, match: Match): void {
      try {
        recordSessionEndInner(conn, match);
      } catch (err) {
        console.log(`[stats] recordSessionEnd failed, dropping record: ${(err as Error).message}`);
      }
    },
  };

  function recordMatchSummaryInner(summary: MatchSummary): void {
    const record: StoredMatchEndRecord = {
      type: 'matchEnd',
      ts: new Date(now()).toISOString(),
      matchId: summary.matchId,
      arenaId: summary.arenaId,
      winCondition: summary.winCondition,
      endReason: summary.endReason,
      durationSec: Number(summary.durationSec),
      totalSeats: summary.totalSeats,
      humanSeats: summary.humanSeats,
      totalKOs: summary.totalKOs,
      maxKoCount: summary.maxKoCount,
      qaSeats: summary.qaSeats,
    };
    appendStatsLine(logPath, record);
  }

  function recordSessionEndInner(conn: SessionEndConnLike, match: Match): void {
    const seat = match.seats[conn.slot];
    if (!seat) return;
    const report = conn.lastReport;
    const profile = conn.profile;
    const endReason: 'eliminated' | 'matchEnded' | 'disconnected' = seat.eliminated
      ? 'eliminated'
      : match.phase === 'ended'
        ? 'matchEnded'
        : 'disconnected';
    const derived = computeDerivedPlayMetrics(conn, match);
    const record: StoredSessionEndRecord = {
      type: 'sessionEnd',
      ts: new Date(now()).toISOString(),
      matchId: match.id,
      winCondition: match.winCondition ?? null,
      eliminated: seat.eliminated,
      endReason,
      sessionDurationSec: Number(((now() - seat.joinedAt) / 1000).toFixed(1)),
      touchActive: profile?.touchActive ?? null,
      firstInputMs: report?.firstInputMs ?? null,
      inputTicks: report?.inputTicks ?? null,
      frameMedianMs: report?.frameMedianMs ?? null,
      frameP95Ms: report?.frameP95Ms ?? null,
      devicePixelRatio: report?.devicePixelRatio ?? null,
      requeued: report?.requeued ?? null,
      qa: seat.qa,
      hwConcurrencyBucket: profile?.hwConcurrencyBucket ?? null,
      deviceMemoryBucket: profile?.deviceMemoryBucket ?? null,
      dprBucket: profile?.dprBucket ?? null,
      frameHistogram: report?.frameHistogram ?? null,
      hiddenFrames: report?.hiddenFrames ?? null,
      networkHitchCount: report?.networkHitchCount ?? null,
      keyboardInputTicks: report?.keyboardInputTicks ?? null,
      touchInputTicks: report?.touchInputTicks ?? null,
      gamepadInputTicks: report?.gamepadInputTicks ?? null,
      canvasWidthPx: profile?.canvasWidthPx ?? null,
      canvasHeightPx: profile?.canvasHeightPx ?? null,
      screenWidthBucket: profile?.screenWidthBucket ?? null,
      screenHeightBucket: profile?.screenHeightBucket ?? null,
      uaFamily: profile?.uaFamily ?? null,
      slowFrameCount: report?.slowFrameCount ?? null,
      slowFrameFightersAliveBuckets: report?.slowFrameFightersAliveBuckets ?? null,
      slowFrameFightersOnScreenBuckets: report?.slowFrameFightersOnScreenBuckets ?? null,
      slowFrameEffectsLoadBuckets: report?.slowFrameEffectsLoadBuckets ?? null,
      slowFrameHitchCoincidentCount: report?.slowFrameHitchCoincidentCount ?? null,
      slowFrameTransitionCoincidentCount: report?.slowFrameTransitionCoincidentCount ?? null,
      visibleMs: report?.visibleMs ?? null,
      hiddenMs: report?.hiddenMs ?? null,
      matchAgeAtLeaveSec: derived.matchAgeAtLeaveSec,
      activePlayMs: derived.activePlayMs,
      spectatingMs: derived.spectatingMs,
      leftBeforeFirstElimination: derived.leftBeforeFirstElimination,
    };
    appendStatsLine(logPath, record);
  }
}
