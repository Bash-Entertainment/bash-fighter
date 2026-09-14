# Bash Fighter wire protocol

Source of truth: `packages/net/src/protocol.ts`. This document describes the
same thing in prose; if the two disagree, the code wins and this file is
out of date.

One WebSocket connection at `ws(s)://<host>/socket` per client. Two kinds of
frames flow over it:

- **Control** — JSON text frames. Infrequent (hello, lobby updates, match
  start/end, elimination, errors, ping/pong). Human-readable on purpose:
  contributors can watch these in a browser's network tab.
- **Binary** — dense frames for the hot path: client input (60Hz) and
  server snapshots (`SNAPSHOT_HZ`, currently 20Hz). Every byte here is
  multiplied by tick rate and player count, so these are packed.

## Version handshake

The very first message a client sends must be `hello` with its
`protocolVersion`. If it does not match the server's `PROTOCOL_VERSION`,
the server replies with `error` (`code: "protocol_mismatch"`) and closes
the connection. This is deliberate: silently letting a mismatched client
continue is the worst failure mode for a deterministic sim, since it looks
fine for a while and then two clients disagree about reality with no error
anywhere. Any other message before `hello`, or a malformed message, gets
`error` (`code: "bad_message"`) and a close.

## Control messages, client -> server

| `t` | Fields | Meaning |
|---|---|---|
| `hello` | `protocolVersion`, `name`, `profile`? | First message. Server assigns a match/slot and replies `welcome`. `profile` is an optional, small, non-identifying client snapshot (see below) used only for engagement telemetry -- see `docs/MEASUREMENT.md`. |
| `spectate` | — | Client wants to only watch, not play (used after being assigned, or after elimination to keep watching without reconciliation). |
| `pong` | `id` | Echo of a server `ping`, for RTT measurement. |
| `startNow` | — | Sent by a client holding a seat in a still-filling lobby (the waiting screen's "Start now" button): fills the rest of that lobby with bots and starts immediately, instead of waiting out the countdown/bot-fill grace period. The server only honours this from a connection that actually holds a seat in that exact match (never a spectator, never a stranger); once the match has left the lobby phase, further `startNow` messages for it are a silent no-op, so a client may resend freely (e.g. a double click). |
| `sessionReport` | `firstInputMs`, `inputTicks`, `frameMedianMs`, `frameP95Ms` | Engagement telemetry only, added 2026-09-13 -- see `docs/MEASUREMENT.md`. Sent periodically (every ~5s) and once more, best-effort, when the tab is hidden. Never required for the match to function; a client that never sends one simply produces a less complete `[sessionEnd]` server log line. `firstInputMs` is milliseconds from match start to this seat's first non-neutral local input, or `null` if none yet. `inputTicks` is the cumulative count of ticks with any input. `frameMedianMs`/`frameP95Ms` are a rolling client frame-time distribution in ms. All fields are validated and clamped server-side (see `packages/net/src/protocol.ts`); a malformed payload is simply rejected like any other bad control message, never trusted partially. |

### `hello.profile`

An optional, small, non-identifying snapshot of the client's environment,
added 2026-09-13 for engagement telemetry (see `docs/MEASUREMENT.md` for
the full privacy statement -- short version: no IP, no user agent, no
persistent id, nothing that survives past this one connection):

| Field | Type | Meaning |
|---|---|---|
| `touchActive` | boolean | Whether a touch input source is active in this client. |
| `viewportWidth` / `viewportHeight` | number | The viewport size in CSS pixels, clamped to `[0, 20000]`. |
| `buildSha` | string | The build sha the client was served, capped at 64 characters. |

Every field is optional and independently dropped if malformed rather than
rejecting the whole `hello` -- a garbled profile must never keep a player
out of their match.

## Control messages, server -> client

| `t` | Fields | Meaning |
|---|---|---|
| `welcome` | `protocolVersion`, `clientId`, `slot`, `matchId` | Reply to `hello`. `slot` is `-1` for a pure spectator. |
| `lobby` | `players`, `capacity`, `minimum`, `countdownTicks`, `names` | Sent while a match is filling. `countdownTicks` is ticks (60/s) until the match starts anyway, or `-1` if no start deadline is known yet. As of 2026-09-13 this covers *both* reasons a lobby ever ends on its own: the post-minimum countdown once enough humans have joined, and the bot-fill grace period a lone player sits in before bots pad out the rest of the lobby -- whichever is sooner. It is computed server-side from a wall-clock deadline on every send, so it stays accurate across broadcast gaps; clients may tick it down locally between messages for a smooth display, but must treat `-1` as an honest "no deadline yet" state, never invent a countdown the server hasn't committed to. |
| `matchStart` | `matchId`, `seed`, `numFighters`, `slot`, `settings`, `arenaId`, `names` | The match has started. Every client builds an identical `Sim` from `seed` + `numFighters` + `arenaId`. |
| `eliminated` | `slot`, `placement`, `tick` | A fighter was eliminated. `placement` is `1` for the eventual winner (announced at match end), `N` for the first fighter out. |
| `matchEnd` | `winner`, `leaderboard`, `tick` | Final result. `winner` is `null` only for a genuine simultaneous final KO. |
| `error` | `code`, `message` | `protocol_mismatch`, `bad_message`, `match_full`, or `server_error`. Connection is closed after this is sent. |

## Player names

`hello.name` is the client's requested display name (typed on the start
screen and persisted client-side in localStorage; empty if the player
never typed one -- see [[Player Names 2026-09-11]] for the full feature
writeup). It is presentation and networking metadata only: never part of
the sim snapshot, never fed into anything determinism-hashed, and never
trusted as given.

The server sanitises every name at the `hello` boundary (`sanitiseName` in
`packages/net/src/protocol.ts`) before it is stored on the seat or
broadcast to anyone:

- Control characters (C0/C1) and newlines are stripped -- they would
  break single-line layouts, HUD cards, and log/journal lines.
- Interior whitespace runs are collapsed and the result trimmed, so a
  name can't be an invisible run of spaces or tabs.
- Truncated to `MAX_NAME_LENGTH` (16 characters).
- Empty/whitespace-only/all-control input sanitises to `''`, not a
  forced placeholder like `"Fighter"`. `''` is a first-class value
  meaning "this seat has no chosen name"; every display of it (HUD,
  in-world badge, win screen, placement/elimination text) falls back to
  the slot label (`#N`, 1-based) instead. This keeps anonymous players
  distinct from each other for free, which a forced shared placeholder
  would not.

Names are never HTML-escaped, because they are never inserted as markup
anywhere: the DOM-based UI (HUD, overlays, win screen) writes them via
`textContent` only, and the PIXI-based world renderer writes them as
`Text` glyphs. There is no code path where a name string is interpreted
as HTML/JS in this codebase, so sanitisation here is about layout/log
safety, not escaping.

Names are also de-duplicated per match (`dedupeName`, same file): a new
seat whose sanitised name case-insensitively collides with an existing
seat's name (human or bot) gets `" (2)"`, `" (3)"`, etc. appended, capped
back to `MAX_NAME_LENGTH`. Two fighters called "Rook" would otherwise be
indistinguishable in the HUD, the win screen, and the elimination log.
Empty names are exempt from de-duplication -- they carry no identity to
collide on.

No wire-format field changed for this feature (the `name`/`names` fields
already existed in the `hello`/`lobby`/`matchStart` schema since the
initial protocol), so `PROTOCOL_VERSION` was **not** bumped for it. Only
sanitisation/de-duplication behaviour and client-side UI changed.
| `ping` | `id` | RTT probe; client should reply `pong` with the same `id`. |

## Binary: input (client -> server), 15 bytes

`tag(1)=1 | tick(u32 LE) | buttons(u16 LE) | stickX(i32 LE, Q16.16) | stickY(i32 LE, Q16.16)`

Sent once per local input change (or at least once per local tick) at up to
60Hz. `tick` is the tick the client intends this input to apply from; the
server uses it only to track the most recently-seen input tick per client
(`ackedInputTick` in snapshots) so the client knows which locally-predicted
inputs it can drop. The server never blocks the tick loop waiting for an
input — a fighter with no input for the current tick simply keeps its last
known input, and a disconnected fighter's input decays to neutral.

Any frame that isn't exactly 15 bytes, or whose first byte isn't `1`, is
silently dropped — never trusted, never allowed to reach the sim or crash
the tick loop.

#### Worked example: encoding one input frame

A player at tick 4720 holds jump and attack together, stick pushed full
right, stick Y neutral. `JUMP` is bit 0 and `ATTACK` is bit 1
(`BUTTON_JUMP | BUTTON_ATTACK` = `0x0003`), the stick axes are Q16.16
signed fixed point so full right (+1.0) encodes as 65536 (`0x00010000`),
and every multi-byte field is little-endian. `encodeInput` produces:

```
01 70 12 00 00 03 00 00 00 01 00 00 00 00 00
```

| Offset | Bytes | Field | Value |
|---|---|---|---|
| 0 | `01` | `tag` | `INPUT` |
| 1 | `70 12 00 00` | `tick` | 4720 (`0x00001270` LE) |
| 5 | `03 00` | `buttons` | `0x0003` = `BUTTON_JUMP \| BUTTON_ATTACK` |
| 7 | `00 00 01 00` | `stickX` | 65536 = +1.0 (full right), Q16.16 LE |
| 11 | `00 00 00 00` | `stickY` | 0 (neutral) |

Reading it back with `decodeInput` yields
`{ tick: 4720, buttons: 3, stickX: 65536, stickY: 0 }`. A debugging trick
that falls out of this layout: byte 0 is always the tag, so a hex dump of
any binary frame starts with `01` (input), `02` (full snapshot), or `03`
(delta), and an input frame is always exactly 15 bytes.

## Binary: snapshot (server -> client), two shapes

Sent to every connected client (players and spectators) at `SNAPSHOT_HZ`
(20/sec), each with its own `ackedInputTick`. As of protocol version 3
(2026-09-11, see wiki "Bandwidth Reduction Pass 2026-09-11") this is
**delta-compressed**: a full keyframe only periodically, deltas the rest of
the time. Which shape a given frame is is the first byte (`tag`).

### Full keyframe (`tag=2`, `SNAPSHOT`)

Header (9 bytes): `tag(1)=2 | tick(u32 LE) | ackedInputTick(u32 LE)`, then
the full serialized sim `StateBuffer` as consecutive `i32` LE words (see
`Sim.saveState`/`loadState` in `packages/sim`). Sent:

- as the very first snapshot on any connection (fresh join, resumed
  reconnect — a connection can never be sent a delta against a baseline it
  could not possibly have), and
- at least once every `KEYFRAME_INTERVAL_SNAPSHOTS` (20, i.e. once/sec at
  20Hz) regardless, as a resync safety net.

### Delta (`tag=3`, `SNAPSHOT_DELTA`)

Header (15 bytes): `tag(1)=3 | tick(u32 LE) | ackedInputTick(u32 LE) |
baseTick(u32 LE) | changedCount(u16 LE)`, then `changedCount` entries of
`index(u16 LE) | value(i32 LE)` (6 bytes each) — the sparse set of
`StateBuffer` words that changed since `baseTick`.

`baseTick` names the specific full keyframe this delta is relative to for
*this connection*. A delta is always relative to the last keyframe sent on
this same connection, never to another delta, so reconstruction is always
one step (copy the keyframe, apply the changed words) — never a chain a
single dropped frame could break silently.

### Client decoding: `SnapshotStreamDecoder`

Both server encoding (`SnapshotStreamEncoder`) and client decoding
(`SnapshotStreamDecoder`) live in `packages/net/src/protocol.ts` — these are
the only supported way to produce/consume this stream; nothing else should
hand-roll delta application. `SnapshotStreamDecoder.decode(bytes)` returns a
reconstructed full `WireSnapshot` exactly like `decodeSnapshot` used to
return directly, so callers elsewhere in the client are unchanged. If a
delta's `baseTick` doesn't match the decoder's current baseline (a dropped
frame, or a stale decoder after some other frame was applied), `decode`
returns `null` for that frame — the caller simply skips that tick's update,
never guesses, and self-heals cleanly at the next full keyframe (at most
`KEYFRAME_INTERVAL_SNAPSHOTS` away).

## Client responsibilities

- Predict only its own fighter locally between snapshots, by replaying its
  own buffered inputs since `ackedInputTick` against a `Sim` seeded
  identically to the server's.
- On each snapshot, `loadState` into its local sim, then re-apply any
  locally buffered inputs newer than `ackedInputTick` to get back to
  "now" — standard client-side prediction + reconciliation, not rollback
  netcode (no other client's inputs are predicted).
- Interpolate remote fighters between snapshots rather than snapping, since
  those arrive at 20Hz but render at up to 60fps+.
- Treat `eliminated` for its own slot as "stop sending input, may
  `spectate`", but keep the connection open and keep applying snapshots.
