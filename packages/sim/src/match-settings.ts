// Match configuration (this task's item 3, revised by owner decision
// 2026-09-07 15:14 PDT): the win condition is a per-match *setting*, not a
// hardcoded rule, and the respawn model is per-mode rather than global.
//
// - 'battleRoyale' (DEFAULT): single elimination, no respawn. Last fighter
//   standing wins. The arena shrinks (see arena-shrink.ts) as the field
//   thins, forcing survivors together instead of leaving most of a
//   20-player match idle-dead for most of its length.
// - 'timedKO': highest KO count within a time limit. Fighters respawn
//   (briefly invulnerable) after being KO'd instead of being eliminated.
// - 'stocks': classic fixed-lives elimination, no arena shrink by default.
//   Kept as the direct generalization of the original 2-fighter stock mode.
export type WinCondition = 'battleRoyale' | 'timedKO' | 'stocks';

export interface MatchSettings {
  winCondition: WinCondition;
  /** Stocks each fighter starts with. battleRoyale forces this to 1
   * (one life, no respawn) regardless of what is passed. */
  startingStocks: number;
  /** Only meaningful for 'timedKO': match ends at this tick count. */
  timeLimitTicks: number;
  /** Only meaningful for 'timedKO': fighters respawn after this many
   * ticks, with respawnInvulnTicks of invulnerability afterward. */
  respawnDelayTicks: number;
  respawnInvulnTicks: number;
  /** Whether the arena's blast-zone rectangle shrinks over the match (see
   * arena-shrink.ts). Defaults to true only for 'battleRoyale'. */
  arenaShrink: boolean;
  /** Tick count at which the tick-driven shrink component reaches full
   * closure (independent of how many fighters remain) — the "hazard storm
   * closing in" clock. */
  shrinkFullyClosedTick: number;
  /** First-match knockout boost (2026-09-26): fighter slots whose hits on
   * a slot in `botSlots` get knockback magnitude scaled by
   * `rookieKnockbackScale` (16.16 fixed point). Lives in settings, not
   * fighter state, so server and client prediction both see it from the
   * matchStart message and stay deterministic. Empty = no effect. */
  rookieSlots: number[];
  botSlots: number[];
  rookieKnockbackScale: number;
}

/** Knockback multiplier for a first-match human's hits on bots (16.16
 * fixed point). 1.75x picked by scripts/rookie-ko-metrics.mjs (2026-09-26):
 * a human-analog novice in 20-fighter Timed Brawl lands a KO within 60s in
 * 75% of 20 trials (0% at 1.0x) while staying below the top bot's count
 * on average. See wiki "First-Match Knockout Boost". */
export const ROOKIE_KNOCKBACK_SCALE = 0x1c000;

export const DEFAULT_MATCH_SETTINGS: MatchSettings = {
  winCondition: 'battleRoyale',
  startingStocks: 1,
  timeLimitTicks: 60 * 60 * 5, // 5 minutes, only used by 'timedKO'
  respawnDelayTicks: 90, // 1.5s
  respawnInvulnTicks: 60, // 1s
  arenaShrink: true,
  // Raised from 4 to 6 minutes (2026-09-09 ring-pacing attribution
  // experiment, see wiki dated page): the population-aware safe-extents
  // floor in arena-shrink.ts (tied to how many fighters are actually
  // still alive) still does the real work of shrinking the endgame ring,
  // but this clock term sets how fast the *overall* squeeze arrives, and
  // live production play showed matches resolving in as little as ~55s
  // with 17 eliminations in ~40s -- a single violent scrum with no
  // middle game. The isolated 1.5x experiment (only this constant
  // changed, nothing else) raised measured combat-vs-boundary share
  // (e.g. battle-royale-20 HARD: 7.4% -> 13.7% combat) and roughly
  // proportionally lengthened matches rather than just producing the same
  // ending later, so slower ring arrival buys more real fighting, not
  // just more waiting. A shorter value here was tried in an earlier pass
  // and rejected for cutting into the EASY novice-survival floor; this
  // change moves the opposite direction (slower), which only adds
  // protection margin, and the novice-survival regression test still
  // passes (see bot.test.ts).
  rookieSlots: [],
  botSlots: [],
  rookieKnockbackScale: 1 << 16,
  shrinkFullyClosedTick: 60 * 60 * 8, // 8 minutes (was 6) -- Lever 6, 2026-09-10 pass 3: individual fights now last longer with Levers 3/4, ease ring pacing further
};

/** Fill in mode-appropriate defaults for any fields the caller omitted,
 * and enforce the mode/respawn/shrink coupling the owner specified: only
 * 'timedKO' respawns, only 'battleRoyale' shrinks by default, and
 * 'battleRoyale' is always single-stock. */
export function resolveMatchSettings(partial: Partial<MatchSettings> = {}): MatchSettings {
  const winCondition = partial.winCondition ?? DEFAULT_MATCH_SETTINGS.winCondition;
  const base: MatchSettings = {
    ...DEFAULT_MATCH_SETTINGS,
    winCondition,
    // 'stocks' shrinks the arena too (2026-09-12 measurement, see wiki
    // "Stocks Mode" page): with respawns keeping most of the field alive
    // for most of the match, the population-aware safe-extents term in
    // arena-shrink.ts barely engages, so without shrink a 20-fighter
    // stocks match measured as UNRESOLVED at a 5-6 minute ceiling in
    // every trial. Turning shrink on for stocks (like battleRoyale) is
    // what actually forces the tick-driven hard-margin closure to do its
    // job of guaranteeing resolution.
    arenaShrink: partial.arenaShrink ?? (winCondition === 'battleRoyale' || winCondition === 'stocks'),
    startingStocks:
      partial.startingStocks ??
      (winCondition === 'battleRoyale' ? 1 : winCondition === 'stocks' ? 2 : 1),
    // 'stocks' needs the tick-driven full-closure clock to arrive much
    // sooner than battleRoyale's 8-minute value: with lives being spent
    // instead of single eliminations, the population-aware shrink term
    // stays wide almost the whole match, so this is the only thing that
    // guarantees the match ends. 3 minutes (10800 ticks) was measured
    // (scripts/stocks-metrics.mjs) to resolve reliably at 2 starting
    // stocks; battleRoyale's 8-minute value left every stocks trial
    // unresolved at a 5-6 minute ceiling.
    shrinkFullyClosedTick:
      partial.shrinkFullyClosedTick ??
      (winCondition === 'stocks' ? 60 * 60 * 3 : DEFAULT_MATCH_SETTINGS.shrinkFullyClosedTick),
  };
  const resolved: MatchSettings = { ...base, ...partial };
  if (winCondition === 'battleRoyale') resolved.startingStocks = 1;
  return resolved;
}

export function respawnsEnabled(settings: MatchSettings): boolean {
  return settings.winCondition === 'timedKO';
}
