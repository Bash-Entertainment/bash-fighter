// Deterministic simulation core: N fighters (2..32), gravity, ground
// collision against data-driven platform geometry, jump/movement, a
// declarative state machine, frame-data-driven attacks with a deterministic
// spatial-grid broad phase for hitbox/hurtbox resolution, percent +
// knockback + hitstun, shielding, and FFA scoring (battle-royale single
// elimination with a shrinking arena by default; timed-KO with respawns and
// classic multi-stock elimination as selectable match settings).
//
// Hot path (advance()) touches only preallocated typed arrays: no `new`,
// no array growth, no Map/Set. This is the GGPO-rollback contract from
// "Engine Architecture: Input, Netplay, and Content Pipeline" section 6.
import * as fx from './math/fixed.ts';
import type { Fixed } from './math/fixed.ts';
import { FighterStateId, type FighterStateValue } from './entities/fighter.ts';
import { assertTransition } from './state-machine/transitions.ts';
import { BUTTON_JUMP, BUTTON_ATTACK, BUTTON_SHIELD, type InputFrame } from './types.ts';
import { seedRng, nextUint32, type RngState } from './math/prng.ts';
import type { CharacterData, MoveDef, MoveIdValue } from './moves/types.ts';
import { MoveId, findMove, moveTotalDuration, windowAtFrame } from './moves/types.ts';
import { makeBoxCentered, aabbOverlap, type Box } from './hitbox.ts';
import {
  computeKnockbackMagnitude,
  crowdDamageScale,
  computeHitstunTicks,
  computeHitstopTicks,
  mirrorAngleIdx,
} from './knockback.ts';
import { sinLUT, cosLUT } from './math/fixed.ts';
import type { ArenaData, Platform } from './arena/types.ts';
import { DEFAULT_ARENA } from './arena/default-arena.ts';
import {
  type MatchSettings,
  resolveMatchSettings,
  respawnsEnabled,
} from './match-settings.ts';
import { computeCurrentBlastRect, computeShrinkProgress } from './arena-shrink.ts';
import { SpatialGrid } from './broadphase.ts';
import { nextBounded } from './math/prng.ts';
import { findItemType, type ItemSet, type ItemTypeDef } from './items/types.ts';
import { DEFAULT_ITEM_SET } from './items/default-items.ts';
import type { HazardConfig } from './hazards/types.ts';
import { DEFAULT_HAZARD_CONFIG } from './hazards/default-hazard.ts';

export const MIN_FIGHTERS = 2;
export const MAX_FIGHTERS = 32;

// --- Tunables (Q16.16), later replaced by real tuning constants ----------
export const GRAVITY: Fixed = fx.fromFloat(-0.85);
export const GROUND_Y: Fixed = fx.fromInt(0);
export const JUMP_VELOCITY: Fixed = fx.fromFloat(14.0);
// Aerial (second) jump is slightly weaker than the grounded jump: gives
// recovery options without matching the grounded jump's height 1:1,
// which reads better and avoids trivializing edgeguards. 0.85x chosen by
// feel per the wiki's "Combat Model" doc guidance to document tuning calls.
export const DOUBLE_JUMP_VELOCITY: Fixed = fx.fromFloat(14.0 * 0.85);
export const MOVE_SPEED: Fixed = fx.fromFloat(4.5);
export const TERMINAL_VELOCITY: Fixed = fx.fromFloat(-20.0);
/** Safety margin for hit-resolution broad-phase queries: comfortably
 * larger than any character's hurtbox/hitbox half-extent, so a query
 * against SpatialGrid (which buckets entities by center point, not by
 * hurtbox extent — see broadphase.ts) always covers the cell(s) an
 * overlapping defender's center could land in even when the hitbox box
 * itself sits just on the near side of a cell boundary. */
export const HIT_QUERY_MARGIN: Fixed = fx.fromInt(20);
// Retained for backward compatibility with anything referencing the old
// flat-stage constants directly; real geometry now comes from ArenaData.
export const STAGE_MIN_X: Fixed = fx.fromInt(-200);
export const STAGE_MAX_X: Fixed = fx.fromInt(200);
export const BLAST_MIN_X: Fixed = fx.fromInt(-260);
export const BLAST_MAX_X: Fixed = fx.fromInt(260);
export const BLAST_MIN_Y: Fixed = fx.fromInt(-120);
export const BLAST_MAX_Y: Fixed = fx.fromInt(220);

export const HITSTUN_DI_ACCEL_PER_TICK: Fixed = fx.fromFloat(0.06);
export const GROUND_FRICTION: Fixed = fx.fromFloat(0.9);
/** Ticks a fighter ignores 'pass-through' platforms after a deliberate
 * drop-through (down+jump while grounded on one). Long enough to clear
 * the platform's thickness at normal fall speed, short enough that
 * landing on the platform below (or the same one, on the next stage tier
 * loop) still feels responsive. Chosen by feel, not measured. */
export const DROP_THROUGH_TICKS = 12;
/** Half-width used for wall collision when a character has none defined
 * on its own data (walls block movement, not combat, so this only needs
 * to be "close enough" to a body -- character.hurtboxWidth/2 is used
 * instead whenever a CharacterData is available). */
export const DEFAULT_WALL_HALF_WIDTH: Fixed = fx.fromFloat(6.0);

export const STARTING_STOCKS = 3;
export const SHIELD_MAX_HEALTH: Fixed = fx.fromInt(100);
export const SHIELD_DAMAGE_MULTIPLIER: Fixed = fx.fromFloat(1.2);
export const SHIELD_STUN_PER_DAMAGE: Fixed = fx.fromFloat(1.0);
export const SHIELD_BREAK_HITSTUN_TICKS = 120;

// --- Items (this task's item 1) -------------------------------------------
// Small fixed pool of concurrently-live item instances, preallocated like
// everything else in the hot path. 6 is generous for a handful of item
// types spawning every few seconds in a 20-player match without ever
// needing to grow the array.
export const MAX_ITEMS = 6;
/** Ticks between item spawn attempts (a draw from the PRNG happens every
 * time this elapses regardless of whether a free slot exists, so the RNG
 * stream never depends on how many items happen to be alive). */
export const ITEM_SPAWN_INTERVAL_TICKS = 300; // 5s
/** Held item position offset above the holder's center, so it renders/acts
 * from roughly hand height rather than exactly on top of the fighter. */
export const ITEM_HELD_OFFSET_Y: Fixed = fx.fromFloat(1.4);
const ItemState = {
  WORLD: 0, // unheld, on the ground or falling toward it — pickupable
  HELD: 1, // carried by a fighter, follows their position
  THROWN: 2, // 'thrown' kind only: flying in a straight line after use
  ARMED: 3, // 'explosive' kind only: dropped, counting down its fuse
} as const;
const ItemField = {
  ACTIVE: 0,
  TYPE: 1,
  POS_X: 2,
  POS_Y: 3,
  VEL_X: 4,
  VEL_Y: 5,
  STATE: 6,
  HOLDER: 7, // fighter index currently holding it, -1 if none
  OWNER: 8, // fighter index who last used/threw/dropped it, -1 if never held
  TIMER: 9, // despawn countdown (WORLD/THROWN) or safety cap (ARMED)
  FUSE: 10, // 'explosive' kind only: ticks left until detonation, -1 n/a
  FIELD_COUNT: 11,
} as const;

// --- Stage hazards (this task's item 2) ------------------------------------
export const MAX_HAZARDS = 4;
const HazardField = {
  ACTIVE: 0,
  POS_X: 1,
  POS_Y: 2,
  VEL_Y: 3,
  TIMER: 4,
  FIELD_COUNT: 5,
} as const;

/** Layout of one fighter's slice inside the flat Int32Array state buffer.
 * Per-fighter hit-dedup fields (LAST_HIT_FROM_0/1 in the 2-fighter version)
 * were pulled out into a separate N*N dedup table sized from the actual
 * fighter count (see Sim.dedupIndex) so this stride does not grow with N. */

/** Truthful attribution for why a fighter's death happened, computed from exit geometry and
 * whether a combat hit landed recently enough to plausibly have caused it -- not from "any
 * damage in the last N ticks means combat", which misattributes ordinary falls/walk-offs at
 * low percent as knockouts (see wiki 'Opening-Seconds Eliminations: Falls Misreported as
 * Knockouts 2026-09-10'). Ring causes are always their own bucket since no attacker is credited. */
export type EliminationCause =
  | 'fall' // exited the blast zone (any edge) with no recent combat hit: self-destruct/walk-off, not a KO
  | 'knockout' // exited the blast zone within COMBAT_ATTRIBUTION_TICKS of a real hit: a genuine KO
  | 'ring' // pushed out through the hard-backstop margin while already taking ring pressure damage
  | 'ring_lethal'; // eliminated by the percent-based ring lethal backstop, not by exiting geometrically

/** How many ticks after a combat hit a subsequent death may still be credited to that hit as a
 * knockout. Chosen to comfortably cover hitstun + launch travel time for a real KO while
 * excluding hits from long before (e.g. a graze several seconds earlier that a fighter then
 * walks off a ledge from, unrelated to the fall). */
export const COMBAT_ATTRIBUTION_TICKS = 90; // 1.5s at 60Hz

export interface EliminationEvent {
  readonly fighterIndex: number;
  readonly tick: number;
  readonly cause: EliminationCause;
  /** Fighter index credited with the KO, or -1 if none (fall, ring, ring_lethal). */
  readonly attacker: number;
  readonly percentAtDeath: Fixed;
}

export const FighterField = {
  POS_X: 0,
  POS_Y: 1,
  VEL_X: 2,
  VEL_Y: 3,
  STATE: 4,
  FACING: 5, // 1 or -1
  GROUNDED: 6, // 0 or 1
  MOVE_ID: 7, // -1 when not attacking
  MOVE_FRAME: 8, // ticks since the current move activation started
  MOVE_INSTANCE: 9, // monotonic per-fighter counter, bumped each move start
  PERCENT: 10, // Fixed
  STOCKS: 11,
  SHIELD_HEALTH: 12, // Fixed
  SHIELD_STUN: 13, // ticks remaining, cannot act
  HITSTUN: 14, // ticks remaining, cannot act
  KO_COUNT: 15, // FFA scoring: KOs this fighter has landed on others
  DEATH_COUNT: 16, // times this fighter has been KO'd
  RESPAWN_TIMER: 17, // ticks remaining until respawn (RESPAWN state only)
  INVULN_TIMER: 18, // ticks remaining of post-respawn invulnerability
  LAST_ATTACKER: 19, // index of last fighter who damaged us, -1 if none
  ELIMINATED: 20, // 0/1: out of the match for good (DEAD, no more lives)
  ELIMINATED_TICK: 21, // tick this fighter was eliminated, -1 if not
  PLACEMENT: 22, // 1 = winner, N = first eliminated; 0 = not yet decided
  JUMPS_USED: 23, // jumps taken since last grounded; reset to 0 on landing
  PREV_JUMP_HELD: 24, // 0/1: BUTTON_JUMP state last tick, for edge-triggering
  DROP_THROUGH_TIMER: 25, // ticks remaining to ignore 'pass-through' platforms, 0 = none
  RING_DAMAGE_TICK: 26, // last tick this fighter took ring (out-of-bounds) damage, -1 if never
  LAST_HIT_TICK: 27, // last tick a combat hit landed on this fighter, -1 if never (see DEATH_CAUSE below)
  HITSTOP_TICKS: 28, // ticks remaining of a sim-side impact freeze (see HITSTOP_* in knockback.ts); 0 = not frozen
  FIELD_COUNT: 29,
} as const;

/** Ring-pressure tuning (2026-09-10): the collapsing boundary no longer kills on contact. A
 * fighter outside it takes rapid accumulating damage instead, which both threatens elimination
 * on its own (via the hard backstop below) and, because knockback scales with percent, makes
 * that fighter dramatically easier for anyone else to launch. The ring's job becomes making
 * fighters vulnerable and pushing the field together; knockouts finish them. */
/** Percent damage applied per tick to a fighter outside the safe (soft) boundary. At 60
 * ticks/s this is 7.2%/s -- survivable for a couple of seconds, punishing to linger in. */
const RING_DAMAGE_PER_TICK = fx.fromFloat(0.12);
/** Extra distance beyond the soft boundary before the *hard* backstop (still an instant,
 * contact kill) applies. This is the lethal backstop: it stops a damaged fighter who simply
 * drifts outward forever from surviving on chip damage alone, without making the soft boundary
 * itself an executioner. Kept generous so it is a rare last resort, not routine play. */
const RING_HARD_MARGIN = fx.fromInt(90);
/** Percent at which ring damage stops being survivable pressure and eliminates the fighter.
 * Far above any percent reachable in ordinary play (matches resolve around 60-140%), and about
 * 42 seconds of continuous ring exposure at RING_DAMAGE_PER_TICK. */
const RING_LETHAL_PERCENT = fx.fromInt(300);
/** The backstop margin starts closing at three quarters of the shrink schedule and reaches zero
 * exactly at full closure, so a match that has run its whole schedule has a contact-lethal ring
 * again and provably terminates. Real matches resolve in 30-80s, far inside the full-width phase. */
const RING_HARD_MARGIN_DECAY_START_NUM = 3;
const RING_HARD_MARGIN_DECAY_START_DEN = 4;
/** Small constant inward nudge applied to velocity while taking ring damage -- what makes the
 * ring push fighters together rather than just hurt them in place. */
const RING_INWARD_PUSH = fx.fromFloat(0.35);

/** Max jumps allowed per airborne phase: one grounded jump + one aerial
 * ("double") jump, matching standard platform-fighter convention. */
export const MAX_JUMPS = 2;

const RNG_FIELD_WORDS = 4; // s0 lo/hi, s1 lo/hi
const TICK_WORDS = 1;
const ELIMINATED_COUNT_WORDS = 1;
const BLAST_RECT_WORDS = 4; // current (possibly shrunk) minX/maxX/minY/maxY

/** Opaque, preallocated snapshot of full sim state. Plain Int32Array so it
 * is cheap to copy (TypedArray.set) and trivial to hash for the determinism
 * test. Never resized after creation. Size depends on fighter count N. */
export type StateBuffer = Int32Array;

function bigintToWords(b: bigint): [number, number] {
  const lo = Number(b & 0xffffffffn) | 0;
  const hi = Number((b >> 32n) & 0xffffffffn) | 0;
  return [lo, hi];
}

function wordsToBigint(lo: number, hi: number): bigint {
  const loU = BigInt(lo >>> 0);
  const hiU = BigInt(hi >>> 0);
  return (hiU << 32n) | loU;
}

export interface FighterSnapshot {
  posX: Fixed;
  posY: Fixed;
  velX: Fixed;
  velY: Fixed;
  state: FighterStateValue;
  facing: 1 | -1;
  grounded: boolean;
  moveId: number; // -1 when not attacking
  moveFrame: number;
  percent: Fixed;
  stocks: number;
  shieldHealth: Fixed;
  shieldStun: number;
  hitstun: number;
  koCount: number;
  deathCount: number;
  invulnTicks: number;
  eliminated: boolean;
  eliminatedTick: number; // -1 if not eliminated
  placement: number; // 0 until decided; 1 = winner
  jumpsUsed: number; // jumps taken since last grounded (0..MAX_JUMPS)
  inRingDanger: boolean; // taking ring (out-of-bounds) damage this tick -- presentation hook
  hitstopTicks: number; // ticks remaining of an active impact freeze, 0 = not frozen (see HITSTOP_* in knockback.ts)
}

export interface ItemSnapshot {
  active: boolean;
  typeId: number;
  posX: Fixed;
  posY: Fixed;
  velX: Fixed;
  velY: Fixed;
  state: number; // 0=world, 1=held, 2=thrown, 3=armed
  holder: number; // fighter index, -1 if none
  owner: number; // fighter index, -1 if never held
  timer: number;
  fuse: number; // -1 if not an armed explosive
}

export interface HazardSnapshot {
  active: boolean;
  posX: Fixed;
  posY: Fixed;
  velY: Fixed;
  timer: number;
}

// A character with no moves: attack input is simply a no-op. Used as the
// default so packages/sim never needs to import packages/content (the
// content -> sim data dependency runs one way, per the design docs); a
// caller that wants real attacks passes CharacterData from packages/content.
const DEFAULT_CHARACTER: CharacterData = {
  name: 'Unnamed',
  weight: fx.fromInt(100),
  hurtboxWidth: fx.fromFloat(1.6),
  hurtboxHeight: fx.fromFloat(3.2),
  moves: [],
};

const STICK_MOVE_THRESHOLD: Fixed = fx.fromFloat(0.5);
// Fighters mid-RESPAWN/DEAD are parked far below the arena so they can
// never be a candidate in the broad-phase grid or blast-zone check while
// inactive; this is simpler than adding an "active" bit to every hot-path
// read and is itself a deterministic constant, not wall-clock/random.
const LIMBO_Y: Fixed = fx.fromInt(-100000);

export class Sim {
  // Preallocated hot-path state. Never reassigned after construction.
  private readonly data: Int32Array;
  private readonly dedup: Int32Array; // N*N: last MOVE_INSTANCE of attacker i that hit defender j
  private rng: RngState;
  private tick = 0;
  private eliminatedCount = 0;
  /** Elimination attribution recorded this tick (transient, not part of the serialized
   *  state -- it is a ground-truth log for the server/tooling, not something the sim needs
   *  to replay). Cleared and repopulated at the top of every advance(). See EliminationCause. */
  readonly eliminationEvents: EliminationEvent[] = [];
  private blastMinX: Fixed;
  private blastMaxX: Fixed;
  private blastMinY: Fixed;
  private blastMaxY: Fixed;
  private readonly characters: readonly CharacterData[];
  private readonly arena: ArenaData;
  private readonly settings: MatchSettings;
  private readonly grid: SpatialGrid;
  // Scratch arrays reused every tick inside resolveHits, preallocated once
  // so the hot path never allocates.
  private readonly activeFlag: Uint8Array;
  private readonly itemsData: Int32Array;
  private readonly hazardsData: Int32Array;
  private readonly itemSet: ItemSet;
  private readonly hazardConfig: HazardConfig;
  private itemSpawnCooldown: number;
  private hazardSpawnCooldown: number;

  readonly numFighters: number;

  constructor(
    seed: number | bigint,
    numFighters: number,
    characters?: readonly CharacterData[],
    arena: ArenaData = DEFAULT_ARENA,
    matchSettings: Partial<MatchSettings> = {},
    itemSet: ItemSet = DEFAULT_ITEM_SET,
    hazardConfig: HazardConfig = DEFAULT_HAZARD_CONFIG,
  ) {
    if (numFighters < MIN_FIGHTERS || numFighters > MAX_FIGHTERS) {
      throw new RangeError(
        `Sim: numFighters must be between ${MIN_FIGHTERS} and ${MAX_FIGHTERS}, got ${numFighters}`,
      );
    }
    this.numFighters = numFighters;
    this.data = new Int32Array(numFighters * FighterField.FIELD_COUNT);
    this.dedup = new Int32Array(numFighters * numFighters);
    this.activeFlag = new Uint8Array(numFighters);
    this.grid = new SpatialGrid(numFighters);
    this.rng = seedRng(seed);
    this.characters =
      characters ?? Array.from({ length: numFighters }, () => DEFAULT_CHARACTER);
    if (this.characters.length !== numFighters) {
      throw new RangeError(
        `Sim: expected ${numFighters} character entries, got ${this.characters.length}`,
      );
    }
    this.arena = arena;
    this.settings = resolveMatchSettings(matchSettings);
    this.blastMinX = arena.blastMinX;
    this.blastMaxX = arena.blastMaxX;
    this.blastMinY = arena.blastMinY;
    this.blastMaxY = arena.blastMaxY;
    this.dedup.fill(-1);
    for (let i = 0; i < numFighters; i++) {
      this.fullResetFighter(i);
    }
    this.itemSet = itemSet;
    this.hazardConfig = hazardConfig;
    this.itemsData = new Int32Array(MAX_ITEMS * ItemField.FIELD_COUNT);
    this.hazardsData = new Int32Array(MAX_HAZARDS * HazardField.FIELD_COUNT);
    for (let i = 0; i < MAX_ITEMS; i++) {
      const base = i * ItemField.FIELD_COUNT;
      this.itemsData[base + ItemField.HOLDER] = -1;
      this.itemsData[base + ItemField.OWNER] = -1;
      this.itemsData[base + ItemField.FUSE] = -1;
    }
    this.itemSpawnCooldown = ITEM_SPAWN_INTERVAL_TICKS;
    this.hazardSpawnCooldown = hazardConfig.spawnIntervalMaxTicks;
  }

  private spawnPoint(index: number): { x: Fixed; y: Fixed } {
    const points = this.arena.spawnPoints;
    const p = points[index % points.length] ?? { x: 0, y: GROUND_Y };
    return p;
  }

  /** Respawn spawn choice for 'timedKO' (2026-09-11): plain round-robin
   * `spawnPoint` is fine for the initial, all-at-once match start, but
   * mid-match a respawning fighter must not drop back into whatever scrum
   * is currently happening at "their" fixed point. Instead pick, among the
   * arena's spawn points, the one whose distance to the *nearest* still-alive
   * fighter is largest (i.e. the most currently-empty corner of the stage).
   * Ties broken by lowest point index for determinism. O(points * fighters),
   * both tiny (<=8 in practice), so no perf concern. */
  private respawnSpawnPoint(index: number): { x: Fixed; y: Fixed } {
    const points = this.arena.spawnPoints;
    if (points.length === 0) return { x: 0 as Fixed, y: GROUND_Y as Fixed };
    let bestIdx = 0;
    let bestMinDistSq = -1;
    for (let pi = 0; pi < points.length; pi++) {
      const p = points[pi] as { x: Fixed; y: Fixed };
      let minDistSq = Number.POSITIVE_INFINITY;
      for (let fi = 0; fi < this.numFighters; fi++) {
        if (fi === index) continue;
        const fbase = fi * FighterField.FIELD_COUNT;
        if ((this.data[fbase + FighterField.ELIMINATED] as number) === 1) continue;
        const fstate = this.data[fbase + FighterField.STATE] as number;
        if (fstate === FighterStateId.RESPAWN || fstate === FighterStateId.DEAD) continue;
        const dx = (this.data[fbase + FighterField.POS_X] as number) - (p.x as number);
        const dy = (this.data[fbase + FighterField.POS_Y] as number) - (p.y as number);
        const distSq = dx * dx + dy * dy;
        if (distSq < minDistSq) minDistSq = distSq;
      }
      if (minDistSq === Number.POSITIVE_INFINITY) {
        // Nobody else alive/on-stage right now: any point is equally empty.
        minDistSq = 0;
      }
      if (minDistSq > bestMinDistSq) {
        bestMinDistSq = minDistSq;
        bestIdx = pi;
      }
    }
    return points[bestIdx] as { x: Fixed; y: Fixed };
  }

  /** Full reset for match start: stocks, KO/death counts, placement, and
   * elimination state all cleared. Distinct from `respawnFighter`, which
   * is a mid-match life reset that preserves match-level stats. */
  private fullResetFighter(index: number): void {
    const base = index * FighterField.FIELD_COUNT;
    const d = this.data;
    const sp = this.spawnPoint(index);
    d[base + FighterField.POS_X] = sp.x as number;
    d[base + FighterField.POS_Y] = sp.y as number;
    d[base + FighterField.VEL_X] = 0;
    d[base + FighterField.VEL_Y] = 0;
    d[base + FighterField.STATE] = FighterStateId.IDLE;
    d[base + FighterField.FACING] = index % 2 === 0 ? 1 : -1;
    d[base + FighterField.GROUNDED] = 1;
    d[base + FighterField.MOVE_ID] = -1;
    d[base + FighterField.MOVE_FRAME] = 0;
    d[base + FighterField.MOVE_INSTANCE] = 0;
    d[base + FighterField.PERCENT] = 0;
    d[base + FighterField.STOCKS] = this.settings.startingStocks;
    d[base + FighterField.SHIELD_HEALTH] = SHIELD_MAX_HEALTH;
    d[base + FighterField.SHIELD_STUN] = 0;
    d[base + FighterField.HITSTUN] = 0;
    d[base + FighterField.KO_COUNT] = 0;
    d[base + FighterField.DEATH_COUNT] = 0;
    d[base + FighterField.RESPAWN_TIMER] = 0;
    d[base + FighterField.INVULN_TIMER] = 0;
    d[base + FighterField.LAST_ATTACKER] = -1;
    d[base + FighterField.ELIMINATED] = 0;
    d[base + FighterField.ELIMINATED_TICK] = -1;
    d[base + FighterField.PLACEMENT] = 0;
    d[base + FighterField.JUMPS_USED] = 0;
    d[base + FighterField.PREV_JUMP_HELD] = 0;
    d[base + FighterField.DROP_THROUGH_TIMER] = 0;
    d[base + FighterField.RING_DAMAGE_TICK] = -1;
    d[base + FighterField.LAST_HIT_TICK] = -1;
    d[base + FighterField.HITSTOP_TICKS] = 0;
  }

  /** Mid-match life reset after a non-final KO: position/percent/shield
   * reset, brief invulnerability granted, but KO/death counts, stocks (the
   * caller already decremented) and elimination state are untouched. */
  private respawnFighter(index: number): void {
    const base = index * FighterField.FIELD_COUNT;
    const d = this.data;
    // 'timedKO' uses the scrum-avoiding spawn choice (see
    // respawnSpawnPoint's comment); 'stocks' keeps the original
    // round-robin spawnPoint unchanged -- it predates this task, is
    // golden-hash-fixed (replay-hashes.json uses 'stocks'), and changing
    // its respawn spot choice is a real behaviour change with no bug
    // report behind it, not something to bundle into this task silently.
    const sp = this.settings.winCondition === 'timedKO' ? this.respawnSpawnPoint(index) : this.spawnPoint(index);
    d[base + FighterField.POS_X] = sp.x as number;
    d[base + FighterField.POS_Y] = sp.y as number;
    d[base + FighterField.VEL_X] = 0;
    d[base + FighterField.VEL_Y] = 0;
    d[base + FighterField.PERCENT] = 0;
    d[base + FighterField.SHIELD_HEALTH] = SHIELD_MAX_HEALTH;
    d[base + FighterField.SHIELD_STUN] = 0;
    d[base + FighterField.HITSTUN] = 0;
    d[base + FighterField.MOVE_ID] = -1;
    d[base + FighterField.MOVE_FRAME] = 0;
    d[base + FighterField.GROUNDED] = 1;
    d[base + FighterField.RESPAWN_TIMER] = 0;
    d[base + FighterField.INVULN_TIMER] = this.settings.respawnInvulnTicks;
    d[base + FighterField.JUMPS_USED] = 0;
    d[base + FighterField.PREV_JUMP_HELD] = 0;
    d[base + FighterField.DROP_THROUGH_TIMER] = 0;
    d[base + FighterField.RING_DAMAGE_TICK] = -1;
    d[base + FighterField.LAST_HIT_TICK] = -1;
    d[base + FighterField.HITSTOP_TICKS] = 0;
    this.setState(base, FighterStateId.IDLE);
  }

  getTick(): number {
    return this.tick;
  }

  getMatchSettings(): MatchSettings {
    return this.settings;
  }

  /** Current (possibly shrunk) blast-zone rectangle, exposed for renderers
   * and spectator cameras — see arena-shrink.ts. */
  getCurrentBlastRect(): { minX: Fixed; maxX: Fixed; minY: Fixed; maxY: Fixed } {
    return { minX: this.blastMinX, maxX: this.blastMaxX, minY: this.blastMinY, maxY: this.blastMaxY };
  }

  /** Read-only accessor for the arena this Sim was constructed with
   * (platforms, starting blast rect, spawn points). Renderers need this
   * to draw the actual stage instead of assuming a hardcoded shape.
   * Never mutate the returned object. */
  getArena(): ArenaData {
    return this.arena;
  }

  private aliveCount(): number {
    let count = 0;
    for (let i = 0; i < this.numFighters; i++) {
      const base = i * FighterField.FIELD_COUNT;
      if ((this.data[base + FighterField.ELIMINATED] as number) === 0) count++;
    }
    return count;
  }

  /** For 'battleRoyale'/'stocks': index of the sole remaining fighter, or
   * null if the match is still ongoing or ended in a simultaneous multi-KO
   * with no survivor.
   * For 'timedKO' (2026-09-11): the top of `getLeaderboard()` (highest KO
   * count, ties broken by fewest deaths) -- but null, an explicit draw,
   * if the top two fighters are still tied on *both* KO count and death
   * count once those tie-breaks are exhausted. A fixed-index tie-break
   * (lowest fighter index wins) would be deterministic but not fair --
   * fighter 0 has no more claim to the win than fighter 1 -- so a real
   * tie is surfaced as a draw rather than silently resolved. */
  getWinner(): number | null {
    if (this.settings.winCondition === 'timedKO') {
      const board = this.getLeaderboard();
      const first = board[0] as number;
      const second = board[1];
      if (second === undefined) return first;
      const f1 = this.getFighter(first);
      const f2 = this.getFighter(second);
      if (f1.koCount === f2.koCount && f1.deathCount === f2.deathCount) return null;
      return first;
    }
    const alive: number[] = [];
    for (let i = 0; i < this.numFighters; i++) {
      const base = i * FighterField.FIELD_COUNT;
      if ((this.data[base + FighterField.ELIMINATED] as number) === 0) alive.push(i);
    }
    if (alive.length === 1) return alive[0] as number;
    return null;
  }

  isMatchOver(): boolean {
    if (this.settings.winCondition === 'timedKO') {
      return this.tick >= this.settings.timeLimitTicks;
    }
    return this.aliveCount() <= 1;
  }

  /** Fighter indices ordered by result: for elimination modes this is
   * placement order (1st..last); for 'timedKO' it is KO count descending,
   * ties broken by fewer deaths then lower fighter index, both fixed,
   * deterministic tie-breaks (never insertion/hash order). */
  getLeaderboard(): number[] {
    const indices = Array.from({ length: this.numFighters }, (_, i) => i);
    if (this.settings.winCondition === 'timedKO') {
      indices.sort((a, b) => {
        const ka = this.getFighter(a);
        const kb = this.getFighter(b);
        if (kb.koCount !== ka.koCount) return kb.koCount - ka.koCount;
        if (ka.deathCount !== kb.deathCount) return ka.deathCount - kb.deathCount;
        return a - b;
      });
      return indices;
    }
    indices.sort((a, b) => {
      const pa = this.data[a * FighterField.FIELD_COUNT + FighterField.PLACEMENT] as number;
      const pb = this.data[b * FighterField.FIELD_COUNT + FighterField.PLACEMENT] as number;
      const ra = pa === 0 ? Number.MAX_SAFE_INTEGER : pa;
      const rb = pb === 0 ? Number.MAX_SAFE_INTEGER : pb;
      if (ra !== rb) return ra - rb;
      return a - b;
    });
    return indices;
  }

  getFighter(index: number): FighterSnapshot {
    if (index < 0 || index >= this.numFighters) {
      throw new RangeError(`getFighter: index out of range: ${index}`);
    }
    const base = index * FighterField.FIELD_COUNT;
    const d = this.data;
    return {
      posX: d[base + FighterField.POS_X] as number,
      posY: d[base + FighterField.POS_Y] as number,
      velX: d[base + FighterField.VEL_X] as number,
      velY: d[base + FighterField.VEL_Y] as number,
      state: d[base + FighterField.STATE] as FighterStateValue,
      facing: (d[base + FighterField.FACING] as number) < 0 ? -1 : 1,
      grounded: (d[base + FighterField.GROUNDED] as number) !== 0,
      moveId: d[base + FighterField.MOVE_ID] as number,
      moveFrame: d[base + FighterField.MOVE_FRAME] as number,
      percent: d[base + FighterField.PERCENT] as number,
      stocks: d[base + FighterField.STOCKS] as number,
      shieldHealth: d[base + FighterField.SHIELD_HEALTH] as number,
      shieldStun: d[base + FighterField.SHIELD_STUN] as number,
      hitstun: d[base + FighterField.HITSTUN] as number,
      koCount: d[base + FighterField.KO_COUNT] as number,
      deathCount: d[base + FighterField.DEATH_COUNT] as number,
      invulnTicks: d[base + FighterField.INVULN_TIMER] as number,
      eliminated: (d[base + FighterField.ELIMINATED] as number) !== 0,
      eliminatedTick: d[base + FighterField.ELIMINATED_TICK] as number,
      placement: d[base + FighterField.PLACEMENT] as number,
      jumpsUsed: d[base + FighterField.JUMPS_USED] as number,
      hitstopTicks: d[base + FighterField.HITSTOP_TICKS] as number,
      // Presentation-only flag (see the field comment above): "did this
      // fighter take ring pressure on the tick that was just simulated".
      // RING_DAMAGE_TICK is written inside checkBlastZone using the
      // *pre-increment* this.tick (advance() only bumps this.tick at its
      // very end, line ~917, after every fighter has been updated), but
      // getFighter() is normally called by app-side code right after
      // advance() returns -- by then this.tick has already moved to the
      // next frame. Comparing against the bare current this.tick here
      // therefore never matched: this flag was always false, silently,
      // for the entire lifetime of the ring-pressure redesign. Proven via
      // packages/sim's own eliminationEvents ('ring'/'ring_lethal' causes
      // fire correctly -- this getter is the only thing that was wrong)
      // and confirmed live: packages/app's ring-damage audio cue reads
      // exactly this flag (see match.ts/net-match.ts) and had never once
      // fired. This is a read-only derived boolean, not a serialized sim
      // field -- it cannot affect determinism or the replay-hash goldens.
      inRingDanger: (d[base + FighterField.RING_DAMAGE_TICK] as number) === this.tick - 1,
    };
  }

  /** Read-only view of item slot `slot` for tests/tools — not used in the
   * hot path. STATE values: 0=world, 1=held, 2=thrown, 3=armed (see
   * ItemState in this file). */
  getItem(slot: number): ItemSnapshot {
    if (slot < 0 || slot >= MAX_ITEMS) throw new RangeError(`getItem: slot out of range: ${slot}`);
    const base = slot * ItemField.FIELD_COUNT;
    const d = this.itemsData;
    return {
      active: (d[base + ItemField.ACTIVE] as number) !== 0,
      typeId: d[base + ItemField.TYPE] as number,
      posX: d[base + ItemField.POS_X] as number,
      posY: d[base + ItemField.POS_Y] as number,
      velX: d[base + ItemField.VEL_X] as number,
      velY: d[base + ItemField.VEL_Y] as number,
      state: d[base + ItemField.STATE] as number,
      holder: d[base + ItemField.HOLDER] as number,
      owner: d[base + ItemField.OWNER] as number,
      timer: d[base + ItemField.TIMER] as number,
      fuse: d[base + ItemField.FUSE] as number,
    };
  }

  /** Read-only view of hazard slot `slot` for tests/tools. */
  getHazard(slot: number): HazardSnapshot {
    if (slot < 0 || slot >= MAX_HAZARDS) throw new RangeError(`getHazard: slot out of range: ${slot}`);
    const base = slot * HazardField.FIELD_COUNT;
    const d = this.hazardsData;
    return {
      active: (d[base + HazardField.ACTIVE] as number) !== 0,
      posX: d[base + HazardField.POS_X] as number,
      posY: d[base + HazardField.POS_Y] as number,
      velY: d[base + HazardField.VEL_Y] as number,
      timer: d[base + HazardField.TIMER] as number,
    };
  }

  private stateWords(): number {
    return (
      this.numFighters * FighterField.FIELD_COUNT +
      this.numFighters * this.numFighters +
      RNG_FIELD_WORDS +
      TICK_WORDS +
      ELIMINATED_COUNT_WORDS +
      BLAST_RECT_WORDS +
      MAX_ITEMS * ItemField.FIELD_COUNT +
      MAX_HAZARDS * HazardField.FIELD_COUNT +
      2 // itemSpawnCooldown, hazardSpawnCooldown
    );
  }

  /** Allocate a StateBuffer sized for this sim. Call once at match setup /
   * whenever a rollback buffer pool is being built — never inside the hot
   * per-tick loop. */
  createStateBuffer(): StateBuffer {
    return new Int32Array(this.stateWords());
  }

  /** Copy current sim state into `buf` (no allocation). */
  saveState(buf: StateBuffer): void {
    if (buf.length !== this.stateWords()) {
      throw new RangeError('saveState: buffer size mismatch');
    }
    const fighterWords = this.numFighters * FighterField.FIELD_COUNT;
    const dedupWords = this.numFighters * this.numFighters;
    buf.set(this.data, 0);
    buf.set(this.dedup, fighterWords);
    let off = fighterWords + dedupWords;
    const [s0lo, s0hi] = bigintToWords(this.rng.s0);
    const [s1lo, s1hi] = bigintToWords(this.rng.s1);
    buf[off++] = s0lo;
    buf[off++] = s0hi;
    buf[off++] = s1lo;
    buf[off++] = s1hi;
    buf[off++] = this.tick;
    buf[off++] = this.eliminatedCount;
    buf[off++] = this.blastMinX as number;
    buf[off++] = this.blastMaxX as number;
    buf[off++] = this.blastMinY as number;
    buf[off++] = this.blastMaxY as number;
    buf.set(this.itemsData, off);
    off += this.itemsData.length;
    buf.set(this.hazardsData, off);
    off += this.hazardsData.length;
    buf[off++] = this.itemSpawnCooldown;
    buf[off++] = this.hazardSpawnCooldown;
  }

  /** Restore sim state from a previously saved buffer (no allocation). */
  loadState(buf: StateBuffer): void {
    if (buf.length !== this.stateWords()) {
      throw new RangeError('loadState: buffer size mismatch');
    }
    const fighterWords = this.numFighters * FighterField.FIELD_COUNT;
    const dedupWords = this.numFighters * this.numFighters;
    this.data.set(buf.subarray(0, fighterWords));
    this.dedup.set(buf.subarray(fighterWords, fighterWords + dedupWords));
    let off = fighterWords + dedupWords;
    const s0 = wordsToBigint(buf[off] as number, buf[off + 1] as number);
    const s1 = wordsToBigint(buf[off + 2] as number, buf[off + 3] as number);
    off += 4;
    this.rng = { s0, s1 };
    this.tick = buf[off++] as number;
    this.eliminatedCount = buf[off++] as number;
    this.blastMinX = buf[off++] as number;
    this.blastMaxX = buf[off++] as number;
    this.blastMinY = buf[off++] as number;
    this.blastMaxY = buf[off++] as number;
    this.itemsData.set(buf.subarray(off, off + this.itemsData.length));
    off += this.itemsData.length;
    this.hazardsData.set(buf.subarray(off, off + this.hazardsData.length));
    off += this.hazardsData.length;
    this.itemSpawnCooldown = buf[off++] as number;
    this.hazardSpawnCooldown = buf[off++] as number;
  }

  private dedupIndex(attacker: number, defender: number): number {
    return attacker * this.numFighters + defender;
  }

  /** True while `posX`/`posY` are over some platform's solid surface,
   * i.e. there is ground to catch a fall here at all. Used only to decide
   * whether normal (non-hitstun) movement clamps to a platform; the actual
   * landing test in stepFighter also needs the specific platform's y. */
  private findLandingPlatform(
    posX: Fixed,
    prevY: Fixed,
    nextY: Fixed,
    ignorePassThrough = false,
  ): Platform | null {
    let best: Platform | null = null;
    for (const p of this.arena.platforms) {
      if (ignorePassThrough && p.kind === 'pass-through') continue;
      if (posX < p.minX || posX > p.maxX) continue;
      if (prevY >= p.y && nextY <= p.y) {
        if (best === null || p.y > best.y) best = p;
      }
    }
    return best;
  }

  /** The specific platform (if any) a grounded fighter is currently
   * standing on -- used only to decide whether a drop-through input is
   * legal (must be standing on a 'pass-through' platform, not solid
   * ground). */
  private findStandingPlatform(posX: Fixed, posY: Fixed): Platform | null {
    for (const p of this.arena.platforms) {
      if (posX >= p.minX && posX <= p.maxX && p.y === posY) return p;
    }
    return null;
  }

  /** Public, read-only: is this fighter (by index) currently standing on
   * a 'pass-through' platform, i.e. could legally drop through it with
   * down+jump right now? Added 2026-09-09 so BotController (which only
   * ever reads through public snapshot accessors -- see the file header
   * of ai/bot.ts on why that matters for determinism) can decide to
   * drop-through without packages/sim exposing any bot-specific state.
   * O(platform count) per call, same cost class as findStandingPlatform
   * itself, and platform counts per arena are single digits. */
  isStandingOnPassThroughPlatform(index: number): boolean {
    const base = index * FighterField.FIELD_COUNT;
    const grounded = this.data[base + FighterField.GROUNDED] === 1;
    if (!grounded) return false;
    const posX = this.data[base + FighterField.POS_X] as Fixed;
    const posY = this.data[base + FighterField.POS_Y] as Fixed;
    const p = this.findStandingPlatform(posX, posY);
    return p !== null && p.kind === 'pass-through';
  }

  /** Clamp a horizontal move from prevX to candidateX against any wall
   * whose y-range covers this fighter's current feet position (posY).
   * Walls block crossing from either side; a fighter already embedded
   * past a wall face (shouldn't happen under normal play, but knockback
   * could in principle place one there) is left alone rather than
   * snapped, to avoid any risk of an unbounded correction. */
  private clampToWalls(prevX: Fixed, candidateX: Fixed, posY: Fixed, halfWidth: Fixed): Fixed {
    let x = candidateX;
    for (const w of this.arena.walls ?? []) {
      if (posY < w.minY || posY > w.maxY) continue;
      const faceLeft = fx.sub(w.x, halfWidth);
      const faceRight = fx.add(w.x, halfWidth);
      if (prevX <= faceLeft && x > faceLeft) {
        x = fx.min(x, faceLeft);
      } else if (prevX >= faceRight && x < faceRight) {
        x = fx.max(x, faceRight);
      }
    }
    return x;
  }

  private onAnyPlatform(posX: Fixed): boolean {
    for (const p of this.arena.platforms) {
      if (posX >= p.minX && posX <= p.maxX) return true;
    }
    return false;
  }

  /** Advance the sim by exactly one fixed 60Hz tick. Must not allocate. */
  advance(inputs: readonly InputFrame[]): void {
    if (inputs.length !== this.numFighters) {
      throw new RangeError(`advance: expected ${this.numFighters} inputs, got ${inputs.length}`);
    }
    this.eliminationEvents.length = 0;
    for (let i = 0; i < this.numFighters; i++) {
      this.stepFighter(i, inputs[i] as InputFrame);
    }
    // Hit resolution runs after movement, in fixed ascending fighter-index
    // order for attackers, and the broad-phase grid's candidate order is
    // itself index-ordered (see broadphase.ts) — never Map/Set iteration,
    // hash ordering, or anything tied to object identity. So the outcome
    // is deterministic regardless of "who acted first" in wall-clock terms
    // and regardless of the order fighters were constructed/added in.
    this.grid.build(
      this.numFighters,
      (i) => this.data[i * FighterField.FIELD_COUNT + FighterField.POS_X] as number,
      (i) => this.data[i * FighterField.FIELD_COUNT + FighterField.POS_Y] as number,
      (i) => {
        const s = this.data[i * FighterField.FIELD_COUNT + FighterField.STATE] as number;
        return s !== FighterStateId.DEAD && s !== FighterStateId.RESPAWN;
      },
    );
    for (let attacker = 0; attacker < this.numFighters; attacker++) {
      this.resolveHitsFor(attacker);
    }
    // Recompute the arena-shrink blast rectangle from *this* tick's alive
    // count before checking anyone against it, so a KO that just reduced
    // the alive count tightens the ring the same tick for everyone still
    // in play (deterministic function of tick + alive count, see
    // arena-shrink.ts; stored back into state so save/load carries it).
    // Rate-limit the ring's *movement*, not just its target: without this,
    // a burst of eliminations (e.g. two fighters trading a double-KO) can
    // drop the alive count enough that the population-aware safe extents
    // in arena-shrink.ts jump straight to a much smaller target on the
    // very next tick, instantly stranding everyone else outside it -- the
    // "arena collapse cascade" (see wiki "Arena Collapse Cascade: Why
    // Matches End With Nobody Left"). The ring is meant to be pressure,
    // not an executioner: a fighter standing in what was safe ground a
    // moment ago must get a real window to see the ring move and react,
    // not be killed by a discontinuity. MAX_SHRINK_STEP caps how far any
    // one edge can move in a single 60Hz tick; the schedule in
    // arena-shrink.ts still decides the *target*, this only smooths the
    // approach to it -- 0.75 units/tick = 45 units/sec, comfortably
    // faster than the schedule's steady-state closing speed (ordinary
    // play unaffected) but slow enough that even the largest single-tick
    // jump in target takes several real seconds to fully arrive.
    const target = computeCurrentBlastRect(this.arena, this.tick, this.aliveCount(), this.numFighters, this.settings);
    const maxStep: Fixed = fx.fromFloat(0.75);
    const stepToward = (prev: Fixed, next: Fixed): Fixed => {
      if ((next as number) > (prev as number)) return fx.min(next, fx.add(prev, maxStep));
      if ((next as number) < (prev as number)) return fx.max(next, fx.sub(prev, maxStep));
      return next;
    };
    this.blastMinX = stepToward(this.blastMinX, target.minX);
    this.blastMaxX = stepToward(this.blastMaxX, target.maxX);
    this.blastMinY = stepToward(this.blastMinY, target.minY);
    this.blastMaxY = stepToward(this.blastMaxY, target.maxY);
    // Items and hazards (this task's items 1/2): world/held/thrown/armed
    // item physics and use-effects, then hazard fall/damage, then the two
    // PRNG-driven spawn attempts — all after combat/blast-zone resolution
    // so a KO this tick is reflected in aliveCount for hazard intensity
    // and in the blast rect items/hazards despawn against.
    this.stepItems();
    this.stepHazards();
    this.trySpawnItem();
    this.trySpawnHazard();
    for (let i = 0; i < this.numFighters; i++) {
      this.checkBlastZone(i);
    }
    // Draw one RNG value per tick so PRNG progression is itself part of the
    // deterministic, hashable state (exercises the RNG in the hot path
    // without affecting movement yet — future hit-chance rolls hook here).
    const { value, state } = nextUint32(this.rng);
    this.rng = state;
    void value;
    this.tick = (this.tick + 1) | 0;
  }

  private setState(base: number, next: FighterStateValue): void {
    const current = this.data[base + FighterField.STATE] as FighterStateValue;
    assertTransition(current, next);
    this.data[base + FighterField.STATE] = next;
  }

  private startMove(index: number, base: number, moveId: number): void {
    const d = this.data;
    const nextInstance = ((d[base + FighterField.MOVE_INSTANCE] as number) + 1) | 0;
    d[base + FighterField.MOVE_ID] = moveId;
    d[base + FighterField.MOVE_FRAME] = 0;
    d[base + FighterField.MOVE_INSTANCE] = nextInstance;
    this.setState(base, FighterStateId.ATTACK);
    void index;
  }

  private stepFighter(index: number, input: InputFrame): void {
    const base = index * FighterField.FIELD_COUNT;
    const d = this.data;

    // HITSTOP: a brief, deterministic freeze of this fighter's own
    // simulation on contact -- gameplay, not presentation (see wiki
    // "Game Feel, Audio, and Reconnection"'s presentation-only rule and
    // its explicit callout that a *real* hitstop would have to live here,
    // identically on server and every client, or online play desyncs).
    // Frozen means frozen: position, velocity, state, move timing, invuln
    // and drop-through timers, jump-edge bookkeeping -- nothing for this
    // fighter advances this tick, only the freeze countdown itself. This
    // is deliberately scoped to a single fighter's own slice of the state
    // array: an uninvolved fighter's stepFighter call is entirely
    // unaffected, so a hit anywhere in a 20-player brawl never stalls
    // anyone but the two fighters actually in it. checkBlastZone (ring
    // damage/push, blast-zone elimination) and resolveHitsFor both still
    // run against a frozen fighter's unchanged-this-tick position exactly
    // as they would for any other tick, so a frozen fighter can still be
    // pushed out of bounds, take ring damage, be eliminated, or take a
    // second real hit -- hitstop holds the *actor*, it grants no
    // invulnerability. See knockback.ts HITSTOP_* for how long this is.
    const hitstopTicks = d[base + FighterField.HITSTOP_TICKS] as number;
    if (hitstopTicks > 0) {
      d[base + FighterField.HITSTOP_TICKS] = (hitstopTicks - 1) | 0;
      return;
    }

    const state = d[base + FighterField.STATE] as FighterStateValue;

    if ((d[base + FighterField.INVULN_TIMER] as number) > 0) {
      d[base + FighterField.INVULN_TIMER] = (d[base + FighterField.INVULN_TIMER] as number) - 1;
    }
    if ((d[base + FighterField.DROP_THROUGH_TIMER] as number) > 0) {
      d[base + FighterField.DROP_THROUGH_TIMER] = (d[base + FighterField.DROP_THROUGH_TIMER] as number) - 1;
    }

    // Edge-trigger bookkeeping for the jump button: updated unconditionally
    // every tick (even through hitstun/attack/respawn states) so a held
    // button never queues up a jump that fires the instant control returns
    // to the player — only the tick the button transitions low->high counts.
    const jumpHeldNow = (input.buttons & BUTTON_JUMP) !== 0;
    const jumpEdge = jumpHeldNow && (d[base + FighterField.PREV_JUMP_HELD] as number) === 0;
    d[base + FighterField.PREV_JUMP_HELD] = jumpHeldNow ? 1 : 0;

    if (state === FighterStateId.DEAD) {
      // Eliminated for good: no physics, no input, no timers.
      return;
    }

    if (state === FighterStateId.RESPAWN) {
      let timer = (d[base + FighterField.RESPAWN_TIMER] as number) - 1;
      if (timer <= 0) {
        this.respawnFighter(index);
      } else {
        d[base + FighterField.RESPAWN_TIMER] = timer;
      }
      void timer;
      return;
    }

    let velX = d[base + FighterField.VEL_X] as number;
    let velY = d[base + FighterField.VEL_Y] as number;
    let posX = d[base + FighterField.POS_X] as number;
    let posY = d[base + FighterField.POS_Y] as number;
    let grounded = (d[base + FighterField.GROUNDED] as number) !== 0;
    let facing = d[base + FighterField.FACING] as number;
    let hitstun = d[base + FighterField.HITSTUN] as number;
    let shieldStun = d[base + FighterField.SHIELD_STUN] as number;
    let moveId = d[base + FighterField.MOVE_ID] as number;
    let moveFrame = d[base + FighterField.MOVE_FRAME] as number;

    const character = this.characters[index] as CharacterData;

    if (hitstun > 0) {
      velX = fx.add(velX, fx.mul(input.stickX, HITSTUN_DI_ACCEL_PER_TICK));
      velY = fx.add(velY, fx.mul(input.stickY, HITSTUN_DI_ACCEL_PER_TICK));
      if (grounded) {
        velX = fx.mul(velX, GROUND_FRICTION);
      } else {
        velY = fx.add(velY, GRAVITY);
        velY = fx.max(velY, TERMINAL_VELOCITY);
      }
      const prevY = posY;
      const prevX = posX;
      posX = fx.add(posX, velX);
      const wallHalfWidth = fx.div(character.hurtboxWidth, fx.fromInt(2));
      posX = this.clampToWalls(prevX, posX, posY, wallHalfWidth);
      posY = fx.add(posY, velY);
      const dropThroughTimer = d[base + FighterField.DROP_THROUGH_TIMER] as number;
      const landing = this.findLandingPlatform(posX, prevY, posY, dropThroughTimer > 0);
      if (landing) {
        posY = landing.y;
        velY = 0;
        grounded = true;
        d[base + FighterField.DROP_THROUGH_TIMER] = 0;
      } else {
        grounded = false;
      }
      hitstun = (hitstun - 1) | 0;
      if (hitstun === 0) {
        this.setState(base, grounded ? FighterStateId.IDLE : FighterStateId.AIRBORNE);
      }
      this.writeBack(base, { posX, posY, velX, velY, grounded, facing, moveId: -1, moveFrame: 0, hitstun, shieldStun });
      return;
    }

    if (shieldStun > 0) {
      shieldStun = (shieldStun - 1) | 0;
      if (shieldStun === 0) {
        this.setState(base, FighterStateId.IDLE);
      }
      this.writeBack(base, { posX, posY, velX: 0, velY: 0, grounded, facing, moveId: -1, moveFrame: 0, hitstun, shieldStun });
      return;
    }

    if (state === FighterStateId.SHIELD) {
      if ((input.buttons & BUTTON_SHIELD) !== 0) {
        this.writeBack(base, { posX, posY, velX: 0, velY: 0, grounded, facing, moveId: -1, moveFrame: 0, hitstun, shieldStun });
        return;
      }
      this.setState(base, FighterStateId.IDLE);
      // fall through to normal movement handling below this tick.
    }

    if (state === FighterStateId.ATTACK) {
      const move = findMove(character, moveId as never);
      const total = move ? moveTotalDuration(move) : 0;
      moveFrame = (moveFrame + 1) | 0;
      if (!grounded) {
        velY = fx.add(velY, GRAVITY);
        velY = fx.max(velY, TERMINAL_VELOCITY);
      } else {
        velX = 0;
      }
      const prevY = posY;
      const prevX = posX;
      posX = fx.add(posX, velX);
      const wallHalfWidth = fx.div(character.hurtboxWidth, fx.fromInt(2));
      posX = this.clampToWalls(prevX, posX, posY, wallHalfWidth);
      posX = this.clampToPlatform(posX);
      posY = fx.add(posY, velY);
      const dropThroughTimer = d[base + FighterField.DROP_THROUGH_TIMER] as number;
      const landing = this.findLandingPlatform(posX, prevY, posY, dropThroughTimer > 0);
      if (landing) {
        posY = landing.y;
        velY = 0;
        grounded = true;
        d[base + FighterField.DROP_THROUGH_TIMER] = 0;
      } else {
        grounded = false;
      }
      if (moveFrame >= total) {
        moveId = -1;
        moveFrame = 0;
        this.setState(base, grounded ? (velX !== 0 ? FighterStateId.RUN : FighterStateId.IDLE) : FighterStateId.AIRBORNE);
      }
      this.writeBack(base, { posX, posY, velX, velY, grounded, facing, moveId, moveFrame, hitstun, shieldStun });
      return;
    }

    // --- Normal (idle/run/jump/airborne) movement + move-start triggers ---
    const wantsShield = (input.buttons & BUTTON_SHIELD) !== 0;
    if (grounded && wantsShield) {
      velX = 0;
      this.setState(base, FighterStateId.SHIELD);
      this.writeBack(base, { posX, posY, velX: 0, velY: 0, grounded, facing, moveId: -1, moveFrame: 0, hitstun, shieldStun });
      return;
    }

    const wantsAttack = (input.buttons & BUTTON_ATTACK) !== 0;
    const heldItemSlot = wantsAttack ? this.findHeldItemSlot(index) : -1;
    if (heldItemSlot >= 0) {
      // Holding an item takes over the attack button entirely; the
      // character's own moves don't fire until the item is used/gone.
      this.useHeldItem(index, heldItemSlot);
      this.writeBack(base, { posX, posY, velX, velY, grounded, facing, moveId, moveFrame, hitstun, shieldStun });
      return;
    }
    if (wantsAttack && character.moves.length > 0) {
      let chosen: MoveIdValue;
      if (grounded) {
        chosen = fx.abs(input.stickX) > STICK_MOVE_THRESHOLD ? MoveId.FTILT : MoveId.JAB;
      } else {
        chosen = input.stickY < fx.neg(STICK_MOVE_THRESHOLD) ? MoveId.DAIR : MoveId.UAIR;
      }
      if (findMove(character, chosen)) {
        this.startMove(index, base, chosen);
        this.writeBack(base, { posX, posY, velX: 0, velY, grounded, facing, moveId: chosen, moveFrame: 0, hitstun, shieldStun });
        return;
      }
    }

    velX = fx.mul(input.stickX, MOVE_SPEED);
    if (velX > 0) facing = 1;
    else if (velX < 0) facing = -1;

    // Deliberate drop-through: holding stick-down and pressing jump while
    // grounded on a 'pass-through' platform drops the fighter through it
    // instead of jumping -- the standard genre convention. Solid ground
    // (a stage's main floor) is never droppable this way, so this only
    // applies when the platform actually standing on is 'pass-through'.
    let droppingThrough = false;
    if (grounded && jumpEdge && input.stickY < fx.neg(STICK_MOVE_THRESHOLD)) {
      const standingOn = this.findStandingPlatform(posX, posY);
      if (standingOn && standingOn.kind === 'pass-through') {
        droppingThrough = true;
      }
    }

    let jumpsUsed = d[base + FighterField.JUMPS_USED] as number;
    if (grounded) jumpsUsed = 0; // landed (or never left): both jumps refreshed
    if (jumpEdge && jumpsUsed < MAX_JUMPS && !droppingThrough) {
      velY = grounded ? JUMP_VELOCITY : DOUBLE_JUMP_VELOCITY;
      grounded = false;
      jumpsUsed = (jumpsUsed + 1) | 0;
    }
    d[base + FighterField.JUMPS_USED] = jumpsUsed;

    let dropThroughTimer = d[base + FighterField.DROP_THROUGH_TIMER] as number;
    if (droppingThrough) {
      // Small downward nudge clears the platform's landing threshold this
      // same tick; the timer keeps findLandingPlatform blind to
      // 'pass-through' platforms for a few more ticks so the fighter
      // doesn't immediately re-land on the one it just left.
      velY = fx.neg(fx.fromFloat(1.0));
      grounded = false;
      dropThroughTimer = DROP_THROUGH_TICKS;
    }

    if (!grounded) {
      velY = fx.add(velY, GRAVITY);
      velY = fx.max(velY, TERMINAL_VELOCITY);
    }

    const prevY = posY;
    const prevX = posX;
    posX = fx.add(posX, velX);
    const wallHalfWidth = fx.div(character.hurtboxWidth, fx.fromInt(2));
    posX = this.clampToWalls(prevX, posX, posY, wallHalfWidth);
    posX = this.clampToPlatform(posX);
    posY = fx.add(posY, velY);

    const ignorePassThrough = droppingThrough || dropThroughTimer > 0;
    const landing = this.findLandingPlatform(posX, prevY, posY, ignorePassThrough);
    if (landing) {
      posY = landing.y;
      velY = 0;
      grounded = true;
      dropThroughTimer = 0;
    }
    d[base + FighterField.DROP_THROUGH_TIMER] = dropThroughTimer;

    const nextState: FighterStateValue = grounded
      ? velX !== 0
        ? FighterStateId.RUN
        : FighterStateId.IDLE
      : FighterStateId.AIRBORNE;
    this.setState(base, nextState);

    this.writeBack(base, { posX, posY, velX, velY, grounded, facing, moveId: -1, moveFrame: 0, hitstun, shieldStun });
  }

  /** Clamp posX to whichever platform's x-range currently contains it, so
   * voluntary movement cannot walk off a platform edge under normal
   * control (only knockback can leave one, matching the original 2-fighter
   * behavior, generalized to "some platform" rather than "the platform"). */
  private clampToPlatform(posX: Fixed): Fixed {
    let best = posX;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const p of this.arena.platforms) {
      const clamped = fx.clamp(posX, p.minX, p.maxX);
      const dist = Math.abs(fx.toFloat(fx.sub(clamped, posX)));
      if (dist < bestDist) {
        bestDist = dist;
        best = clamped;
      }
    }
    return best;
  }

  private writeBack(
    base: number,
    v: {
      posX: Fixed;
      posY: Fixed;
      velX: Fixed;
      velY: Fixed;
      grounded: boolean;
      facing: number;
      moveId: number;
      moveFrame: number;
      hitstun: number;
      shieldStun: number;
    },
  ): void {
    const d = this.data;
    d[base + FighterField.POS_X] = v.posX;
    d[base + FighterField.POS_Y] = v.posY;
    d[base + FighterField.VEL_X] = v.velX;
    d[base + FighterField.VEL_Y] = v.velY;
    d[base + FighterField.GROUNDED] = v.grounded ? 1 : 0;
    d[base + FighterField.FACING] = v.facing;
    d[base + FighterField.MOVE_ID] = v.moveId;
    d[base + FighterField.MOVE_FRAME] = v.moveFrame;
    d[base + FighterField.HITSTUN] = v.hitstun;
    d[base + FighterField.SHIELD_STUN] = v.shieldStun;
  }

  /** For fighter `attacker` currently in the ATTACK state, find its active
   * window's hitboxes (if any) and resolve overlap against nearby
   * defenders via the broad-phase grid. One hit per target per move
   * activation, enforced via the MOVE_INSTANCE / dedup table. */
  private resolveHitsFor(attacker: number): void {
    const d = this.data;
    const aBase = attacker * FighterField.FIELD_COUNT;
    if ((d[aBase + FighterField.STATE] as number) !== FighterStateId.ATTACK) return;

    const attackerChar = this.characters[attacker] as CharacterData;
    const moveId = d[aBase + FighterField.MOVE_ID] as number;
    const move = findMove(attackerChar, moveId as never) as MoveDef | undefined;
    if (!move) return;
    const moveFrame = d[aBase + FighterField.MOVE_FRAME] as number;
    // moveFrame was already incremented for *this* tick in stepFighter, so
    // the window we just finished executing is (moveFrame - 1).
    const located = windowAtFrame(move, moveFrame - 1);
    if (!located || located.window.kind !== 'active' || located.window.hitboxes.length === 0) return;

    const attackerFacing = d[aBase + FighterField.FACING] as number;
    const attackerX = d[aBase + FighterField.POS_X] as number;
    const attackerY = d[aBase + FighterField.POS_Y] as number;
    const moveInstance = d[aBase + FighterField.MOVE_INSTANCE] as number;

    for (const hb of located.window.hitboxes) {
      const mirroredOffsetX = attackerFacing < 0 ? fx.neg(hb.offsetX) : hb.offsetX;
      const worldX = fx.add(attackerX, mirroredOffsetX);
      const worldY = fx.add(attackerY, hb.offsetY);
      const box: Box = makeBoxCentered(worldX, worldY, hb.width, hb.height);
      // The grid buckets each entity by a single point (its center), not
      // by the extent of its hurtbox (see broadphase.ts SpatialGrid.build).
      // A defender whose hurtbox overlaps this hitbox's box can still be
      // centered one cell over — e.g. hitbox box max at x=159.99 with a
      // defender centered at x=161.47 (cell boundary at 160) is a real
      // overlap that a same-cell-only query would miss. Pad the query
      // range by HIT_QUERY_MARGIN (comfortably larger than any hurtbox's
      // half-extent) so the candidate set always includes any entity
      // whose *center* could be near enough to have an overlapping box;
      // tryApplyHit's exact aabbOverlap check afterward means this can
      // only add extra candidates to reject, never a false hit.
      this.grid.queryBox(
        fx.sub(box.minX, HIT_QUERY_MARGIN),
        fx.sub(box.minY, HIT_QUERY_MARGIN),
        fx.add(box.maxX, HIT_QUERY_MARGIN),
        fx.add(box.maxY, HIT_QUERY_MARGIN),
        (defender) => {
          if (defender === attacker) return;
          this.tryApplyHit(attacker, defender, box, hb, moveInstance);
        },
      );
    }
  }

  private tryApplyHit(
    attacker: number,
    defender: number,
    hitboxBox: Box,
    hb: MoveDef['windows'][number]['hitboxes'][number],
    moveInstance: number,
  ): void {
    const d = this.data;
    const dBase = defender * FighterField.FIELD_COUNT;
    const defenderState = d[dBase + FighterField.STATE] as number;
    if (defenderState === FighterStateId.DEAD || defenderState === FighterStateId.RESPAWN) return;
    if ((d[dBase + FighterField.INVULN_TIMER] as number) > 0) return;

    const dedupIdx = this.dedupIndex(attacker, defender);
    if ((this.dedup[dedupIdx] as number) === moveInstance) return; // already hit this activation

    const defenderChar = this.characters[defender] as CharacterData;
    const defenderX = d[dBase + FighterField.POS_X] as number;
    const defenderY = d[dBase + FighterField.POS_Y] as number;
    const defenderBox = makeBoxCentered(defenderX, defenderY, defenderChar.hurtboxWidth, defenderChar.hurtboxHeight);
    if (!aabbOverlap(hitboxBox, defenderBox)) return;

    this.dedup[dedupIdx] = moveInstance;
    d[dBase + FighterField.LAST_ATTACKER] = attacker;
    d[dBase + FighterField.LAST_HIT_TICK] = this.tick;

    if (defenderState === FighterStateId.SHIELD) {
      const shieldLoss = fx.mul(hb.damage, SHIELD_DAMAGE_MULTIPLIER);
      const healthBefore = d[dBase + FighterField.SHIELD_HEALTH] as number;
      const healthAfter = fx.sub(healthBefore, shieldLoss);
      d[dBase + FighterField.SHIELD_HEALTH] = healthAfter > 0 ? healthAfter : 0;
      if (healthAfter <= 0) {
        d[dBase + FighterField.SHIELD_HEALTH] = SHIELD_MAX_HEALTH;
        d[dBase + FighterField.SHIELD_STUN] = SHIELD_BREAK_HITSTUN_TICKS;
      } else {
        const stunTicks = fx.toInt(fx.mul(hb.damage, SHIELD_STUN_PER_DAMAGE));
        d[dBase + FighterField.SHIELD_STUN] = stunTicks < 1 ? 1 : stunTicks;
      }
      d[dBase + FighterField.VEL_X] = 0;
      d[dBase + FighterField.VEL_Y] = 0;
      return;
    }

    // Crowd-aware damage scale (see knockback.ts crowdDamageScale): a
    // 20-player free-for-all lets many attackers land hits on the same
    // fighter in a window a 1v1 combat model never accounted for, so scale
    // the authored per-move damage down while many fighters are alive and
    // let it converge back to full duel damage as the lobby thins out.
    // Deliberately scoped to fighter-vs-fighter hits only -- ring pressure
    // and item/hazard damage keep their own separately-tuned constants.
    const scaledDamage = fx.mul(hb.damage, crowdDamageScale(this.aliveCount()));
    const percentBefore = d[dBase + FighterField.PERCENT] as number;
    const percentAfter = fx.add(percentBefore, scaledDamage);
    d[dBase + FighterField.PERCENT] = percentAfter;

    // Knockback magnitude is deliberately fed the *unscaled* per-move
    // damage (hb.damage), not scaledDamage, even though percent accrual
    // above uses scaledDamage. See knockback.ts crowdDamageScale doc and
    // wiki "Combat Model: Knockback, Hitstun, and DI" (2026-09-14 update):
    // crowdDamageScale exists so percent climbs at a sane rate across a
    // full 20-player match instead of saturating in the opening seconds --
    // it was never meant to make individual hits push people around less.
    // percentAfter (the real, slow-climbing accumulated percent) is still
    // passed through untouched, so a fighter already damaged still flies
    // further per hit, exactly as in a 1v1 duel -- only the *raw damage*
    // term of the formula is decoupled from the crowd scale.
    const magnitude = computeKnockbackMagnitude(
      hb.damage,
      percentAfter,
      hb.baseKnockback,
      hb.knockbackGrowth,
      defenderChar.weight,
      this.tick,
    );
    const attackerBase = attacker * FighterField.FIELD_COUNT;
    const attackerFacing = d[attackerBase + FighterField.FACING] as number;
    const angleIdx = attackerFacing < 0 ? mirrorAngleIdx(hb.angleIdx) : hb.angleIdx;

    const velX = fx.mul(cosLUT(angleIdx), magnitude);
    const velY = fx.mul(sinLUT(angleIdx), magnitude);
    d[dBase + FighterField.VEL_X] = velX;
    d[dBase + FighterField.VEL_Y] = velY;
    d[dBase + FighterField.HITSTUN] = computeHitstunTicks(magnitude);
    d[dBase + FighterField.GROUNDED] = 0;
    d[dBase + FighterField.MOVE_ID] = -1;
    d[dBase + FighterField.MOVE_FRAME] = 0;
    this.setState(dBase, FighterStateId.HITSTUN);

    // HITSTOP: both attacker and defender freeze (the standard genre
    // convention -- freezing only the victim reads as the attacker's
    // limb clipping through a statue; freezing only the attacker reads as
    // the victim being unaffected). Scoped to exactly these two fighter
    // slots, so the other (up to) eighteen fighters in the match are
    // never touched. Take the max against whatever freeze is already
    // queued rather than adding, so simultaneous multi-hitbox hits (or a
    // hit landing again before an already-queued freeze finishes ticking
    // down) can refresh the freeze up to computeHitstopTicks' own cap,
    // never stack past it -- see knockback.ts HITSTOP_* doc.
    const hitstopTicks = computeHitstopTicks(magnitude);
    const currentDefenderHitstop = d[dBase + FighterField.HITSTOP_TICKS] as number;
    d[dBase + FighterField.HITSTOP_TICKS] =
      currentDefenderHitstop > hitstopTicks ? currentDefenderHitstop : hitstopTicks;
    const currentAttackerHitstop = d[attackerBase + FighterField.HITSTOP_TICKS] as number;
    d[attackerBase + FighterField.HITSTOP_TICKS] =
      currentAttackerHitstop > hitstopTicks ? currentAttackerHitstop : hitstopTicks;
  }

  /** Shared damage/knockback/hitstun application for items and hazards:
   * same magnitude/hitstun formulas as tryApplyHit but with no shield
   * interaction and no dedup table (an item/hazard is a single discrete
   * event, not a multi-frame active window, so there is nothing to
   * dedupe against). Ignores DEAD/RESPAWN/invulnerable defenders like
   * combat hits do. `mirror` is true when the source point is to the
   * defender's... no — mirroring here follows the *source's* facing
   * (thrown item's travel direction, or true for hazards which have no
   * facing and always mean "launch on the LUT's own axis"). */
  private applyItemDamage(
    defender: number,
    damage: Fixed,
    baseKnockback: Fixed,
    knockbackGrowth: Fixed,
    angleIdx: number,
    mirror: boolean,
  ): void {
    const d = this.data;
    const dBase = defender * FighterField.FIELD_COUNT;
    const defenderState = d[dBase + FighterField.STATE] as number;
    if (defenderState === FighterStateId.DEAD || defenderState === FighterStateId.RESPAWN) return;
    if ((d[dBase + FighterField.INVULN_TIMER] as number) > 0) return;

    const defenderChar = this.characters[defender] as CharacterData;
    const percentBefore = d[dBase + FighterField.PERCENT] as number;
    const percentAfter = fx.add(percentBefore, damage);
    d[dBase + FighterField.PERCENT] = percentAfter;

    const magnitude = computeKnockbackMagnitude(damage, percentAfter, baseKnockback, knockbackGrowth, defenderChar.weight);
    const effectiveAngleIdx = mirror ? mirrorAngleIdx(angleIdx) : angleIdx;
    d[dBase + FighterField.VEL_X] = fx.mul(cosLUT(effectiveAngleIdx), magnitude);
    d[dBase + FighterField.VEL_Y] = fx.mul(sinLUT(effectiveAngleIdx), magnitude);
    d[dBase + FighterField.HITSTUN] = computeHitstunTicks(magnitude);
    d[dBase + FighterField.GROUNDED] = 0;
    d[dBase + FighterField.MOVE_ID] = -1;
    d[dBase + FighterField.MOVE_FRAME] = 0;
    this.setState(dBase, FighterStateId.HITSTUN);
  }

  private isTargetable(index: number): boolean {
    const base = index * FighterField.FIELD_COUNT;
    const state = this.data[base + FighterField.STATE] as number;
    if (state === FighterStateId.DEAD || state === FighterStateId.RESPAWN) return false;
    if ((this.data[base + FighterField.INVULN_TIMER] as number) > 0) return false;
    return true;
  }

  /** -1 if fighter `index` holds no item, else the item slot index. Linear
   * scan over a tiny fixed pool — no allocation, no Map. */
  private findHeldItemSlot(index: number): number {
    for (let slot = 0; slot < MAX_ITEMS; slot++) {
      const base = slot * ItemField.FIELD_COUNT;
      if (
        (this.itemsData[base + ItemField.ACTIVE] as number) === 1 &&
        (this.itemsData[base + ItemField.STATE] as number) === ItemState.HELD &&
        (this.itemsData[base + ItemField.HOLDER] as number) === index
      ) {
        return slot;
      }
    }
    return -1;
  }

  /** Attack button pressed while holding an item: resolve its use-effect
   * per item kind (see items/types.ts for why each kind behaves as it
   * does). Called from stepFighter instead of starting a character move. */
  private useHeldItem(fighterIndex: number, slot: number): void {
    const base = slot * ItemField.FIELD_COUNT;
    const typeId = this.itemsData[base + ItemField.TYPE] as number;
    const type = findItemType(this.itemSet, typeId);
    if (!type) {
      this.itemsData[base + ItemField.ACTIVE] = 0;
      return;
    }
    const fBase = fighterIndex * FighterField.FIELD_COUNT;
    const facing = this.data[fBase + FighterField.FACING] as number;
    const posX = this.data[fBase + FighterField.POS_X] as number;
    const posY = this.data[fBase + FighterField.POS_Y] as number;

    if (type.kind === 'thrown') {
      this.itemsData[base + ItemField.STATE] = ItemState.THROWN;
      this.itemsData[base + ItemField.HOLDER] = -1;
      this.itemsData[base + ItemField.VEL_X] = facing < 0 ? fx.neg(type.projectileSpeed) : type.projectileSpeed;
      this.itemsData[base + ItemField.VEL_Y] = 0;
      this.itemsData[base + ItemField.TIMER] = type.despawnTicks;
      return;
    }
    if (type.kind === 'melee') {
      const offsetX = fx.mul(fx.fromFloat(0.9), fx.fromInt(facing < 0 ? -1 : 1));
      const box = makeBoxCentered(fx.add(posX, offsetX), posY, type.boxWidth, type.boxHeight);
      for (let target = 0; target < this.numFighters; target++) {
        if (target === fighterIndex || !this.isTargetable(target)) continue;
        const tBase = target * FighterField.FIELD_COUNT;
        const tChar = this.characters[target] as CharacterData;
        const tBox = makeBoxCentered(
          this.data[tBase + FighterField.POS_X] as number,
          this.data[tBase + FighterField.POS_Y] as number,
          tChar.hurtboxWidth,
          tChar.hurtboxHeight,
        );
        if (aabbOverlap(box, tBox)) {
          this.applyItemDamage(target, type.damage, type.baseKnockback, type.knockbackGrowth, type.angleIdx, facing < 0);
        }
      }
      this.itemsData[base + ItemField.ACTIVE] = 0;
      return;
    }
    if (type.kind === 'explosive') {
      this.itemsData[base + ItemField.STATE] = ItemState.ARMED;
      this.itemsData[base + ItemField.HOLDER] = -1;
      this.itemsData[base + ItemField.VEL_X] = 0;
      this.itemsData[base + ItemField.VEL_Y] = 0;
      this.itemsData[base + ItemField.FUSE] = type.fuseTicks;
      this.itemsData[base + ItemField.TIMER] = type.despawnTicks;
      return;
    }
    // 'heal': instant, no world presence needed afterward.
    const percentBefore = this.data[fBase + FighterField.PERCENT] as number;
    const percentAfter = fx.sub(percentBefore, type.healAmount);
    this.data[fBase + FighterField.PERCENT] = percentAfter > 0 ? percentAfter : 0;
    this.itemsData[base + ItemField.ACTIVE] = 0;
  }

  private outsideBlastRect(posX: number, posY: number): boolean {
    return (
      (posX as number) < (this.blastMinX as number) ||
      (posX as number) > (this.blastMaxX as number) ||
      (posY as number) < (this.blastMinY as number) ||
      (posY as number) > (this.blastMaxY as number)
    );
  }

  /** Per-tick physics/lifecycle for every active item slot: world items
   * fall and land like a fighter (reusing findLandingPlatform), held items
   * follow their holder, thrown projectiles fly straight and detonate on
   * the first fighter (other than their owner) they touch, and armed
   * bombs fall/rest while their fuse counts down to a radius explosion
   * that (unlike a thrown hit) can catch the owner too. Pickup is
   * resolved for WORLD items in ascending fighter-index order so the
   * lowest index always wins a tie, per the task's determinism
   * requirement. */
  private stepItems(): void {
    for (let slot = 0; slot < MAX_ITEMS; slot++) {
      const base = slot * ItemField.FIELD_COUNT;
      if ((this.itemsData[base + ItemField.ACTIVE] as number) !== 1) continue;
      const state = this.itemsData[base + ItemField.STATE] as number;
      const type = findItemType(this.itemSet, this.itemsData[base + ItemField.TYPE] as number);
      if (!type) {
        this.itemsData[base + ItemField.ACTIVE] = 0;
        continue;
      }

      if (state === ItemState.HELD) {
        const holder = this.itemsData[base + ItemField.HOLDER] as number;
        const hBase = holder * FighterField.FIELD_COUNT;
        const holderState = this.data[hBase + FighterField.STATE] as number;
        if (holder < 0 || holderState === FighterStateId.DEAD) {
          // Holder eliminated mid-hold: drop it back into the world.
          this.itemsData[base + ItemField.STATE] = ItemState.WORLD;
          this.itemsData[base + ItemField.HOLDER] = -1;
          this.itemsData[base + ItemField.VEL_X] = 0;
          this.itemsData[base + ItemField.VEL_Y] = 0;
          this.itemsData[base + ItemField.TIMER] = type.despawnTicks;
          continue;
        }
        this.itemsData[base + ItemField.POS_X] = this.data[hBase + FighterField.POS_X] as number;
        this.itemsData[base + ItemField.POS_Y] = fx.add(
          this.data[hBase + FighterField.POS_Y] as number,
          ITEM_HELD_OFFSET_Y,
        );
        continue;
      }

      if (state === ItemState.THROWN) {
        const posX = fx.add(this.itemsData[base + ItemField.POS_X] as number, this.itemsData[base + ItemField.VEL_X] as number);
        const posY = this.itemsData[base + ItemField.POS_Y] as number;
        this.itemsData[base + ItemField.POS_X] = posX;
        const owner = this.itemsData[base + ItemField.OWNER] as number;
        let hit = false;
        const box = makeBoxCentered(posX, posY, type.boxWidth, type.boxHeight);
        for (let target = 0; target < this.numFighters && !hit; target++) {
          if (target === owner || !this.isTargetable(target)) continue;
          const tBase = target * FighterField.FIELD_COUNT;
          const tChar = this.characters[target] as CharacterData;
          const tBox = makeBoxCentered(
            this.data[tBase + FighterField.POS_X] as number,
            this.data[tBase + FighterField.POS_Y] as number,
            tChar.hurtboxWidth,
            tChar.hurtboxHeight,
          );
          if (aabbOverlap(box, tBox)) {
            const mirror = (this.itemsData[base + ItemField.VEL_X] as number) < 0;
            this.applyItemDamage(target, type.damage, type.baseKnockback, type.knockbackGrowth, type.angleIdx, mirror);
            hit = true;
          }
        }
        const timer = ((this.itemsData[base + ItemField.TIMER] as number) - 1) | 0;
        this.itemsData[base + ItemField.TIMER] = timer;
        if (hit || timer <= 0 || this.outsideBlastRect(posX, posY)) {
          this.itemsData[base + ItemField.ACTIVE] = 0;
        }
        continue;
      }

      // WORLD and ARMED both fall/land like a fighter's airborne physics.
      const prevY = this.itemsData[base + ItemField.POS_Y] as number;
      let velY = fx.add(this.itemsData[base + ItemField.VEL_Y] as number, GRAVITY);
      let posY = fx.add(prevY, velY);
      const posX = this.itemsData[base + ItemField.POS_X] as number;
      const landing = this.findLandingPlatform(posX, prevY, posY);
      if (landing) {
        posY = landing.y;
        velY = 0;
      }
      this.itemsData[base + ItemField.POS_Y] = posY;
      this.itemsData[base + ItemField.VEL_Y] = velY;

      if (state === ItemState.ARMED) {
        const fuse = ((this.itemsData[base + ItemField.FUSE] as number) - 1) | 0;
        this.itemsData[base + ItemField.FUSE] = fuse;
        if (fuse <= 0) {
          const blastBox = makeBoxCentered(posX, posY, type.boxWidth, type.boxHeight);
          for (let target = 0; target < this.numFighters; target++) {
            if (!this.isTargetable(target)) continue;
            const tBase = target * FighterField.FIELD_COUNT;
            const tChar = this.characters[target] as CharacterData;
            const tBox = makeBoxCentered(
              this.data[tBase + FighterField.POS_X] as number,
              this.data[tBase + FighterField.POS_Y] as number,
              tChar.hurtboxWidth,
              tChar.hurtboxHeight,
            );
            // Explosive deliberately does NOT exclude its own owner: the
            // task calls for punishing a holder too slow to clear the
            // blast, so unlike a thrown item this has no owner exclusion.
            if (aabbOverlap(blastBox, tBox)) {
              this.applyItemDamage(target, type.damage, type.baseKnockback, type.knockbackGrowth, type.angleIdx, false);
            }
          }
          this.itemsData[base + ItemField.ACTIVE] = 0;
          continue;
        }
      } else {
        // WORLD: pickup check, ascending fighter index so the lowest index
        // always wins a simultaneous overlap (task's determinism
        // requirement for pickup tie-breaking).
        const itemBox = makeBoxCentered(posX, posY, type.boxWidth, type.boxHeight);
        for (let target = 0; target < this.numFighters; target++) {
          if (!this.isTargetable(target)) continue;
          const tBase = target * FighterField.FIELD_COUNT;
          const tChar = this.characters[target] as CharacterData;
          const tBox = makeBoxCentered(
            this.data[tBase + FighterField.POS_X] as number,
            this.data[tBase + FighterField.POS_Y] as number,
            tChar.hurtboxWidth,
            tChar.hurtboxHeight,
          );
          if (aabbOverlap(itemBox, tBox)) {
            this.itemsData[base + ItemField.STATE] = ItemState.HELD;
            this.itemsData[base + ItemField.HOLDER] = target;
            this.itemsData[base + ItemField.OWNER] = target;
            break;
          }
        }
        if ((this.itemsData[base + ItemField.STATE] as number) === ItemState.HELD) continue;
      }

      const timer = ((this.itemsData[base + ItemField.TIMER] as number) - 1) | 0;
      this.itemsData[base + ItemField.TIMER] = timer;
      if (timer <= 0 || this.outsideBlastRect(posX, posY)) {
        this.itemsData[base + ItemField.ACTIVE] = 0;
      }
    }
  }

  /** Draw item-type and spawn-point choices from the shared PRNG whenever
   * the spawn interval elapses, unconditionally (whether or not a free
   * slot exists), so the RNG stream never depends on how many items are
   * currently alive — only on tick count, which is identical on every
   * client. */
  private trySpawnItem(): void {
    this.itemSpawnCooldown -= 1;
    if (this.itemSpawnCooldown > 0) return;
    this.itemSpawnCooldown = ITEM_SPAWN_INTERVAL_TICKS;

    const spawnPoints = this.arena.spawnPoints;
    if (this.itemSet.length === 0 || spawnPoints.length === 0) return;

    const typeDraw = nextBounded(this.rng, this.itemSet.length);
    this.rng = typeDraw.state;
    const pointDraw = nextBounded(this.rng, spawnPoints.length);
    this.rng = pointDraw.state;

    const type = this.itemSet[typeDraw.value % this.itemSet.length] as ItemTypeDef;
    const point = spawnPoints[pointDraw.value % spawnPoints.length] as { x: Fixed; y: Fixed };

    for (let slot = 0; slot < MAX_ITEMS; slot++) {
      const base = slot * ItemField.FIELD_COUNT;
      if ((this.itemsData[base + ItemField.ACTIVE] as number) === 1) continue;
      this.itemsData[base + ItemField.ACTIVE] = 1;
      this.itemsData[base + ItemField.TYPE] = type.id;
      this.itemsData[base + ItemField.POS_X] = point.x as number;
      this.itemsData[base + ItemField.POS_Y] = point.y as number;
      this.itemsData[base + ItemField.VEL_X] = 0;
      this.itemsData[base + ItemField.VEL_Y] = 0;
      this.itemsData[base + ItemField.STATE] = ItemState.WORLD;
      this.itemsData[base + ItemField.HOLDER] = -1;
      this.itemsData[base + ItemField.OWNER] = -1;
      this.itemsData[base + ItemField.TIMER] = type.despawnTicks;
      this.itemsData[base + ItemField.FUSE] = -1;
      return;
    }
    // No free slot: the draw is discarded, item is "lost". Deterministic
    // either way since it depends only on state, not wall-clock timing.
  }

  /** Falling-debris hazard (this task's item 2): pure function of tick +
   * PRNG state exactly like arena-shrink, except the *interval* itself is
   * derived from computeShrinkProgress so hazards fire more often as the
   * ring closes and the field thins — the explicit coordination with
   * arena-shrink the task calls for. */
  private stepHazards(): void {
    for (let slot = 0; slot < MAX_HAZARDS; slot++) {
      const base = slot * HazardField.FIELD_COUNT;
      if ((this.hazardsData[base + HazardField.ACTIVE] as number) !== 1) continue;
      const cfg = this.hazardConfig;
      const velY = fx.add(this.hazardsData[base + HazardField.VEL_Y] as number, cfg.fallAccel);
      const posX = this.hazardsData[base + HazardField.POS_X] as number;
      const posY = fx.add(this.hazardsData[base + HazardField.POS_Y] as number, velY);
      this.hazardsData[base + HazardField.VEL_Y] = velY;
      this.hazardsData[base + HazardField.POS_Y] = posY;

      const box = makeBoxCentered(posX, posY, cfg.boxWidth, cfg.boxHeight);
      for (let target = 0; target < this.numFighters; target++) {
        if (!this.isTargetable(target)) continue;
        const tBase = target * FighterField.FIELD_COUNT;
        const tChar = this.characters[target] as CharacterData;
        const tBox = makeBoxCentered(
          this.data[tBase + FighterField.POS_X] as number,
          this.data[tBase + FighterField.POS_Y] as number,
          tChar.hurtboxWidth,
          tChar.hurtboxHeight,
        );
        if (aabbOverlap(box, tBox)) {
          this.applyItemDamage(target, cfg.damage, cfg.baseKnockback, cfg.knockbackGrowth, cfg.angleIdx, false);
        }
      }

      const timer = ((this.hazardsData[base + HazardField.TIMER] as number) - 1) | 0;
      this.hazardsData[base + HazardField.TIMER] = timer;
      if (timer <= 0 || (posY as number) < (this.blastMinY as number)) {
        this.hazardsData[base + HazardField.ACTIVE] = 0;
      }
    }
  }

  private trySpawnHazard(): void {
    this.hazardSpawnCooldown -= 1;
    if (this.hazardSpawnCooldown > 0) return;

    const cfg = this.hazardConfig;
    const progress = computeShrinkProgress(this.tick, this.aliveCount(), this.numFighters, this.settings);
    const span = cfg.spawnIntervalMaxTicks - cfg.spawnIntervalMinTicks;
    const interval = cfg.spawnIntervalMaxTicks - Math.round(span * progress);
    this.hazardSpawnCooldown = interval < cfg.spawnIntervalMinTicks ? cfg.spawnIntervalMinTicks : interval;

    const xDraw = nextBounded(this.rng, 1000);
    this.rng = xDraw.state;
    const spanX = (this.blastMaxX as number) - (this.blastMinX as number);
    const posX = (this.blastMinX as number) + Math.floor((spanX * xDraw.value) / 1000);

    for (let slot = 0; slot < MAX_HAZARDS; slot++) {
      const base = slot * HazardField.FIELD_COUNT;
      if ((this.hazardsData[base + HazardField.ACTIVE] as number) === 1) continue;
      this.hazardsData[base + HazardField.ACTIVE] = 1;
      this.hazardsData[base + HazardField.POS_X] = posX;
      this.hazardsData[base + HazardField.POS_Y] = this.blastMaxY as number;
      this.hazardsData[base + HazardField.VEL_Y] = 0;
      this.hazardsData[base + HazardField.TIMER] = cfg.maxLifetimeTicks;
      return;
    }
  }

  /** A fighter whose position leaves the current (possibly shrunk)
   * blast-zone rectangle loses a life. Elimination-mode fighters
   * (battleRoyale/stocks) that are out of stocks go to DEAD permanently and
   * get their placement recorded; everyone else (timedKO, or a
   * stocks-mode fighter with lives left) goes to RESPAWN for a brief
   * invulnerable window instead. */
  /** Current lethal-backstop margin beyond the soft boundary, in fixed-point units. Full width
   * until three quarters of the shrink schedule, then linearly to zero at full closure,
   * guaranteeing termination. */
  private ringHardMargin(): number {
    const closed = this.settings.shrinkFullyClosedTick;
    if (closed <= 0) return RING_HARD_MARGIN;
    const start = Math.floor((closed * RING_HARD_MARGIN_DECAY_START_NUM) / RING_HARD_MARGIN_DECAY_START_DEN);
    if (this.tick <= start) return RING_HARD_MARGIN;
    if (this.tick >= closed) return 0;
    const t = fx.div(fx.fromInt(closed - this.tick), fx.fromInt(closed - start));
    return fx.mul(RING_HARD_MARGIN, t);
  }

  private checkBlastZone(index: number): void {
    const base = index * FighterField.FIELD_COUNT;
    const d = this.data;
    const state = d[base + FighterField.STATE] as number;
    if (state === FighterStateId.DEAD || state === FighterStateId.RESPAWN) return;
    const posX = d[base + FighterField.POS_X] as number;
    const posY = d[base + FighterField.POS_Y] as number;

    const outsideSoft =
      posX < this.blastMinX || posX > this.blastMaxX || posY < this.blastMinY || posY > this.blastMaxY;
    if (!outsideSoft) return;

    // Falling below the stage floor (posY < blastMinY) is categorically different from being
    // pushed out through the shrinking ring's sides/top: it is a plain fall/self-destruct/walk-
    // off-a-ledge, not ring pressure, and it can happen in the opening seconds of a match on any
    // stage with a gap, long before the ring has closed at all. Production evidence (2026-09-11,
    // see wiki 'Resolution Guarantee and Harness Trust 2026-09-10'): a 0.5%-damage 'ring'
    // elimination 3.2s into a match, which the ring cannot possibly have caused yet. A fighter
    // drifting slowly downward through the floor threshold could always accumulate a few ticks
    // of ring soft-damage (and so a fresh RING_DAMAGE_TICK) before finally crossing the hard
    // margin -- the truthful-attribution pass never accounted for this. A fall through the floor
    // must never earn 'ring'/'ring_lethal': only 'knockout' (a real recent hit sent them off) or
    // 'fall' (they walked/dropped off on their own).
    const exitedBelowFloor = posY < this.blastMinY;

    // The hard backstop closes in once the ordinary shrink schedule has fully run: over the
    // stalemate-override window the margin decays to zero, so a late match can never sit
    // forever on chip damage with nobody able to finish anyone (the sim-level guarantee that
    // every match resolves). During normal play the margin is at full width and rarely reached.
    const margin = this.ringHardMargin();
    const outsideHard =
      posX < fx.sub(this.blastMinX, margin) ||
      posX > fx.add(this.blastMaxX, margin) ||
      posY < fx.sub(this.blastMinY, margin) ||
      posY > fx.add(this.blastMaxY, margin);

    // Percent-based lethal backstop. Geometry alone cannot guarantee resolution: the safe extents
    // never contract below "room for the final few", so fighters standing on ground near the
    // centre are never outside the soft boundary at all, and a lobby that stops landing knockouts
    // could chip along forever (this is the seed-1001/1003 non-resolution that every pacing lever
    // kept tripping over). Ring damage therefore becomes lethal once a fighter has taken enough
    // of it to be far past any survivable percent. Because the threshold is on accumulated
    // percent and every fighter accumulates at a different rate, deaths arrive staggered rather
    // than as a simultaneous wipe, so a stalemated match still resolves to exactly one survivor.
    const percentNow = d[base + FighterField.PERCENT] as number;
    const ringLethal = (percentNow as number) >= (RING_LETHAL_PERCENT as number);

    // Record ring exposure for THIS tick before branching on hard/lethal. Once the stalemate
    // override has decayed ringHardMargin() to zero (see above -- routinely true late in a long
    // match, exactly when most eliminations happen), outsideSoft and outsideHard become the same
    // threshold, so a fighter can go straight from "inside" to "eliminated" in a single tick
    // without ever passing through the soft-only branch below that used to be the only place
    // RING_DAMAGE_TICK got set. That left recentRingExposure false at the moment of death and
    // every such elimination was misattributed as a plain 'fall' -- a real classification bug
    // (not a harness artifact): see wiki 'Resolution Guarantee and Harness Trust 2026-09-10'.
    // outsideSoft is already established (checked above; function returns early if false), so
    // this fighter is taking ring pressure this tick regardless of which branch runs next.
    if (!exitedBelowFloor) d[base + FighterField.RING_DAMAGE_TICK] = this.tick;

    if (!outsideHard && !ringLethal) {
      if (exitedBelowFloor) {
        // A gap in the platforms, not the ring: no ring chip damage, no RING_DAMAGE_TICK, no
        // inward nudge. Let them keep falling under ordinary physics; if nobody hit them
        // recently this resolves as a plain 'fall' once they cross the hard margin below.
        return;
      }
      // Soft boundary: damaging pressure, not a kill. Accumulating percent both threatens the
      // hard backstop on its own over time and makes this fighter far easier for anyone else to
      // launch (knockback scales with percent) -- that's the whole point of the redesign.
      const percentBefore = d[base + FighterField.PERCENT] as number;
      d[base + FighterField.PERCENT] = fx.add(percentBefore, RING_DAMAGE_PER_TICK);
      d[base + FighterField.RING_DAMAGE_TICK] = this.tick;
      // Note (2026-09-10): LAST_ATTACKER is deliberately left alone here. Clearing it every ring
      // tick used to also wipe the record of a genuine recent combat hit for anyone who spent a
      // few ticks drifting through ring pressure before crossing the hard margin -- which is the
      // common case for a real knockback-driven KO near the shrinking ring, not an edge case.
      // Whether a ring-pressure death still counts as a KO or as pure 'ring' is now decided
      // explicitly below, in the elimination attribution, using COMBAT_ATTRIBUTION_TICKS.
      // Nudge inward on whichever axes are actually out of bounds, on top of existing velocity,
      // so the ring pushes fighters back toward the middle (and each other) instead of just
      // hurting them in place.
      if (posX < this.blastMinX) d[base + FighterField.VEL_X] = fx.add(d[base + FighterField.VEL_X] as number, RING_INWARD_PUSH);
      else if (posX > this.blastMaxX) d[base + FighterField.VEL_X] = fx.sub(d[base + FighterField.VEL_X] as number, RING_INWARD_PUSH);
      if (posY > this.blastMaxY) d[base + FighterField.VEL_Y] = fx.sub(d[base + FighterField.VEL_Y] as number, RING_INWARD_PUSH);
      return;
    }

    d[base + FighterField.DEATH_COUNT] = (d[base + FighterField.DEATH_COUNT] as number) + 1;
    const attacker = d[base + FighterField.LAST_ATTACKER] as number;

    // Truthful attribution (2026-09-10, see wiki 'Opening-Seconds Eliminations: Falls
    // Misreported as Knockouts'): ring causes are their own bucket first (no attacker, they are
    // not exits through the geometric boundary in the sense a KO is). Otherwise a death only
    // counts as a knockout if a real combat hit landed within COMBAT_ATTRIBUTION_TICKS -- at low
    // percent, knockback is far too small to send anyone out on its own, so an old or absent hit
    // means this was a fall/self-destruct/walk-off, not something the attacker caused.
    const lastHitTick = d[base + FighterField.LAST_HIT_TICK] as number;
    const recentlyHit = attacker >= 0 && attacker !== index && lastHitTick >= 0 && this.tick - lastHitTick <= COMBAT_ATTRIBUTION_TICKS;
    // Recently exposed to ring soft-damage (within the same window used for combat attribution):
    // covers both "still drifting through ring pressure this exact tick" and "took ring chip
    // damage a couple of ticks ago, then the hard margin/lethal threshold caught up with it".
    const ringDamageTick = d[base + FighterField.RING_DAMAGE_TICK] as number;
    const recentRingExposure = ringDamageTick >= 0 && this.tick - ringDamageTick <= COMBAT_ATTRIBUTION_TICKS;
    let cause: EliminationCause;
    if (ringLethal) {
      cause = 'ring_lethal';
    } else if (recentlyHit) {
      // A real, recent combat hit takes priority over ring exposure: someone launched this
      // fighter and the ring's chip damage along the way did not change who did it.
      cause = 'knockout';
    } else if (recentRingExposure) {
      cause = 'ring';
    } else {
      cause = 'fall';
    }
    const creditedAttacker = cause === 'knockout' ? attacker : -1;
    if (creditedAttacker >= 0) {
      const attackerBase = creditedAttacker * FighterField.FIELD_COUNT;
      d[attackerBase + FighterField.KO_COUNT] = (d[attackerBase + FighterField.KO_COUNT] as number) + 1;
    }
    this.eliminationEvents.push({
      fighterIndex: index,
      tick: this.tick,
      cause,
      attacker: creditedAttacker,
      percentAtDeath: d[base + FighterField.PERCENT] as Fixed,
    });
    d[base + FighterField.LAST_ATTACKER] = -1;

    const respawns = respawnsEnabled(this.settings);
    let stocksAfter = d[base + FighterField.STOCKS] as number;
    if (!respawns) {
      stocksAfter = ((d[base + FighterField.STOCKS] as number) - 1) | 0;
      d[base + FighterField.STOCKS] = stocksAfter < 0 ? 0 : stocksAfter;
    }

    d[base + FighterField.VEL_X] = 0;
    d[base + FighterField.VEL_Y] = 0;
    d[base + FighterField.HITSTUN] = 0;
    d[base + FighterField.SHIELD_STUN] = 0;

    if (!respawns && stocksAfter <= 0) {
      d[base + FighterField.ELIMINATED] = 1;
      d[base + FighterField.ELIMINATED_TICK] = this.tick;
      this.eliminatedCount = (this.eliminatedCount + 1) | 0;
      d[base + FighterField.PLACEMENT] = this.numFighters - this.eliminatedCount + 1;
      d[base + FighterField.POS_X] = 0;
      d[base + FighterField.POS_Y] = LIMBO_Y;
      this.setState(base, FighterStateId.DEAD);
      return;
    }

    d[base + FighterField.RESPAWN_TIMER] = this.settings.respawnDelayTicks;
    d[base + FighterField.POS_X] = 0;
    d[base + FighterField.POS_Y] = LIMBO_Y;
    // Percent/shield reset immediately on the KO rather than only when the
    // respawn timer elapses: match UI and tests observe the new life's 0%
    // the same tick stocks drop, not after a delay.
    d[base + FighterField.PERCENT] = 0;
    d[base + FighterField.SHIELD_HEALTH] = SHIELD_MAX_HEALTH;
    this.setState(base, FighterStateId.RESPAWN);
  }
}
