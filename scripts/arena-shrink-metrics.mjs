// Headless 20-fighter metrics harness for the arena-shrink rework (see
// wiki "Arena Collapse Cascade: Why Matches End With Nobody Left
// 2026-09-09" and "Arena Shrink Rework: Fighting Decides Matches
// 2026-09-09"). Deterministic: fixed seeds, no wall-clock, no
// Math.random. Run via:
//   node --experimental-strip-types scripts/arena-shrink-metrics.mjs [arenaId] [seeds] [ticks]
//
// Measures, per match: duration, survivor count (0/1/2+), and — the key
// number — how many eliminations were boundary-caused (fighter had not
// taken damage recently, i.e. the closing rectangle reached them rather
// than a hit knocking them out) versus combat-caused (damage within the
// last COMBAT_WINDOW_TICKS of elimination). Also runs one "passive"
// match where fighter 0 never presses a button, to check it cannot win
// by standing still.
import { Sim } from '../packages/sim/src/sim.ts';
import { BotController, BotDifficulty, deriveBotSeed } from '../packages/sim/src/ai/bot.ts';
import { makeInputFrame } from '../packages/sim/src/types.ts';
import { ALL_ARENAS } from '../packages/content/src/arenas.ts';
import * as fx from '../packages/sim/src/math/fixed.ts';
import { DEFAULT_MATCH_SETTINGS } from '../packages/sim/src/match-settings.ts';
import { PRODUCTION_DEFAULT_BOT_DIFFICULTY_NAME } from '../server/src/match-defaults.ts';
import { assignServerCharacters } from './lib/bot-character-assignment.mjs';

// REVISED 2026-09-09 (task #28195): this harness previously hardcoded
// BotDifficulty.HARD for every measurement in every wiki-recorded pass
// (Ring Pressure Not Executioner, KB Growth Scale Revert, Bot
// Clustering/Vertical/Ring Pacing, Task 28163). Production's actual
// default is MEDIUM (server/src/match.ts reads MATCH_BOT_DIFFICULTY,
// defaulting to 'medium' when unset) -- so every one of those
// combat-share/duration numbers described a harder, more aggressive
// lobby than almost anyone playing the live site actually gets. HARD
// bots fight more (tighter attack-decision cadence, less hesitation),
// so HARD-only measurement systematically over-reports combat share and
// under-reports how boundary-dominated a real MEDIUM match is. The
// default here now comes from the same constant server/src/match.ts
// resolves against production's env var, imported from
// server/src/match-defaults.ts (not duplicated), so a future change to
// the production default automatically flows into this harness too.
// Pass a difficulty explicitly (5th arg) to still measure other tiers.
const arenaArg = process.argv[2] || 'all';
const SEEDS = parseInt(process.argv[3] || '8', 10);
const TICKS = parseInt(process.argv[4] || '21600', 10); // 6 min hard cap @ 60hz -- see drift-guard warning below
const diffArg = (process.argv[5] || PRODUCTION_DEFAULT_BOT_DIFFICULTY_NAME).toUpperCase();
const DIFFICULTY = BotDifficulty[diffArg] ?? BotDifficulty.MEDIUM;

// Anti-drift guard (task #28195): this file's own TICKS default (21600 =
// shrinkFullyClosedTick's current value exactly) gives the stalemate
// override *zero* room to run before the ceiling hits, which is precisely
// the harness-ceiling bug that previously produced false 67-83% timeout
// readings on the-undercroft/the-spire (see wiki: Bot Pursuit and
// Finishing 2026-09-09, and the fix/root-cause in Bot Clustering,
// Vertical Bots, Ring Pacing 2026-09-09 section 1). Kept as the default
// here for backward-compatible call sites, but flagged loudly rather than
// silently trusted.
console.log('=== Harness settings vs production DEFAULT_MATCH_SETTINGS ===');
console.log(JSON.stringify(DEFAULT_MATCH_SETTINGS));
const MIN_SAFE_TICKS = DEFAULT_MATCH_SETTINGS.shrinkFullyClosedTick + 120 * 60;
if (TICKS < MIN_SAFE_TICKS) {
  console.log(`WARNING: ticks=${TICKS} < ${MIN_SAFE_TICKS} (shrinkFullyClosedTick + stalemate-override relax window + margin). Any 'timeout'/no-survivor result below is likely a harness-ceiling artifact, not a real stalemate -- prefer scripts/full-sweep-metrics.mjs with its default ceiling, or pass a larger ticks value here.`);
}
if (process.env.MATCH_SHRINK_FULLY_CLOSED_TICK) {
  console.log(`WARNING: MATCH_SHRINK_FULLY_CLOSED_TICK=${process.env.MATCH_SHRINK_FULLY_CLOSED_TICK} is set -- this run will not match production timing.`);
}
const N = 20;
console.log(`bot difficulty: ${diffArg} (production default unless overridden by 5th arg)`);

const arenaEntries = arenaArg === 'all' ? ALL_ARENAS : ALL_ARENAS.filter((a) => a.id === arenaArg);
if (arenaEntries.length === 0) {
  console.error(`unknown arena id: ${arenaArg}`);
  process.exit(1);
}

function runMatch(arenaEntry, seed, { passiveIndex = -1 } = {}) {
  // FIX 2026-09-14 (see docs/MEASUREMENT.md, "Root cause found and fixed,
  // 2026-09-11"): this used to call `new Sim(seed, N, undefined, ...)`,
  // which silently resolves every seat to packages/sim's internal
  // DEFAULT_CHARACTER (moves: []) -- bots that can move and take ring
  // damage but can PHYSICALLY NEVER LAND A HIT. That is the exact bug
  // already root-caused and fixed in human-analog-metrics.mjs and
  // full-sweep-metrics.mjs; this script was never migrated and kept
  // reporting the same "~100% boundary, ~500s matches" artifact. Build
  // the same production-faithful roster server/src/rooms.ts draws.
  const humanSlots = passiveIndex >= 0 ? new Set([passiveIndex]) : new Set();
  const characters = assignServerCharacters(seed, N, humanSlots);
  // Anti-drift assertion: fail loudly rather than silently re-introducing
  // the moveless-bot bug if this ever regresses (e.g. a future edit
  // passes `undefined` again, or ALL_CHARACTERS ships a moveless entry).
  const moveless = characters.filter((c) => !c.moves || c.moves.length === 0);
  if (moveless.length > 0) {
    console.error(
      `FATAL: ${moveless.length}/${N} assigned characters have no moves -- this is the exact ` +
      `DEFAULT_CHARACTER regression documented in docs/MEASUREMENT.md. Refusing to report a ` +
      `measurement that would silently reproduce it.`,
    );
    process.exit(1);
  }
  const sim = new Sim(seed, N, characters, arenaEntry.arena);
  const bots = Array.from({ length: N }, (_, i) =>
    i === passiveIndex ? null : new BotController(i, DIFFICULTY, deriveBotSeed(seed, i)),
  );
  const wasEliminated = new Array(N).fill(false);
  let boundaryElims = 0;
  let combatElims = 0;
  let endTick = TICKS;
  let matchEnded = false;

  const idleInput = makeInputFrame(0, 0, 0);

  for (let t = 0; t < TICKS; t++) {
    const inputs = bots.map((b, i) => (b ? b.nextInput(sim) : idleInput));
    sim.advance(inputs);

    // Truthful attribution (see wiki "Opening-Seconds Eliminations: Falls
    // Misreported as Knockouts 2026-09-10" and "Resolution Guarantee and
    // Harness Trust 2026-09-10"): read Sim.eliminationEvents directly --
    // the same ground truth production's own [elimination] log line
    // uses -- instead of the old "damage in the last COMBAT_WINDOW_TICKS"
    // heuristic, which misattributed late-match ring kills (margin decays
    // to zero) and below-floor falls. 'knockout' is combat; 'fall',
    // 'ring', and 'ring_lethal' are all boundary/environment for this
    // script's two-bucket split.
    for (const ev of sim.eliminationEvents) {
      if (!wasEliminated[ev.fighterIndex]) {
        wasEliminated[ev.fighterIndex] = true;
        if (ev.cause === 'knockout') combatElims++;
        else boundaryElims++;
      }
    }

    if (sim.isMatchOver && sim.isMatchOver()) {
      endTick = t;
      matchEnded = true;
      break;
    }
  }

  let survivors = 0;
  for (let i = 0; i < N; i++) if (!sim.getFighter(i).eliminated) survivors++;

  // Distinguish, among nobody-survived endings, a final-two double-KO
  // (the last two fighters standing eliminate each other on the same or
  // an adjacent frame) from a whole-lobby wipe (three or more fighters
  // eliminated together, i.e. the boundary cascade). See wiki "Ring
  // Pressure Not Executioner: 2026-09-09 Rebalance" -- this was flying
  // blind before 2026-09-09.
  let endingKind = 'resolved'; // resolved | timeout | final-two-double-ko | whole-lobby-wipe
  if (survivors === 0) {
    const elimTicks = [];
    for (let i = 0; i < N; i++) {
      const et = sim.getFighter(i).eliminatedTick;
      if (et !== null && et !== undefined) elimTicks.push(et);
    }
    elimTicks.sort((a, b) => a - b);
    const lastTick = elimTicks[elimTicks.length - 1];
    const ADJACENT = 2; // ticks; "same or adjacent frame"
    const countInFinalBurst = elimTicks.filter((t) => lastTick - t <= ADJACENT).length;
    endingKind = countInFinalBurst <= 2 ? 'final-two-double-ko' : 'whole-lobby-wipe';
  } else if (survivors >= 2 && !matchEnded) {
    endingKind = 'timeout';
  }

  const passiveResult =
    passiveIndex >= 0
      ? {
          passiveEliminatedTick: sim.getFighter(passiveIndex).eliminatedTick,
          passiveSurvived: !sim.getFighter(passiveIndex).eliminated,
          passivePlacement: sim.getFighter(passiveIndex).placement,
        }
      : null;

  return {
    seed,
    matchEnded,
    durationSec: Number((endTick / 60).toFixed(1)),
    survivors,
    boundaryElims,
    combatElims,
    endingKind,
    passiveResult,
  };
}

for (const arenaEntry of arenaEntries) {
  const results = [];
  for (let s = 0; s < SEEDS; s++) {
    const seed = 100000 + s * 7919 + arenaEntry.id.length;
    results.push(runMatch(arenaEntry, seed));
  }
  // One passive-player match per arena: fighter 0 never presses a button.
  const passive = runMatch(arenaEntry, 999001, { passiveIndex: 0 });

  const durations = results.map((r) => r.durationSec).sort((a, b) => a - b);
  const noSurvivor = results.filter((r) => r.survivors === 0).length;
  const oneSurvivor = results.filter((r) => r.survivors === 1).length;
  const multiSurvivor = results.filter((r) => r.survivors >= 2).length;
  const totalBoundary = results.reduce((a, r) => a + r.boundaryElims, 0);
  const totalCombat = results.reduce((a, r) => a + r.combatElims, 0);

  console.log(`\n=== ${arenaEntry.id} (${SEEDS} seeds) ===`);
  console.log(`duration (s): min=${durations[0]} median=${durations[Math.floor(durations.length / 2)]} max=${durations[durations.length - 1]}`);
  console.log(`endings: 1-survivor=${oneSurvivor}/${SEEDS}  nobody-survived=${noSurvivor}/${SEEDS}  multi-survivor(timeout)=${multiSurvivor}/${SEEDS}`);
  const finalTwoDoubleKo = results.filter((r) => r.endingKind === 'final-two-double-ko').length;
  const wholeLobbyWipe = results.filter((r) => r.endingKind === 'whole-lobby-wipe').length;
  console.log(`nobody-survived breakdown: final-two-double-ko=${finalTwoDoubleKo}/${SEEDS}  whole-lobby-wipe=${wholeLobbyWipe}/${SEEDS}`);
  console.log(`eliminations: boundary=${totalBoundary}  combat=${totalCombat}  boundary%=${((100 * totalBoundary) / Math.max(1, totalBoundary + totalCombat)).toFixed(1)}%`);
  console.log(`passive player (fighter 0, never presses a button): survived=${passive.passiveResult.passiveSurvived} eliminatedTick=${passive.passiveResult.passiveEliminatedTick} placement=${passive.passiveResult.passivePlacement} matchDurationSec=${passive.durationSec}`);
  console.log(JSON.stringify(results, null, 1));
}
