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
  /** How many times this seat's stay in the match involved a successful
   *  resume (reclaimed via resume token) before this record was emitted.
   *  0 for a seat that never disconnected-and-came-back. */
  reconnectCount: number;
  requeuedAtJoin?: boolean;
}

/** Server-derived "actually playing" figures for one ending session --
 *  shared by the console `[sessionEnd]` line and the durable stats
 *  store (server/src/stats-store.ts) so the two can never drift apart
 *  (2026-09-15, "actually playing" session-duration work; see wiki
 *  'Private Stats and QA Traffic Tagging 2026-09-14').
 *
 *  Deliberately computed from server-authoritative tick state
 *  (`match.tick`, `Seat.eliminatedAtTick`, `match.getMatchStartedAtTick()`,
 *  `match.firstEliminationTick`) rather than trusted client-reported
 *  wall-clock timestamps: a client cannot spoof how far into a match it
 *  got, only a browser tab's raw open time (`sessionDurationSec`, kept
 *  unchanged alongside this).
 *
 *  - `matchAgeAtLeaveSec`: ticks from match start to now, i.e. how far
 *    into the match this session lasted -- null while the match never
 *    left the lobby (`matchStartedAtTick` never advances there, so the
 *    figure would be meaningless).
 *  - `activePlayMs`: time this seat spent as a live, controllable
 *    fighter (match start to elimination, or to now if never
 *    eliminated) -- the "actually playing" figure the North Star metric
 *    means, as distinct from time spent spectating after elimination.
 *  - `spectatingMs`: time this seat spent connected but already
 *    eliminated (elimination to now) -- 0 for a seat that was never
 *    eliminated or disconnected the instant it was.
 *  - `leftBeforeFirstElimination`: true if this session ended before
 *    *any* seat in the match (bot or human) had been eliminated yet --
 *    the number the owner asked for: did we lose this player in the
 *    dead-quiet opening seconds, or after the match's action had
 *    already started. Null when the match never reached 'playing'. */
export interface DerivedPlayMetrics {
  matchAgeAtLeaveSec: number | null;
  activePlayMs: number | null;
  spectatingMs: number | null;
  leftBeforeFirstElimination: boolean | null;
}

export function computeDerivedPlayMetrics(conn: SessionEndConnLike, match: Match): DerivedPlayMetrics {
  const seat = match.seats[conn.slot];
  // Use match.phase, not "matchStartedAtTick === 0", to detect "never
  // left the lobby": a match whose bot-fill/countdown is very short (or
  // configured to 0 for local testing) can call start() while tick is
  // still exactly 0, which the tick-based sentinel would misreport as
  // "never started". phase is the real state machine and cannot be off
  // by a race like that.
  if (!seat || match.phase === 'lobby') {
    return { matchAgeAtLeaveSec: null, activePlayMs: null, spectatingMs: null, leftBeforeFirstElimination: null };
  }
  const matchStartedAtTick = match.getMatchStartedAtTick();
  const endTick = seat.eliminatedAtTick ?? match.tick;
  const nowTick = match.tick;
  const matchAgeAtLeaveSec = Number(((nowTick - matchStartedAtTick) / 60).toFixed(1));
  const activeTicks = Math.max(0, endTick - matchStartedAtTick);
  const activePlayMs = Math.round((activeTicks / 60) * 1000);
  const spectatingTicks = seat.eliminatedAtTick === null ? 0 : Math.max(0, nowTick - seat.eliminatedAtTick);
  const spectatingMs = Math.round((spectatingTicks / 60) * 1000);
  const leftBeforeFirstElimination = match.firstEliminationTick === null ? true : nowTick <= match.firstEliminationTick;
  return { matchAgeAtLeaveSec, activePlayMs, spectatingMs, leftBeforeFirstElimination };
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
      : match.phase === 'ended' && match.endCause !== 'abandoned_by_humans'
        ? 'matchEnded'
        : 'disconnected';
    const derived = computeDerivedPlayMetrics(conn, match);
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
      devicePixelRatio: report?.devicePixelRatio ?? null,
      requeued: report?.requeued ?? (conn.requeuedAtJoin ? true : null),
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
      // "Actually playing" figures (2026-09-15, see docs/MEASUREMENT.md
      // "Actually-playing session duration") -- visibleMs/hiddenMs are
      // client-reported (same "?? null means not tracked" convention as
      // every field above); the match* figures are server-derived, see
      // computeDerivedPlayMetrics's doc comment.
      visibleMs: report?.visibleMs ?? null,
      hiddenMs: report?.hiddenMs ?? null,
      // Render-resolution telemetry (2026-09-21) -- whether the
      // adaptive-resolution governor (packages/render/src/adaptive-resolution.ts)
      // actually fired for this seat's client, and what resolution it
      // ended the session at. Same "?? null means not tracked" convention.
      renderResolution: report?.renderResolution ?? null,
      resolutionDowngrades: report?.resolutionDowngrades ?? null,
      matchAgeAtLeaveSec: derived.matchAgeAtLeaveSec,
      activePlayMs: derived.activePlayMs,
      spectatingMs: derived.spectatingMs,
      leftBeforeFirstElimination: derived.leftBeforeFirstElimination,
      reconnectCount: conn.reconnectCount,
    };
    console.log(`[sessionEnd] ${JSON.stringify(line)}`);
  } catch (err) {
    console.log(`[sessionEnd] failed to build log line: ${(err as Error).message}`);
  }
}
