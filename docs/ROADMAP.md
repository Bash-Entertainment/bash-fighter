# Roadmap

This tracks what exists in this repo and what's planned as features, at a
coarse grain. It is not a business plan or a launch schedule — those live
elsewhere and aren't part of the public repo.

## Done

- **`packages/sim`** — deterministic fixed-timestep simulation core:
  Q16.16 fixed-point math, LUT-based trig, seeded PRNG. Generalised to
  support 2–32 fighters with single elimination, deterministic placement,
  KO counts, and a deterministically collapsing arena. Full combat loop
  (state machine, frame data, hitboxes/hurtboxes, knockback, hitstun, DI,
  shield, stocks). Covered by a determinism/rollback test harness with a
  committed golden-hash file.
- **`packages/content`** — character/stage data format, a validator, and
  a growing roster of eight: Placeholder, Ballast (heavyweight), Voltling,
  Reed (long-reach zoner), Scrapper (rushdown brawler), Anchor (grappler
  heavyweight), Zephyr (acrobatic lightweight), and Wisp (ranged
  skirmisher), each with a full four-move kit and a character-select
  screen to pick between them. Items (Thrown
  Brick, Slam Bat, Bash Bomb, Medkit) and stage hazards are implemented,
  PRNG-driven so server and clients agree without sending item events
  over the wire, and are drawn on screen (`packages/render/src/hazard-sprite.ts`
  and item sprites), not just simulated invisibly.
- **`packages/render`, `packages/input`, `packages/app`** — a playable
  build: WebGL2 (PixiJS) renderer with multi-platform arena support,
  keyboard/gamepad input, a Vite app shell with an offline local-match
  mode and a character-select screen (`packages/app/src/ui/character-select.ts`).
- **`server/`** — the authoritative match server: lobby, room isolation,
  match lifecycle, snapshot broadcasting, bots that fill lobbies below
  capacity, mid-match reconnection (grace period + token, see
  `server/src/match.ts` and `server/src/rooms.ts`), and an integration
  test that connects multiple real WebSocket clients and diffs their
  final state hashes to prove no desync.
- **`packages/net` + online play in `packages/app`** — a "PLAY ONLINE"
  mode: client connects to the server, predicts its own fighter,
  reconciles on snapshots, interpolates remote fighters, shows connection
  state, and reconnects into an in-progress match after a drop.
- **Live public deployment** — the match server and web client run in
  production at https://bashfighter.com/ (HTTPS and secure websockets;
  the bare IP `http://135.181.45.254/` still works as a fallback),
  serving real 20-player matches over the public
  internet.
- **Licensing** — AGPL-3.0 (`LICENSE`), with a Contributor License
  Agreement required from contributors (`CLA.md`; signing mechanism not
  yet built).
- **Repo hygiene** — README, CONTRIBUTING, Code of Conduct, Security
  policy, this roadmap, an architecture overview, issue/PR templates, and
  a CI workflow (typecheck/lint/test on push and PR).

## In progress / known gaps

- **Match modes.** The sim currently implements single-elimination
  free-for-all (Last Fighter Standing). Timed Brawl (KO count within a
  time limit, with respawns) and Stocks are designed but not both fully
  wired end to end yet.
- **Online play polish.** Snapshots are full state rather than
  delta-compressed or quantised. Anti-cheat is limited to basic input
  validation (see "Not started" below).
- **Content pipeline.** The character/stage data format and validator
  exist; the broader on-ramp for community-contributed characters and
  stages (documentation, examples, more than one reference character) is
  still being built out.

## Not started

- **More characters and stages.** Eight characters exist today, covering
  the core rushdown/tank/aerial-mobility/ranged-skirmisher archetypes;
  more variety and more than one arena layout are ahead of us.
- **TLS / a domain.** The production deployment is plain HTTP/WS; a
  domain and certificate purchase is pending owner sign-off.
- **Anti-cheat / input validation hardening** beyond basic protocol
  version checks and malformed-message handling.
- **Accessibility and input remapping** beyond basic keyboard/gamepad
  capture.

## Sequencing rationale

The deterministic sim was the hard, foundational piece and it's done
first for a reason: rendering, input, and netcode all lean on its
guarantees, and none of them are worth building against a moving target.
Within "what's left," prefer picking up whatever unblocks the next item
on this list over something further down it — check open issues and PRs
first to avoid duplicating in-flight work. For raw playtest feedback and
feature ideas that aren't scoped issues yet, check
[Discussions](https://github.com/Bash-Entertainment/bash-fighter/discussions)
too — this roadmap gets pulled from there.
