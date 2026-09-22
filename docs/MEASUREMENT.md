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
`viewportWidth`/`viewportHeight` (CSS pixels, clamped 0-20000),
`buildSha` (which build was served, capped at 64 chars), and, only when
set, `qa` (a boolean, nothing more). See `docs/PROTOCOL.md`'s
`hello.profile` section for the exact wire shape.

**Debug URL parameters (client-side, `packages/app/src/main.ts` and
friends), added here so they live in one place:** `?crowd20=1` fills
local play with 20 characters for solo layout testing (see
[[Local Crowd Testing Tool 2026-09-11]]); `?forceTouch=1`
(`packages/input/src/touch.ts`) forces touch-control detection on for
testing touch UI without a touch device; `?bashTest=1`
(`packages/app/src/main.ts`) exposes `window.__bashTestMatch` /
`__bashTestTouch` / `__bashTestAudio` test hooks; `?minFighterPx=<n>`
(`packages/app/src/main.ts` -> `setDevMinFighterPx`) raises the camera's
min-fighter-size legibility floor from its normal 26px, which is the only
way to watch the follow path in a real browser -- the floor otherwise only
engages on viewports narrower or shorter than the test tooling can drive;
and `?qa=1`
(`packages/app/src/main.ts`'s `isQaSession`) sets `hello.profile.qa =
true` for this session -- this is the only one of the five that gets
recorded in the private stats. None of the five are secret and none
are enforced server-side beyond `qa` being validated as a plain
boolean like any other profile field; they are conveniences for testers
and contributors, not access control.

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
  "frameP95Ms": 34.2,
  "hwConcurrencyBucket": 8,
  "deviceMemoryBucket": 4,
  "dprBucket": 3,
  "frameHistogram": [1200, 340, 60, 30, 8, 2],
  "hiddenFrames": 0,
  "networkHitchCount": 1
}
```

(the six new fields are described just below, in "Distinguishing a slow
device from a slow network from a backgrounded tab, 2026-09-14")

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

### Capability vs usage: `touchActive` is not "played on touch" (2026-09-14)

**Read this before quoting any touch/keyboard percentage from this
system.** `touchActive` (in `hello.profile`) is built from
`isTouchCapable()` in `packages/input/src/touch.ts`, which is
`navigator.maxTouchPoints > 0` -- a static fact about the *hardware*,
checked once at page load. It says nothing about which controls a
player actually put their hands on. Any touchscreen Windows laptop, any
touch-capable all-in-one desktop, and Chrome DevTools' device-emulation
mode all report `touchActive: true` even when driven entirely by a
keyboard. This is exactly what happened with our one piece of genuine
outside feedback (see [[First Real Player Feedback 2026-09-14]]): the
player wrote "(played on PC)" and a 1600x900 viewport, and their session
was recorded as `touchActive: true` -- and an earlier internal report
used that kind of record to conclude "phones are our primary platform"
(see the correction on [[Real Player Measurements 2026-09-14: Phones Are
the Primary Platform]]).

To fix that we added **observed usage**, counted client-side per local
simulation tick by which real `InputManager` source
(`packages/input/src/index.ts`, `InputSourceKind`) actually produced
that tick's non-neutral `InputFrame` -- touch only counts while
`TouchSource.isActive()` is true that tick, gamepad only while a
connected pad actually produced the frame, keyboard is the fallback.
Counted by `InputUsageTracker` in `packages/app/src/session-report.ts`
(same allocation-free-per-tick style as the existing
`InputActivityTracker`), reported as three new optional `sessionReport`
fields -- `keyboardInputTicks`, `touchInputTicks`, `gamepadInputTicks` --
following the exact "absent means not tracked, never a fabricated zero"
convention as `contextLostCount`/`renderStalled`/`frameHistogram`.
Validated and clamped server-side to `[0, 10_000_000]` in
`packages/net/src/protocol.ts`'s `sanitiseSessionReport`, carried
through `server/src/session-telemetry.ts` and `server/src/stats-store.ts`
exactly like every other optional session field.

**`touchActive` is not being removed.** Device capability is still a
useful, honest signal on its own (e.g. "how many of our sessions were on
touch-capable hardware at all") -- it just must never again be reported
as "what device they played on". `scripts/stats-report.mjs` now prints
the two as two clearly separate, clearly labelled lines: input device
*by observed usage* is the headline, and input device *by capability
only* is kept immediately below it with an explicit "NOT usage" warning
in the label itself, specifically so nobody can quote one number while
meaning the other again.

A session with zero ticks on all three sources (spectator, or a report
sent before the seat's local player ever polled) is not counted toward
any of the three usage buckets, but still isn't a fabricated zero at the
protocol level -- it is absent unless the client build sent it. A
session that used more than one source in a match (rebound to keyboard
mid-match, say) is attributed to whichever source produced the most
ticks, and separately counted in a `mixed` total so that ambiguity is
visible rather than hidden inside a single winner-take-all number.

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
- **Every new field added 2026-09-14 (see below) follows this exact
  convention too.** Each is optional on the wire; absent means "this
  client's build/browser didn't report it", never a real zero or a
  dropped value. `frameHistogram` is validated as a whole array (wrong
  length, wrong element type, or a negative element drops the entire
  array rather than half-trusting it) since a partial histogram is not a
  usable one; the scalar fields (`hwConcurrencyBucket`,
  `deviceMemoryBucket`, `dprBucket`, `hiddenFrames`,
  `networkHitchCount`) are clamped into a fixed valid range like every
  pre-existing numeric field here, never trusted raw.
- **No PII, ever.** No IP, no user agent, no header, no cookie, no
  account/session id that outlives one connection. If you are a
  contributor auditing this before relying on it: `grep -rn
  "req.headers\|remoteAddress\|user-agent" server/src/session-telemetry.ts
  packages/net/src/protocol.ts` should come back empty, and it does.

### Distinguishing a slow device from a slow network from a backgrounded tab, 2026-09-14

Motivated by a specific gap: our private stats store shows 82% of real
sessions are on touch devices, and their p95 client frame time is
~71ms (~14fps) against our own QA sessions' ~18ms (see [[Real Player
Measurements 2026-09-14: Phones Are the Primary Platform]]). Two
separate in-container profiling passes could not reproduce anything
close to 71ms -- render cost measured a few hundred microseconds against
a 16.7ms budget (see [[Client Frame Time Measurements 2026-09-12]]) --
so the sandbox structurally cannot explain a real phone's 71ms. The six
fields below exist to let the *next few days of real sessions* answer
that, rather than guessing between "weak/thermal-throttled device",
"browser compositor/tab backgrounding", and "network hitch misread as
frame time".

**`hello.profile`: coarse device-capability tags**, added alongside the
existing `touchActive`/`viewportWidth`/`viewportHeight`:
`hwConcurrencyBucket` (`navigator.hardwareConcurrency`, bucketed up to
the nearest of 2/4/8/16/32/64), `deviceMemoryBucket`
(`navigator.deviceMemory` in GB, bucketed to 0.25/0.5/1/2/4/6/8/16/32;
absent on browsers without the Device Memory API, notably Safari --
absence means "not available", never "zero memory"), and `dprBucket`
(`window.devicePixelRatio`, bucketed to 1/1.5/2/3/4). All three are
already-public, non-identifying browser APIs (a huge fraction of all
devices share each bucket), bucketed client-side in
`packages/app/src/session-report.ts` (`bucketHardwareConcurrency`/
`bucketDeviceMemory`/`bucketDevicePixelRatio`) before sending, and
clamped again server-side rather than trusted
(`packages/net/src/protocol.ts`'s `sanitiseClientProfile`). A session
with a small `hwConcurrencyBucket`/`deviceMemoryBucket` and a
consistently high `frameMedianMs` is evidence for "weak device"; a
session with generous buckets and the same high frame time is evidence
against it, pointing at the network or the browser instead.

**`sessionReport`: a frame-time histogram**, `frameHistogram`, a
cumulative (whole-match, not rolling-window) count of rendered frames in
six fixed buckets: `[<20ms, 20-33ms, 33-50ms, 50-100ms, 100-250ms,
>250ms]` (boundaries shared as `FRAME_HISTOGRAM_BOUNDARIES_MS` in
`packages/net/src/protocol.ts`, imported by both the client and
`scripts/stats-report.mjs` so they can never drift apart). This exists
because `frameMedianMs`/`frameP95Ms` alone cannot tell a *steady* 14fps
session (every frame ~71ms) from an otherwise-smooth 60fps session with
a handful of huge stalls (say, one 3-second GC pause) -- the two can
produce a similar p95 but need completely different fixes. See
`packages/app/test/session-report.test.ts`'s
"a steady-71ms session and a mostly-smooth-with-one-huge-stall session"
test for the exact worked example.

**Backgrounded-tab frames are separated out, not counted as slow
render.** `FrameTimeTracker.record()` now takes a second `hidden`
argument (`packages/app/src/net-match.ts` passes `document.hidden`); a
frame measured while the tab was hidden is excluded from the rolling
median/p95 samples *and* the histogram, and only bumps the new
`hiddenFrames` counter. A backgrounded tab is throttled by the browser
on purpose (rAF fires rarely, sometimes with one huge coalesced delta on
return) -- folding that into the frame-time distribution would misreport
a player who alt-tabbed or turned their phone screen off as "a slow
device", which is a completely different, non-actionable case. A high
`hiddenFrames` relative to session length is itself a useful (different)
signal: this player was not actually watching for some of the match.

**A network-hitch counter, separate from render**: `networkHitchCount`,
a count of gaps between consecutively *received* server snapshots that
exceeded 250ms (`NETWORK_HITCH_THRESHOLD_MS` in
`packages/app/src/session-report.ts`) -- well above the ~50ms expected
interval at the server's 20Hz snapshot rate. Measured at the point
`packages/app/src/net-match.ts` already computes the raw inter-snapshot
gap for its own display-interpolation clamp, so this adds no new
measurement machinery, just a threshold counter on an existing number.
Also skipped while the tab is hidden, for the same reason as
`hiddenFrames` above -- a backgrounded tab coalescing/delaying messages
is not a network problem. A session with a high `networkHitchCount` but
a clean `frameHistogram` points at the network, not the device or the
renderer; the reverse points the other way.

**What was deliberately left out, and why:**

- **No user agent string, no GPU/renderer string, no canvas/audio
  fingerprint.** These would be the single most informative fields for
  this exact investigation (a UA string all but names the device model)
  and were the first thing considered -- rejected because they are
  exactly the kind of high-entropy, potentially-unique strings the
  owner's private-stats decision and this feature's whole privacy stance
  (see above) rule out. The bucketed capability tags are a deliberately
  blunter substitute: enough to separate "old, weak phone" from
  "capable phone with a bad network" in aggregate, not enough to pick
  out one device.
- **No page-visibility *duration* (ms spent hidden), only a frame
  *count*.** A duration would need a monotonic timer started/stopped on
  every visibilitychange, adding real complexity for a number the frame
  count already answers well enough for this decision (steady low
  frame-rate vs. a background pause vs. a network hitch); if this later
  proves too coarse, duration is the natural next addition.
  `hiddenFrames` alone was enough to keep `FrameTimeTracker`'s existing
  no-argument call sites in `packages/app/test/session-report.test.ts`
  working unchanged.
  Note this is a size decision, not a privacy one: mirroring
  `frameHistogram`, wall-clock hidden-duration is not device-identifying.
- **No per-frame timestamps or a raw frame-time array.** Would have
  answered "when exactly did it go bad" but at unbounded, per-session
  size; the six-bucket histogram is the deliberately coarse compromise
  that answers "steady vs. stalled" without the array.
- **No battery/thermal API (`navigator.getBattery`, deprecated and
  increasingly unsupported) and no `navigator.connection`
  (`effectiveType`/`downlink`, still Chrome-only and itself somewhat
  fingerprint-y).** Both were considered as more direct signals for
  "thermal-throttled" and "weak network" respectively; both are
  non-standard/inconsistently supported enough that they would mostly
  read as "unknown" across the real phone-heavy traffic this is aimed
  at, for a privacy cost similar to the UA string above. The existing
  `networkHitchCount` measures the network's actual observed behaviour
  instead of asking the browser to self-report a category.

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
{"type":"sessionEnd","ts":"2026-09-14T07:00:05.000Z","matchId":"m1","winCondition":"battleRoyale","eliminated":false,"endReason":"disconnected","sessionDurationSec":21.4,"touchActive":false,"firstInputMs":620,"inputTicks":340,"frameMedianMs":15.9,"frameP95Ms":19.4,"hwConcurrencyBucket":4,"deviceMemoryBucket":2,"dprBucket":2,"frameHistogram":[300,40,5,2,0,0],"hiddenFrames":0,"networkHitchCount":0,"keyboardInputTicks":340,"touchInputTicks":0,"gamepadInputTicks":0}
```

(the last six fields are the 2026-09-14 device-capability/frame-histogram/
network-hitch additions described above; `null` on records from an
older client build, never a fabricated zero)

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
distribution (min/median/p95/max); input device *by observed usage*
(headline, since 2026-09-14 -- see "Capability vs usage" above) with
input device *by capability only* printed right below it, clearly
labelled as not the same thing; client
frame-time distribution; feedback submission count (count only); and,
broken out three ways (all / not marked QA / marked QA, plus an
"unknown" count for pre-existing records), the self-declared `?qa=1`
hint described in the privacy section below. Since 2026-09-14 it
also reports, per group (all/not-QA/QA): the frame-time histogram summed
across sessions, how many sessions had any hidden/backgrounded frames
and the total count, how many sessions had any network hitch (>250ms
gap between received snapshots) and the total count, and the
device-capability bucket distributions (`hwConcurrencyBucket`/
`deviceMemoryBucket`/`dprBucket`) -- all straight aggregates over the
fields described above, all omitted from the printed report when no
session in the group reports that field at all (an old-client-only log
stays exactly as terse as before).

### Privacy stance, restated plainly for this store

- **No HTTP surface reads any of this.** `/stats` and `/api/stats` were
  considered and explicitly rejected by the owner on 2026-09-14 -- see
  the task history -- specifically so nobody outside the project can see
  activity numbers while the game is in early growth. `server/src/`
  gained no new route, no new listener, and no new externally reachable
  code path for this feature; only `stats-store.ts` (new), `match.ts`
  (one new optional event) and `index.ts` (wiring) changed.
- **No unique-visitor number, ever.** We do not collect IPs, cookies, or
  device fingerprints, and this store does not start now -- every count
  here is a *session* count. A returning player and a new player are
  indistinguishable by design, so `stats-report.mjs` never prints
  anything claiming otherwise. As of 2026-09-15, `uaFamily` is the one
  exception to "no user agent" as literally stated above -- but it is
  never the raw `navigator.userAgent` string, only one of four fixed
  values (`chrome`/`firefox`/`safari`/`other`) derived from it
  client-side before anything is sent; see "Slow-frame attribution"
  below for why it exists and why that reduction is enough to keep it
  out of fingerprint territory.
- **Zero prints as zero.** No filler, no rounding up, no placeholder
  numbers -- if nothing happened, the report says `0`.
- **Not retrospective.** The report states the timestamp of the first
  record in the store; anything before that only shows up if you pass
  `--extra-log` with an older export, and even then it's labelled
  separately.
- **Our own QA traffic can be self-declared, but never proven.** A
  client opened with `?qa=1` sends `hello.profile.qa = true`, which is
  recorded on that seat's `sessionEnd` line and rolled up into a
  `qaSeats` count on the match's `matchEnd` line (see "Debug URL
  parameters" above). This adds exactly one boolean to the existing
  fields -- still no IP, no user agent, no cookie, no fingerprint, no
  persistent identifier. It is a self-declared hint, not proof: a real
  player could set the parameter by accident, and a tester could
  forget it, so `stats-report.mjs` always shows all three groups (all
  sessions / not marked QA / marked QA, plus an "unknown" count for
  records written before this field existed) and never drops or
  silently reclassifies anything on the strength of this flag alone.

See also: [[Player Feedback Channel 2026-09-13]], [[Production Traffic Reality Check 2026-09-13]].



## `scripts/arena-shrink-metrics.mjs` had the same moveless-bot bug, fixed 2026-09-14

This script was never migrated when the `characters: undefined` ->
`DEFAULT_CHARACTER` (`moves: []`) bug above was found and fixed in
`human-analog-metrics.mjs`/`full-sweep-metrics.mjs` on 2026-09-11. It kept
calling `new Sim(seed, N, undefined, arenaEntry.arena)` for its whole
20-bot-no-human sweep, so every bot in every run was physically unable to
land a hit. It also classified elimination cause with the old
"damage in the last 60 ticks" heuristic instead of reading
`Sim.eliminationEvents[].cause` directly, which the "Resolution Guarantee
and Harness Trust" wiki page had already shown mislabels late-ring and
below-floor-fall deaths.

**Symptom reported 2026-09-14:** on `battle-royale-20`/EASY the script read
501-539s match durations and a 95.4%/4.6% boundary-vs-combat split --
unreconcilable with real play (matches run ~110-125s, knockouts are the
normal way fighters die).

**Fix:** build the roster with `scripts/lib/bot-character-assignment.mjs`'s
`assignServerCharacters` (same seeded `ALL_CHARACTERS` draw
`server/src/rooms.ts`'s bot-fill timer performs) instead of passing
`undefined`; added a loud `process.exit(1)` assertion if any assigned
character ever again has an empty `moves` array, so this exact regression
cannot silently return; switched cause classification to
`Sim.eliminationEvents[].cause` (`knockout` = combat, `fall`/`ring`/
`ring_lethal` = boundary), matching what production's own `[elimination]`
log line uses.

**Production ground truth** (SSH `journalctl -u bash-fighter --since '-48h'`,
`evt:"elimination"`/`evt:"matchSummary"` lines, 142 matches, 1034
elimination events, all arenas/difficulties mixed since production always
runs the single EASY default): knockout 802 (77.6%), ring 192 (18.6%), fall
40 (3.9%) -> combat 77.6% / boundary 22.4%. 44 matches resolved with a
winner, duration 35.7-180.0s (median 115.0s). `battle-royale-20` specifically:
4 resolved matches, 118.4-124.4s (median 118.4s).

**Harness before/after, `battle-royale-20`, EASY, same seeds:**

| metric | before (reported bug) | after fix (16 seeds) | production (ground truth) |
|---|---|---|---|
| duration | 501-539s | min 73.0, median 117.9, max 162.8s | median 118.4s (n=4 resolved), 35.7-180.0s across all arenas (n=44) |
| boundary % | 95.4% | 9.5% (29/305 elims) | 22.4% (232/1034 elims, all arenas) |
| combat % | 4.6% | 90.5% | 77.6% |
| 1-survivor resolution | not stated as 100% | 16/16 | 44/142 matches ended `resolved`; rest `abandoned_by_humans` (a harness has no equivalent -- see below) |

Duration now agrees closely with production (within the observed spread).
Boundary share is now the right order of magnitude and the right side of
50% (combat clearly dominant, matching real play), but still undershoots
production's 22.4% by roughly half -- honestly unresolved, plausibly
because this harness still runs zero human seats (see the human-analog
gap discussion above) and 20 uniform EASY bots may press each other into
the ring less erratically than a real player does. Do not read the exact
boundary percentage as production-equivalent; do trust the qualitative
verdict (durations ~110-165s, knockouts are the dominant cause) and the
duration figures.

**Update 2026-09-15: the remaining seven scripts above were fixed too.**
`bot-brawl-metrics.mjs`, `clustering-metrics.mjs`,
`human-placement-metrics.mjs`, `measure-lowpct-ko.mjs`,
`novice-survival-metrics.mjs`, `ring-pacing-experiment.mjs`, and
`stocks-metrics.mjs` all called `new Sim(seed, N)` / `new Sim(seed, N,
undefined, ...)` and have all been migrated to
`assignServerCharacters` with the same loud `moves.length === 0`
`process.exit(1)` guard as `arena-shrink-metrics.mjs`.
`ring-pacing-experiment.mjs` additionally had the old damage-window
elimination-cause heuristic, now replaced with
`Sim.eliminationEvents[].cause`. `measure-lowpct-ko.mjs` had a second,
independent bug in its own percent-at-death conversion (`/65536*100`,
double-scaling by 100x versus every other script's `fx.toFloat`),
invisible before because it never had a real `knockout` event to apply
it to; also fixed. Full before/after numbers for all seven, and which
previously-published figures they invalidate, are in [[Resolution
Guarantee and Harness Trust]]'s 2026-09-15 note. (Not affected:
`damage-curve-metrics.mjs`, `regen-golden.mjs`, `full-sweep-metrics.mjs`,
`human-analog-metrics.mjs`, `arena-shrink-metrics.mjs` -- all already
pass real `characters`.)

## Which scripts to trust for which question, 2026-09-14

- **Match duration, elimination-cause split, "is combat or the boundary
  deciding matches":** trust production logs first, always
  (`journalctl -u bash-fighter`, `evt:"elimination"`/`evt:"matchSummary"`).
  Of the offline harnesses, `human-analog-metrics.mjs` and
  `full-sweep-metrics.mjs` (post-2026-09-11 fix) and
  `arena-shrink-metrics.mjs` (post-2026-09-14 fix) all build a real
  roster and read truthful `eliminationEvents.cause`; use them for
  relative before/after comparisons on a single change, not as a
  standalone substitute for production's own numbers.
- **`bot-brawl-metrics.mjs`, `clustering-metrics.mjs`,
  `human-placement-metrics.mjs`, `measure-lowpct-ko.mjs`,
  `novice-survival-metrics.mjs`, `ring-pacing-experiment.mjs`,
  `stocks-metrics.mjs` (fixed 2026-09-15):** all now build a real roster
  via `assignServerCharacters` and fail loudly if any assigned character
  has no moves; `ring-pacing-experiment.mjs` and `measure-lowpct-ko.mjs`
  read `eliminationEvents.cause` directly. Fine for relative
  before/after comparisons within one script's own scope (novice
  survival time, human placement distribution, stock-count resolution
  time, clustering distance, ring-pacing duration/combat split). Every
  headline number any of them published before 2026-09-15 was measured
  with moveless bots and is now known wrong -- see the specific
  before/after table in [[Resolution Guarantee and Harness Trust]] before
  citing any pre-2026-09-15 figure from these scripts again.
- **Camera framing (`camera-framing-metrics.mjs`):** trustworthy as of its
  own fix -- asserts damped-vs-raw scale agreement and exits non-zero on
  mismatch; see its own history for what that closed.
- **Bandwidth (`bandwidth-` figures in the relevant wiki pages), load
  testing (`load-test-metrics.mjs`):** unrelated to this bug class (no
  `Sim`/bot characters involved); not re-audited here.

## Actually-playing session duration, 2026-09-15

The owner made session count and session *duration* the project's North
Star (see wiki "Private Stats and QA Traffic Tagging 2026-09-14",
"North Star metric" section). The problem: `sessionDurationSec` (see
above) measures wall-clock time between a websocket opening and closing
-- a browser tab left open in a background window inflates it exactly as
much as someone actually playing. Today's production figures were median
46s vs p95 894s vs max 1,858s; the max is almost certainly an abandoned
tab, not 31 minutes of play, and it was sitting in the same number the
owner now steers by.

"Actually playing" is defined here as three genuinely different
quantities, not one, because collapsing them loses the question the
owner actually asked (did we lose this player in the first ten seconds,
or after they'd been drawn in):

- **In a live match**, not sitting on the start screen or a match-end
  screen. Server-derived (`activePlayMs`/`matchAgeAtLeaveSec` below):
  tick-based off `Match.tick` and `Match.getMatchStartedAtTick()`, so a
  client cannot spoof it, only a tab's raw open time can be.
- **Tab visible and focused**, not backgrounded. Client-reported
  (`visibleMs`/`hiddenMs`, see `docs/PROTOCOL.md`): real ms of frame
  deltas summed while `document.visibilityState === 'visible'` vs
  hidden, not a frame *count* (the existing `hiddenFrames` field), which
  a throttled background tab makes a poor proxy for wall-clock time --
  a single hidden rAF can carry a multi-second coalesced delta or never
  fire at all.
- **An active fighter, not spectating** after elimination.
  Server-derived (`spectatingMs`, `leftBeforeFirstElimination` below)
  from the new `Seat.eliminatedAtTick` (server/src/match.ts) and the new
  whole-match `Match.firstEliminationTick` milestone.

New fields, all additive and optional (an older client/server build
producing none of them still validates and stores, same convention as
every field before them):

| Field | Source | Meaning |
|---|---|---|
| `visibleMs` / `hiddenMs` | client, wire (`SessionReportMessage`) | See `docs/PROTOCOL.md`. |
| `matchAgeAtLeaveSec` | server-derived | Ticks from match start to session end, i.e. how far into the match this session lasted. `null` if the match never left the lobby. |
| `activePlayMs` | server-derived | Time this seat spent as a live, controllable fighter (match start to elimination, or to session end if never eliminated). This is the single number closest to "actually playing". |
| `spectatingMs` | server-derived | Time this seat spent connected but already eliminated. |
| `leftBeforeFirstElimination` | server-derived | Did this session end before *any* seat (bot or human) in the match had been eliminated -- i.e. did we lose them in the dead-quiet opening seconds, or after the action had already started. |

All four server-derived fields are computed once, in
`server/src/session-telemetry.ts`'s `computeDerivedPlayMetrics`, and
consumed identically by the console `[sessionEnd]` log line and the
durable stats-store record, so the two cannot drift apart.

`scripts/stats-report.mjs` reports, per group: the tab-open duration
(unchanged, kept alongside, never replaced) and the actually-playing
duration side by side, plus a drop-off breakdown -- never-started
(left in lobby), first 10s of match time, later but still alive and
before the match's first elimination, after their own elimination, or
stayed to the match's end. Every one of these follows the existing
convention: below `MIN_N_FOR_DURATION` (5) known samples it prints raw
counts and says plainly that there are too few to support a percentile
or a breakdown, rather than presenting noise as a finding.

**What this still cannot tell us:** whether a visible, active-fighter
tab actually had a human paying attention to it (no keyboard/mouse
activity in a stretch does not distinguish "reading the screen" from
"stepped away with the tab still frontmost"); nothing about matches that
never produced a `sessionEnd` at all (a killed server process, for
instance); and, as always, nothing about *people* -- only sessions,
since no identifying signal is collected.

## Seeing real phone layout

The browser in our container refuses viewports narrower than 1024px, and
phone emulation cannot initialise WebGL, so phone layout used to be
unobservable. Real sessions report canvas sizes as small as 260 CSS px wide
(780x1478 at devicePixelRatio 3), and defects live down there.

Load the game inside an iframe of the size you want to test, from a page
already open in the browser:

```js
const f = document.createElement('iframe');
f.style.cssText = 'position:fixed;left:0;top:0;width:260px;height:493px;z-index:99999';
f.src = 'https://bashfighter.com/?qa=1&forceTouch=1';
document.body.appendChild(f);
```

The iframe is the layout viewport for fixed positioning and media queries,
and WebGL still works because the host is a desktop GPU context. Drive it
with `f.contentDocument` and measure with `getBoundingClientRect()`;
screenshots of the iframe region are not reliably to scale, so trust the
measured rectangles. This is how the 2026-09-19 phone-width defects (a
128px-wide canvas, the stick sitting on the action buttons, a 220x414
elimination panel) were found.


## `scripts/ko-distribution-metrics.mjs`: what it does and does not reproduce

Fixed 2026-09-21: this headless KO-distribution harness originally built its
`Sim` directly (`new Sim(seed, N, characters, undefined, { winCondition })`),
leaving the arena argument `undefined`. That defaults to `packages/sim`'s
`DEFAULT_ARENA` -- a minimal single-platform stage with only 2 spawn points,
built for 2-fighter physics unit tests, not for a 20-fighter match. Cramming
20 bots onto that 400-unit-wide platform (instead of a real stage's several
hundred units and 20 spread-out spawn points across multiple chambers)
produced roughly 4x too many knockouts in `timedKO`: a top-seat mean of 49.45
KOs (p90 68) versus production's actual per-match top seat (18 KOs, in a real
`the-foundry` timedKO match, 2026-09-21 17:52 PDT, `matchId: m1`, `totalKOs:
61`). The fix switches to `createMatchSim` (`packages/content`), the same
builder the server uses, with `pickArenaId(seed)` choosing the real stage the
same way `server/src/match.ts` does. After the fix the harness's top-seat
mean for `timedKO` is 13.5 (p90 21) -- in production's range.

**What this harness still does not reproduce, so do not balance off it
alone:**
- It never passes a human seat to any `BotController`, so EASY's
  beginner-protection targeting penalty (`protectedIndices` in
  `packages/sim/src/ai/bot.ts`, wired from `server/src/match.ts`'s
  `humanSlots`) never engages. A real match with a human seat redistributes
  some KO share away from that seat; this harness cannot show that.
- It runs bot-only matches. Production `timedKO` matches typically carry one
  real (or QA) connection whose presence affects nothing mechanically beyond
  the point above, but whose session can end the match early via
  disconnect/abandonment logic this harness does not model at all.
- It picks the stage id itself the same way the server does
  (`pickArenaId(seed)`), so a single run only samples whichever stage that
  seed maps to -- it is not a per-stage breakdown across all six stages.
