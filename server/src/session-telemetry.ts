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
    };
    console.log(`[sessionEnd] ${JSON.stringify(line)}`);
  } catch (err) {
    console.log(`[sessionEnd] failed to build log line: ${(err as Error).message}`);
  }
}
