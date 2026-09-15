// Engagement telemetry only (2026-09-13, see docs/MEASUREMENT.md for the
// full field list and the privacy statement). Kept in its own module,
// separate from server/src/index.ts, so it can be unit-tested without
// importing (and thereby starting) the real HTTP/WebSocket server.
import type { Match } from './match.ts';
import type { ClientSessionProfile, SessionReportMessage } from '@bash-fighter/net/src/protocol.ts';

/** The subset of a live connection that logSessionEnd needs. The real
 *  connection type (ClientConn in server/src/index.ts) satisfies this
 *  structurally; tests can pass a minimal object instead. */
export interface SessionEndConnLike {
  slot: number;
  profile: ClientSessionProfile | null;
  lastReport: SessionReportMessage | null;
}

const LOG_LEVEL = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
const LOGGING_ENABLED = LOG_LEVEL !== 'silent';

/** Logs one `[sessionEnd]` JSON line for a human seat whose session has
 *  just ended (its connection closed while it held a live, non-
 *  superseded seat -- see the `hadLiveSeat` branch in the `close`
 *  handler in server/src/index.ts). Joins what the server already knows
 *  about the match/seat with whatever the client volunteered in
 *  `hello.profile` and its most recent `sessionReport`, so real players
 *  who leave alive and un-eliminated can be split into "never touched
 *  the controls", "on touch", "low frame rate", and "played and left
 *  anyway" instead of all looking identical. Never throws, never blocks
 *  the close path -- a logging bug must not be able to interfere with
 *  seat cleanup, and this function touches no simulation or match
 *  state, only reads it. */
export function logSessionEnd(conn: SessionEndConnLike, match: Match): void {
  if (!LOGGING_ENABLED) return;
  try {
    const seat = match.seats[conn.slot];
    if (!seat) return;
    const report = conn.lastReport;
    const profile = conn.profile;
    const endReason: 'eliminated' | 'matchEnded' | 'disconnected' = seat.eliminated
      ? 'eliminated'
      : match.phase === 'ended'
        ? 'matchEnded'
        : 'disconnected';
    const line = {
      ts: new Date().toISOString(),
      matchId: match.id,
      arenaId: match.arenaId,
      winCondition: match.winCondition,
      eliminated: seat.eliminated,
      endReason,
      sessionDurationSec: Number(((Date.now() - seat.joinedAt) / 1000).toFixed(1)),
      touchActive: profile?.touchActive ?? null,
      viewportWidth: profile?.viewportWidth ?? null,
      viewportHeight: profile?.viewportHeight ?? null,
      buildSha: profile?.buildSha ?? null,
      firstInputMs: report?.firstInputMs ?? null,
      inputTicks: report?.inputTicks ?? null,
      frameMedianMs: report?.frameMedianMs ?? null,
      frameP95Ms: report?.frameP95Ms ?? null,
      contextLostCount: report?.contextLostCount ?? null,
      renderStalled: report?.renderStalled ?? null,
      // Device-capability tags and frame/network telemetry added
      // 2026-09-14 (see docs/MEASUREMENT.md) to help tell a weak/
      // throttled device apart from a browser/network hitch as the
      // explanation for the phone-vs-QA frame-time gap. All optional on
      // the wire already (see protocol.ts); `?? null` here just means
      // "this client's build/browser didn't report it", same as every
      // other field in this line.
      hwConcurrencyBucket: profile?.hwConcurrencyBucket ?? null,
      deviceMemoryBucket: profile?.deviceMemoryBucket ?? null,
      dprBucket: profile?.dprBucket ?? null,
      frameHistogram: report?.frameHistogram ?? null,
      hiddenFrames: report?.hiddenFrames ?? null,
      networkHitchCount: report?.networkHitchCount ?? null,
      // Observed input-device usage (2026-09-14, see docs/MEASUREMENT.md
      // "Capability vs usage") -- ticks actually driven by each source,
      // as opposed to touchActive above which is a static capability
      // check. `?? null` means "this client build didn't report it".
      keyboardInputTicks: report?.keyboardInputTicks ?? null,
      touchInputTicks: report?.touchInputTicks ?? null,
      gamepadInputTicks: report?.gamepadInputTicks ?? null,
      // Slow-frame attribution (2026-09-15, see docs/MEASUREMENT.md
      // "Slow-frame attribution") -- device/canvas context sent once in
      // hello.profile, plus per-match slow-frame-conditioned histograms
      // from the periodic sessionReport. `?? null` means "this client
      // build didn't report it", same convention as every field above.
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
    };
    console.log(`[sessionEnd] ${JSON.stringify(line)}`);
  } catch (err) {
    console.log(`[sessionEnd] failed to build log line: ${(err as Error).message}`);
  }
}
