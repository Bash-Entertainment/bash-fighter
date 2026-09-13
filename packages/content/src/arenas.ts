// Arena registry: one place a new stage joins to become selectable
// everywhere else (server-side match creation, local match bot-fill,
// online join protocol). Mirrors packages/content/src/characters.ts's
// pattern exactly. Adding a stage means adding an entry here -- no other
// package should hardcode the stage list, and nothing outside this file
// and match-sim.ts should import an arena data module directly.
import type { ArenaData } from '../../sim/src/arena/types.ts';
import { BATTLE_ROYALE_20_ARENA } from './arenas/battle-royale-20/data.ts';
import { THE_UNDERCROFT_ARENA } from './arenas/the-undercroft/data.ts';
import { THE_SPIRE_ARENA } from './arenas/the-spire/data.ts';
import { THE_FOUNDRY_ARENA } from './arenas/the-foundry/data.ts';
import { THE_ATOLL_ARENA } from './arenas/the-atoll/data.ts';
import { THE_QUARRY_ARENA } from './arenas/the-quarry/data.ts';

export interface ArenaEntry {
  /** Stable wire/storage identifier -- never the display name. Sent to
   * every client in MatchStartMessage.arenaId so a joining or reconnecting
   * client builds the identical Sim the server is running (see
   * match-sim.ts's determinism warning). */
  id: string;
  arena: ArenaData;
}

export const DEFAULT_ARENA_ID = 'battle-royale-20';

/** All selectable stages, in rotation order (see nextArenaId). */
export const ALL_ARENAS: readonly ArenaEntry[] = [
  { id: 'battle-royale-20', arena: BATTLE_ROYALE_20_ARENA },
  { id: 'the-undercroft', arena: THE_UNDERCROFT_ARENA },
  { id: 'the-spire', arena: THE_SPIRE_ARENA },
  { id: 'the-foundry', arena: THE_FOUNDRY_ARENA },
  { id: 'the-atoll', arena: THE_ATOLL_ARENA },
  { id: 'the-quarry', arena: THE_QUARRY_ARENA },
];

/** Resolves a wire-supplied arena id to its ArenaData, falling back to the
 * default for anything absent, unknown, or sent by a client/server that
 * predates stage selection -- same backward-compatibility shape as
 * resolveCharacterId. */
export function resolveArenaId(id: string | null | undefined): ArenaData {
  const found = ALL_ARENAS.find((a) => a.id === id);
  return found ? found.arena : BATTLE_ROYALE_20_ARENA;
}

export function isKnownArenaId(id: string | null | undefined): boolean {
  return typeof id === 'string' && ALL_ARENAS.some((a) => a.id === id);
}

/** Deterministic per-match stage choice: a seeded pick, not a client
 * preference and not wall-clock rotation (that would make two matches
 * started in the same second collide, and would not replay identically
 * from a recorded seed). The match seed already exists and is already
 * told to every client for PRNG purposes, so reusing it here costs nothing
 * new on the wire and guarantees a reconnecting client re-derives the same
 * choice the server made, independent of arenaId even being read --
 * though the server still always sends arenaId explicitly rather than
 * relying on a client to recompute this. */
export function pickArenaId(seed: number): string {
  const index = Math.abs(seed) % ALL_ARENAS.length;
  return ALL_ARENAS[index]!.id;
}
