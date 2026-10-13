# AGENTS.md

Guide for AI agents and human contributors working in this repo. Bash Fighter
is a web platform fighter for 20-player free-for-all matches (AGPL-3.0, CLA
required: see `CLA.md`). Longer reading: `CONTRIBUTING.md`,
`docs/ARCHITECTURE.md`, `docs/PROTOCOL.md`, `docs/ROADMAP.md`.

## Requirements

Node 22.18+ or 24+ (tests run TypeScript directly via type-stripping). Then:

```sh
npm install
```

## Run locally

Two terminals:

```sh
cd server && npm run dev          # match server, WebSocket on :8081
cd packages/app && npm run dev    # Vite dev server; proxies /socket and /api to :8081
```

Open the URL Vite prints. "PLAY" runs the sim fully client-side (no server
needed); "PLAY ONLINE" connects to the server. For a 20-fighter crowd without
a server see `docs/LOCAL_CROWD_TESTING.md`. Production build: `npm run build`.

## Tests and checks

| What | Command |
|---|---|
| Typecheck | `npx tsc --noEmit -p tsconfig.json` |
| Lint | `npm run lint` |
| Narrow (use this first) | `timeout 50 node scripts/run-tests.mjs packages/app/test/personal-best.test.ts` |
| Full package suite | `bash -O globstar -c "node scripts/run-tests.mjs"` |
| Server tests | `npm run test:server` |
| Everything CI runs | `npm run test:all` |

The full suite takes several minutes. Run it in the background and poll:

```sh
nohup bash -O globstar -c "node scripts/run-tests.mjs" > /tmp/full.log 2>&1 &
tail -f /tmp/full.log
```

`-O globstar` matters: without it `**` in the runner's default globs does not
expand. Server tests run with `--test-concurrency=1` because they bind ports.
Tests use `node:test` + `node:assert`; some content tests use vitest-style
`describe/it` imported from `node:test`.

## Layout

- `packages/sim`: deterministic fixed-point simulation. No DOM, no I/O, no floats in state.
- `packages/content`: characters, arenas (stages), items, hazards, animation data, validators.
- `packages/render`: PixiJS/WebGL rendering. Reads sim state, never mutates it.
- `packages/input`: keyboard, gamepad and touch polling, key bindings and persistence.
- `packages/net`: wire protocol types and the client side of netplay.
- `packages/audio`: synthesised sound effects and music.
- `packages/app`: the Vite app: game loop, menus, HUD, settings, start/end screens (`src/ui/`).
- `server/`: authoritative match server (Node + `ws`), lobbies, telemetry, feedback endpoint.
- `scripts/`: test runner, offline measurement harnesses, packaging.
- `deploy/`: production deploy scripts and nginx config. Do not run these as a contributor.
- `docs/`: architecture, protocol, adding a character/stage, match modes, measurement.

Dependencies point one way: `sim` depends on nothing; `content` on `sim` types;
`render`, `input`, `net` on `sim` but not each other; `app` wires them together.

## Conventions

- **Determinism.** The sim is fixed-point (helpers in `packages/sim/src/math`) and must produce
  identical state on every machine for the same seed and inputs. No `Math.random`, `Date.now`
  or floating point in sim state. Presentation (camera, particles, screen shake, audio, labels)
  must never feed back into sim state. Read the "Determinism rules" in `CONTRIBUTING.md`
  before touching `packages/sim`; golden fixtures live in `packages/sim/test`.
- **Small files, plain functions.** One responsibility per file, logic in plain modules,
  DOM and network at the edges. No dead code.
- **Tests for rules.** Add a test with every rule, bug fix or boundary. Write the failing
  test first for bugs. Assert outcomes, not implementation shape.
- **Do not change gameplay balance** (knockback, damage, speeds, stage geometry) in a
  drive-by change; open an issue to discuss first.
- **Commits:** small, with a message that says why. Stage by explicit path, not `git add -A`.

## Telemetry and privacy

Telemetry and the measurement harnesses are documented in `docs/MEASUREMENT.md`.
Analytics are never served over HTTP: there is no public endpoint exposing
activity numbers, and `server/test/no-public-activity-numbers.test.ts` enforces it.
Do not add one. Player feedback goes to `/api/feedback` and is write-only.

## Pull requests

1. For anything non-trivial open an issue first; comment to claim a good-first-issue
   (see "Claiming an issue" in `CONTRIBUTING.md`).
2. Keep the PR to one logical change; fill in `.github/PULL_REQUEST_TEMPLATE.md`.
3. CI (`.github/workflows/ci.yml`) runs install, typecheck, lint and tests on Node 22 and 24.
   `cla-check.yml` verifies the author has signed the CLA (`CLA-SIGNATURES.md`).
4. A maintainer reviews and merges. Nothing reaches `main` without review and green CI.
   Deployment is maintainer-only.
