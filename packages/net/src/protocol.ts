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
  /** Small, non-identifying client environment snapshot -- added for the
   *  engagement-telemetry work (2026-09-13, see docs/MEASUREMENT.md) so a
   *  `[sessionEnd]` log line can tell "no touch support" and "tiny
   *  viewport" apart from a plain fun/pacing loss. Exactly the same
   *  fields/conventions as `FeedbackContext` in server/src/feedback.ts:
   *  no IP, no user agent, no persistent id, nothing that survives past
   *  this one connection. Optional so an older client that predates this
   *  still parses as a normal hello. */
  profile?: ClientSessionProfile;
  /** Dev-only stage pin request: the id of a registered arena (see
   *  @bash-fighter/content's ALL_ARENAS) the client asks the server to
   *  pin this match's stage to, instead of the seeded pick. The client
   *  only ever sends this from a dev build with `?arena=<id>` in the URL
   *  -- and the server only ever HONOURS it when explicitly opted in via
   *  the MATCH_ARENA_OVERRIDE env var, so a production server ignores it
   *  no matter what a client sends. Unknown to older servers, which drop
   *  it like any other unrecognised field: the version handshake is
   *  untouched. Sanitised like every other client-supplied string and
   *  validated against the registry server-side. */
  arena?: string;
}

/** See HelloMessage.profile. Match-scoped, non-identifying: whether a
 *  touch input source is active, the viewport size, and the build sha the
 *  client was served -- nothing that identifies a person or survives
 *  across sessions. */
export interface ClientSessionProfile {
  touchActive?: boolean;
  viewportWidth?: number;
  viewportHeight?: number;
  buildSha?: string;
  /** Self-declared QA hint, set only when the client was opened with
   *  `?qa=1` (see docs/MEASUREMENT.md). This is a HINT, not proof: a real
   *  player could set the parameter by accident, and a tester could
   *  forget it. Never treated as authoritative -- see stats-report.mjs's
   *  three-way grouping (all / not-marked-QA / marked-QA) and its note
   *  that unmarked QA traffic is still possible. */
  qa?: boolean;
  /** Coarse, bucketed `navigator.hardwareConcurrency` (logical CPU
   *  count), added 2026-09-14 to help tell "weak/thermal-throttled
   *  device" apart from "browser/network hitch" as an explanation for
   *  the phone-vs-QA frame-time gap (see docs/MEASUREMENT.md). Bucketed
   *  client-side to the nearest power-of-two ceiling in
   *  `packages/app/src/session-report.ts`'s `bucketHardwareConcurrency`
   *  (2, 4, 8, 16, 32, 64) -- this is already public API
   *  (`navigator.hardwareConcurrency`) and, alone or combined with the
   *  other bucket fields here, does not narrow down to an individual
   *  device. */
  hwConcurrencyBucket?: number;
  /** Coarse, bucketed `navigator.deviceMemory` in GB, same rationale as
   *  `hwConcurrencyBucket`. Absent on browsers that don't implement the
   *  Device Memory API (notably Safari) -- absence means "not
   *  available", never "zero memory". Bucketed to the spec's own
   *  reporting granularity (0.25, 0.5, 1, 2, 4, 6, 8, ...GB ceilings). */
  deviceMemoryBucket?: number;
  /** Coarse, bucketed `window.devicePixelRatio`, same rationale. A high
   *  DPR (3+) on a small viewport is itself a signal the device is
   *  asking the GPU to composite a lot more physical pixels than the
   *  logical viewport suggests -- useful context for a frame-time
   *  reading that otherwise looks the same as a low-DPR phone. */
  dprBucket?: number;
  /** Device pixel canvas backing-store size (2026-09-15, see
   *  docs/MEASUREMENT.md "Slow-frame attribution") -- the real
   *  `<canvas>.width`/`.height` the renderer draws into, i.e. CSS size
   *  times the resolution Pixi actually applied, not the CSS/viewport
   *  size already covered by `viewportWidth`/`viewportHeight` above. A
   *  phone can report a small CSS viewport but a large device-pixel
   *  canvas (high DPR), which is exactly the fill-rate cost
   *  `viewportWidth`/`viewportHeight` alone cannot show. Not bucketed --
   *  canvas pixel dimensions are already coarse (tied to common device
   *  screen sizes) and clamped hard by the sanitiser below, so a second
   *  bucketing pass would only lose precision for no privacy gain. */
  canvasWidthPx?: number;
  canvasHeightPx?: number;
  /** Coarse, bucketed `window.screen.width`/`.height` (physical screen
   *  size, not the browser viewport) -- lets a report tell a small-
   *  screen phone apart from a windowed desktop browser with a small
   *  viewport, which `viewportWidth`/`viewportHeight` cannot do alone.
   *  Bucketed the same "round up to the nearest public ceiling" way as
   *  the other capability fields via `bucketScreenDimension` in
   *  `packages/app/src/session-report.ts`. */
  screenWidthBucket?: number;
  screenHeightBucket?: number;
  /** Coarse browser *family*, not a version string and not the raw user
   *  agent -- derived client-side from `navigator.userAgent` down to one
   *  of a fixed, small set of values (see `detectUaFamily` in
   *  session-report.ts). Exists only to tell "a Safari-family mobile
   *  browser" from "a Chromium-family one" when correlating slow frames,
   *  since the two have meaningfully different GPU/compositor paths on
   *  phones. Never the full UA string -- that is deliberately never
   *  read into this profile at all. */
  uaFamily?: 'chrome' | 'firefox' | 'safari' | 'other';
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

/** Small, infrequent client -> server report used only for the engagement-
 *  telemetry work: how quickly (if ever) this seat's player gave a real
 *  control input after match start, how many ticks carried any input, and
 *  a rough client frame-time distribution. Sent periodically (every few
 *  seconds) and best-effort once more when the tab is hidden -- never on
 *  a hot path, never large, never required for the match to function.
 *  See docs/MEASUREMENT.md for exactly what this is and is not. */
export interface SessionReportMessage {
  t: 'sessionReport';
  /** Milliseconds from match start to this seat's first non-neutral
   *  local input, or null if none has happened yet. */
  firstInputMs: number | null;
  /** Count of simulation ticks in which this seat supplied any non-
   *  neutral input, cumulative for the match so far. */
  inputTicks: number;
  /** Median client frame time in ms over a recent rolling window. */
  frameMedianMs: number;
  /** 95th-percentile client frame time in ms over the same window. */
  frameP95Ms: number;
  /** Raw device pixel ratio observed at session start, rounded to two decimals. */
  devicePixelRatio?: number;
  /** Count of WebGL `webglcontextlost` events this seat's client has
   *  observed so far this match (2026-09-14; see wiki "Camera Framing"
   *  sibling page on renderer robustness). Almost always 0 -- a lost
   *  context is a normal but uncommon browser event (GPU switch, phone
   *  backgrounding the tab, driver reset). No new personal data: this is
   *  a plain count, same as inputTicks, carrying no IP/UA/id. Optional so
   *  an older client that predates this field still parses as a valid
   *  report. */
  contextLostCount?: number;
  /** True if the render watchdog fired for this seat's client this match
   *  (2026-09-14) -- the renderer never presented a single frame within
   *  the grace period after the match started, a failure mode a lost-
   *  context event alone cannot catch (dead/blocklisted GPU context,
   *  WebGL exhausted after a prior context died). A boolean, not a
   *  count: by construction it can only happen once per match. Same
   *  privacy contract as contextLostCount -- no new personal data.
   *  Optional for the same reason every other field here is. */
  renderStalled?: boolean;
  /** Cumulative count of rendered frames whose measured delta fell into
   *  each of six coarse buckets (ms): `[<20, 20-33, 33-50, 50-100,
   *  100-250, >250]`, in that fixed order -- see
   *  `FRAME_HISTOGRAM_BOUNDARIES_MS` below, which both the client
   *  (`packages/app/src/session-report.ts`) and this validator share so
   *  the boundaries can never drift out of sync between them. Added
   *  2026-09-14 alongside `frameMedianMs`/`frameP95Ms` specifically so a
   *  steady 71ms/14fps session can be told apart from an otherwise-smooth
   *  session with a few huge stalls -- the two look identical in a
   *  median/p95 pair but need different fixes. Frames rendered while the
   *  tab was hidden are excluded from this histogram (and from
   *  frameMedianMs/frameP95Ms) -- see `hiddenFrames`. Optional for the
   *  same backward-compatibility reason as every other field here;
   *  absent means "not tracked", never "all zero". */
  frameHistogram?: number[];
  /** Cumulative count of rendered frames observed while
   *  `document.visibilityState !== 'visible'` this match (tab
   *  backgrounded, phone screen off, app-switched away). These frames
   *  are deliberately excluded from `frameHistogram`/`frameMedianMs`/
   *  `frameP95Ms`: a backgrounded tab is throttled by the browser on
   *  purpose and its frame timing says nothing about the device's real
   *  rendering capability, so counting it there would misreport a
   *  player who alt-tabbed as a slow device. A session with a high
   *  `hiddenFrames` relative to its duration is itself a useful signal
   *  (this player was not actually watching), just a different one.
   *  Optional/absent means "not tracked". */
  hiddenFrames?: number;
  /** Cumulative count of gaps between consecutive received server
   *  snapshots that exceeded a fixed threshold well above the expected
   *  ~50ms interval at `SNAPSHOT_HZ` (see `NETWORK_HITCH_THRESHOLD_MS` in
   *  `packages/app/src/session-report.ts`) -- a network hitch, not a
   *  render hitch. Measured independently of `frameHistogram`
   *  specifically so a slow *network* can be told apart from a slow
   *  *renderer*: the same underlying "the game felt like 14fps" report
   *  can come from either, and only one of them is about the device.
   *  Optional/absent means "not tracked". */
  networkHitchCount?: number;
  /** Cumulative count of local simulation ticks this seat's client
   *  attributed to *observed keyboard usage* -- an InputManager slot
   *  poll that fell through to the keyboard source for that tick (see
   *  `InputSourceKind` in `packages/input/src/index.ts`). This is usage,
   *  not capability: unlike the `touchActive` field on the client
   *  profile (built from `isTouchCapable()`, a static device check),
   *  these three counters (keyboard/touch/gamepad) tell apart what a
   *  player actually drove the match with, which can differ wildly from
   *  what their hardware supports -- see docs/MEASUREMENT.md
   *  "Capability vs usage" for the touch-laptop case that motivated this.
   *  Optional/absent means "not tracked", never a fabricated zero. */
  keyboardInputTicks?: number;
  /** Same as `keyboardInputTicks` but for ticks attributed to the
   *  on-screen touch controls actually being held (`TouchSource.isActive()`
   *  true for that tick), not merely `navigator.maxTouchPoints > 0`.
   *  Optional/absent means "not tracked". */
  touchInputTicks?: number;
  /** Same as `keyboardInputTicks` but for ticks attributed to a
   *  connected gamepad actually producing the frame. Optional/absent
   *  means "not tracked". */
  gamepadInputTicks?: number;
  /** Cumulative count, this match so far, of *rendered* frames whose
   *  delta met or exceeded `SLOW_FRAME_THRESHOLD_MS` (2026-09-15, see
   *  docs/MEASUREMENT.md "Slow-frame attribution") -- deliberately a
   *  second, coarser threshold than `frameHistogram`'s buckets: this is
   *  the denominator every `slowFrame*` field below is conditioned on.
   *  Optional/absent means "not tracked" (older client), never a
   *  fabricated zero. */
  slowFrameCount?: number;
  /** For every frame counted in `slowFrameCount`, which of four fixed
   *  buckets (`[0-5, 6-10, 11-15, 16-20]` fighters) the count of *alive*
   *  fighters fell into at that moment, summed across the match so far
   *  -- lets a report ask "do slow frames cluster when the lobby is
   *  still full?" without shipping a per-frame sample. Always exactly 4
   *  entries when present. Optional/absent means "not tracked". */
  slowFrameFightersAliveBuckets?: number[];
  /** Same shape and bucket boundaries as
   *  `slowFrameFightersAliveBuckets`, but counting fighters the camera
   *  actually drew on screen rather than fighters still alive in the
   *  match -- these are expected to match almost always (the camera is
   *  built never to crop a live fighter out of frame), so a persistent
   *  gap between the two histograms is itself a signal that invariant
   *  has regressed, not just a frame-cost signal. Optional/absent means
   *  "not tracked". */
  slowFrameFightersOnScreenBuckets?: number[];
  /** Same shape, but bucketing the live particle/pop/trail-segment count
   *  the effects layer was holding (`[0-20, 21-60, 61-120, 121+]`) at
   *  the moment of a slow frame -- distinguishes "slow because the arena
   *  is crowded with fighters" from "slow because of an effects burst"
   *  (a simultaneous multi-hit pile-up), which a fighter count alone
   *  cannot tell apart. Optional/absent means "not tracked". */
  slowFrameEffectsLoadBuckets?: number[];
  /** Of the frames counted in `slowFrameCount`, how many happened within
   *  one second of a network hitch (see `networkHitchCount`) -- lets a
   *  report separate "the render pipeline itself is slow" from "the
   *  network stalled and dragged the next render down with it".
   *  Optional/absent means "not tracked". */
  slowFrameHitchCoincidentCount?: number;
  /** Of the frames counted in `slowFrameCount`, how many happened within
   *  one second of an elimination/match-transition effect being queued
   *  -- a plausible source of a momentary spike (several simultaneous
   *  elimination effects, a stage-shrink cut) that would otherwise look
   *  identical to a steady per-frame cost problem. Optional/absent means
   *  "not tracked". */
  slowFrameTransitionCoincidentCount?: number;
  /** Cumulative real ms of rendered-frame deltas this seat's client has
   *  observed with the tab visible (`document.visibilityState ===
   *  'visible'`) so far this match -- see `FrameTimeTracker.getVisibleMs`
   *  in `packages/app/src/session-report.ts` (2026-09-15, "actually
   *  playing" session-duration work, see wiki 'Private Stats and QA
   *  Traffic Tagging 2026-09-14'). This is the numerator for time spent
   *  actually looking at the game, as opposed to a tab left open in a
   *  background window: `hiddenFrames` above counts *frames*, which a
   *  throttled background tab makes a poor proxy for wall-clock time,
   *  since a single hidden rAF can carry a multi-second coalesced delta
   *  or never fire at all. Optional/absent means "not tracked" (older
   *  client), never a fabricated zero. */
  visibleMs?: number;
  /** Same as `visibleMs` but summed while the tab was hidden --
   *  companion figure, not a duplicate of `hiddenFrames`. A session
   *  whose `hiddenMs` is large relative to its total duration was a tab
   *  left open, not a player who stepped away for a few seconds mid-
   *  match. Optional/absent means "not tracked". */
  hiddenMs?: number;
}

/** Frame-delta threshold (ms) at which a rendered frame counts toward
 *  `SessionReportMessage.slowFrameCount` and its accompanying
 *  attribution buckets (2026-09-15, see docs/MEASUREMENT.md "Slow-frame
 *  attribution"). Deliberately a plain "worse than 30fps" cut, coarser
 *  than `FRAME_HISTOGRAM_BOUNDARIES_MS`'s finest buckets -- this is the
 *  denominator for a handful of *conditional* counters, so it is kept to
 *  one clearly-worse-than-smooth threshold rather than a second full
 *  histogram. Shared between the client (session-report.ts) and this
 *  validator so they can never drift apart. */
export const SLOW_FRAME_THRESHOLD_MS = 33;

/** Number of buckets in every `slowFrame*Buckets` array above -- fixed at
 *  4 for all three (fighters-alive, fighters-on-screen, effects-load),
 *  each with its own boundaries documented on the client-side bucketing
 *  helpers in `packages/app/src/session-report.ts`. */
export const SLOW_FRAME_BUCKET_COUNT = 4;

export type ClientControlMessage =
  | HelloMessage
  | SpectateMessage
  | PongMessage
  | StartNowMessage
  | SessionReportMessage;

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
/** Most control messages are tiny. `sessionReport` is not: it carries the
 * per-session telemetry fields and legitimately runs to a couple of KB, and
 * it grows every time we add a measurement. A single shared 512-byte cap
 * silently rejected every real session report (and the server then closed
 * the socket), so the cap is per-message-type. */
export const MAX_CONTROL_MESSAGE_BYTES = 512;
export const MAX_SESSION_REPORT_BYTES = 8192;

export function parseClientControl(text: string): ClientControlMessage | null {
  if (text.length > MAX_SESSION_REPORT_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.t !== 'sessionReport' && text.length > MAX_CONTROL_MESSAGE_BYTES) return null;
  switch (obj.t) {
    case 'hello': {
      if (typeof obj.protocolVersion !== 'number') return null;
      if (typeof obj.name !== 'string') return null;
      const resume = typeof obj.resume === 'string' && obj.resume.length > 0 ? obj.resume : undefined;
      const characterId =
        typeof obj.characterId === 'string' && obj.characterId.length > 0 ? obj.characterId : undefined;
      const profile = sanitiseClientProfile(obj.profile);
      // Dev-only stage pin (see HelloMessage.arena). Same sanitising
      // convention as the rest of this boundary: dropped entirely if
      // absent or unusable, never trusted beyond the length clamp --
      // registry validation happens server-side.
      const arena = clampCappedString(obj.arena, 64);
      return {
        t: 'hello',
        protocolVersion: obj.protocolVersion,
        name: sanitiseName(obj.name),
        ...(resume ? { resume } : {}),
        ...(characterId ? { characterId } : {}),
        ...(profile ? { profile } : {}),
        ...(arena ? { arena } : {}),
      };
    }
    case 'spectate':
      return { t: 'spectate' };
    case 'startNow':
      return { t: 'startNow' };
    case 'pong':
      if (typeof obj.id !== 'number') return null;
      return { t: 'pong', id: obj.id };
    case 'sessionReport':
      return sanitiseSessionReport(obj);
    default:
      return null;
  }
}

function clampFiniteNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(min, Math.min(max, value));
}

function clampCappedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.slice(0, maxLength);
}

/** Shared histogram bucket ceilings (ms) for `SessionReportMessage.
 *  frameHistogram` -- exported so the client
 *  (`packages/app/src/session-report.ts`) and `scripts/stats-report.mjs`
 *  bucket/read using the exact same six buckets this validator enforces
 *  the shape of: `[<20, 20-33, 33-50, 50-100, 100-250, >250]`. */
export const FRAME_HISTOGRAM_BOUNDARIES_MS = [20, 33, 50, 100, 250] as const;
export const FRAME_HISTOGRAM_BUCKET_COUNT = FRAME_HISTOGRAM_BOUNDARIES_MS.length + 1;

/** Validates a `frameHistogram` array: must be exactly
 *  FRAME_HISTOGRAM_BUCKET_COUNT finite, non-negative numbers. Any other
 *  shape (wrong length, wrong element type, negative) is dropped
 *  entirely -- a partially-wrong histogram is not a usable histogram, so
 *  there's no safe partial-clamp here unlike the scalar fields below. */
function sanitiseFrameHistogram(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length !== FRAME_HISTOGRAM_BUCKET_COUNT) return undefined;
  const out: number[] = [];
  for (const v of value) {
    // Reject a negative element outright rather than clamping it to 0:
    // a negative count is a malformed histogram, not a valid-but-small
    // one, and clamping it would silently hide the malformed input.
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined;
    out.push(Math.round(Math.min(v, 10_000_000)));
  }
  return out;
}

/** Validates a fixed-length array of finite, non-negative numbers of
 *  exactly `length` elements -- same all-or-nothing discipline as
 *  `sanitiseFrameHistogram`: a partially-wrong bucket array is not a
 *  usable one, so there is no safe partial-clamp, only accept-whole or
 *  drop-whole. Shared by every `slowFrame*Buckets` field. */
function sanitiseFixedNumberArray(value: unknown, length: number): number[] | undefined {
  if (!Array.isArray(value) || value.length !== length) return undefined;
  const out: number[] = [];
  for (const v of value) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined;
    out.push(Math.round(Math.min(v, 10_000_000)));
  }
  return out;
}

/** Validates and clamps HelloMessage.profile -- never trusts a client to
 *  have sent sane values, exactly like the rest of this boundary. Every
 *  field is optional and independently dropped if malformed rather than
 *  rejecting the whole `hello`: a garbled profile must never keep a
 *  player out of their match. Returns undefined for "nothing usable". */
function sanitiseClientProfile(value: unknown): ClientSessionProfile | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  const out: ClientSessionProfile = {};
  if (typeof input.touchActive === 'boolean') out.touchActive = input.touchActive;
  const width = clampFiniteNumber(input.viewportWidth, 0, 20000);
  if (width !== undefined) out.viewportWidth = Math.round(width);
  const height = clampFiniteNumber(input.viewportHeight, 0, 20000);
  if (height !== undefined) out.viewportHeight = Math.round(height);
  const buildSha = clampCappedString(input.buildSha, 64);
  if (buildSha) out.buildSha = buildSha;
  // Self-declared QA hint (?qa=1). A boolean, nothing more -- see
  // ClientSessionProfile.qa's doc comment for why this is never treated
  // as proof.
  if (typeof input.qa === 'boolean') out.qa = input.qa;
  // Coarse device-capability tags (2026-09-14, see docs/MEASUREMENT.md).
  // Each is an already-bucketed number from the client -- clamped again
  // here rather than trusted, same as every other numeric field in this
  // function. Wide ceilings: these buckets are coarse by construction,
  // so a generous clamp still cannot narrow down to an individual
  // device.
  const hwConcurrency = clampFiniteNumber(input.hwConcurrencyBucket, 1, 128);
  if (hwConcurrency !== undefined) out.hwConcurrencyBucket = Math.round(hwConcurrency);
  const deviceMemory = clampFiniteNumber(input.deviceMemoryBucket, 0.25, 128);
  if (deviceMemory !== undefined) out.deviceMemoryBucket = deviceMemory;
  const dpr = clampFiniteNumber(input.dprBucket, 0.5, 8);
  if (dpr !== undefined) out.dprBucket = dpr;
  // Canvas device-pixel size and screen/browser-family context
  // (2026-09-15, see docs/MEASUREMENT.md "Slow-frame attribution").
  // Same clamp-not-trust discipline as every field above.
  const canvasWidthPx = clampFiniteNumber(input.canvasWidthPx, 0, 20000);
  if (canvasWidthPx !== undefined) out.canvasWidthPx = Math.round(canvasWidthPx);
  const canvasHeightPx = clampFiniteNumber(input.canvasHeightPx, 0, 20000);
  if (canvasHeightPx !== undefined) out.canvasHeightPx = Math.round(canvasHeightPx);
  const screenWidthBucket = clampFiniteNumber(input.screenWidthBucket, 0, 20000);
  if (screenWidthBucket !== undefined) out.screenWidthBucket = Math.round(screenWidthBucket);
  const screenHeightBucket = clampFiniteNumber(input.screenHeightBucket, 0, 20000);
  if (screenHeightBucket !== undefined) out.screenHeightBucket = Math.round(screenHeightBucket);
  // Fixed enum, not a free string -- anything unrecognised (including a
  // client that mistakenly forwarded a real UA fragment) is dropped
  // rather than accepted, so this can never become a fingerprinting
  // channel via a hostile/buggy client.
  if (input.uaFamily === 'chrome' || input.uaFamily === 'firefox' || input.uaFamily === 'safari' || input.uaFamily === 'other') {
    out.uaFamily = input.uaFamily;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Validates and clamps a `sessionReport`. Any field that is the wrong
 *  type or out of range is clamped/dropped rather than rejecting the
 *  whole message -- a client that sends garbage here must never be able
 *  to break its own match, only to produce a less useful telemetry line.
 *  Returns null only when there is nothing usable at all (e.g. not an
 *  object, or every field malformed), which the caller treats as "ignore
 *  this frame" -- it never desyncs or blocks anything either way since
 *  sessionReport never touches match state. */
function sanitiseSessionReport(obj: Record<string, unknown>): SessionReportMessage | null {
  const firstInputMs = obj.firstInputMs === null ? null : clampFiniteNumber(obj.firstInputMs, 0, 600_000);
  const inputTicks = clampFiniteNumber(obj.inputTicks, 0, 10_000_000);
  const frameMedianMs = clampFiniteNumber(obj.frameMedianMs, 0, 5_000);
  const frameP95Ms = clampFiniteNumber(obj.frameP95Ms, 0, 5_000);
  const devicePixelRatio = clampFiniteNumber(obj.devicePixelRatio, 0.01, 100);
  const contextLostCount = clampFiniteNumber(obj.contextLostCount, 0, 10_000_000);
  const renderStalled = typeof obj.renderStalled === 'boolean' ? obj.renderStalled : undefined;
  const frameHistogram = sanitiseFrameHistogram(obj.frameHistogram);
  const hiddenFrames = clampFiniteNumber(obj.hiddenFrames, 0, 10_000_000);
  const networkHitchCount = clampFiniteNumber(obj.networkHitchCount, 0, 10_000_000);
  const keyboardInputTicks = clampFiniteNumber(obj.keyboardInputTicks, 0, 10_000_000);
  const touchInputTicks = clampFiniteNumber(obj.touchInputTicks, 0, 10_000_000);
  const gamepadInputTicks = clampFiniteNumber(obj.gamepadInputTicks, 0, 10_000_000);
  const slowFrameCount = clampFiniteNumber(obj.slowFrameCount, 0, 10_000_000);
  const slowFrameFightersAliveBuckets = sanitiseFixedNumberArray(obj.slowFrameFightersAliveBuckets, SLOW_FRAME_BUCKET_COUNT);
  const slowFrameFightersOnScreenBuckets = sanitiseFixedNumberArray(obj.slowFrameFightersOnScreenBuckets, SLOW_FRAME_BUCKET_COUNT);
  const slowFrameEffectsLoadBuckets = sanitiseFixedNumberArray(obj.slowFrameEffectsLoadBuckets, SLOW_FRAME_BUCKET_COUNT);
  const slowFrameHitchCoincidentCount = clampFiniteNumber(obj.slowFrameHitchCoincidentCount, 0, 10_000_000);
  const slowFrameTransitionCoincidentCount = clampFiniteNumber(obj.slowFrameTransitionCoincidentCount, 0, 10_000_000);
  // Capped at 6h in ms -- generous relative to MATCH_MAX_MATCH_TICKS,
  // clamped rather than trusted like every other numeric field here.
  const visibleMs = clampFiniteNumber(obj.visibleMs, 0, 21_600_000);
  const hiddenMs = clampFiniteNumber(obj.hiddenMs, 0, 21_600_000);
  if ([firstInputMs, inputTicks, frameMedianMs, frameP95Ms, devicePixelRatio, contextLostCount, renderStalled, frameHistogram, hiddenFrames, networkHitchCount, keyboardInputTicks, touchInputTicks, gamepadInputTicks, slowFrameCount, slowFrameFightersAliveBuckets, slowFrameFightersOnScreenBuckets, slowFrameEffectsLoadBuckets, slowFrameHitchCoincidentCount, slowFrameTransitionCoincidentCount, visibleMs, hiddenMs].every((v) => v === undefined)) return null;
  const out: SessionReportMessage = {
    t: 'sessionReport',
    firstInputMs: firstInputMs === undefined ? null : firstInputMs,
    inputTicks: inputTicks !== undefined ? Math.round(inputTicks) : 0,
    frameMedianMs: frameMedianMs ?? 0,
    frameP95Ms: frameP95Ms ?? 0,
  };
  if (devicePixelRatio !== undefined) out.devicePixelRatio = Math.round(devicePixelRatio * 100) / 100;
  if (contextLostCount !== undefined) out.contextLostCount = Math.round(contextLostCount);
  if (renderStalled !== undefined) out.renderStalled = renderStalled;
  if (frameHistogram !== undefined) out.frameHistogram = frameHistogram;
  if (hiddenFrames !== undefined) out.hiddenFrames = Math.round(hiddenFrames);
  if (networkHitchCount !== undefined) out.networkHitchCount = Math.round(networkHitchCount);
  if (keyboardInputTicks !== undefined) out.keyboardInputTicks = Math.round(keyboardInputTicks);
  if (touchInputTicks !== undefined) out.touchInputTicks = Math.round(touchInputTicks);
  if (gamepadInputTicks !== undefined) out.gamepadInputTicks = Math.round(gamepadInputTicks);
  if (slowFrameCount !== undefined) out.slowFrameCount = Math.round(slowFrameCount);
  if (slowFrameFightersAliveBuckets !== undefined) out.slowFrameFightersAliveBuckets = slowFrameFightersAliveBuckets;
  if (slowFrameFightersOnScreenBuckets !== undefined) out.slowFrameFightersOnScreenBuckets = slowFrameFightersOnScreenBuckets;
  if (slowFrameEffectsLoadBuckets !== undefined) out.slowFrameEffectsLoadBuckets = slowFrameEffectsLoadBuckets;
  if (slowFrameHitchCoincidentCount !== undefined) out.slowFrameHitchCoincidentCount = Math.round(slowFrameHitchCoincidentCount);
  if (slowFrameTransitionCoincidentCount !== undefined) out.slowFrameTransitionCoincidentCount = Math.round(slowFrameTransitionCoincidentCount);
  if (visibleMs !== undefined) out.visibleMs = Math.round(visibleMs);
  if (hiddenMs !== undefined) out.hiddenMs = Math.round(hiddenMs);
  return out;
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
