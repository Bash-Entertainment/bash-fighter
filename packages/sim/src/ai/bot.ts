// Bot input source (see Netcode Design Part 1/4 and this task's brief): a
// bot is NOT a special kind of fighter inside Sim. It is an input source
// that produces the exact same InputFrame a human's keyboard produces, fed
// into Sim.advance() by the server (architecture option (a) — the server
// computes bot inputs every tick from read-only sim state, same as it
// relays a human's inputs; nothing in packages/sim needs a concept of
// "bot" and clients predict bot-controlled slots exactly as they predict
// remote humans). This keeps determinism trivially intact: two Sims fed
// the same seed and the same recorded InputFrame[] — bot-authored or not —
// produce identical hash sequences, because a BotController only reads
// through the same public snapshot accessors any test or renderer uses
// (getFighter/getItem/getHazard/getCurrentBlastRect/getLeaderboard) and
// only ever draws randomness from its own seeded PRNG stream, never
// Math.random/Date.now.
import * as fx from '../math/fixed.ts';
import type { Fixed } from '../math/fixed.ts';
import { seedRng, nextBounded, type RngState } from '../math/prng.ts';
import { BUTTON_JUMP, BUTTON_ATTACK, BUTTON_SHIELD, makeInputFrame, type InputFrame } from '../types.ts';
import type { Sim, FighterSnapshot } from '../sim.ts';
import { MAX_JUMPS } from '../sim.ts';

export const BotDifficulty = {
  EASY: 0,
  MEDIUM: 1,
  HARD: 2,
} as const;
export type BotDifficultyValue = (typeof BotDifficulty)[keyof typeof BotDifficulty];

interface DifficultyTuning {
  /** Ticks between decisions; the bot only re-reads sim state and picks a
   * new intent this often — the "reaction time" a human would need. The
   * same cached input keeps being replayed in between, so a slow bot is
   * slow to *notice* things, never physically weaker. */
  reactionTicks: number;
  /** +/- jitter added to reactionTicks (deterministic, drawn from the
   * bot's own PRNG) so many bots on the same difficulty don't all decide
   * on the exact same tick. */
  reactionJitterTicks: number;
  /** Probability in [0,1000) (compared against nextBounded(1000)) that a
   * decision tick's stick input gets a random wobble instead of the
   * precise aim, modelling imprecise execution rather than a weaker hit. */
  wobbleChancePerMille: number;
  /** Fixed-point magnitude of that wobble, added to stickX/stickY before
   * clamping to [-ONE, ONE]. */
  wobbleMagnitude: Fixed;
  /** Probability in [0,1000) that an in-range attack decision is skipped
   * this decision tick (a missed opening a human would sometimes miss). */
  hesitationPerMille: number;
  /** Probability in [0,1000) that this decision the bot ignores whatever
   * target it would otherwise chase and just idles/wanders instead --
   * models a genuinely passive bot rather than a merely slow-and-sloppy
   * one. 0 at MEDIUM/HARD (unchanged prior behaviour). */
  passiveChancePerMille: number;
  /** Flat score penalty added when scoring a candidate target that is in
   * this bot's `protectedIndices` set (see BotController constructor).
   * Large at EASY so a passive bot goes out of its way to avoid piling
   * onto a human player when any other opponent is remotely competitive
   * as a target; 0 at MEDIUM/HARD, where a human is just another fighter. */
  protectedTargetPenalty: number;
  /** Multiplier applied to the existing anti-clump density penalty
   * (CLUSTER_PENALTY) specifically when the candidate being scored is a
   * protected index -- makes an already-crowded human even less
   * appealing to a fresh EASY bot than the generic anti-clump term alone
   * would, without touching how bots treat each other. 1 (no change) at
   * MEDIUM/HARD. */
  protectedClusterMultiplier: number;
  /** Score bonus per point of a candidate target's current percent
   * (capped at 150), scaled in the same squared-distance units as the
   * rest of `score()`. Biases target choice toward finishing off an
   * already-damaged opponent instead of always chasing the nearest body,
   * converting more eliminations into combat kills rather than leaving
   * damaged fighters to wander into the boundary. Higher at HARD (reads
   * as a genuinely threatening closer), present but gentler at MEDIUM,
   * modest at EASY so a beginner-protected match doesn't turn into a
   * pile-on the moment a human takes one hit. */
  finishingPriority: number;
  /** Whether this difficulty pursues and finishes an opponent it has
   * already hurt, instead of treating every target the same regardless
   * of how vulnerable they currently are. This does NOT change target
   * *selection* (pickTarget's scoring is untouched -- that is what the
   * reverted finishing-priority experiment changed, and what pushed
   * double-KOs past tolerance; see finishingPriority above and the dated
   * wiki page). It only changes how aggressively the bot presses an
   * already-locked target once that target is visibly vulnerable
   * (airborne in hitstun from a hit, or deep into its damage range):
   * lower hesitation on the finishing blow, and for HARD, steering
   * toward the target's predicted landing spot instead of its current
   * position -- a real edge-guard, not just a tighter chase. False at
   * EASY: a beginner must never be chased down and finished. */
  pursuitEnabled: boolean;
  /** Hesitation roll (per-mille, lower = more reliable) used instead of
   * the normal `hesitationPerMille` specifically when the locked target
   * is currently vulnerable (see isVulnerable()). Irrelevant when
   * pursuitEnabled is false. */
  pursuitHesitationPerMille: number;
  /** Ticks of lead time used to steer toward a vulnerable target's
   * predicted position (posX + velX*lead) rather than its current spot.
   * 0 = no lead (aim at current position). Only HARD leads by default --
   * MEDIUM still pursues but aims at where the target actually is. */
  pursuitLeadTicks: number;
  /** Whether this difficulty will deliberately drop through a
   * 'pass-through' platform (down+jump) to chase a target that is below
   * it, and will treat a target on a platform above as worth a genuine
   * climb rather than only the pre-existing "jump toward someone above"
   * nudge. False at EASY: a beginner should never be hunted across
   * platform tiers -- if a human ducks onto a platform, EASY simply
   * loses interest rather than dropping down on them. Added 2026-09-09;
   * see the dated wiki page for the diagnosis (bots never issued
   * down+jump, so drop-through platforms on 3 stages went unused). */
  verticalPursuit: boolean;
}

const TUNING: Record<BotDifficultyValue, DifficultyTuning> = {
  // EASY was tuned in the past to still be a reasonably active fighter --
  // slow and sloppy, but chasing and swinging just as readily as MEDIUM.
  // That is not what "easy" means to a first-time player dropped into a
  // 20-fighter FFA: reaction delay and imprecision alone cannot save you
  // from being the nearest target to several bots at once. EASY now adds
  // genuine passivity (often doesn't chase at all) and a strong aversion
  // to piling onto a protected (human) target on top of the existing
  // reaction/wobble/hesitation slowdowns.
  [BotDifficulty.EASY]: {
    reactionTicks: 40, // ~667ms
    reactionJitterTicks: 16,
    wobbleChancePerMille: 500,
    wobbleMagnitude: fx.fromFloat(0.8),
    hesitationPerMille: 550,
    passiveChancePerMille: 400,
    protectedTargetPenalty: 900.0,
    protectedClusterMultiplier: 3.0,
    finishingPriority: 0.0,
    pursuitEnabled: false,
    pursuitHesitationPerMille: 550,
    pursuitLeadTicks: 0,
    verticalPursuit: false,
  },
  [BotDifficulty.MEDIUM]: {
    reactionTicks: 14, // ~230ms
    reactionJitterTicks: 6,
    wobbleChancePerMille: 180,
    wobbleMagnitude: fx.fromFloat(0.35),
    hesitationPerMille: 120,
    passiveChancePerMille: 0,
    protectedTargetPenalty: 0,
    protectedClusterMultiplier: 1.0,
    finishingPriority: 0.0,
    pursuitEnabled: true,
    pursuitHesitationPerMille: 60,
    pursuitLeadTicks: 0,
    verticalPursuit: true,
  },
  [BotDifficulty.HARD]: {
    reactionTicks: 6, // 100ms
    reactionJitterTicks: 3,
    wobbleChancePerMille: 60,
    wobbleMagnitude: fx.fromFloat(0.15),
    hesitationPerMille: 30,
    passiveChancePerMille: 0,
    protectedTargetPenalty: 0,
    protectedClusterMultiplier: 1.0,
    finishingPriority: 0.0,
    pursuitEnabled: true,
    pursuitHesitationPerMille: 10,
    pursuitLeadTicks: 10,
    verticalPursuit: true,
  },
};

// Was 3.0/3.0 -- far tighter than any move's actual reach (hitbox
// offsetX 10-16 + hitbox half-width ~5-7, plus the attacker's and
// target's own hurtbox half-widths ~5-12 each on top). At 3.0, a bot's
// "am I in range" check almost never lined up with an actual swing
// landing: bodies had to be nearly coincident, and since this was only
// evaluated at decision instants (every 6-40 ticks, see reactionTicks)
// while the fighter walks at MOVE_SPEED=4.5/tick in between, the closing
// motion routinely overshot or undershot that 3-unit window between
// checks entirely. Measured effect: 20-bot brawls averaged ~0.7-0.75
// damage/sec and a mean pairwise distance of ~175 world units for the
// whole match -- bots were chasing but essentially never registering as
// "in range" long enough to swing. Widened to roughly match real move
// reach (see per-move offsetX/width in packages/content character data,
// and hurtboxWidth 10-24 across the roster).
const ATTACK_RANGE_X: Fixed = fx.fromFloat(16.0);
const ATTACK_RANGE_Y: Fixed = fx.fromFloat(15.0);
const ITEM_SEEK_RANGE_X: Fixed = fx.fromFloat(60.0);
/** How close (fixed units) to the current, possibly-shrunk blast rect edge
 * before the bot treats "stand your ground" as unsafe and prioritises
 * moving inward over anything else — chasing a target or an item. */
const EDGE_SAFETY_MARGIN: Fixed = fx.fromFloat(18.0);
/** Anti-clumping: fighters within this radius of a candidate target count
 * toward its "crowded" score (see BotController.pickTarget). Squared
 * float units to avoid a sqrt per candidate pair.
 *
 * REVISED 2026-09-09 (clustering diagnosis, see wiki "Bot Pursuit and
 * Finishing 2026-09-09" follow-up): measured mean pairwise fighter
 * spacing is 150-450 world units and this radius was 12 -- smaller than
 * a fighter's own hurtbox neighbourhood, so density() almost never
 * counted anything and the anti-clump term was inert until fighters
 * were already stacked on top of each other, too late to prevent the
 * observed 8-of-20 pile-up. Widened to a radius comparable to real
 * early-match spacing so it can actually steer target choice apart
 * before a cluster forms, not just after. */
const CLUSTER_RADIUS_SQ = 90.0 * 90.0;

// PACING REWORK 2026-09-10, LEVER 4: full decisions a bot sits out before
// picking a new target after its old one is eliminated (see comment on
// retargetCooldownDecisions). At MEDIUM's ~14-tick decision cadence this is
// roughly 3 decisions worth of pause -- long enough to matter, short enough
// that a bot never looks unresponsive to a live threat closing on it (the
// pause only affects *seeking a new target*, not defending against unsafe
// terrain or an in-range attacker who is already the cached target).
const RETARGET_COOLDOWN_DECISIONS = 3;
/** Score penalty in squared-distance units (scoring uses squared
 * distance throughout to avoid a sqrt/transcendental call, which
 * packages/sim's lint rule forbids for determinism) added per other
 * fighter already near a candidate target.
 *
 * REVISED 2026-09-09: raised alongside the radius widening above so the
 * penalty is still meaningful at the new radius scale -- ~600 is
 * equivalent to that target being roughly 24-25 world units farther
 * away per crowder (sqrt(600) ~ 24.5), enough to redirect a bot toward
 * an uncrowded opponent noticeably closer instead of piling onto one
 * that already has company, without being so large it overrides a
 * genuinely much closer target. */
const CLUSTER_PENALTY = 600.0;
/** Score bonus (squared-distance units) for keeping the current target,
 * so equally-good candidates don't cause flicker between decisions. */
const STICKINESS_BONUS = 400.0;
/** Decisions a target lock lasts before pickTarget re-rolls, in addition
 * to the jittered extra below. At MEDIUM's ~230ms/decision this is
 * roughly 1.8-3.2s per lock — long enough to actually fight, short enough
 * that pairs don't orbit for a whole match. */
const TARGET_LOCK_DECISIONS = 8;
/** Alive-fighter count at/above which protectedIndices scoring runs at
 * full strength; below this it fades linearly to 0 protection at 2
 * fighters left (see pickTarget). Keeps the beginner-safety purpose of
 * protection intact for the crowded opening of a match while closing the
 * late-game "stand still, stay protected, coast to a win" exploit. */
const LATE_GAME_ALIVE_THRESHOLD = 6;
const ONE = fx.ONE;
const EMPTY_SET: ReadonlySet<number> = new Set();

// PACING PASS 2026-09-10 (follow-up to Match Arc Lengthening Pass -- see
// wiki): knockback-scale tuning alone plateaued at ~63s avg vs a 150-180s
// target, because 20-fighter FFA runs many parallel 1v1/2v1 skirmishes
// that resolve independently -- slowing one fight barely slows the whole
// match. This lever instead spreads out *when* those skirmishes connect:
// during the opening stretch of a match, every bot (any difficulty) rolls
// its attack-commit hesitation against a temporarily raised threshold, so
// fewer of the many simultaneous early scrums land a hit in the same few
// seconds. It does not touch detection/movement/targeting -- bots still
// walk up, circle, and swing just as readily -- so this does not make
// bots look idle or passive, only slower to actually connect early on,
// spreading first-blood eliminations out over more of the match instead
// of clustering them in the opening flurry. Ramps down to 0 by
// EARLY_ENGAGEMENT_RAMP_TICKS, matching the existing early-match
// knockback dampener's 60s window (knockback.ts) so the two levers ease
// off together rather than one dragging past the other.
const EARLY_ENGAGEMENT_HESITATION_BONUS = 300;
const EARLY_ENGAGEMENT_RAMP_TICKS = 3600; // 60s @ 60Hz

// LATE-GAME FINISH FIX (task: endgame time-budget 2026-09-15): measured
// via scripts/time-budget-metrics.mjs that once the field thins to the
// final handful of fighters, EASY bots (production's actual default --
// see server/src/match-defaults.ts) essentially never finish an already-
// vulnerable opponent. EASY has pursuitEnabled=false, so even against a
// target in hitstun, airborne with real knockback velocity, or already
// at kill percent, it keeps rolling the full 550/1000 base hesitation on
// every ~0.67s decision tick with no aim-lead -- by the time the roll
// hits, the target has often recovered or drifted out of range. Result,
// EASY 24-seed harness sample: the last elimination (alive 3->1) is
// ring-caused 20/24 times (83%) -- the ring, not combat, decides who
// wins almost every match, exactly the "executioner" outcome the 2026-
// 09-10 design decision rejected. This does not touch pursuitEnabled,
// aim-lead, or pickTarget scoring (the finishing-priority experiment
// already reverted for double-KO risk, see pickTarget) -- only how
// readily an EASY bot commits the finishing swing it was already about
// to throw, and only once the lobby has thinned and only against a
// target already vulnerable.
const LATE_GAME_FINISH_HESITATION_PER_MILLE = 60; // matches MEDIUM's pursuitHesitationPerMille

function countAlive(sim: Sim): number {
  let n = 0;
  for (let i = 0; i < sim.numFighters; i++) {
    if (!sim.getFighter(i).eliminated) n++;
  }
  return n;
}

/** 0 at >= LATE_GAME_ALIVE_THRESHOLD alive, ramping linearly to 1 at 2
 * alive (same shape as pickTarget's protectionScale fade) -- reuses the
 * existing late-game threshold rather than inventing a new one. */
function lateGameFinishScale(aliveTotal: number): number {
  if (aliveTotal >= LATE_GAME_ALIVE_THRESHOLD) return 0;
  return Math.min(1, Math.max(0, (LATE_GAME_ALIVE_THRESHOLD - aliveTotal) / (LATE_GAME_ALIVE_THRESHOLD - 2)));
}

/** Only ever reduces hesitation for a difficulty that does not already
 * get pursuit's finishing treatment (i.e. EASY today), only against a
 * target isVulnerable() already flags, and only as the lobby thins past
 * LATE_GAME_ALIVE_THRESHOLD. Returns the hesitation value to use in
 * place of tuning.hesitationPerMille; unchanged (returns base) whenever
 * any of those conditions don't hold. */
function finishHesitationPerMille(
  tuning: DifficultyTuning,
  aliveTotal: number,
  targetVulnerable: boolean,
  base: number,
): number {
  if (tuning.pursuitEnabled || !targetVulnerable) return base;
  const scale = lateGameFinishScale(aliveTotal);
  if (scale <= 0) return base;
  return base - scale * (base - LATE_GAME_FINISH_HESITATION_PER_MILLE);
}

/** Extra per-mille hesitation added on top of a difficulty's normal
 * hesitation roll while a match is still in its opening stretch, linearly
 * decaying to 0 by EARLY_ENGAGEMENT_RAMP_TICKS. Deliberately difficulty-
 * agnostic (same bonus at EASY/MEDIUM/HARD): the goal is fewer *parallel*
 * connects across the whole 20-fighter lobby early on, not a difficulty
 * rebalance, and EASY's own beginner-protection scoring (protectedIndices)
 * is untouched by this. Applied uniformly to the retreat-attack,
 * chase-attack, and per-tick attack-refresh sites so there is no gap a
 * player could learn to exploit at one of them but not the others. */
function earlyEngagementHesitationBonus(tick: number): number {
  if (tick >= EARLY_ENGAGEMENT_RAMP_TICKS) return 0;
  const remaining = EARLY_ENGAGEMENT_RAMP_TICKS - Math.max(0, tick);
  return Math.round((EARLY_ENGAGEMENT_HESITATION_BONUS * remaining) / EARLY_ENGAGEMENT_RAMP_TICKS);
}

function clampStick(v: Fixed): Fixed {
  return fx.clamp(v, fx.neg(ONE), ONE);
}

function signOf(v: Fixed): Fixed {
  if (v > 0) return ONE;
  if (v < 0) return fx.neg(ONE);
  return 0;
}

/**
 * One bot's input source. Holds only its own small piece of mutable state
 * (a private PRNG stream + the last decision) — never touches Sim's
 * internals, never allocates inside the hot path beyond the plain object
 * literal an InputFrame already is (matching how a human input adapter
 * would hand a fresh InputFrame to the server each tick).
 */
export class BotController {
  readonly fighterIndex: number;
  readonly difficulty: BotDifficultyValue;
  private rng: RngState;
  private decisionCooldown = 0;
  private cached: InputFrame = makeInputFrame();
  /** Sticky target index (-1 = none yet). Kept across decisions so bots
   * don't flicker between two equally-close opponents; only re-evaluated
   * on the normal decision cadence, plus forced re-rolls (see
   * targetLockTicks) so a mutual stare-down eventually breaks up. */
  private targetIndex = -1;
  /** Decisions remaining before this bot is willing to switch target even
   * if a clearly better one exists (prevents rapid flicker), decremented
   * once per decision. Forced to 0 periodically to break up orbiting
   * pairs/clumps and to keep targets changing over a match. */
  private targetLockDecisions = 0;
  private targetSwitchCount = 0;
  /** PACING REWORK 2026-09-10, LEVER 4 (see wiki "Match Pacing Rework"):
   * full decisions remaining before this bot will pick a new target after
   * its current one is eliminated. Production evidence showed a "second
   * wave" of near-simultaneous eliminations as the field thinned and
   * survivors immediately piled onto whoever was nearest right after a
   * kill; this cooldown makes a bot pause/reposition for a beat instead
   * of instantly chaining into the next fight. Zero by default so a
   * bot's very first target pick (no prior target) is unaffected. */
  private retargetCooldownDecisions = 0;

  /**
   * @param seed Deterministic per-bot seed. Callers should derive this from
   *   the match seed and fighterIndex (e.g. `matchSeed ^ (fighterIndex * 0x9e3779b1)`)
   *   so a rerun of the same match seed reproduces the same bot decisions.
   */
  /** Fighter indices this bot should go out of its way to avoid piling
   * onto (in practice: human-controlled seats). Only has teeth at EASY,
   * where protectedTargetPenalty/protectedClusterMultiplier are non-zero.
   * Empty by default so existing callers (tests, bot-vs-bot metrics) are
   * unaffected. */
  private readonly protectedIndices: ReadonlySet<number>;

  constructor(fighterIndex: number, difficulty: BotDifficultyValue, seed: number, protectedIndices?: ReadonlySet<number>) {
    this.fighterIndex = fighterIndex;
    this.difficulty = difficulty;
    this.rng = seedRng(seed);
    this.protectedIndices = protectedIndices ?? EMPTY_SET;
  }

  private rollPerMille(): number {
    const { value, state } = nextBounded(this.rng, 1000);
    this.rng = state;
    return value;
  }

  private rollWobble(): Fixed {
    const { value, state } = nextBounded(this.rng, 2001); // [-1000, 1000]
    this.rng = state;
    return fx.mul(fx.fromInt(value - 1000), fx.fromFloat(0.001));
  }

  /** Computes (or replays, if still inside the reaction-delay window) this
   * tick's InputFrame. Called once per fighter per Sim.advance() call by
   * the server, same call site as reading a human seat's pending input. */
  nextInput(sim: Sim): InputFrame {
    const self = sim.getFighter(this.fighterIndex);
    if (self.eliminated) {
      return makeInputFrame();
    }
    if (this.decisionCooldown > 0) {
      this.decisionCooldown -= 1;
      // Re-check the attack trigger every tick, not just on the bot's
      // full reaction cadence. Movement stick/target selection stays
      // cached (that is the deliberate "reaction time" a slower bot
      // needs), but whether the *current* target is actually within
      // swing range changes tick-to-tick as both fighters keep moving
      // under that cached input -- checking it only once every
      // reactionTicks (6-40 ticks) meant the walk-in regularly carried a
      // bot straight through the attack window between checks, so the
      // decision to swing was frequently made either too early or too
      // late. This costs one getFighter() lookup and one range check per
      // bot per tick, which is cheap next to the 16.67ms tick budget.
      return this.refreshAttackTrigger(sim, self);
    }
    const tuning = TUNING[this.difficulty];
    const jitter =
      tuning.reactionJitterTicks > 0
        ? nextBounded(this.rng, tuning.reactionJitterTicks * 2 + 1).value - tuning.reactionJitterTicks
        : 0;
    this.decisionCooldown = Math.max(1, tuning.reactionTicks + jitter);
    this.cached = this.decide(sim, self, tuning);
    return this.cached;
  }

  /** Between full decisions: keep the cached movement stick, but
   * re-evaluate the attack button against the current target's current
   * position so a swing fires the tick range is actually entered rather
   * than only on the next full reaction-delay decision. Uses the same
   * hesitation roll as a full decision so difficulty tuning still
   * applies to how reliably an in-range opening is taken. */
  private refreshAttackTrigger(sim: Sim, self: FighterSnapshot): InputFrame {
    if (this.targetIndex < 0 || this.targetIndex >= sim.numFighters) return this.cached;
    const target = sim.getFighter(this.targetIndex);
    if (target.eliminated) return this.cached;
    const tuning = TUNING[this.difficulty];
    const inRange = this.inAttackRange(self, target);
    const vulnerable = this.isVulnerable(target);
    const baseHesitation = tuning.pursuitEnabled && vulnerable ? tuning.pursuitHesitationPerMille : tuning.hesitationPerMille;
    const lateGameHesitation = finishHesitationPerMille(tuning, countAlive(sim), vulnerable, baseHesitation);
    const hesitation = lateGameHesitation + earlyEngagementHesitationBonus(sim.getTick());
    const shouldAttack = inRange && this.rollPerMille() >= hesitation;
    const buttons = shouldAttack ? this.cached.buttons | BUTTON_ATTACK : this.cached.buttons & ~BUTTON_ATTACK;
    if (buttons === this.cached.buttons) return this.cached;
    return { buttons, stickX: this.cached.stickX, stickY: this.cached.stickY };
  }

  private decide(sim: Sim, self: FighterSnapshot, tuning: DifficultyTuning): InputFrame {
    let stickX: Fixed = 0;
    let stickY: Fixed = 0;
    let buttons = 0;

    const blast = sim.getCurrentBlastRect();
    const unsafe = this.unsafeDirection(self, blast, sim.getArena().platforms);
    // Passivity: at EASY, this decision has a real chance of skipping
    // target-chasing entirely -- a genuinely passive bot, not merely a
    // slow-and-sloppy one. Recovery (unsafe !== 0) always overrides this;
    // standing still off-stage is not "passive", it is falling to your
    // death, which is not the point.
    const passive = tuning.passiveChancePerMille > 0 && this.rollPerMille() < tuning.passiveChancePerMille;
    if (this.targetIndex >= 0 && sim.getFighter(this.targetIndex).eliminated && this.retargetCooldownDecisions <= 0) {
      // Our target just died since we last looked (Lever 4): sit out a
      // few full decisions before chasing whoever is nearest next.
      this.retargetCooldownDecisions = RETARGET_COOLDOWN_DECISIONS;
      this.targetIndex = -1;
    }
    let target: (FighterSnapshot & { index: number }) | null;
    if (this.retargetCooldownDecisions > 0) {
      this.retargetCooldownDecisions -= 1;
      target = null;
    } else {
      target = passive ? null : this.pickTarget(sim, self);
    }

    // --- Recovery / edge safety takes priority over everything else. ---
    if (unsafe !== 0) {
      stickX = unsafe;
      // Double jump for recovery: if airborne, still have a jump banked,
      // and either off the safe zone or sinking fast, use it — the only
      // other lever (DI via `unsafe`) is weak on its own, which is exactly
      // why bots used to lose stocks a human wouldn't. `requestJump` below
      // handles turning this into a real button-press edge.
      if (!self.grounded && self.jumpsUsed < MAX_JUMPS && self.velY < 0) {
        if (this.requestJump()) buttons |= BUTTON_JUMP;
      }
      // Retreating from the collapsing boundary must not mean "never
      // fights again" -- a bot already in range of its target still gets
      // a free swing on the way in (retreat direction wins the stick, the
      // attack button is nearly free). Without this, a boundary-hugging
      // endgame turns into everyone silently walking inward and no one
      // ever getting eliminated by combat, which is its own kind of
      // boring standstill and part of why a passive player could coast.
      if (
        target &&
        this.inAttackRange(self, target) &&
        this.rollPerMille() >= tuning.hesitationPerMille + earlyEngagementHesitationBonus(sim.getTick())
      ) {
        buttons |= BUTTON_ATTACK;
      }
    } else {
      // --- Item seeking: closest reachable world item, if any. ---
      const itemTarget = this.findNearestWorldItem(sim, self);
      const heldItemSlot = this.findHeldItemSlot(sim);
      if (heldItemSlot >= 0) {
        // Holding an item: use it on a nearby target, same button as attack.
        if (target && this.inAttackRange(self, target)) {
          buttons |= BUTTON_ATTACK;
          stickX = signOf(fx.sub(target.posX, self.posX));
        } else if (target) {
          stickX = signOf(fx.sub(target.posX, self.posX));
        }
      } else if (itemTarget) {
        stickX = signOf(fx.sub(itemTarget.posX, self.posX));
      } else if (target) {
        // Pursuit: once a target is visibly vulnerable (knocked into
        // hitstun/airborne by a hit, or deep into its damage range), aim
        // at where it is going rather than where it currently is -- this
        // is the edge-guard/finish lever. Only changes aim and
        // hesitation for the already-locked target; pickTarget's scoring
        // is untouched, deliberately (see pursuitEnabled doc comment --
        // that is what caused the reverted experiment's double-KO
        // regression).
        const pursuing = tuning.pursuitEnabled && this.isVulnerable(target);
        const aimX = pursuing && tuning.pursuitLeadTicks > 0
          ? fx.add(target.posX, fx.mul(target.velX, fx.fromInt(tuning.pursuitLeadTicks)))
          : target.posX;
        const aimY = pursuing && tuning.pursuitLeadTicks > 0
          ? fx.add(target.posY, fx.mul(target.velY, fx.fromInt(tuning.pursuitLeadTicks)))
          : target.posY;
        const dx = fx.sub(aimX, self.posX);
        const dy = fx.sub(aimY, self.posY);
        stickX = signOf(dx);
        stickY = signOf(dy);
        const baseHesitation = pursuing ? tuning.pursuitHesitationPerMille : tuning.hesitationPerMille;
        const lateGameHesitation = finishHesitationPerMille(tuning, countAlive(sim), this.isVulnerable(target), baseHesitation);
        const hesitation = lateGameHesitation + earlyEngagementHesitationBonus(sim.getTick());
        if (this.inAttackRange(self, target) && this.rollPerMille() >= hesitation) {
          buttons |= BUTTON_ATTACK;
          // Aim: grounded jab/ftilt picked by |stickX| threshold in
          // sim.ts, airborne uair/dair picked by stickY sign — steer the
          // stick to request the appropriate move for the target's
          // relative position rather than always spamming forward-tilt.
          const rdx = fx.sub(target.posX, self.posX);
          const rdy = fx.sub(target.posY, self.posY);
          if (!self.grounded) {
            stickY = rdy < 0 ? fx.neg(ONE) : ONE;
          } else if (fx.abs(rdx) > fx.fromFloat(1.5)) {
            stickX = signOf(rdx);
          } else {
            stickX = 0; // close-range: jab, not forward-tilt.
          }
        }
      }
    }

    // Occasional shield vs. an incoming close, active attacker — cheap
    // "defensive" behaviour: if someone else is mid-attack right next to
    // us on the ground, sometimes hold shield instead of always trading.
    // Kept rare (and slightly rarer than before) so fights keep moving
    // instead of stalling into shield-standoffs.
    if (unsafe === 0 && self.grounded && this.rollPerMille() < 25) {
      if (target && this.inAttackRange(self, target)) {
        buttons |= BUTTON_SHIELD;
        buttons &= ~BUTTON_ATTACK;
      }
    }

    // Jump to chase a target on a higher platform, close the last bit of
    // horizontal gap with an air approach, or escape a hazard overhead.
    // Also spend a banked double jump to close distance faster when a
    // target is nearby but not yet in range — keeps engagements moving
    // instead of a long ground walk-up every time.
    // Deliberate drop-through: a verticalPursuit-capable bot standing on
    // a 'pass-through' platform with its target clearly below drops down
    // to it (down+jump, see sim.ts's droppingThrough handling) instead of
    // walking to an edge and falling off passively. Checked before the
    // ordinary jump-to-chase block below so it takes priority over
    // anything that would otherwise also want the jump button this tick.
    if (
      unsafe === 0 &&
      self.grounded &&
      target &&
      tuning.verticalPursuit &&
      target.posY < fx.sub(self.posY, fx.fromFloat(4.0)) &&
      fx.abs(fx.sub(target.posX, self.posX)) < fx.fromFloat(45.0) &&
      sim.isStandingOnPassThroughPlatform(this.fighterIndex)
    ) {
      stickY = fx.neg(ONE);
      if (this.requestJump()) buttons |= BUTTON_JUMP;
    } else if (unsafe === 0 && self.grounded) {
      // Chase a target on a higher platform. verticalPursuit bots
      // consider a wider horizontal window and will bank a double jump
      // mid-air (see the airborne branch below) to actually reach it,
      // not just hop in place; non-pursuit (EASY) bots keep the original
      // tight window -- a small hop toward someone barely above, not a
      // real climb.
      const climbRangeX = tuning.verticalPursuit ? fx.fromFloat(45.0) : fx.fromFloat(20.0);
      if (target && target.posY > fx.add(self.posY, fx.fromFloat(4.0)) && fx.abs(fx.sub(target.posX, self.posX)) < climbRangeX) {
        buttons |= BUTTON_JUMP;
      }
      if (this.nearOverheadHazard(sim, self)) {
        buttons |= BUTTON_JUMP;
      }
    } else if (
      unsafe === 0 &&
      !self.grounded &&
      target &&
      self.jumpsUsed < MAX_JUMPS &&
      fx.abs(fx.sub(target.posX, self.posX)) > fx.fromFloat(6.0) &&
      !this.inAttackRange(self, target)
    ) {
      if (this.requestJump()) buttons |= BUTTON_JUMP;
    }

    // Imprecision: wobble the stick rather than the decision itself, so a
    // low-difficulty bot still tries to do the right thing, just sloppily.
    if (this.rollPerMille() < tuning.wobbleChancePerMille) {
      stickX = clampStick(fx.add(stickX, fx.mul(this.rollWobble(), tuning.wobbleMagnitude)));
      stickY = clampStick(fx.add(stickY, fx.mul(this.rollWobble(), tuning.wobbleMagnitude)));
    }

    return { buttons, stickX: clampStick(stickX), stickY: clampStick(stickY) };
  }

  /** Turns a desire to jump right now into a genuine button-press edge.
   * The sim only counts a jump on a 0->1 transition of the jump button
   * (`jumpEdge` in sim.ts); this.cached can hold the button pressed for
   * many ticks (decisions are infrequent), so pressing again while it's
   * already held would silently do nothing. If the last frame we emitted
   * already had the button down, release it for one tick (returning
   * false — caller omits the bit) and force an immediate re-decision so
   * the very next tick presses again and gets a fresh edge. */
  private requestJump(): boolean {
    const alreadyHeld = (this.cached.buttons & BUTTON_JUMP) !== 0;
    if (alreadyHeld) {
      this.decisionCooldown = 1;
      return false;
    }
    return true;
  }

  /** Picks the fighter to fight/flee, scoring by proximity but penalising
   * targets already crowded by other fighters (broken-up clumping) and
   * favouring the current target somewhat (stickiness, avoids flicker).
   * Periodically forces a fresh look even if the current target still
   * scores fine, so a match doesn't settle into fixed pairs for its whole
   * duration. */
  private pickTarget(sim: Sim, self: FighterSnapshot): (FighterSnapshot & { index: number }) | null {
    const candidates: (FighterSnapshot & { index: number })[] = [];
    for (let i = 0; i < sim.numFighters; i++) {
      if (i === this.fighterIndex) continue;
      const f = sim.getFighter(i);
      if (f.eliminated) continue;
      candidates.push({ ...f, index: i });
    }
    if (candidates.length === 0) {
      this.targetIndex = -1;
      return null;
    }

    // Cluster density around each candidate: how many *other* fighters
    // (excluding self and the candidate) sit within CLUSTER_RADIUS of it.
    // A candidate already surrounded scores worse, nudging idle bots
    // toward opponents elsewhere in the arena instead of piling on.
    const density = (c: FighterSnapshot & { index: number }): number => {
      let n = 0;
      for (const other of candidates) {
        if (other.index === c.index) continue;
        const dx = fx.toFloat(fx.sub(other.posX, c.posX));
        const dy = fx.toFloat(fx.sub(other.posY, c.posY));
        if (dx * dx + dy * dy <= CLUSTER_RADIUS_SQ) n++;
      }
      return n;
    };

    // Squared distance (plain float arithmetic — no sqrt/transcendental
    // calls, which packages/sim's lint rule forbids for determinism).
    // Ranking only needs a monotonic proxy for distance, so skipping the
    // sqrt is free; the other terms are scaled to match squared-distance
    // units (see CLUSTER_PENALTY/STICKINESS_BONUS_SQ comments).
    const distSqTo = (c: FighterSnapshot & { index: number }): number => {
      const dx = fx.toFloat(fx.sub(c.posX, self.posX));
      const dy = fx.toFloat(fx.sub(c.posY, self.posY));
      return dx * dx + dy * dy;
    };

    const tuning = TUNING[this.difficulty];
    // Protection (see protectedTargetPenalty/protectedClusterMultiplier)
    // exists to stop a fresh beginner being swarmed in the opening seconds
    // of a 20-fighter match. Left at full strength for the whole match, it
    // does the opposite job late: once the field has thinned and the
    // arena has collapsed down to its endgame size, a protected fighter
    // who simply stands still is nearly unattackable by EASY bots and
    // (per unsafeDirection) never leaves the safe zone either, so they
    // coast to a win without ever being at real risk -- the exact bug
    // this task fixes. Fade protection out as fewer fighters remain: full
    // strength while the lobby is still crowded (>= LATE_GAME_ALIVE_THRESHOLD
    // alive), linearly down to none once only two fighters are left, so
    // the beginner-safety purpose survives the opening flurry but a
    // turtling player is fair game again by the time the match is close
    // to over.
    const aliveTotal = candidates.length + 1;
    const protectionScale =
      aliveTotal >= LATE_GAME_ALIVE_THRESHOLD
        ? 1.0
        : Math.max(0, aliveTotal - 2) / (LATE_GAME_ALIVE_THRESHOLD - 2);
    const score = (c: FighterSnapshot & { index: number }): number => {
      const isProtected = this.protectedIndices.has(c.index);
      const clusterMult = isProtected ? 1.0 + (tuning.protectedClusterMultiplier - 1.0) * protectionScale : 1.0;
      let s = distSqTo(c) + density(c) * CLUSTER_PENALTY * clusterMult;
      if (isProtected) s += tuning.protectedTargetPenalty * protectionScale;
      if (c.index === this.targetIndex) s -= STICKINESS_BONUS;
      return s;
    };
    // A finishing-priority bias toward already-damaged targets was tried
    // here and measured: it raised combat-caused eliminations only
    // marginally but pushed the simultaneous-double-KO rate well past
    // the regression test's tolerance (2/5 seeds ending in a tie vs the
    // <=1/5 the test requires), because it concentrates fights into the
    // endgame right at the boundary's edge. Reverted rather than loosen
    // that test -- see the dated wiki page for the measurement.
    void tuning.finishingPriority;

    let best = candidates[0]!;
    let bestScore = score(best);
    for (let i = 1; i < candidates.length; i++) {
      const s = score(candidates[i]!);
      if (s < bestScore) {
        bestScore = s;
        best = candidates[i]!;
      }
    }

    // Force periodic re-rolls: even a "sticky" pair breaks up once the
    // lock expires, and if there is a genuinely different opponent
    // available we pick a *different* one than last time's target
    // (weighted-random among the top few, not just nearest) so 20 bots
    // don't converge onto the single globally-nearest pairing pattern.
    if (this.targetLockDecisions <= 0 && candidates.length > 1) {
      const sorted = candidates
        .map((c) => ({ c, s: score(c) }))
        .sort((a, b) => a.s - b.s)
        .slice(0, Math.min(3, candidates.length));
      const roll = this.rollPerMille() % sorted.length;
      best = sorted[roll]!.c;
      this.targetLockDecisions = TARGET_LOCK_DECISIONS + (this.rollPerMille() % 4);
    } else {
      this.targetLockDecisions -= 1;
    }

    if (best.index !== this.targetIndex) this.targetSwitchCount++;
    this.targetIndex = best.index;
    return best;
  }

  /** Returns -1/0/1 (fixed ONE units) for "move this way to stay inside the
   * current blast rect with a safety margin", or 0 if comfortably safe. */
  private unsafeDirection(
    self: FighterSnapshot,
    blast: { minX: Fixed; maxX: Fixed; minY: Fixed; maxY: Fixed },
    platforms: readonly { minX: Fixed; maxX: Fixed; y: Fixed; kind?: string }[],
  ): Fixed {
    if (self.posX < fx.add(blast.minX, EDGE_SAFETY_MARGIN)) return ONE;
    if (self.posX > fx.sub(blast.maxX, EDGE_SAFETY_MARGIN)) return fx.neg(ONE);
    if (self.posY < fx.add(blast.minY, EDGE_SAFETY_MARGIN)) {
      // Below the safe band (e.g. knocked down off a platform): steer back
      // toward center X so at least horizontal drift helps a recovery.
      return self.posX > 0 ? fx.neg(ONE) : ONE;
    }
    // Minimal ledge awareness (2026-09-10, see wiki 'Opening-Seconds Eliminations: Falls
    // Misreported as Knockouts'): a grounded bot standing near the edge of the solid ground
    // platform it is actually on (e.g. the-undercroft's central chasm, or either end of a
    // ground slab) steers back inward, exactly like it already does for the outer blast rect.
    // This is not combat awareness or edge-guarding -- it fires from standing still or
    // wandering near a drop, regardless of any target, and is unconditional across
    // difficulties because "don't walk off a cliff for no reason" is not a difficulty knob.
    if (self.grounded) {
      const onLedge = platforms.find(
        (p) => p.kind !== 'pass-through' && fx.abs(fx.sub(p.y, self.posY)) <= EDGE_SAFETY_MARGIN && self.posX >= fx.sub(p.minX, EDGE_SAFETY_MARGIN) && self.posX <= fx.add(p.maxX, EDGE_SAFETY_MARGIN),
      );
      if (onLedge) {
        if (self.posX < fx.add(onLedge.minX, EDGE_SAFETY_MARGIN)) return ONE;
        if (self.posX > fx.sub(onLedge.maxX, EDGE_SAFETY_MARGIN)) return fx.neg(ONE);
      }
    }
    return 0;
  }

  /** A target counts as "vulnerable" for pursuit purposes when it is
   * visibly in the aftermath of a hit (hitstun, or airborne with real
   * velocity -- knocked away rather than just jumping) or already deep
   * into its damage range and therefore one solid hit from elimination.
   * Deliberately cheap and local to the target snapshot -- no memory of
   * who hit them or when, so this stays correct even if another fighter
   * landed the original blow. */
  private isVulnerable(target: FighterSnapshot): boolean {
    if (target.hitstun > 0) return true;
    if (!target.grounded && fx.add(fx.abs(target.velX), fx.abs(target.velY)) > fx.fromFloat(3.0)) return true;
    if (fx.toFloat(target.percent) >= 100) return true;
    return false;
  }

  private inAttackRange(self: FighterSnapshot, target: FighterSnapshot): boolean {
    return (
      fx.abs(fx.sub(target.posX, self.posX)) <= ATTACK_RANGE_X &&
      fx.abs(fx.sub(target.posY, self.posY)) <= ATTACK_RANGE_Y
    );
  }

  private findNearestWorldItem(sim: Sim, self: FighterSnapshot): { posX: Fixed; posY: Fixed } | null {
    let best: { posX: Fixed; posY: Fixed } | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let slot = 0; slot < 8; slot++) {
      let item;
      try {
        item = sim.getItem(slot);
      } catch {
        break; // MAX_ITEMS reached
      }
      if (!item.active || item.state !== 0 /* WORLD */) continue;
      const dx = fx.toFloat(fx.sub(item.posX, self.posX));
      if (Math.abs(dx) > fx.toFloat(ITEM_SEEK_RANGE_X)) continue;
      const dist = dx * dx;
      if (dist < bestDist) {
        bestDist = dist;
        best = { posX: item.posX, posY: item.posY };
      }
    }
    return best;
  }

  private findHeldItemSlot(sim: Sim): number {
    for (let slot = 0; slot < 8; slot++) {
      let item;
      try {
        item = sim.getItem(slot);
      } catch {
        break;
      }
      if (item.active && item.state === 1 /* HELD */ && item.holder === this.fighterIndex) return slot;
    }
    return -1;
  }

  private nearOverheadHazard(sim: Sim, self: FighterSnapshot): boolean {
    for (let slot = 0; slot < 4; slot++) {
      let hz;
      try {
        hz = sim.getHazard(slot);
      } catch {
        break;
      }
      if (!hz.active) continue;
      if (fx.abs(fx.sub(hz.posX, self.posX)) < fx.fromFloat(2.0) && hz.posY > self.posY && hz.posY < fx.add(self.posY, fx.fromFloat(15.0))) {
        return true;
      }
    }
    return false;
  }
}

/** Deterministically derives a per-bot seed from the match seed and slot
 * index so every client (and every rerun of the same match seed) produces
 * the exact same bot decisions without needing to send bot RNG state over
 * the wire. */
export function deriveBotSeed(matchSeed: number, fighterIndex: number): number {
  return (matchSeed ^ Math.imul(fighterIndex + 1, 0x9e3779b1)) >>> 0;
}

const BOT_NAME_POOL = [
  'Nova',
  'Gizmo',
  'Rook',
  'Wisp',
  'Talon',
  'Cinder',
  'Bramble',
  'Fuzz',
  'Orbit',
  'Static',
  'Puck',
  'Kettle',
  'Junco',
  'Marble',
  'Pixel',
  'Grit',
  'Squall',
  'Ember',
  'Copper',
  'Vellum',
];

/** Plausible, human-scannable bot name — prefixed so it's never confused
 * with a real player's chosen name in the lobby list. */
export function botName(index: number): string {
  const name = BOT_NAME_POOL[index % BOT_NAME_POOL.length] ?? 'Bot';
  return `CPU ${name}`;
}
