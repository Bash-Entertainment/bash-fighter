// Bash Fighter authoritative match server. Server-owned deterministic sim,
// one per match; clients only send inputs and receive snapshots. See
// docs/PROTOCOL.md for the wire format.
//
// Module-level state (clients/watchers/manager) is fine here: one process
// runs one server. Tests that want an isolated instance run this in a
// child process or import createBashFighterServer, which is exercised by
// server/test/integration.test.ts via a spawned child process so multiple
// test runs never share this module's state.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  parseClientControl,
  decodeInput,
  SnapshotStreamEncoder,
  sanitiseName,
  type ServerControlMessage,
  type ClientSessionProfile,
  type SessionReportMessage,
} from '@bash-fighter/net/src/protocol.ts';
import { logSessionEnd } from './session-telemetry.ts';
import { createStatsRecorder } from './stats-store.ts';
import { RoomManager, DEFAULT_CAPACITY, DEFAULT_MINIMUM } from './rooms.ts';
import { tickMetricsSnapshot } from './tick-metrics.ts';
import { modeDisplayName } from './mode-rotation.ts';
import { SNAPSHOT_EVERY_N_TICKS, type Match } from './match.ts';
import { createFeedbackHandler } from './feedback.ts';

export interface ServerOptions {
  port?: number;
  capacity?: number;
  minimum?: number;
}

export interface ClientConn {
  id: string;
  ws: WebSocket;
  match: Match | null;
  slot: number; // -1 = pure spectator / not yet assigned
  spectating: boolean;
  helloed: boolean;
  /** Set when this connection's seat has been handed to a newer connection
   *  via the stale-incumbent self-heal in handleResume (see retireConn).
   *  Once set, this connection's own eventual `close` event must NOT call
   *  markDisconnected again -- that seat may already be live under a
   *  different ClientConn by then, and re-marking it disconnected would
   *  invalidate a resume token that a currently-connected player still
   *  needs. A belated close from a socket the server has already retired
   *  is expected, not an error. */
  superseded: boolean;
  /** Per-connection delta-compression state for the snapshot broadcast --
   *  see [[Bandwidth Reduction Pass 2026-09-11]]. Deliberately per
   *  connection, not per match/slot: a fresh connection (new socket, incl.
   *  a resumed reconnect) always starts with a fresh encoder, so its very
   *  first snapshot is a full keyframe -- there is no way for a client to
   *  receive a delta against a baseline it could not possibly have. */
  snapshotEncoder: SnapshotStreamEncoder;
  /** Small, non-identifying client environment snapshot from `hello`, see
   *  ClientSessionProfile -- null until a hello with one arrives (an
   *  older client, or a resume, may never send one). Engagement-
   *  telemetry only, see docs/MEASUREMENT.md; never touches match state. */
  profile: ClientSessionProfile | null;
  /** Most recent `sessionReport` this connection has sent, or null if it
   *  never has. Overwritten in place -- only the latest matters, since
   *  `[sessionEnd]` logs a snapshot of "how things stood" when the
   *  session ended, not a full history. */
  lastReport: SessionReportMessage | null;
  /** Wall-clock time this connection was accepted, for the engagement-
   *  telemetry `[sessionEnd]` line's own bookkeeping (distinct from
   *  Seat.joinedAt, which survives a reconnect; this is this socket's own
   *  lifetime). */
  connectedAt: number;
  /** How many times this connection's seat has been resumed from a prior
   *  disconnect within this same match (see handleResume) -- 0 until a
   *  resume actually happens onto this seat. Carried onto the sessionEnd
   *  record so double-counted-vs-genuine-reconnect is visible in stats,
   *  see server/src/session-telemetry.ts's SessionEndConnLike. */
  reconnectCount: number;
}

const clients = new Map<string, ClientConn>();

// --- One sessionEnd record per seat per match, even across a reconnect ---
// (2026-09-20 fix for the double-counted-telemetry bug, see wiki/commit for
// the production evidence). A human seat's whole stay in a match must
// produce exactly one [sessionEnd]/StoredSessionEndRecord, spanning any
// number of disconnect-then-resume cycles. Two pieces of state make that
// true:
//   - pendingSessionEnds: when a live seat's socket closes, we don't yet
//     know if it will be resumed, so we stash its last-known telemetry
//     context here instead of emitting immediately. It is resolved by
//     exactly one of: a successful resume (adopted onto the new
//     connection, entry deleted, nothing emitted here), the match's own
//     grace timer expiring with no resume (onSeatGraceExpired below,
//     emitted then), or the match ending while the seat is still in its
//     grace window (onMatchEnd below, emitted then).
//   - emittedSessionEnds: belt-and-suspenders de-dup keyed the same way,
//     checked by emitSessionEndOnce right before actually writing a
//     record, so no code path (including a connection that resumes into
//     an already-ended match, which never held a live seat to begin with)
//     can ever produce a second record for the same seat/match.
interface PendingSessionEnd {
  profile: ClientSessionProfile | null;
  lastReport: SessionReportMessage | null;
  reconnectCount: number;
}
const pendingSessionEnds = new Map<string, PendingSessionEnd>();
const emittedSessionEnds = new Set<string>();
/** 20 seats x plenty of concurrent matches, with a wide margin. */
const EMITTED_SESSION_END_KEYS_MAX = 4000;

function seatKey(matchId: string, slot: number): string {
  return `${matchId}:${slot}`;
}

/** Writes the one-and-only [sessionEnd] log line + durable stats record
 *  for a seat's whole stay, or does nothing if one has already been
 *  written for this matchId+slot. */
function emitSessionEndOnce(
  connLike: { slot: number; profile: ClientSessionProfile | null; lastReport: SessionReportMessage | null; reconnectCount: number },
  match: Match,
): void {
  const key = seatKey(match.id, connLike.slot);
  if (emittedSessionEnds.has(key)) return;
  // The de-dup set would otherwise grow for the process's whole lifetime
  // (one entry per seat per match). Matches are reaped after a minute, so
  // old keys can never come back; drop the lot once the set is far larger
  // than any plausible set of live matches rather than tracking teardown.
  if (emittedSessionEnds.size > EMITTED_SESSION_END_KEYS_MAX) emittedSessionEnds.clear();
  emittedSessionEnds.add(key);
  logSessionEnd(connLike, match);
  statsRecorder.recordSessionEnd(connLike, match);
}
// matchId -> set of client ids watching it (players + spectators)
const watchers = new Map<string, Set<string>>();

function send(conn: ClientConn, msg: ServerControlMessage): void {
  if (conn.ws.readyState !== WebSocket.OPEN) return;
  conn.ws.send(JSON.stringify(msg));
}

function sendBinary(conn: ClientConn, bytes: Uint8Array): void {
  if (conn.ws.readyState !== WebSocket.OPEN) return;
  conn.ws.send(bytes);
}

function closeWithError(
  conn: ClientConn,
  code: 'protocol_mismatch' | 'bad_message' | 'match_full' | 'server_error' | 'resume_invalid' | 'resume_expired' | 'resume_seat_taken',
  message: string,
): void {
  logConn(conn, 'error_close', { code, message });
  send(conn, { t: 'error', code, message });
  conn.ws.close();
}

// Structured, single-line connection-lifecycle logging -- deliberately not
// a logging framework, just enough (timestamp, conn id, slot/match if
// known, event, extra fields) that a production drop or a resume-that-
// didn't-work is diagnosable from `journalctl`/systemd logs rather than
// invisible. See wiki "First-Match Experience Problem" for why this was
// missing before: the only way to know a disconnect happened was the
// player noticing themselves.
// LOG_LEVEL controls verbosity without a logging framework: 'silent'
// disables all [conn]/[summary] lines (e.g. for a busy test run), 'info'
// (default) is every lifecycle event below plus the periodic summary --
// there is deliberately no per-tick or per-frame level, because that
// firehose is exactly what would cost CPU and fill the disk.
const LOG_LEVEL = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
const LOGGING_ENABLED = LOG_LEVEL !== 'silent';

function logConn(conn: ClientConn, event: string, extra?: Record<string, unknown>): void {
  if (!LOGGING_ENABLED) return;
  const line = {
    ts: new Date().toISOString(),
    connId: conn.id,
    matchId: conn.match?.id ?? null,
    slot: conn.slot,
    event,
    ...extra,
  };
  console.log(`[conn] ${JSON.stringify(line)}`);
}


function watcherSet(matchId: string): Set<string> {
  let s = watchers.get(matchId);
  if (!s) {
    s = new Set();
    watchers.set(matchId, s);
  }
  return s;
}

/** Tell the match how many clients (playing or spectating) are currently
 *  connected to it, so Match.isAbandoned() can end it the instant that
 *  hits zero rather than the instant the last human seat is eliminated
 *  (2026-09-09, see wiki 'Match Duration Contradiction: The Spire Firing
 *  Squad'). Call after every watcherSet add/delete. */
function syncWatcherCount(match: { id: string; setWatcherCount: (n: number) => void }): void {
  match.setWatcherCount(watcherSet(match.id).size);
}

// A connection counts as a live player only while it holds an un-eliminated
// seat and never opted into pure spectating. Everyone else -- pre-join
// sockets (slot -1), explicit spectators, and eliminated fighters whose
// seat keeps ticking in the sim on neutral input -- gets the reduced
// spectator stream below. Re-derived from match/seat state on every
// snapshot rather than cached on ClientConn, since elimination flips a
// seat from live to spectator mid-match with no separate event needed here.
function isSpectatorConn(conn: ClientConn, match: Match): boolean {
  if (conn.spectating || conn.slot < 0) return true;
  const seat = match.seats[conn.slot];
  return !seat || seat.eliminated;
}

// Snapshot rate for spectator connections, as a divisor of the live 20Hz
// rate (SNAPSHOT_HZ in packages/net/src/protocol.ts). 2 -> 10Hz.
//
// Why 10Hz and not lower: per wiki "Netplay Chaos Part 1", a 20-player
// match spends most of its connected-client-seconds with few fighters left
// and many spectators (a Last-Fighter-Standing match ends 19/20
// eliminated), so spectator egress dominates total server egress for most
// of a match's duration even though spectators need less fidelity than a
// live player reconciling their own position. Halving the rate halves
// spectator egress (~68 KB/s -> ~35 KB/s per the wiki's own 10Hz number)
// while staying comfortably above the ~5-8Hz floor where platform-fighter
// motion starts to visibly step even with interpolation (short, fast
// hops/dashes need enough samples to look continuous). 4x (5Hz) was
// measured to look noticeably steppier during visual verification (see
// commit message / final report) with the same interpolation code, so 2x
// is the number actually shipped, not just estimated.
const SPECTATOR_SNAPSHOT_DIVISOR = 2;

function broadcastLobby(match: Match): void {
  const modeName = modeDisplayName(match.effectiveWinCondition(), match.effectiveTimeLimitTicks(), match.effectiveStartingStocks());
  const msg: ServerControlMessage = {
    t: 'lobby',
    players: match.filledSlots,
    capacity: match.capacity,
    minimum: match.minimum,
    countdownTicks: match.remainingStartTicks(),
    names: match.seats.map((s) => s.name),
    modeName,
  };
  for (const cid of watcherSet(match.id)) {
    const c = clients.get(cid);
    if (c) send(c, msg);
  }
}

function broadcastMatchStart(match: Match): void {
  for (const cid of watcherSet(match.id)) {
    const c = clients.get(cid);
    if (!c) continue;
    send(c, {
      t: 'matchStart',
      matchId: match.id,
      seed: match.seed,
      numFighters: match.seats.length,
      slot: c.spectating ? -1 : c.slot,
      settings: match.getClientSettings() ?? {},
      arenaId: match.arenaId,
      names: match.seats.map((s) => s.name),
      characterIds: match.seats.map((s) => s.characterId),
    });
  }
}

function makeEventsFor(matchId: string) {
  return {
    onStart() {
      const match = manager.getMatch(matchId);
      if (match) broadcastMatchStart(match);
    },
    onLobbyUpdate() {
      const match = manager.getMatch(matchId);
      if (match && match.phase === 'lobby') broadcastLobby(match);
    },
    onSeatGraceExpired(slot: number) {
      if (LOGGING_ENABLED) {
        const line = {
          ts: new Date().toISOString(),
          connId: null,
          matchId,
          slot,
          event: 'seat_grace_expired',
        };
        console.log(`[conn] ${JSON.stringify(line)}`);
      }
      // The grace window closed with no resume: this seat's stay is over,
      // emit its stashed telemetry now (see pendingSessionEnds docs above).
      const match = manager.getMatch(matchId);
      const key = seatKey(matchId, slot);
      const pending = pendingSessionEnds.get(key);
      if (match && pending) {
        pendingSessionEnds.delete(key);
        emitSessionEndOnce({ slot, ...pending }, match);
      }
    },
    onSnapshot(tick: number, acked: Map<number, number>) {
      const match = manager.getMatch(matchId);
      if (!match || !match.sim) return;
      const buf = match.sim.createStateBuffer();
      match.sim.saveState(buf);
      // This callback already only fires once per SNAPSHOT_EVERY_N_TICKS
      // (20Hz) -- skip alternate firings for spectator connections to land
      // on ~10Hz for them (SPECTATOR_SNAPSHOT_DIVISOR), without touching
      // the 60Hz sim tick or the live-player rate at all.
      const sendToSpectatorsThisTick = (tick / SNAPSHOT_EVERY_N_TICKS) % SPECTATOR_SNAPSHOT_DIVISOR === 0;
      for (const cid of watcherSet(matchId)) {
        const c = clients.get(cid);
        if (!c) continue;
        const spectator = isSpectatorConn(c, match);
        if (spectator && !sendToSpectatorsThisTick) continue;
        // ackedInputTick only means anything to a client replaying its own
        // buffered inputs during reconciliation (packages/app's
        // net-match.ts); a spectator/eliminated connection never predicts
        // or reconciles a fighter of its own, so it's dead weight -- always
        // 0 for them rather than a per-slot lookup that has no meaning for
        // that connection.
        const ackedInputTick = spectator ? 0 : acked.get(c.slot) ?? 0;
        sendBinary(c, c.snapshotEncoder.encode(tick, ackedInputTick, buf));
      }
    },
    onEliminated(slot: number, placement: number, tick: number) {
      const msg: ServerControlMessage = { t: 'eliminated', slot, placement, tick };
      for (const cid of watcherSet(matchId)) {
        const c = clients.get(cid);
        if (c) send(c, msg);
      }
    },
    onMatchSummary(summary) {
      statsRecorder.recordMatchSummary(summary);
    },
    onMatchEnd(winner: number | null, leaderboard: number[], tick: number, resolved: boolean) {
      const msg: ServerControlMessage = { t: 'matchEnd', winner, leaderboard, tick, resolved };
      // Send-time log (2026-09-09): lets a live cross-reference against
      // this same log settle whether a client-observed match-end really
      // came from the server, and exactly when/why -- see wiki "Match-End
      // Client Bugs and Session Wrap".
      const botDifficulty = manager.getMatch(matchId)?.botDifficulty ?? null;
      const winCondition = manager.getMatch(matchId)?.winCondition ?? null;
      console.log(`[matchEnd] ${JSON.stringify({ matchId, winner, tick, resolved, watchers: watcherSet(matchId).size, botDifficulty, winCondition })}`);
      for (const cid of watcherSet(matchId)) {
        const c = clients.get(cid);
        if (c) send(c, msg);
      }
      // Any seat still sitting in its disconnect grace window when the
      // match ends is genuinely over now too -- the match end boundary
      // beats the grace timer, per the sessionEnd de-dup contract above.
      const endedMatch = manager.getMatch(matchId);
      if (endedMatch) {
        for (const [key, pending] of [...pendingSessionEnds.entries()]) {
          if (!key.startsWith(`${matchId}:`)) continue;
          const slot = Number(key.slice(matchId.length + 1));
          pendingSessionEnds.delete(key);
          emitSessionEndOnce({ slot, ...pending }, endedMatch);
        }
      }
    },
  };
}

const CAPACITY = Number(process.env.MATCH_CAPACITY ?? DEFAULT_CAPACITY);
const MINIMUM = Number(process.env.MATCH_MINIMUM ?? DEFAULT_MINIMUM);
const manager = new RoomManager(makeEventsFor, CAPACITY, MINIMUM);

// Durable private stats aggregation (server/src/stats-store.ts) -- no
// HTTP route reads this; it exists purely so scripts/stats-report.mjs
// (run over SSH on the production box) can report real, restart-
// surviving numbers. See docs/MEASUREMENT.md.
const statsRecorder = createStatsRecorder();

const feedbackHandler = createFeedbackHandler();

const server = http.createServer((req, res) => {
  if (req.url === '/api/feedback') {
    feedbackHandler(req, res);
    return;
  }
  // Activity numbers (how many matches, how many players) are deliberately
  // NOT public: the owner reads them privately via scripts/stats-report.mjs
  // over SSH. nginx always adds X-Forwarded-For to proxied requests, so its
  // presence means the request came from the internet and gets the reduced
  // body; a direct loopback request (from the box itself, or from the test
  // suite) gets the operational detail.
  const fromInternet = req.headers['x-forwarded-for'] !== undefined;
  if (req.url === '/api/metrics') {
    if (fromInternet) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(tickMetricsSnapshot()));
    return;
  }
  if (req.url === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        fromInternet
          ? { status: 'ok' }
          : {
              status: 'ok',
              uptimeSeconds: process.uptime(),
              matchCount: manager.matchCount,
              playerCount: manager.playerCount,
            },
      ),
    );
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

const wss = new WebSocketServer({ server, path: '/socket' });

  wss.on('connection', (ws) => {
  const conn: ClientConn = {
    id: randomUUID(),
    ws,
    match: null,
    slot: -1,
    spectating: false,
    helloed: false,
    superseded: false,
    snapshotEncoder: new SnapshotStreamEncoder(),
    profile: null,
    lastReport: null,
    connectedAt: Date.now(),
    reconnectCount: 0,
  };
  clients.set(conn.id, conn);
  logConn(conn, 'connected');
  (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
  ws.on('pong', () => {
    (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
  });

  ws.on('message', (data, isBinary) => {
    try {
      if (isBinary) {
        handleBinary(conn, data as Buffer);
      } else {
        handleText(conn, data.toString('utf8'));
      }
    } catch {
      // A hostile or buggy client must never take the process down.
      closeWithError(conn, 'server_error', 'internal error handling message');
    }
  });

  ws.on('close', (code, reason) => {
    // Close code + reason are the single most useful fact for telling a
    // client-dropped-it disconnect (1001/1006, no reason) apart from a
    // server-initiated close (closeWithError always sets a reason string).
    // Never anything sensitive here -- code is a number, reason is a short
    // protocol string, never a token or IP.
    const closeInfo = { code, reason: reason.toString('utf8').slice(0, 120) || null };
    // A spectator or not-yet-assigned socket has no seat to hold open; only
    // a real fighter slot gets the disconnect/grace-period treatment. A
    // superseded connection's seat was already handed to a newer connection
    // by retireConn (see handleResume) -- this close is just its own dead
    // socket catching up, not a real disconnect of whoever holds the seat
    // now, so it must never call markDisconnected again.
    const hadLiveSeat = conn.match && !conn.spectating && conn.slot >= 0 && !conn.superseded;
    if (hadLiveSeat && conn.match) {
      // Telemetry for this seat's stay is emitted exactly once for the
      // whole match, not on every close: if the match is already over
      // there is no more grace window to wait out, so this really is the
      // end of the stay and we emit immediately; otherwise stash the
      // telemetry context and let the match's own grace timer (via
      // onSeatGraceExpired) or a later match end (via onMatchEnd) decide
      // when the stay is genuinely over -- a resume in between adopts the
      // stash and cancels this pending emission. See pendingSessionEnds
      // docs above.
      if (conn.match.phase === 'ended') {
        emitSessionEndOnce(conn, conn.match);
      } else {
        pendingSessionEnds.set(seatKey(conn.match.id, conn.slot), {
          profile: conn.profile,
          lastReport: conn.lastReport,
          reconnectCount: conn.reconnectCount,
        });
      }
      // Always mark the seat disconnected in the match's own bookkeeping,
      // even when we emitted immediately above -- resume tokens are only
      // reclaimable (Match.reclaimSeat) once seat.connected is false, and
      // a seat that stayed connected all the way through match end must
      // still be resumable afterwards (see the resume_after_match_ended
      // branch in handleResume) to tell the player the real outcome.
      conn.match.markDisconnected(conn.slot);
      logConn(conn, 'seat_disconnected', { gracePeriod: true, ...closeInfo });
    } else if (conn.superseded) {
      logConn(conn, 'closed', { hadSeat: false, superseded: true, ...closeInfo });
    } else {
      logConn(conn, 'closed', { hadSeat: false, ...closeInfo });
    }
    if (conn.match) {
      watcherSet(conn.match.id).delete(conn.id);
      syncWatcherCount(conn.match);
    }
    clients.delete(conn.id);
  });

  ws.on('error', (err) => {
    logConn(conn, 'socket_error', { message: err instanceof Error ? err.message : String(err) });
    ws.close();
  });
});

// A dropped mobile connection often never sends a TCP FIN or RST -- the OS
// can sit on a dead socket for a very long time before the ws library ever
// sees a `close` event. Without this, a seat's `connected` flag stays true
// long after the player is gone, so their own attempt to resume gets
// rejected with resume_seat_taken by a seat nobody is actually holding.
// A periodic WebSocket-protocol ping/pong catches that: any socket that
// doesn't answer one full interval's ping gets terminated, which runs the
// normal close-handler cleanup (markDisconnected + grace timer) so a
// resume can succeed well within the grace window.
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS ?? 12_000);
const heartbeatTimer = setInterval(() => {
  for (const conn of clients.values()) {
    const ws = conn.ws as WebSocket & { isAlive?: boolean };
    if (ws.isAlive === false) {
      logConn(conn, 'heartbeat_timeout', {});
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      // socket already going away; the next sweep (or its close event)
      // will clean it up
    }
  }
}, HEARTBEAT_INTERVAL_MS);
heartbeatTimer.unref?.();

/** Handles a `hello` that carries a `resume` token instead of joining a
 *  fresh lobby. Presenting a token is the ONLY path that can hand a
 *  connection someone else's seat -- there is no lookup by matchId+slot
 *  alone -- and a wrong/expired/already-connected token always fails with
 *  an explicit `error` frame rather than silently falling back to a new
 *  join, so a client bug can't accidentally end up spectating or dropped
 *  into a random lobby without knowing why. */
/** Finds the ClientConn that currently occupies a given match+slot, if
 *  any -- used only to check whether that connection's own socket is
 *  actually still open before we trust the seat's `connected` flag. */
function findIncumbentConn(matchId: string, slot: number): ClientConn | undefined {
  for (const c of clients.values()) {
    if (!c.spectating && c.match?.id === matchId && c.slot === slot) return c;
  }
  return undefined;
}

/** Retires a connection whose socket is provably dead (readyState is no
 *  longer OPEN) but whose `close` event the server has not yet received --
 *  the real-world case is a dropped mobile connection where the OS can
 *  take far longer than a player's patience to notice the TCP session is
 *  gone. Marks it `superseded` so its eventual belated `close` is a no-op,
 *  releases its grip on the seat via the normal markDisconnected path, and
 *  removes it from bookkeeping so it can't be found again. */
function retireConn(conn: ClientConn): void {
  conn.superseded = true;
  if (conn.match && !conn.spectating && conn.slot >= 0) {
    conn.match.markDisconnected(conn.slot);
  }
  clients.delete(conn.id);
  // 2026-09-10: removeAllListeners() below strips the socket's 'close'
  // handler, which is the only place that otherwise deletes conn.id from
  // watcherSet(match.id) -- so without this explicit delete, every
  // resumed/reconnected connection leaked its old id into the watcher set
  // forever. onSnapshot's `clients.get(cid)` guard means a leaked id never
  // crashes anything, but it does mean the reported watcher count (and
  // the isAbandonedByHumans/teardown logic that reads it) can overcount
  // real, currently-connected watchers by every stale id an old match's
  // reconnects left behind. Delete it here, before the listeners are gone.
  if (conn.match) {
    watcherSet(conn.match.id).delete(conn.id);
    syncWatcherCount(conn.match);
  }
  try {
    conn.ws.removeAllListeners();
    conn.ws.terminate();
  } catch {
    // best-effort cleanup of an already-dead socket
  }
}

function handleResume(conn: ClientConn, token: string): void {
  let found = manager.findReclaim(token);
  if (!found) {
    const held = manager.findByAnyToken(token);
    if (held) {
      // Valid token, and the seat's bookkeeping says it's still connected.
      // That bookkeeping is only updated by the incumbent's own `close`
      // event though, which can lag well behind reality on a flaky mobile
      // connection. Check the incumbent's actual socket state before
      // trusting it -- if it is provably no longer OPEN, self-heal instead
      // of making this legitimately reconnecting player wait out someone
      // else's dead TCP session (which can take minutes).
      const incumbent = findIncumbentConn(held.match.id, held.slot);
      if (incumbent && incumbent.ws.readyState !== WebSocket.OPEN) {
        logConn(conn, 'stale_incumbent_retired', {
          matchId: held.match.id,
          slot: held.slot,
          staleReadyState: incumbent.ws.readyState,
        });
        retireConn(incumbent);
        found = manager.findReclaim(token);
      }
    }
  }
  if (!found) {
    if (manager.isTokenForConnectedSeat(token)) {
      // Valid token, but that seat already has a live socket -- reject the
      // newcomer, never kick the incumbent.
      logConn(conn, 'resume_rejected', { reason: 'resume_seat_taken' });
      closeWithError(conn, 'resume_seat_taken', 'this seat already has an active connection');
    } else {
      logConn(conn, 'resume_rejected', { reason: 'resume_invalid' });
      closeWithError(conn, 'resume_invalid', 'resume token not recognised or expired');
    }
    return;
  }
  const { match, slot } = found;
  const seat = match.seats[slot];

  if (match.phase === 'ended') {
    logConn(conn, 'resume_after_match_ended', { matchId: match.id, slot });
    // Told the outcome instead of erroring (edge case: reconnect after the
    // match already ended). The seat is not re-marked connected -- there is
    // no sim ticking any more to reconnect *to* -- this is purely informing
    // the client so it can show a result screen instead of hanging.
    conn.match = match;
    conn.slot = slot;
    // Never treat this as holding a live seat: there is nothing left to
    // disconnect from, and without this the ws 'close' handler's
    // hadLiveSeat check (`conn.match && !conn.spectating && conn.slot >= 0`)
    // would be true and emit a second, all-null sessionEnd record for a
    // seat that already produced one on its real disconnect -- the bug
    // fixed 2026-09-20. emitSessionEndOnce's own de-dup guards the same
    // case defensively even if this flag is ever missed.
    conn.spectating = true;
    watcherSet(match.id).add(conn.id);
    syncWatcherCount(match);
    send(conn, {
      t: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      clientId: conn.id,
      slot,
      matchId: match.id,
      resumeToken: null,
      resumed: true,
    });
    const sim = match.sim;
    const resumeWinner = sim ? sim.getWinner() : null;
    console.log(`[matchEnd] ${JSON.stringify({ matchId: match.id, winner: resumeWinner, tick: match.tick, resolved: true, path: 'resume-into-ended' })}`);
    send(conn, {
      t: 'matchEnd',
      winner: resumeWinner,
      leaderboard: sim ? sim.getLeaderboard() : [],
      tick: match.tick,
      // Rejoining a match that's already over: we don't know here whether
      // it finished naturally or was torn down early, but by the time a
      // client is asking to rejoin, either way there's a real leaderboard
      // to show -- treat as resolved so the client gives a result screen
      // instead of silently hanging.
      resolved: true,
    });
    return;
  }

  if (!match.reclaimSeat(slot)) {
    // Lost a race (e.g. grace timer fired between findReclaim and here, or
    // someone else's connection beat us to it) -- fail cleanly rather than
    // handing over a seat that is no longer actually reclaimable.
    logConn(conn, 'resume_rejected', { reason: 'resume_expired', matchId: match.id, slot });
    closeWithError(conn, 'resume_expired', 'seat is no longer reclaimable');
    return;
  }

  conn.match = match;
  conn.slot = slot;
  // Adopt whatever telemetry context the previous connection for this
  // seat had stashed on disconnect (see pendingSessionEnds docs above), so
  // the eventual single sessionEnd record for this seat's whole stay still
  // reflects its profile/report rather than starting blank, and cancel
  // that pending emission -- this connection now owns telling the seat's
  // story. joinedAt is untouched (Match keeps the original), so the
  // eventual sessionDurationSec still spans the whole stay including the
  // disconnected gap.
  const resumedKey = seatKey(match.id, slot);
  const stashed = pendingSessionEnds.get(resumedKey);
  if (stashed) {
    pendingSessionEnds.delete(resumedKey);
    conn.profile = stashed.profile;
    conn.lastReport = stashed.lastReport;
    conn.reconnectCount = stashed.reconnectCount + 1;
  }
  watcherSet(match.id).add(conn.id);
  syncWatcherCount(match);
  logConn(conn, 'resume_succeeded');
  send(conn, {
    t: 'welcome',
    protocolVersion: PROTOCOL_VERSION,
    clientId: conn.id,
    slot,
    matchId: match.id,
    resumeToken: seat.resumeToken,
    resumed: true,
  });
  // Re-tell the reconnecting client the match parameters (seed, arena,
  // names) so it can rebuild its sim from scratch rather than trusting any
  // stale client-side state -- it will resync from the very next
  // authoritative snapshot regardless.
  send(conn, {
    t: 'matchStart',
    matchId: match.id,
    seed: match.seed,
    numFighters: match.seats.length,
    slot,
    settings: match.getClientSettings() ?? {},
    arenaId: match.arenaId,
    names: match.seats.map((s) => s.name),
    characterIds: match.seats.map((s) => s.characterId),
  });
}

function handleText(conn: ClientConn, text: string): void {
  const msg = parseClientControl(text);
  if (!msg) {
    // Never end a live player's match over one unparseable control message.
    // Control messages are advisory (telemetry, pings, lobby actions); the
    // authoritative simulation does not depend on any of them, so the safe
    // response is to drop the message and keep playing. We logged players out
    // mid-match for this, which real players reported as the connection
    // dropping constantly.
    logConn(conn, 'control_message_ignored', { bytes: text.length });
    return;
  }
  switch (msg.t) {
    case 'hello': {
      if (msg.protocolVersion !== PROTOCOL_VERSION) {
        closeWithError(
          conn,
          'protocol_mismatch',
          `server protocol ${PROTOCOL_VERSION}, client sent ${msg.protocolVersion}`,
        );
        return;
      }
      if (conn.helloed) return; // ignore duplicate hello
      conn.helloed = true;
      // Engagement telemetry only (see docs/MEASUREMENT.md) -- stored on
      // the connection, never touches match state, and is simply absent
      // if the client didn't send one (older client, or malformed profile
      // already dropped by parseClientControl).
      if (msg.profile) conn.profile = msg.profile;

      if (msg.resume) {
        handleResume(conn, msg.resume);
        return;
      }

      const name = sanitiseName(msg.name);
      const { match, slot } = manager.joinLobby(name, msg.characterId, msg.profile?.qa === true, msg.arena);
      conn.match = match;
      conn.slot = slot;
      watcherSet(match.id).add(conn.id);
      syncWatcherCount(match);
      logConn(conn, 'joined_lobby', { name });
      send(conn, {
        t: 'welcome',
        protocolVersion: PROTOCOL_VERSION,
        clientId: conn.id,
        slot,
        matchId: match.id,
        resumeToken: match.seats[slot].resumeToken,
        resumed: false,
      });
      if (match.phase === 'lobby') {
        broadcastLobby(match);
      } else {
        broadcastMatchStart(match);
      }
      break;
    }
    case 'spectate': {
      conn.spectating = true;
      break;
    }
    case 'pong': {
      // Round-trip measurement hook; nothing to do server-side yet.
      break;
    }
    case 'sessionReport': {
      // Engagement telemetry only (see docs/MEASUREMENT.md): overwritten
      // in place, read only when this connection's session ends. Never
      // gates or touches match/sim state, so a client that never sends
      // one, or sends nonsense (already clamped by parseClientControl),
      // simply leaves `[sessionEnd]` reporting nulls/zeros for it.
      conn.lastReport = msg;
      break;
    }
    case 'startNow': {
      // Only a connection holding an actual seat in a still-filling lobby
      // can force the start -- never a spectator, never a stranger who
      // hasn't even joined this match, and never once the match has left
      // the lobby phase (RoomManager.startNow is itself idempotent on
      // phase, so a double-send or a stale/duplicate request from the
      // same client is a silent no-op, not an error or a second start).
      if (!conn.match || conn.spectating || conn.slot < 0) break;
      if (conn.match.phase !== 'lobby') break;
      manager.startNow(conn.match);
      break;
    }
  }
}

function handleBinary(conn: ClientConn, data: Buffer): void {
  const input = decodeInput(new Uint8Array(data));
  if (!input) return; // malformed input frame: drop it, don't crash or close
  if (!conn.match || conn.spectating || conn.slot < 0) return;
  conn.match.setInput(conn.slot, { buttons: input.buttons, stickX: input.stickX, stickY: input.stickY }, input.tick);
}

// Test-only override: production leaves these at their defaults
// (30s sweep, 60s max age); tests set both low so an abandoned match's
// teardown can be asserted without waiting out real-world timings.
const REAP_INTERVAL_MS = Number(process.env.MATCH_REAP_INTERVAL_MS ?? 30_000);
const REAP_MAX_AGE_MS = Number(process.env.MATCH_REAP_MAX_AGE_MS ?? 60_000);
setInterval(() => manager.reap(REAP_MAX_AGE_MS), REAP_INTERVAL_MS).unref();

// Periodic one-line health summary, only when there's something to say --
// an idle server (no connections, no matches) stays silent rather than
// printing a heartbeat every 30s forever. Bots count separately from real
// players so a log reader can tell a bot-filled lobby from a real crowd.
setInterval(() => {
  if (!LOGGING_ENABLED) return;
  const connectionCount = clients.size;
  const matchCount = manager.matchCount;
  const playerCount = manager.playerCount;
  const botCount = manager.botCount;
  if (connectionCount === 0 && matchCount === 0) return; // idle: stay silent
  console.log(
    `[summary] ${JSON.stringify({
      ts: new Date().toISOString(),
      connections: connectionCount,
      matches: matchCount,
      players: playerCount,
      bots: botCount,
    })}`,
  );
}, 30_000).unref();

const PORT = Number(process.env.PORT ?? 8081);
server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`bash-fighter server listening on :${PORT} (capacity=${manager.capacity}, minimum=${manager.minimum})`);
});
