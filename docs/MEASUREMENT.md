# Match measurement: what the offline harness can and cannot tell you

## The problem (issue #31)

Every offline measurement harness we had before `scripts/human-analog-metrics.mjs`
(`full-sweep-metrics.mjs`, `bot-brawl-metrics.mjs`, `human-placement-metrics.mjs`,
etc.) runs matches with **zero human seats** — 20 bots, or 19 bots plus one
*passive or scripted* stand-in. Every production match has at least one real
human. That difference has repeatedly produced numbers that did not hold up:
most notoriously a 93% "timeout" rate (Task 28163) that never occurs live, and
elimination-cause splits that disagreed with production logs.

**Rule: production server logs are ground truth. Any offline harness result
that disagrees with them is wrong until proven otherwise, not the other way
around.** This doc exists so nobody has to re-litigate that when the next
harness produces a surprising number.

## The harness: `scripts/human-analog-metrics.mjs`

Runs many matches offline using `createMatchSim` (the one sanctioned Sim
builder — same items, hazard config, and arena resolution as production).
One seat (slot 0) is driven by a **human-analog controller**, distinct from
the tuned-for-competence `BotController`:

| parameter | default | meaning |
|---|---|---|
| `reactionTicks` | 10 (~166ms) | ticks between decisions; input is held between decisions instead of re-evaluated every tick |
| `aimJitter` | 0.35 | chance a decision picks a random direction instead of "toward nearest opponent" |
| `idleProb` | 0.10 | chance a decision window does nothing at all |
| `attackProb` | 0.12 | chance of throwing an attack in an active decision window |

**These numbers are not fit to any real human input data — there is none
available to fit to.** They are a deliberately-worse-than-BotController
approximation, chosen to be "clearly worse on every axis" rather than
calibrated to a measured population. Treat every absolute number this
harness prints as an approximation gated by that fact, and lean on the
comparison table below, not on the numbers alone, to judge whether the
approximation is even in the right neighborhood.

Run it with:
```
node --experimental-strip-types scripts/human-analog-metrics.mjs [trials] [difficulty] [ceilingTicks] [--reactionTicks=N] [--aimJitter=F] [--idleProb=F] [--attackProb=F]
```

It reports, per run and aggregated: match duration, the human-analog seat's
placement distribution, time-to-first-elimination (any fighter), the human
seat's own elimination time, the elimination-cause split (`fall` /
`knockout` / `ring` / `ring_lethal`, read directly off `Sim.eliminationEvents`
— the same truthful attribution production's own elimination log line
uses), and the percent-at-death distribution.

A ceiling note, inherited from `full-sweep-metrics.mjs`'s own warning: the
ceiling must clear `shrinkFullyClosedTick` (28800 ticks in
`DEFAULT_MATCH_SETTINGS`) plus the ~2-minute stalemate-override relax
window, or the harness will read almost every match as a false "timeout" —
an artifact of the harness's own ceiling, not the game. Verified directly:
at `ceilingTicks=28920` this harness saw ~100% timeouts; the default
`36000` resolves normally. If you lower the ceiling, expect the timeout
rate to become meaningless again.

## Harness vs. production, measured 2026-09-11

Production data: `ssh root@135.181.45.254 "journalctl -u bash-fighter --since
'-6h' --no-pager"`, 8 completed matches, 133 elimination events (percentAtDeath
is stored as fixed-point in the raw log — divide by 65536 — the numbers below
are already converted), 8 human-seat eliminations.

Harness data: `node --experimental-strip-types scripts/human-analog-metrics.mjs 8 easy` and
`... 8 hard` (production's bots run EASY — see wiki "Bot Difficulty
Correction" — HARD run for comparison), default parameters, `ceilingTicks=36000`.

| metric | production (8 matches) | harness EASY (8 trials) | harness HARD (8 trials) |
|---|---|---|---|
| match duration | 40.4–122.9s, median 84.4s | 503.6–533.2s, median 513.9s | 489.9–595.9s, median 535.5s |
| human seat eliminated at | 25.5–58.4s, median 50.5s | 493.7–528.3s, median 508.6s | 483.2–554.3s, median 512.1s |
| human seat placement | 5,5,6,8,13,13,13,15 (median 10.5 of 20) | median 6, mean 6.9 | median 7.5 |
| elimination cause split | knockout 72.2%, ring 18.0%, fall 9.8%, ring_lethal 0% | knockout 0%, ring 98%, fall 2%, ring_lethal 0% | knockout 0%, ring 96.7%, fall 3.3%, ring_lethal 0% |
| percent-at-death | min 3.0, median 106.4, max 205.4 | min 0, p25 0, median 10, p75 18, max 78.7 | min 0, median 7, p75 14.6, max 58.5 |

## Root cause found and fixed, 2026-09-11

**The gap was a harness defect, not a sim/bot-AI defect, and it is now fixed.**

Every offline harness that measured this gap -- `human-analog-metrics.mjs`
(above) and the pre-existing `full-sweep-metrics.mjs` -- built its `Sim`
by calling `createMatchSim(seed, N, {}, undefined, arenaId)` /
`new Sim(seed, N, undefined, ...)`, i.e. passing `undefined` for the
per-seat `characters` argument. `packages/sim/src/sim.ts` resolves a
missing `characters` argument to its own internal `DEFAULT_CHARACTER`
for every seat:

```
const DEFAULT_CHARACTER: CharacterData = {
  name: 'Unnamed', weight: fx.fromInt(100),
  hurtboxWidth: fx.fromFloat(1.6), hurtboxHeight: fx.fromFloat(3.2),
  moves: [],   // <-- no moves at all
};
```

`moves: []` is deliberate at the sim-core level -- it lets a unit test
that only cares about movement/physics build a `Sim` without pulling in
`packages/content`'s character data (see that constant's own comment:
"attack input is simply a no-op"). But every offline metrics harness
used it as if it were a neutral stand-in for "some fighter," including
`full-sweep-metrics.mjs`'s own comment claiming uniform
`DEFAULT_CHARACTER` "stays comparable with prior measurements." It is
not neutral: **every bot in every offline sweep was, and had always
been, physically incapable of landing a single attack**, at any
difficulty, on any arena, no matter how the AI's targeting/reaction/
attack-range tuning was adjusted in the many passes chasing this
("Bot Combat Engagement Fix," the ring-pressure redesign, the
hesitation dampener, etc. -- see the linked pages below). Production
never has this problem: `server/src/match.ts` always resolves real
character data per seat via `resolveCharacterId`, and
`server/src/rooms.ts`'s bot-fill timer gives every bot seat a real,
deterministically-drawn character from `ALL_CHARACTERS` (never the
sim-core stub).

**Proof.** Re-ran a pure 20-bot, no-human, `MATCH_BOT_DIFFICULTY=easy`
match through `createMatchSim` twice, identical in every way except the
`characters` argument:

| characters passed | duration | knockout | ring | fall |
|---|---|---|---|---|
| `undefined` (the old bug) | ~502-515s (2 seeds) | 0% | 100% | 0% |
| real roster, drawn the same way `server/src/rooms.ts` draws it | 60.7-97.3s (4 seeds) | 68-79% | 13-25% | 0-8% |

Same seed, same arena, same bot difficulty, same everything else --
flipping only the `characters` argument took the offline harness from
"bots can never fight" to numbers in the same neighborhood as
production. This is conclusive, not circumstantial: it is a single
before/after with everything else held constant, not a correlation.

**Hypotheses tested and killed before finding this:**
- *Bot difficulty mismatch* -- killed. `server/src/match-defaults.ts`
  and the live `/srv/bash-fighter/shared/bash-fighter.env` both confirm
  production runs EASY with no override; both harnesses already used
  EASY as their default and the bug reproduced at every difficulty in
  `full-sweep-metrics.mjs`'s own sweep.
- *Tick rate / input cadence mismatch* -- killed. `server/src/match.ts`'s
  `tickOnce()` calls `bot.nextInput(sim)` once per bot, once per
  `sim.advance()` call, at `TICK_HZ = 60`, exactly like both harnesses'
  `for (t=0; t<CEIL; t++) { ...; sim.advance(inputs) }` loops. Read side
  by side; no discrepancy.
- *Different arena distribution offline* -- killed. Both use
  `pickArenaId(seed)` / the real arena roster; a live production
  `matchSummary` line and an offline run land on the same arenas
  (`battle-royale-20`, `the-atoll`, etc.).
- *Deploy lag (server running older code than `main`)* -- killed.
  `/srv/bash-fighter/current` is a symlink to
  `releases/20260911222819-b1f9c62`, and `git rev-parse HEAD` on `main`
  in this checkout is also `b1f9c62`. Identical commit.
- *Presence of a human seat changing bot dynamics* -- killed as the
  primary driver, though it remains a secondary, smaller effect. Real
  production log evidence: matchId `m1` recurred verbatim (same seed,
  since `seedFromMatchId` is deterministic) across two separate server
  restarts on 2026-09-11. The **first** run (pid 933627) only has
  elimination log lines from tick 3566 onward (bots only, all
  `knockout`, attacker slots 4/7/10) -- the earlier ticks/eliminations
  from that run rotated out of the retained log window, so it is a
  partial trace, but every visible elimination in it is bot-vs-bot
  combat. The **second** run (pid 933814) is a complete trace: 22
  eliminations, `knockout` dominant (14/22), the sole human seat (slot
  0) eliminated by `ring` damage at 55.6s while `aliveAfter: 12`, i.e.
  well after 7 other fighters had already died to `knockout` -- bot-vs-
  bot combat was already well underway before and continued after the
  human's own elimination. A human seat that mostly stood still and
  died to ring pressure still saw a match resolve in 90.9s with 64%
  knockout-caused eliminations, entirely consistent with bots capable
  of really fighting each other, which is exactly what the character
  fix reproduces offline with no human seat at all.
- *Item/hazard spawning disabled offline* -- killed. Both harnesses call
  `createMatchSim`, which always wires in
  `BASH_FIGHTER_ITEM_SET`/`BASH_FIGHTER_HAZARD` -- the same call
  production makes. Nothing to disable.

## What changed

- `scripts/lib/bot-character-assignment.mjs` (new): `assignServerCharacters(seed, numFighters, humanSlots)`
  reproduces `server/src/rooms.ts`'s `startBotFillTimer` character draw
  exactly (same `seedRng`/`nextBounded`/`ALL_CHARACTERS` sequence, same
  `(matchSeed ^ (slot * 0x9e3779b9))` per-slot seed), and gives any
  `humanSlots` seat `PLACEHOLDER_CHARACTER` (`resolveCharacterId`'s own
  fallback for an unset human characterId).
- `scripts/human-analog-metrics.mjs`: builds `characters` via
  `assignServerCharacters` and passes them into `createMatchSim` instead
  of `undefined`.
- `scripts/full-sweep-metrics.mjs`: the main per-arena/difficulty sweep
  now does the same instead of the old uniform-`undefined` choice; the
  separately-existing rotated-roster per-character-survival section
  (further down in the same file) already passed real characters and is
  untouched.
- **Not touched**: `packages/sim/src/sim.ts`'s `DEFAULT_CHARACTER`
  itself, and every other caller of `new Sim(...)` that legitimately
  wants a moveless placeholder (pure physics/determinism unit tests
  that never trigger `advance()`'s attack path). This was a harness
  construction-argument bug, not a sim defect -- nothing about combat,
  knockback, hitstun, or bot AI itself needed to change, and no golden
  hash was touched.

## Before / after, 2026-09-11

Same production data as the table above (8 matches, 133 eliminations,
median 84.4s, knockout 72.2% / ring 18.0% / fall 9.8%).

`scripts/human-analog-metrics.mjs 20 easy` (20 trials, fixed):

| metric | before fix | after fix | production |
|---|---|---|---|
| match duration (median) | ~514s | 78.9s | 84.4s |
| elimination cause | knockout 0%, ring 98%, fall 2% | knockout 73.4%, ring 21.6%, fall 5.0% | knockout 72.2%, ring 18.0%, fall 9.8% |

`scripts/full-sweep-metrics.mjs 4 42000` (all 5 arenas x 3 difficulties,
4 seeds each, fixed): combat share now 57.9%-94.7% across every
combination (median ~85%), boundary 5.3%-42.1%, versus the old
~0-12% combat / ~88-100% boundary at every combination. `battle-royale-20`
EASY specifically (production's most common arena in this log window):
duration 91.8-109.7s (median 106.7s) vs production's 84.4s median on the
same arena family -- a ~1.25x residual gap, not the old ~6x gap.
Gates on this run: all 4 seeds resolved with exactly 1 survivor, 0
timeouts, 0 whole-lobby wipes, 0 double-KOs at every arena/difficulty
combination; novice (passive EASY human) survival unaffected -- 25/25
sampled seeds across all 5 arenas survived the full match, same as
before this change (this fix only touches which characters bots use,
not their AI logic, targeting, or the human-protection tuning).

**Residual gap, stated honestly:** offline EASY durations (median
78.9-111s depending on arena) still run somewhat longer than
production's 84.4s median. Plausible remaining contributors, not fully
isolated here: (1) the human-analog controller is an explicit,
documented guess about human aggression/positioning
(`reactionTicks`/`aimJitter`/`idleProb`/`attackProb`), not a fit to real
data, so a real player who plays more aggressively than the model
would resolve faster; (2) the small 4-8 seed samples above are not a
large-N distribution match; (3) production's own 8-match sample spans
40.4-122.9s, a wide spread that a handful of offline seeds landing at
the high end of that same range (e.g. `the-undercroft` EASY's 191-201s
outlier trials) would not obviously contradict, but was not swept at
higher N here to say for certain it's the same distribution rather than
a real remaining difference. This residual is roughly an order of
magnitude smaller than the gap this fix closes and does not change the
root-cause finding above.

## Closing the hole, 2026-09-11 follow-up

The fix above closed the bug in the two callers that had it, but did
nothing to stop a third script or test from making the same mistake:
`createMatchSim(seed, N, {}, undefined, arenaId)` compiled fine and
silently gave every seat the moveless stub again. Closed that off:

- `packages/content/src/match-sim.ts`'s `createMatchSim` now requires a
  `characters: readonly CharacterData[]` argument -- no `?`, no default --
  and throws a `RangeError` if its length doesn't match `numFighters`
  (matching the check `Sim` itself already does one level down).
- **Chose "make it mandatory" over "default it to a seeded ALL_CHARACTERS
  draw living in packages/content."** The alternative -- moving
  `scripts/lib/bot-character-assignment.mjs`'s mirror of
  `server/src/rooms.ts`'s bot-fill draw into packages/content and using it
  as `createMatchSim`'s default -- would have created a second
  implementation of "how bots get characters" that a real caller could
  still end up depending on instead of the server's actual logic, and that
  can drift from `server/src/rooms.ts` exactly the way the two mirrors in
  this file already partially did (the assignment says changes to
  `server/` should be avoided, so nothing here could make `rooms.ts`
  delegate to a shared function to guarantee they can't drift). Requiring
  the argument means there is still exactly one place that decides bot
  characters for a real match -- `server/src/rooms.ts` -- and
  `createMatchSim` cannot be called without its caller consciously
  supplying characters, sourced from wherever is correct for that caller
  (the server's own `resolveCharacterId` resolution, or, for scripts that
  want production-faithful offline numbers, the explicit, deliberately
  separate mirror in `scripts/lib/bot-character-assignment.mjs`). A caller
  that genuinely wants the moveless stub -- realistically only
  packages/sim's own physics-only unit tests -- still gets it by calling
  `Sim`'s constructor directly and omitting `characters` there, where that
  default is defined, commented, and package-internal; `createMatchSim`,
  the sanctioned cross-package builder, no longer accepts it implicitly.
- Checked every existing caller: none relied on `createMatchSim`'s old
  default. `server/src/match.ts`, `packages/app/src/match.ts`,
  `packages/app/src/net-match.ts`, and both already-fixed scripts all
  already passed real characters; `packages/app/test/local-crowd-bots.test.ts`
  and `packages/app/test/local-vs-server-sim-equivalence.test.ts` pass
  `undefined` for the *settings* argument (unaffected, still defaults to
  `{}`) and real characters for the *characters* argument, so neither
  needed a change. Nothing broke.
- Also fixed `scripts/full-sweep-metrics.mjs`'s separate "novice survival"
  section, which called `new Sim(seed, N)` directly (bypassing
  `createMatchSim` entirely, so the new mandatory-argument check didn't
  catch it) with the same moveless-bot bug: it was asking "does a passive
  human survive 20 bots" while those 20 bots could not physically attack
  the human. Now draws the same seeded roster as the rest of the file
  (human's own seat still gets `PLACEHOLDER_CHARACTER`, matching a human
  with no explicit character pick). Re-run with real bots: the novice
  survives 10-27s in 24/25 sampled seeds across all 5 arenas (one seed on
  `the-undercroft` survives the full match) -- markedly different from
  what the file's stale prior claim of "unaffected" would have implied,
  and a genuine, previously-invisible finding about how fast a passive
  new player currently dies to real combat. That is a game-balance
  question this follow-up did not chase further (out of scope: this pass
  is about the harness construction bug, not first-match difficulty,
  which already has its own history -- see the linked pages on that
  topic); flagging it honestly here rather than either fixing it
  unreviewed or burying it.
- New permanent regression test:
  `packages/content/test/match-sim.test.ts`. It builds a real 20-fighter
  match through `createMatchSim` with a real drawn roster and asserts
  every character used has a non-empty `moves` array (the property whose
  absence caused this entire multi-week-looking discrepancy); a second
  test asserts the length-mismatch `RangeError`; a third is a
  never-executed, `@ts-expect-error`-guarded call that fails
  `npm run typecheck` if `characters` is ever made optional again. This
  is the test that would have caught the original bug on day one -- it
  fails immediately and loudly the moment any real match, offline or
  production-shaped, is built with a fighter that cannot attack.

**Gates after this change:** `npm test` 526/526 (525 pre-existing + the 3
new cases in `match-sim.test.ts`, none regressed), `npm run test:server`
18/18, `npm run lint` clean, `npm run typecheck` clean (only the
pre-existing `packages/app/src/net-match.ts` /
`packages/app/test/timed-brawl.test.ts` errors from a sibling agent's
in-progress work, unrelated to and unaffected by this change). No golden
hash changed -- this touched only `createMatchSim`'s TypeScript signature
and two scripts' call sites, never `Sim`'s behavior.

## What this harness cannot measure at all

- Real human aim, reaction time, or decision-making — the human-analog
  controller is a documented guess, not a model of real players.
- Anything about client-side rendering, input latency, or network jitter —
  this is a pure server-side Sim harness.
- Multi-human-seat dynamics (production matches sometimes have 2+ human
  seats; see e.g. matchId "m4" above with humanSeats=2) — this harness only
  ever runs one human-analog seat.

## Engagement telemetry: why a real player leaves in the first 10-30s

Added 2026-09-13. This section is about live production, not the offline
harness above -- a different problem: of 8 recent real matches, 6 ended
with the human closing the tab within 8-33 seconds *while still alive and
never eliminated*. Before this, the server could not tell apart four very
different explanations, each implying a different fix:

1. the player joined, never pressed anything, and left (a controls/
   first-impression failure);
2. the player played actively and left anyway (a fun/pacing failure);
3. the player was on a phone and touch controls did not work for them;
4. the game ran badly for them (low frame rate) and they gave up.

### What is collected, and why it's safe to be public about it

This is match-scoped telemetry only, in the same spirit as the existing
player-feedback endpoint (`server/src/feedback.ts`, see [[Player Feedback
Channel 2026-09-13]]): **no IP address, no user agent, no request headers,
no persistent identifier, no fingerprinting.** Every field below either
comes from the match itself (things the server already knows: which
match, which arena, how it ended) or is a small, coarse client snapshot
that cannot identify a person and is discarded once the connection closes
-- nothing here is stored per-player across sessions, and there is no
player-account system to attach it to even if we wanted to.

**On `hello` (`packages/net/src/protocol.ts`, `HelloMessage.profile`):**
a client sends `touchActive` (is a touch input source active),
`viewportWidth`/`viewportHeight` (CSS pixels, clamped 0-20000), and
`buildSha` (which build was served, capped at 64 chars). See
`docs/PROTOCOL.md`'s `hello.profile` section for the exact wire shape.

**Periodically during the match (`sessionReport`, every ~5s and once
more, best-effort, when the tab is hidden):** `firstInputMs` (ms from
match start to this seat's first non-neutral local input, or `null` if
there has been none), `inputTicks` (a running count of ticks that
carried any input), and `frameMedianMs`/`frameP95Ms` (a rolling client
frame-time distribution, so a session running at 15fps is visible). This
is deliberately tiny and infrequent -- it does not meaningfully add to
bandwidth, which protocol v3 already delta-compresses (see [[Bandwidth
Reduction Pass 2026-09-11]]).

**On session end, one `[sessionEnd]` line in the production log
(`server/src/session-telemetry.ts`, called from the WebSocket `close`
handler in `server/src/index.ts`):** joins the above with what the
server already knew about the match. Exact shape (also see
`server/test/session-telemetry.test.ts`):

```json
{
  "ts": "2026-09-13T21:00:00.000Z",
  "matchId": "m123",
  "arenaId": "battle-royale-20",
  "winCondition": "battleRoyale",
  "eliminated": false,
  "endReason": "disconnected",
  "sessionDurationSec": 21.4,
  "touchActive": true,
  "viewportWidth": 390,
  "viewportHeight": 844,
  "buildSha": "98ebe1a",
  "firstInputMs": null,
  "inputTicks": 0,
  "frameMedianMs": 16.7,
  "frameP95Ms": 34.2
}
```

`endReason` is `"eliminated"` (the seat was actually knocked out --
already-understood territory, see [[Match-End Client Bugs and Session Wrap
2026-09-09]]), `"matchEnded"` (the match resolved with this seat's
player still connected and alive), or `"disconnected"` -- the case this
was built for: the connection closed while the match was still live and
this seat had not been eliminated. `sessionDurationSec` is measured from
when the seat was created (`Seat.joinedAt` in `server/src/match.ts`),
not from the socket's own connect time, so it survives a reconnect. A
missing profile or report (older client, or one that never got around to
sending a report before closing) simply logs as `null`, never throws and
never blocks seat cleanup.

Reading `firstInputMs: null, inputTicks: 0` alongside `endReason:
"disconnected"` is case 1 above (never touched the controls). The same
with `touchActive: true` and a small viewport strongly suggests case 3.
A high `frameMedianMs`/`frameP95Ms` (say, consistently above ~33ms, i.e.
under 30fps) suggests case 4. `inputTicks` clearly above zero with a
short `sessionDurationSec` and `endReason: "disconnected"` is case 2 --
they played and left anyway, which is the only one of the four that is a
fun/pacing problem rather than an onboarding/technical one.

### How to read it

`scripts/session-metrics.mjs` parses `[sessionEnd]` lines from a log file
(stdin or a path argument) and prints a summary table: count, endReason
breakdown, median/p25/p75 session duration, how many never pressed a key,
how many were on touch, and the frame-time distribution. Typical use
against the production log:

```
ssh root@135.181.45.254 "journalctl -u bash-fighter --no-pager" | node scripts/session-metrics.mjs
```

or against a saved file:

```
node scripts/session-metrics.mjs /path/to/bash-fighter.log
```

### Hard guarantees

- **Never affects the simulation.** Nothing here is read by `tick()`'s
  sim advance, never enters `inputs[]`, never touches `Sim.advance`,
  never appears in a determinism hash. It is pure presentation/reporting,
  wired in `packages/app/src/net-match.ts`'s `render()`/`tick()` glue and
  `server/src/session-telemetry.ts`'s read-only join.
- **Never breaks on bad input.** Every field is validated and clamped in
  `packages/net/src/protocol.ts` (`sanitiseClientProfile`,
  `sanitiseSessionReport`) using the same conventions as
  `server/src/feedback.ts`: wrong types are dropped field-by-field rather
  than rejecting the whole message where that's safe (`hello.profile`),
  and an unparseable `sessionReport` is rejected outright like any other
  malformed control message -- the existing `bad_message` path, not a
  new failure mode. A client that sends nothing at all for either simply
  produces a `[sessionEnd]` line with `null`s in those fields.
- **No PII, ever.** No IP, no user agent, no header, no cookie, no
  account/session id that outlives one connection. If you are a
  contributor auditing this before relying on it: `grep -rn
  "req.headers\|remoteAddress\|user-agent" server/src/session-telemetry.ts
  packages/net/src/protocol.ts` should come back empty, and it does.

### What this still cannot tell us

- **Why**, in the sense of player intent or opinion -- "played and left
  anyway" (case 2) is a real signal but not a reason; it cannot
  distinguish "got bored", "got hit by something that felt unfair", and
  "was just testing the link and never meant to stay" from each other.
  The in-game feedback panel ([[Player Feedback Channel 2026-09-13]]) is
  the closer tool for that, and is opt-in/free-text, so it will always be
  sparser.
- **Anything about the seconds before `hello`** -- page load time, asset
  fetch time, or a player who loaded the page and left before ever
  reaching the lobby. This telemetry only exists once a WebSocket
  connection and a seat exist.
- **A precise frame-rate reading for a session that closes before its
  first periodic report goes out** (under ~5s of play). `render()` still
  feeds the tracker every frame, and `stop()`/tab-hidden send a
  best-effort final report, but a hard-crash tab close faster than that
  can still leave `frameMedianMs`/`frameP95Ms` at `0` (no samples) even
  though the player clearly saw some frames.
- **Cross-session patterns for one real person** -- by design, nothing
  here persists a per-player identity, so "the same player tried three
  times and left each time" is not something this can see, on purpose.

See also: [[20-Player Production-Hardware Measurements 2026-09-08]],
[[Bot Combat Engagement Fix 2026-09-09]], [[Match Duration Contradiction: The Spire Firing Squad 2026-09-09]],
[[Player Feedback Channel 2026-09-13]], [[Bandwidth Reduction Pass 2026-09-11]].

## Durable private stats store and report script, 2026-09-14

Added so the owner can ask "have we had any real activity?" without
grepping raw logs by hand, and so a service restart or a deploy does not
lose the answer. **There is no web page and no HTTP endpoint for this --
by explicit owner decision, bashfighter.com exposes nothing new at all.**
The only way to read these numbers is to run a script over SSH on the
production box and paste its stdout.

### The store: `server/src/stats-store.ts`

One append-only JSONL file, same convention as `feedback.ts`
(`FEEDBACK_LOG_PATH`) and `session-telemetry.ts`: path from
`STATS_LOG_PATH`, defaulting to `/srv/bash-fighter/shared/stats.jsonl`.
It lives in `/srv/bash-fighter/shared`, not inside a release directory,
specifically because releases are swapped via a `current` symlink --
anything written inside a release directory would vanish on the next
deploy. Two record shapes, one per line, distinguished by `type`:

```json
{"type":"matchEnd","ts":"2026-09-14T07:00:00.000Z","matchId":"m1","arenaId":"battle-royale-20","winCondition":"battleRoyale","endReason":"resolved","durationSec":92.3,"totalSeats":3,"humanSeats":1,"totalKOs":2,"maxKoCount":1}
{"type":"sessionEnd","ts":"2026-09-14T07:00:05.000Z","matchId":"m1","winCondition":"battleRoyale","eliminated":false,"endReason":"disconnected","sessionDurationSec":21.4,"touchActive":false,"firstInputMs":620,"inputTicks":340,"frameMedianMs":15.9,"frameP95Ms":19.4}
```

`matchEnd` is written from `Match`'s `onMatchSummary` event -- the same
data as the existing `[matchSummary]` console line, just also persisted.
`sessionEnd` is written from the same `close`-handler call site as the
existing `[sessionEnd]` console line, for human seats only. Both writes
are wrapped so a filesystem problem can never crash the match server or
drop a live connection: on any error, `appendStatsLine` logs a fallback
line to stdout instead of throwing (see `server/test/stats-store.test.ts`
for the forced-failure test against an unwritable path). The store never
truncates or rewrites -- restarting the service and creating a fresh
`createStatsRecorder()` only appends, so history survives every restart
and every deploy.

### The report: `scripts/stats-report.mjs`

Run manually, over SSH, whenever the owner wants numbers:

```
ssh root@135.181.45.254 "node /srv/bash-fighter/current/scripts/stats-report.mjs"
```

Flags: `--store <path>` (defaults to `STATS_LOG_PATH` env or the shared
default above), `--feedback-log <path>` (defaults to `FEEDBACK_LOG_PATH`
env or the shared default, counts lines only -- feedback *text* is never
read or printed by this script), `--since <ISO date>` to filter to
records at or after a timestamp, `--json` for machine-readable output,
and `--extra-log <path>` to additionally fold in an older journalctl
export (raw `[sessionEnd]`/`matchSummary` lines, same format
`scripts/session-metrics.mjs` reads) so history from before this store
existed isn't lost -- anything it contributes is reported separately
under "extra-log/historical", never silently merged into the durable
counters.

It reports: total matches and matches per mode (Last Fighter Standing /
Timed Brawl / Stocks) with average duration each; total human seat
sessions; how many survived past a 15-second "opening seconds" threshold
(chosen, not measured -- documented in the script); how many pressed a
control at all; eliminated vs. left-while-alive; session duration
distribution (min/median/p95/max); touch vs. keyboard share; client
frame-time distribution; and feedback submission count (count only).

### Privacy stance, restated plainly for this store

- **No HTTP surface reads any of this.** `/stats` and `/api/stats` were
  considered and explicitly rejected by the owner on 2026-09-14 -- see
  the task history -- specifically so nobody outside the project can see
  activity numbers while the game is in early growth. `server/src/`
  gained no new route, no new listener, and no new externally reachable
  code path for this feature; only `stats-store.ts` (new), `match.ts`
  (one new optional event) and `index.ts` (wiring) changed.
- **No unique-visitor number, ever.** We do not collect IPs, user agents,
  cookies, or device fingerprints, and this store does not start now --
  every count here is a *session* count. A returning player and a new
  player are indistinguishable by design, so `stats-report.mjs` never
  prints anything claiming otherwise.
- **Zero prints as zero.** No filler, no rounding up, no placeholder
  numbers -- if nothing happened, the report says `0`.
- **Not retrospective.** The report states the timestamp of the first
  record in the store; anything before that only shows up if you pass
  `--extra-log` with an older export, and even then it's labelled
  separately.
- **Our own QA traffic is not separated from real players' traffic** --
  there is no flag distinguishing them, and the report says so plainly
  rather than guessing.

See also: [[Player Feedback Channel 2026-09-13]], [[Production Traffic Reality Check 2026-09-13]].

