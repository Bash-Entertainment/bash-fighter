# Bash Fighter

[![CI](https://github.com/Bash-Entertainment/bash-fighter/actions/workflows/ci.yml/badge.svg)](https://github.com/Bash-Entertainment/bash-fighter/actions/workflows/ci.yml)

Play it: https://bashfighter.com/

Day-to-day development of this project, including most of the code in this
repository and the posts made by the project's accounts elsewhere, is done
by an AI agent working on the owner's behalf. Pull requests and issues are
reviewed by that agent. We would rather say so plainly here than have
anyone find it out afterwards.

Bash Fighter is an open-source, web-based platform fighter in the Super
Smash genre, built for chaotic 20-player free-for-all matches instead of
the traditional 1v1. It runs in the browser, with a server-authoritative
match server for online play.

The project is early but live: a 20-player match server runs in
production at **https://bashfighter.com/** (HTTPS, with the bare IP
`http://135.181.45.254/` kept working as a fallback). Several parts described below are
thinner than they sound. This document describes what actually exists in
this repository today, not the eventual vision. For the current roster
of playable characters, see `docs/ARCHITECTURE.md` and
`packages/content/src/characters` — the roster is data-driven and grows
over time, so it isn't enumerated here.

![Bash Fighter mid-match: six fighters remaining, arena collapsed, items on the ground](docs/images/gameplay-ffa.png)
*Screenshot from a real match on the live server — a 20-player lobby collapsed down to 6.*

## Game design

The default mode is **Last Fighter Standing**: single-elimination battle
royale for up to 20 players, no respawns. The arena collapses as the match
goes on — a deterministic, shrinking blast-zone boundary driven by tick
count and match seed (never wall-clock time) — forcing survivors into
closer combat as the field thins. Eliminated players get a spectate camera
they can move freely while they wait out the rest of the match.

Two alternative modes are part of the design and share the same sim:
**Timed Brawl** (highest KO count within a time limit, with respawns) and
**Stocks** (classic multi-stock elimination). There are no teams in any
mode. 1v1 works as a two-player instance of any of the above; it is not
the primary design target.

See `docs/ARCHITECTURE.md` for how the simulation, rendering, and netcode
fit together.

### Playing with people you know

There are no accounts, so an invite is just a URL. Pressing **Play with a
friend** on the start screen puts a four-character code in your address bar
(`https://bashfighter.com/?join=ABCD`); anyone who opens that link joins your
lobby. A private lobby waits a minute before filling the empty seats with
bots, and you can press **Start now** at any point. Match-end screens offer
the same link for your next match.

Swap `join` for `watch` (`?watch=ABCD`) to spectate instead: no seat is taken,
`TAB` cycles survivors and `O` shows the whole arena. Protocol details are in
`docs/PROTOCOL.md`.

## Feedback

We want to know how the game actually feels to play — combat weight, camera
readability, fun, touch ergonomics, lobby clarity. Two ways to tell us:

- In-game: click the **Feedback** button (start screen, in-match HUD, or
  match-end screen). It's a short form, free text plus optional 1-5 ratings,
  needs no account, and posts straight to our server.
- On GitHub: [open an issue](https://github.com/Bash-Entertainment/bash-fighter/issues)
  if you prefer that route, especially for bugs or specific reproduction steps.

## Repository layout

npm workspace monorepo:

```
packages/
  sim/      deterministic fixed-point simulation core (real, tested)
  content/  character/stage data format + loader/validator
  render/   WebGL2 renderer (PixiJS), reads sim state, never mutates it
  input/    keyboard/gamepad capture into the sim's InputFrame format
  net/      client-side netcode: wire protocol types, NetMatch client
  app/      Vite app shell wiring sim + render + input + net together
server/    authoritative match server (Node + ws): lobby, rooms, snapshots
docs/       contributor-facing technical docs and the public roadmap
.github/    issue/PR templates and CI workflow
scripts/    offline generators (e.g. the trig lookup table)
```

`packages/sim` has zero dependency on any other package or on the DOM;
everything else depends on it, not the other way around. `packages/net`
holds the client side of the protocol (used by `packages/app`); the
server lives in `server/` as its own workspace since it runs on Node, not
in a browser.

## Running it locally

Requirements: Node 22.18+ or 24+. The test suite runs TypeScript directly
via Node's built-in type-stripping, so older Node versions will not run it.
CI covers Node 22 and 24.

```sh
git clone https://github.com/Bash-Entertainment/bash-fighter.git
cd bash-fighter
npm install
npm test            # packages/*/test only — see CONTRIBUTING.md "Running the tests"
npm run test:server  # server/test — not covered by `npm test`
npm run test:all      # both; what CI runs
npm run typecheck    # tsc --noEmit -p tsconfig.json
npm run lint          # eslint .
```

To play locally against yourself or a second local client:

```sh
# terminal 1: the match server (WebSocket on :8081)
cd server
npm run dev

# terminal 2: the app dev server (Vite, proxies /socket and /api to :8081)
cd packages/app
npm run dev
```

Open the Vite dev URL it prints. The local build has two entry points: a
"PLAY" button that runs the sim entirely client-side as an offline test
harness (no server needed), and a "PLAY ONLINE" button that connects to
the match server above, predicts the local fighter, and reconciles against
server snapshots. Both use the same deterministic `packages/sim`.

The live production deployment is at https://bashfighter.com/ and runs the
match server described above; the "PLAY ONLINE" flow works the same way
against it as against a local `server` dev instance.

To reproduce a full 20-fighter crowd locally without a server or a live
lobby (`?crowd20=1`, reproducible via `&seed=`/`&arena=`), see
[`docs/LOCAL_CROWD_TESTING.md`](./docs/LOCAL_CROWD_TESTING.md).

The game is also published as an HTML5 playable on
[itch.io](https://bashfighter.itch.io/bash-fighter), built from the same
source with a separate static bundle so it works from itch's CDN
subdirectory and off-origin; see
[`docs/ITCH_BUILD.md`](./docs/ITCH_BUILD.md) for how that build is
produced and uploaded.

## Determinism

`packages/sim` is a pure function of previous state plus input: Q16.16
fixed-point math (no floats in sim state), a lookup table for trig instead
of `Math.sin`/`Math.cos`, a seeded PRNG instead of `Math.random`, and no
reads of wall-clock time. This is what lets the server and every client run
the identical simulation and stay in sync, and what lets a client predict
its own fighter locally and reconcile against server snapshots without
drifting. See `CONTRIBUTING.md` for the specific rules this places on any
change to `packages/sim`, and `docs/ARCHITECTURE.md` for why the
architecture is shaped this way.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for dev environment setup,
coding standards, and the PR process. [`docs/ROADMAP.md`](./docs/ROADMAP.md)
tracks what's built, in progress, and not started. Use the issue forms
under `.github/ISSUE_TEMPLATE/` to report bugs or propose features, and
see [`SECURITY.md`](./SECURITY.md) to report a vulnerability privately.

Playtest feedback and general questions go in
[GitHub Discussions](https://github.com/Bash-Entertainment/bash-fighter/discussions)
(Q&A for questions, General or Show and tell for feedback and playtest
reports); concrete bugs and scoped feature requests go in Issues — see
"Discussions vs. issues" in `CONTRIBUTING.md`. Played a match on the live
server? Tell us how it felt, in Discussions.

## License

AGPL-3.0 (see [`LICENSE`](./LICENSE)), with a Contributor License Agreement
required from contributors — see [`CLA.md`](./CLA.md) for why and for the
CLA text. The project stays AGPL-3.0; the CLA lets Bash Entertainment also
offer the game under additional commercial terms.
