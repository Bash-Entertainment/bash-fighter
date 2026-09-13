# Adding a new stage: a worked example

There is no dedicated stage-authoring doc yet even though the roster of
stages has grown to six (`battle-royale-20`, `the-undercroft`,
`the-spire`, `the-foundry`, `the-atoll`, `the-quarry`) — this fills that
gap. It mirrors [`ADDING_A_CHARACTER.md`](./ADDING_A_CHARACTER.md); read that
first if you haven't, the shape of the work is the same. "Stage" in
prose and `ArenaData`/`arena` in code refer to the same thing — the name
was kept from an earlier design pass and both spellings are used
throughout the codebase and docs on purpose.

## 1. Pick a template and copy its data

Every stage lives in one file:
`packages/content/src/arenas/<name>/data.ts`, exporting a single
`ArenaData` object (`packages/sim/src/arena/types.ts`). `the-foundry` is
a good template if you want walls and pass-through ledges; `the-atoll`
if you want a bridge; `battle-royale-20` if you want the simplest
possible flat floor.

```sh
mkdir -p packages/content/src/arenas/my-stage
cp packages/content/src/arenas/the-foundry/data.ts \
   packages/content/src/arenas/my-stage/data.ts
```

Edit `my-stage/data.ts`:

- Rename the exported constant (e.g. `MY_STAGE_ARENA`) and set `name`.
- Pick a `accentColor` that is clearly distinct from the existing
  stages' accents and stays off the orange/amber band reserved for
  hazard/danger cues in `PALETTE` (`packages/render/src/palette.ts`).
- Lay out `platforms` (solid or `kind: 'pass-through'`) and `walls`.
  Every coordinate goes through `fx.fromInt`/`fx.fromFloat`
  (`packages/sim/src/math/fixed.ts`) — never a raw float — because arena
  geometry is simulated in the same Q16.16 fixed-point space as
  everything else, and floats would break determinism.
- Set `blastMinX/MaxX/MinY/MaxY` — the fixed outer bounds the collapsing
  ring shrinks toward. Leave enough headroom above the highest platform
  for a full jump arc, or characters will feel like they bump a ceiling.
- Fill in the spawn point list (see the tail of any existing `data.ts`)
  for up to 20 fighters. Spread spawns across any separate
  chambers/platforms roughly evenly — see the comment in
  `the-foundry/data.ts` for the reasoning — and remember human seats
  always get the lowest fighter indices (`server/src/rooms.ts`), so index
  0 should not be stuck in an isolated pocket.
- **Spawn-clearance invariant (2026-09-11):** no spawn point may sit
  close enough to the live tick-0 boundary that a fresh (0% damage)
  fighter can be knocked out of bounds by an ordinary early hit before
  the ring even starts shrinking. This is a real defect class that hit
  three of the five shipped stages (see wiki "Spawn Clearance Audit: All
  Stages 2026-09-11") — a fighter genuinely eliminated at 4-22% in the
  opening seconds, not a balance complaint. The rule, enforced by
  `packages/content/test/spawn-clearance.test.ts` on every stage
  automatically:
  - Horizontal clearance from each spawn to the ground-derived safe
    extent (`computeSafeExtents` in `packages/sim/src/arena-shrink.ts`,
    evaluated at tick 0 with the full 20-fighter field alive — the
    tightest the boundary ever is) must be **>= 1.15x** the worst-case
    horizontal arc a 0%-damage, lightest-weight fighter can be launched
    by the single hardest-hitting hitbox in the roster (computed from
    `packages/sim/src/knockback.ts`).
  - Vertical (ceiling) clearance must be **>= 1.0x** the equivalent
    worst-case upward arc.
  - Prefer fixing shortfalls by **compressing spawn spacing** (move
    spawns inward), not by widening the stage's own blast rect or
    softening knockback — a wider boundary makes that stage's own ring
    take longer to close and can time out `server/test/reconnect.test.ts`
    under load (rejected once already on battle-royale-20).
  - Run `node scripts/spawn-clearance-audit.mjs` for the full printable
    per-stage, per-slot table while iterating; it uses the exact same
    computation as the test, so there is no drift between "the audit
    passed" and "the test passed".

## 2. Validate it

`packages/content/src/validate.ts` exports `validateArena` /
`assertValidArena` — the same schema/geometry sanity check CI runs on
every content PR (missing spawn points, inverted min/max bounds,
platforms outside the blast rect, etc.). Run it against your new stage
while iterating:

```sh
node --experimental-strip-types -e "
import { assertValidArena } from './packages/content/src/validate.ts';
import { MY_STAGE_ARENA } from './packages/content/src/arenas/my-stage/data.ts';
assertValidArena(MY_STAGE_ARENA);
console.log('my-stage: valid');
"
```

## 3. Register it

Add your stage to `packages/content/src/arenas.ts` — the single arena
registry the file's own header comment describes: "nothing outside this
file and `match-sim.ts` should import an arena data module directly."
Import your `data.ts` export and add an entry with a stable `id` (this id
is sent over the wire in `MatchStartMessage.arenaId`, see
`docs/PROTOCOL.md` — never change an existing id once it has shipped,
or reconnecting clients on an older build will build the wrong `Sim`).

**Registering a new arena changes `ALL_ARENAS.length`, and at least one
existing test picks an arena with `ALL_ARENAS[seed % ALL_ARENAS.length]`**
(`packages/sim/test/arena-shrink.test.ts`, the "the-foundry seed 1003"
regression at the time of writing). Adding your sixth-or-later stage
silently retargets that modulo onto a different arena and the test fails
with an assertion like `expected 'the-foundry', actual: 'the-undercroft'`
— this is not a bug in your stage, it is that test's own fragility, and
it will keep recurring for whoever adds the seventh stage unless each
occurrence is changed to look an arena up by `id` (`ALL_ARENAS.find(a =>
a.id === 'the-foundry')`) instead of by position. Grep the whole repo for
`% ALL_ARENAS.length` before you conclude a failing test means your
stage is broken.

## 4. Give it a render treatment

`packages/render/src/arena-adapter.ts` and `packages/render/src/stage.ts`
draw whatever `ArenaData` describes generically (platforms, walls, blast
rect), so a new stage is visible with no render code changes at all.
Stages that want a distinct visual identity beyond the generic renderer
(background treatment, parallax, stage-specific decoration) add that in
`packages/render/src/stage.ts`, keyed off the arena's `name` or `id` —
look at how the existing stages differ there for the pattern. This
step is optional; skip it for a first draft.

## 5. Test it

- Run `npm test` — the determinism/N-fighter stress tests
  (`packages/sim/test`) run against every registered arena, so a broken
  stage (e.g. spawn points outside the blast rect) usually fails there
  first. See the modulo-indexing pitfall in step 3 before you assume a
  failure is about your stage's own geometry. The full suite is slow
  (20+ minutes on a contended box; `packages/sim/test/arena-shrink.test.ts`
  alone is 3+ minutes) — background it
  (`nohup sh -c 'npm test > /tmp/test.log 2>&1; echo exit=$? >> /tmp/test.log' &`)
  rather than assuming a long silence means it hung.
- Add a `packages/content/test/<your-stage>.test.ts` for anything specific
  to your stage's own geometry (e.g. "every raised platform is
  pass-through", "the tiers are left/right symmetric") — the generic
  suites in `packages/content/test/arenas.test.ts` and
  `spawn-clearance.test.ts` already run against every registered arena
  automatically, so you do not need to duplicate those checks, only add
  ones unique to your layout.
- Play it locally and actually watch full matches — do not verify a stage
  by reasoning about the coordinates alone. There is no dev-only stage
  picker in the normal client UI, and there is no button literally
  labelled "PLAY": from `packages/app`, `npm run dev` and open the app,
  expand "Play locally on one keyboard" and click "Start local match" to
  play a 2-human/bots-fill match, **or**, for the actual 20-fighter offline
  harness this doc is really pointing at, load the app with
  `?crowd20=1&seed=<n>&arena=<your-stage-id>` in the URL and click the
  "Start local match" button that appears — that runs a full offline
  20-fighter bot match on exactly your stage and seed, with `TAB` to cycle
  survivors and `F3` for the debug overlay. Watch several seeds through to
  a result: look for firing-squad spawns, first-second deaths, a ring that
  wipes everyone at once, and platforms that camouflage fighters. None of
  this requires `server && npm run dev` — that is only needed for the
  networked "Play online" path, not for offline stage iteration.
- There is no automated visual test for stage geometry
  (`packages/render` has almost no test harness at all — see
  `docs/ARCHITECTURE.md`); a screenshot walkthrough in your PR
  description showing full-lobby and endgame framing on the new stage is
  the expected substitute for now.
