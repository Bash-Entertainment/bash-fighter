# Match modes

Bash Fighter's production server rotates matches through three modes.
Mode is decided once per created match (`server/src/mode-rotation.ts`,
`decideMatchMode`) and announced to every client as a plain-language
`modeName` string in the lobby message — clients never see the internal
identifier (`battleRoyale`/`timedKO`/`stocks`).

## Battle Royale (`battleRoyale`)

The default. No respawns; the collapsing arena forces a resolution.
Spectate on death. Last fighter standing wins. Production matches
resolve in roughly 60-90 seconds (median ~84s, see wiki "20-Player
Production-Hardware Measurements").

## Timed Brawl (`timedKO`)

3 minutes (`TIMED_BRAWL_TIME_LIMIT_TICKS` = 10800 ticks @ 60Hz).
Respawns are unlimited for the duration; most knockouts when the clock
hits zero wins. End screen shows full standings
(`packages/app/src/ui/timed-brawl-end-screen.ts`).

## Stocks (`stocks`)

Each fighter starts with a fixed number of lives (production default:
**2**, `STOCKS_STARTING_STOCKS` in `server/src/mode-rotation.ts`). A
knockout costs one life and respawns the fighter (same respawn machinery
as Timed Brawl); at zero lives the fighter is permanently eliminated.
Last fighter with lives remaining wins.

Sim-level support (`packages/sim/src/sim.ts`, `packages/sim/src/
match-settings.ts`) already modelled `'stocks'` as a first-class win
condition before this mode was wired up to the server/client — the
respawn-with-remaining-stocks / permanent-elimination-at-zero / single-
winner logic was already correct and already covered by
`packages/sim/test/combat.test.ts`'s 2-fighter cases. What Stocks
launch (2026-09-12) added:

- A 20-fighter resolution *guarantee*, which did not hold out of the
  box. `resolveMatchSettings` now turns arena shrink **on** for stocks
  (like Battle Royale) and shortens the tick-driven full-closure clock
  to **3 minutes** instead of Battle Royale's 8. Reasoning: with
  respawns keeping most of a 20-fighter field alive for most of the
  match, the *population-aware* term in the arena-shrink safe-extent
  calculation barely narrows the ring — it thinks a nearly-full lobby
  still needs room. Only the tick-based hard-margin closure (independent
  of population) reliably forces the match to end. Measured with
  `scripts/stocks-metrics.mjs` (20 fighters, HARD bots, 4 trials/config):
  with the 8-minute Battle Royale closure tick, *every* stocks trial was
  still unresolved at a 5-6 minute ceiling, for both 2 and 3 starting
  stocks. With the closure shortened to 3 minutes, all trials resolved,
  median ~224s (2 stocks) / ~236s (3 stocks).
- The **2 vs 3 starting stocks** decision: the measurement above shows
  stock count barely changes match length once the 3-minute closure
  exists, because the closure — not attrition — is what ends most
  matches. Since 3 stocks buys no shorter or more "sudden-death-earned"
  match here, 2 was chosen as the leaner default per the owner's
  stated preference for 2 absent evidence favouring 3.
- Server wiring: `decideMatchMode`/`modeDisplayName` in
  `server/src/mode-rotation.ts`, `Match.plannedStartingStocks` /
  `effectiveStartingStocks()` in `server/src/match.ts`, an env override
  `MATCH_STARTING_STOCKS` (same pattern as `MATCH_TIME_LIMIT_TICKS`).
- Client: the HUD's per-fighter stock-dot row (`packages/app/src/ui/
  hud.ts`) and the plain win screen (`packages/app/src/ui/win-screen.ts`)
  already branched on `winCondition !== 'timedKO'` and worked for any
  stocks count without changes — Stocks reuses Battle Royale's end
  screen (a single winner), not Timed Brawl's standings screen, because
  a Stocks match has one winner exactly like Battle Royale, not a
  ranked field.

## Rotation

`server/src/mode-rotation.ts`'s `DEFAULT_ROTATION` is
`['battleRoyale', 'battleRoyale', 'timedKO', 'stocks']`: Battle Royale
twice, then Timed Brawl, then Stocks, repeating (a 2-in-4 majority for
the headline mode, 1-in-4 each for the other two). Configurable without
a redeploy via `MATCH_MODE_ROTATION` (comma-separated list of the three
identifiers). Kill switch: `MATCH_MODE_ROTATION_DISABLED=1` pins every
match to Battle Royale (or whatever `MATCH_WIN_CONDITION` pins
manually), same as before Timed Brawl shipped.

## A first-time visitor's first match

One exception overrides the rotation: if the player creating a match did
not arrive via "Play again", that match is forced to Timed Brawl
(`decideMatchModeForJoin` in `server/src/mode-rotation.ts`, fed by
`ClientConn.requeuedAtJoin`). A newcomer's first match should not be able
to end fifteen seconds in — in Timed Brawl a knockout respawns you, so
their first three minutes are always playable. The `[modeRotation]` log
line records this as `forcedForFirstTimeVisitor`.

The override does not touch the rotation counter: `matchNumber` still
increments once per created match and `decideMatchMode` stays pure over
it, so forcing a mode never shifts the sequence for everyone else. The
same kill switch (`MATCH_MODE_ROTATION_DISABLED`) also disables the
override, which is how the server tests opt out of it.

## Leaving a match

Both end screens and the elimination overlay count themselves down and
re-enter matchmaking on their own unless the player interacts
(`packages/app/src/ui/auto-continue.ts`; 6s on the end screens, 4s on the
elimination overlay). This is client-side only — the server sees an
ordinary join with `requeued: true`.

## Local testing

`?mode=stocks` (and `?stocks=<n>`) in the local crowd harness — see
`docs/LOCAL_CROWD_TESTING.md`.
