/**
 * Bash Fighter wire protocol.
 *
 * Two channels over one WebSocket:
 *
 *  - Control messages are JSON text frames. They are infrequent (join, match
 *    start, elimination, match end), so legibility is worth more than bytes,
 *    and being able to read them in a browser's network tab is a real debugging
 *    advantage for contributors.
 *  - Inputs and snapshots are binary frames. These are the hot path: inputs go
 *    up at 60Hz and snapshots come down at SNAPSHOT_HZ, so every byte is
 *    multiplied by the tick rate and the player count.
 *
 * Both sides must agree on PROTOCOL_VERSION. A mismatch is refused at the
 * handshake with an explicit error rather than allowed to desync silently,
 * which is the single most confusing failure mode a deterministic netcode can
 * have: play looks fine for a few seconds and then two clients disagree about
 * reality with no error anywhere.
 */

/** Bumped to 3 for delta-compressed snapshots (2026-09-11): the server may
 *  now send a `SNAPSHOT_DELTA` binary frame instead of a full `SNAPSHOT`,
 *  see "Binary: snapshot delta" below and the "Bandwidth Reduction Pass
 *  2026-09-11" wiki page. A mismatch is still refused explicitly at the
 *  handshake rather than silently misbehaving -- see the module comment
 *  above. (Was bumped to 2 for resume-token reconnection support.) */
export const PROTOCOL_VERSION = 3;

/** Snapshots per second sent to each client. The sim runs at 60Hz; clients
 *  interpolate between snapshots and predict their own fighter, so the
 *  broadcast rate can be well below the tick rate. */
export const SNAPSHOT_HZ = 20;

/** Binary frame discriminators (first byte of a binary frame). */
export const BinaryTag = {
  INPUT: 1,
  SNAPSHOT: 2,
  /** A delta against a previously-sent full SNAPSHOT for this same
   *  connection, see "Binary: snapshot delta" below. */
  SNAPSHOT_DELTA: 3,
} as const;

/** How many snapshots between forced full keyframes, per connection. Bounds
 *  how stale a client's baseline can ever get after a dropped delta or a
 *  reconnect: at 20Hz this is once per second. Also the periodic resync
 *  safety net flagged in the original design as future work -- see
 *  [[Netcode Design Part 2: Bandwidth and State Sync]]. */
export const KEYFRAME_INTERVAL_SNAPSHOTS = 20;

// ---------------------------------------------------------------------------
// Control messages: client -> server
// ---------------------------------------------------------------------------

export interface HelloMessage {
  t: 'hello';
  protocolVersion: number;
  /** Display name. Server sanitises and truncates; never trusted. */
  name: string;
  /** Opaque resume token from a previous `welcome`, presented to reclaim a
   *  disconnected seat in an in-progress (or just-ended) match instead of
   *  joining a fresh lobby. Absent for a normal new join. Unguessable --
   *  see server/src/match.ts's token generation -- so presenting one is the
   *  ONLY way to reclaim a seat; there is no other path that hands a seat
   *  back based on slot number or match id alone. */
  resume?: string;
  /** Requested character id from @bash-fighter/content's roster (e.g.
   *  'placeholder', 'ballast'). Optional and defaults to the placeholder
   *  character server-side -- required for backward compatibility with
   *  any client built before character selection existed. Unrecognised
   *  ids are also treated as absent by the server, never rejected. */
  characterId?: string;
}

/** Sent by a client that wants to keep watching after being eliminated. */
export interface SpectateMessage {
  t: 'spectate';
}

export interface PongMessage {
  t: 'pong';
  /** Echo of the server's ping id, for round-trip measurement. */
  id: number;
}

/** Sent by a client sitting in a lobby who wants the match to start right
 *  now instead of waiting out the countdown/bot-fill grace period -- the
 *  "Start now" control on the waiting screen. The server only honours this
 *  from a connection holding an actual seat in that lobby (never a
 *  spectator, never a stranger to the match), and treats it as a no-op
 *  once the match has left the lobby phase, so it's safe to send more
 *  than once (e.g. a double click). Remaining empty seats are filled with
 *  bots exactly as the normal bot-fill timer would. */
export interface StartNowMessage {
  t: 'startNow';
}

export type ClientControlMessage = HelloMessage | SpectateMessage | PongMessage | StartNowMessage;

// ---------------------------------------------------------------------------
// Control messages: server -> client
// ---------------------------------------------------------------------------

export interface WelcomeMessage {
  t: 'welcome';
  protocolVersion: number;
  /** Opaque connection id, for logs and reconnection. */
  clientId: string;
  /** Fighter slot in the match, or -1 for a pure spectator. */
  slot: number;
  matchId: string;
  /** Opaque resume token for this seat, or null for a pure spectator (a
   *  spectator holds no reclaimable seat). Present it in a later `hello`'s
   *  `resume` field to reclaim this exact seat after a disconnect, as long
   *  as the seat is still within its grace window. Generated with
   *  crypto.randomBytes server-side -- not derivable from slot or matchId. */
  resumeToken: string | null;
  /** True when this welcome is the result of successfully reclaiming a
   *  disconnected seat via a resume token, so the client knows to treat
   *  this as "you're back" rather than "you're new". */
  resumed: boolean;
}

/** Sent while a match is filling, so the client can show something honest
 *  instead of a blank screen. */
export interface LobbyMessage {
  t: 'lobby';
  players: number;
  /** Slots the match will start with once full. */
  capacity: number;
  /** Minimum players needed to start early. */
  minimum: number;
  /** Ticks until the match starts anyway, or -1 if no deadline is known
   *  yet (a match with nobody in it, which never actually gets sent).
   *  Covers both reasons a lobby ever ends: the post-minimum countdown
   *  AND the bot-fill grace period a lone player sits in before bots pad
   *  the rest of the lobby -- whichever is sooner. Computed server-side
   *  from a wall-clock deadline each time this message is sent, so it's
   *  always accurate even across broadcast gaps; the client may still
   *  tick it down locally between messages for a smooth display. */
  countdownTicks: number;
  names: string[];
  /** Plain-language name of the mode this lobby's match will run, e.g.
   *  "Battle Royale — last fighter standing wins" or "Timed Brawl — most
   *  knockouts in 3 minutes wins" (2026-09-11, mode rotation launch --
   *  see server/src/mode-rotation.ts's modeDisplayName). Never the raw
   *  internal identifier ('timedKO'/'battleRoyale'): a player must be
   *  told what they are about to play in words, before it matters.
   *  Optional so an older server that predates rotation still parses. */
  modeName?: string;
}

export interface MatchStartMessage {
  t: 'matchStart';
  matchId: string;
  /** PRNG seed. Every client builds an identical Sim from this. */
  seed: number;
  numFighters: number;
  /** Which fighter this client controls, or -1 when spectating. */
  slot: number;
  /** Serialised match settings (win condition, stocks, time limit). */
  settings: unknown;
  /** Identifier of the arena in @bash-fighter/content. */
  arenaId: string;
  names: string[];
  /** Character id (from @bash-fighter/content's roster) for each seat, in
   *  slot order -- parallel array to `names`. Lets every client build a
   *  local Sim with the exact same per-slot CharacterData the server used,
   *  which is load-bearing for determinism (character weight affects
   *  knockback) and for rendering the right silhouette for remote
   *  fighters. Always present and always resolved server-side (never
   *  'unknown'), so older clients that ignore it lose nothing and newer
   *  clients never need a fallback for this field specifically. */
  characterIds: string[];
}

export interface EliminatedMessage {
  t: 'eliminated';
  slot: number;
  placement: number;
  tick: number;
}

export interface MatchEndMessage {
  t: 'matchEnd';
  /** Winning slot, or null for no winner (everyone eliminated on the same
   *  tick, which a simultaneous KO can genuinely produce). */
  winner: number | null;
  /** Slots in finishing order, best first. */
  leaderboard: number[];
  tick: number;
  /** true if the sim itself decided the match (a real winner, or a
   *  genuine simultaneous-KO draw); false if every human seat left and
   *  the server tore an unfinished bot-only fight down early to stop
   *  paying for it (see isAbandonedByHumans in server/src/match.ts). An
   *  already-eliminated player should still get a real result screen
   *  when resolved is true -- only the early-teardown case is noise that
   *  has nothing to do with the match they actually played. Added
   *  2026-09-09, see wiki 'End-of-Match Screen Missing Entirely'. */
  resolved: boolean;
}

export interface ErrorMessage {
  t: 'error';
  code:
    | 'protocol_mismatch'
    | 'bad_message'
    | 'match_full'
    | 'server_error'
    | 'resume_invalid'
    | 'resume_expired'
    | 'resume_seat_taken';
  message: string;
}

export interface PingMessage {
  t: 'ping';
  id: number;
}

export type ServerControlMessage =
  | WelcomeMessage
  | LobbyMessage
  | MatchStartMessage
  | EliminatedMessage
  | MatchEndMessage
  | ErrorMessage
  | PingMessage;

// ---------------------------------------------------------------------------
// Binary: input (client -> server)
// ---------------------------------------------------------------------------

/** tag(1) + tick(4) + buttons(2) + stickX(4) + stickY(4) = 15 bytes. */
export const INPUT_FRAME_BYTES = 15;

export interface WireInput {
  /** The tick this input is intended for. Lets the server reject inputs that
   *  arrive impossibly early, and place late ones correctly. */
  tick: number;
  buttons: number;
  stickX: number;
  stickY: number;
}

export function encodeInput(input: WireInput): Uint8Array {
  const buf = new ArrayBuffer(INPUT_FRAME_BYTES);
  const view = new DataView(buf);
  view.setUint8(0, BinaryTag.INPUT);
  view.setUint32(1, input.tick >>> 0, true);
  view.setUint16(5, input.buttons & 0xffff, true);
  view.setInt32(7, input.stickX | 0, true);
  view.setInt32(11, input.stickY | 0, true);
  return new Uint8Array(buf);
}

/** Returns null for anything malformed. Callers must treat clients as hostile:
 *  a bad frame closes the connection, it never reaches the sim. */
export function decodeInput(bytes: Uint8Array): WireInput | null {
  if (bytes.byteLength !== INPUT_FRAME_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== BinaryTag.INPUT) return null;
  return {
    tick: view.getUint32(1, true),
    buttons: view.getUint16(5, true),
    stickX: view.getInt32(7, true),
    stickY: view.getInt32(11, true),
  };
}

// ---------------------------------------------------------------------------
// Binary: snapshot (server -> client)
// ---------------------------------------------------------------------------

/** tag(1) + tick(4) + ackedInputTick(4) = 9 bytes, then the Int32 state words. */
export const SNAPSHOT_HEADER_BYTES = 9;

export interface WireSnapshot {
  tick: number;
  /** The most recent input tick the server has received from this client.
   *  The client uses it to discard inputs it no longer needs to re-apply. */
  ackedInputTick: number;
  state: Int32Array;
}

export function encodeSnapshot(snapshot: WireSnapshot): Uint8Array {
  const words = snapshot.state.length;
  const out = new Uint8Array(SNAPSHOT_HEADER_BYTES + words * 4);
  const view = new DataView(out.buffer);
  view.setUint8(0, BinaryTag.SNAPSHOT);
  view.setUint32(1, snapshot.tick >>> 0, true);
  view.setUint32(5, snapshot.ackedInputTick >>> 0, true);
  // Copy word by word with an explicit little-endian write rather than a
  // typed-array set: the state buffer's byte order must not depend on the
  // endianness of whichever machine the server happens to run on.
  for (let i = 0; i < words; i++) {
    view.setInt32(SNAPSHOT_HEADER_BYTES + i * 4, snapshot.state[i] as number, true);
  }
  return out;
}

export function decodeSnapshot(bytes: Uint8Array): WireSnapshot | null {
  if (bytes.byteLength < SNAPSHOT_HEADER_BYTES) return null;
  const payload = bytes.byteLength - SNAPSHOT_HEADER_BYTES;
  if (payload % 4 !== 0) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== BinaryTag.SNAPSHOT) return null;
  const words = payload / 4;
  const state = new Int32Array(words);
  for (let i = 0; i < words; i++) {
    state[i] = view.getInt32(SNAPSHOT_HEADER_BYTES + i * 4, true);
  }
  return {
    tick: view.getUint32(1, true),
    ackedInputTick: view.getUint32(5, true),
    state,
  };
}

// ---------------------------------------------------------------------------
// Binary: snapshot delta (server -> client)
//
// A delta is always relative to a specific previously-sent full SNAPSHOT for
// THIS connection (identified by baseTick), never to another delta -- this
// keeps reconstruction a single step (copy the last full state, apply
// changed words) instead of a chain that a single dropped frame could break
// silently. If a client's decoder doesn't recognise baseTick as its current
// baseline (never received that keyframe, or has since applied a different
// one), it must discard the delta and wait for the next periodic full
// keyframe (KEYFRAME_INTERVAL_SNAPSHOTS) rather than guess -- see
// SnapshotStreamDecoder below, which is the only supported way to consume
// this frame type.
// ---------------------------------------------------------------------------

/** tag(1) + tick(4) + ackedInputTick(4) + baseTick(4) + changedCount(2) =
 *  15 bytes, then changedCount * (index(2) + value(4)) = 6 bytes/change. */
export const SNAPSHOT_DELTA_HEADER_BYTES = 15;

export interface WireSnapshotDelta {
  tick: number;
  ackedInputTick: number;
  /** The tick of the full SNAPSHOT this delta is relative to. */
  baseTick: number;
  changed: Array<{ index: number; value: number }>;
}

export function encodeSnapshotDelta(delta: WireSnapshotDelta): Uint8Array {
  const n = delta.changed.length;
  const out = new Uint8Array(SNAPSHOT_DELTA_HEADER_BYTES + n * 6);
  const view = new DataView(out.buffer);
  view.setUint8(0, BinaryTag.SNAPSHOT_DELTA);
  view.setUint32(1, delta.tick >>> 0, true);
  view.setUint32(5, delta.ackedInputTick >>> 0, true);
  view.setUint32(9, delta.baseTick >>> 0, true);
  view.setUint16(13, n, true);
  let off = SNAPSHOT_DELTA_HEADER_BYTES;
  for (const c of delta.changed) {
    view.setUint16(off, c.index, true);
    view.setInt32(off + 2, c.value, true);
    off += 6;
  }
  return out;
}

export function decodeSnapshotDelta(bytes: Uint8Array): WireSnapshotDelta | null {
  if (bytes.byteLength < SNAPSHOT_DELTA_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== BinaryTag.SNAPSHOT_DELTA) return null;
  const n = view.getUint16(13, true);
  if (bytes.byteLength !== SNAPSHOT_DELTA_HEADER_BYTES + n * 6) return null;
  const changed: Array<{ index: number; value: number }> = [];
  let off = SNAPSHOT_DELTA_HEADER_BYTES;
  for (let i = 0; i < n; i++) {
    changed.push({ index: view.getUint16(off, true), value: view.getInt32(off + 2, true) });
    off += 6;
  }
  return {
    tick: view.getUint32(1, true),
    ackedInputTick: view.getUint32(5, true),
    baseTick: view.getUint32(9, true),
    changed,
  };
}

/** Server-side helper: turns a stream of full state buffers for one
 *  connection into full keyframes + deltas, per the scheme above. One
 *  instance per connection -- state is per-recipient by design, since two
 *  clients can be at different points in the stream (e.g. one just
 *  reconnected). */
export class SnapshotStreamEncoder {
  private lastSentState: Int32Array | null = null;
  private lastSentTick: number | null = null;
  private sinceKeyframe = 0;

  /** Forces the next call to encode() to be a full keyframe. Call this on a
   *  fresh/resumed connection so its first frame is never a delta against a
   *  baseline the client cannot possibly have. */
  reset(): void {
    this.lastSentState = null;
    this.lastSentTick = null;
    this.sinceKeyframe = 0;
  }

  encode(tick: number, ackedInputTick: number, state: Int32Array): Uint8Array {
    const needsKeyframe =
      this.lastSentState === null ||
      this.lastSentTick === null ||
      this.lastSentState.length !== state.length ||
      this.sinceKeyframe >= KEYFRAME_INTERVAL_SNAPSHOTS;
    if (needsKeyframe) {
      this.sinceKeyframe = 0;
      this.lastSentState = state.slice();
      this.lastSentTick = tick;
      return encodeSnapshot({ tick, ackedInputTick, state });
    }
    const baseTick = this.lastSentTick as number;
    const prev = this.lastSentState as Int32Array;
    const changed: Array<{ index: number; value: number }> = [];
    for (let i = 0; i < state.length; i++) {
      if (state[i] !== prev[i]) changed.push({ index: i, value: state[i] as number });
    }
    this.sinceKeyframe += 1;
    this.lastSentState = state.slice();
    this.lastSentTick = tick;
    return encodeSnapshotDelta({ tick, ackedInputTick, baseTick, changed });
  }
}

/** Client-side helper: the exact inverse of SnapshotStreamEncoder. Feed it
 *  every binary snapshot frame in arrival order; it hands back a
 *  reconstructed full WireSnapshot, or null if the frame could not be
 *  applied (malformed, or a delta whose baseTick isn't the decoder's
 *  current baseline -- e.g. after a dropped frame). Returning null rather
 *  than guessing is deliberate: the caller simply skips that tick's update
 *  and picks back up cleanly on the next full keyframe, at most
 *  KEYFRAME_INTERVAL_SNAPSHOTS away -- it never risks applying a delta to
 *  the wrong base and drifting from the server. */
export class SnapshotStreamDecoder {
  private lastState: Int32Array | null = null;
  private lastTick: number | null = null;

  decode(bytes: Uint8Array): WireSnapshot | null {
    if (bytes.byteLength === 0) return null;
    const tag = bytes[0];
    if (tag === BinaryTag.SNAPSHOT) {
      const snap = decodeSnapshot(bytes);
      if (!snap) return null;
      this.lastState = snap.state.slice();
      this.lastTick = snap.tick;
      return snap;
    }
    if (tag === BinaryTag.SNAPSHOT_DELTA) {
      const delta = decodeSnapshotDelta(bytes);
      if (!delta) return null;
      if (this.lastState === null || this.lastTick !== delta.baseTick) {
        // Unknown or stale baseline (never got the keyframe this delta is
        // relative to, or missed a frame since) -- drop it and wait for the
        // next full keyframe rather than reconstructing from a guess.
        return null;
      }
      const state = this.lastState.slice();
      for (const c of delta.changed) state[c.index] = c.value;
      this.lastState = state;
      this.lastTick = delta.tick;
      return { tick: delta.tick, ackedInputTick: delta.ackedInputTick, state };
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Control message parsing
// ---------------------------------------------------------------------------

/** Parse a JSON text frame from a client. Returns null for anything that is
 *  not a recognised, well-formed message. Never throws. */
export function parseClientControl(text: string): ClientControlMessage | null {
  if (text.length > 512) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  switch (obj.t) {
    case 'hello': {
      if (typeof obj.protocolVersion !== 'number') return null;
      if (typeof obj.name !== 'string') return null;
      const resume = typeof obj.resume === 'string' && obj.resume.length > 0 ? obj.resume : undefined;
      const characterId =
        typeof obj.characterId === 'string' && obj.characterId.length > 0 ? obj.characterId : undefined;
      return {
        t: 'hello',
        protocolVersion: obj.protocolVersion,
        name: sanitiseName(obj.name),
        ...(resume ? { resume } : {}),
        ...(characterId ? { characterId } : {}),
      };
    }
    case 'spectate':
      return { t: 'spectate' };
    case 'startNow':
      return { t: 'startNow' };
    case 'pong':
      if (typeof obj.id !== 'number') return null;
      return { t: 'pong', id: obj.id };
    default:
      return null;
  }
}

/** Max characters kept from a client-supplied name. Applied after
 *  stripping and trimming so it counts visible characters, not raw
 *  bytes an attacker padded with control characters. */
export const MAX_NAME_LENGTH = 16;

/** Names are shown to other players -- as plain text, never as markup, in
 *  every renderer this codebase has (DOM textContent in the HUD/overlays,
 *  PIXI Text glyphs in the world badges) -- so there is technically no
 *  script-injection surface today. Sanitising here anyway is deliberate
 *  defence in depth at the one boundary every name crosses: it is cheap,
 *  and it means a future renderer that is less careful (say, an HTML
 *  tooltip built with a template string) inherits safety for free instead
 *  of having to remember this rule itself.
 *
 *  Stripped: C0/C1 control characters and newlines (would break single-line
 *  layouts, HUD cards, and log lines), then whitespace is collapsed and
 *  trimmed so a name can't be an invisible run of spaces or tabs.
 *  Truncated to MAX_NAME_LENGTH.
 *
 *  Deliberately returns '' for empty/whitespace-only/all-control input
 *  rather than a forced placeholder like "Fighter": callers (server seat
 *  assignment, client display) treat '' as "this player didn't pick a
 *  name" and fall back to the slot label ("#7") instead, which stays
 *  distinct per-seat for free. A forced non-empty fallback would instead
 *  make every anonymous player collide on the exact same string. */
export function sanitiseName(name: string): string {
  return name
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
}

/** De-duplicates a sanitised name against names already in use (case-
 *  insensitive -- "Rook" and "rook" read as the same identity to a human
 *  even though they're different strings), by appending " (2)", " (3)",
 *  etc. Empty names are never deduped: they carry no identity to collide
 *  on and are shown via slot fallback instead. Stays within
 *  MAX_NAME_LENGTH even with the suffix appended. */
export function dedupeName(name: string, existing: readonly string[]): string {
  if (name.length === 0) return name;
  const taken = new Set(existing.filter((n) => n.length > 0).map((n) => n.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; n < 1000; n++) {
    const suffix = ` (${n})`;
    const candidate = (name.slice(0, MAX_NAME_LENGTH - suffix.length) + suffix).trim();
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return name;
}
