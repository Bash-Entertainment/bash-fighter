// Dev-only arena override tests (issue #19). The hello handshake gained an
// optional `arena` field so a dev/CI client can pin the next match's stage
// instead of the seeded pick. Three layers of "dev-only" are asserted here
// and in protocol.test.ts:
//   1. RoomManager stores the request from the first joiner that presents
//      one (first request wins; later joiners never retarget a lobby).
//   2. Match.start() honours the request ONLY when the server opted in via
//      MATCH_ARENA_OVERRIDE=1 AND the id is registered -- otherwise the
//      seeded pick stands (a production server sets neither, so a player
//      can never move a production match).
//   3. The [matchStart] log line carries arenaPinned: true only when the
//      pin actually won, so journalctl can tell a pinned dev match from a
//      seeded one without knowing the env state.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Match, seedFromMatchId, type MatchEvents } from '../src/match.ts';
import { RoomManager } from '../src/rooms.ts';
import { pickArenaId } from '@bash-fighter/content/src/index.ts';

function noopEvents(): MatchEvents {
  return {
    onStart: () => {},
    onSnapshot: () => {},
    onEliminated: () => {},
    onMatchEnd: () => {},
    onSeatGraceExpired: () => {},
  };
}

function seededPickFor(matchId: string): string {
  return pickArenaId(seedFromMatchId(matchId));
}

function makeMatch(matchId: string): Match {
  const match = new Match(matchId, 2, 1, noopEvents());
  match.addSeat('human-a', false);
  match.addSeat('bot-1', true);
  return match;
}

/** Sets MATCH_ARENA_OVERRIDE for the duration of `run`, restoring the
 *  previous value after -- other tests in the suite must never see the
 *  override on. */
function withArenaOverride(enabled: boolean, run: () => void): void {
  const previous = process.env.MATCH_ARENA_OVERRIDE;
  if (enabled) process.env.MATCH_ARENA_OVERRIDE = '1';
  else delete process.env.MATCH_ARENA_OVERRIDE;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.MATCH_ARENA_OVERRIDE;
    else process.env.MATCH_ARENA_OVERRIDE = previous;
  }
}

describe('dev-only arena override (issue #19)', () => {
  test('without the opt-in env var, a hello arena request is ignored and the seeded pick stands', () => {
    const match = makeMatch('arena-override-1');
    match.arenaRequest = 'the-atoll';
    withArenaOverride(false, () => {
      match.start();
      match.stop();
    });
    assert.equal(match.arenaId, seededPickFor('arena-override-1'));
  });

  test('with MATCH_ARENA_OVERRIDE=1 and a registered request, start() pins the stage', () => {
    const match = makeMatch('arena-override-2');
    match.arenaRequest = 'the-atoll';
    withArenaOverride(true, () => {
      match.start();
      match.stop();
    });
    assert.equal(match.arenaId, 'the-atoll');
  });

  test('with the opt-in but an unregistered id, the seeded pick stands (never errors a lobby)', () => {
    const match = makeMatch('arena-override-3');
    match.arenaRequest = 'not-a-real-arena';
    withArenaOverride(true, () => {
      match.start();
      match.stop();
    });
    assert.equal(match.arenaId, seededPickFor('arena-override-3'));
  });

  test('with the opt-in but no request, the seeded pick stands', () => {
    const match = makeMatch('arena-override-4');
    withArenaOverride(true, () => {
      match.start();
      match.stop();
    });
    assert.equal(match.arenaId, seededPickFor('arena-override-4'));
  });

  test('the [matchStart] log marks a pinned match and leaves the production line shape unchanged otherwise', () => {
    const lines: Array<Record<string, unknown>> = [];
    const realLog = console.log;
    console.log = ((...args: unknown[]) => {
      const [line] = args;
      if (typeof line === 'string' && line.startsWith('[matchStart] ')) {
        lines.push(JSON.parse(line.slice('[matchStart] '.length)) as Record<string, unknown>);
      }
    }) as typeof console.log;
    try {
      const pinned = makeMatch('arena-override-log-1');
      pinned.arenaRequest = 'the-spire';
      withArenaOverride(true, () => {
        pinned.start();
        pinned.stop();
      });

      const unpinned = makeMatch('arena-override-log-2');
      unpinned.arenaRequest = 'the-spire';
      withArenaOverride(false, () => {
        unpinned.start();
        unpinned.stop();
      });
    } finally {
      console.log = realLog;
    }
    assert.equal(lines.length, 2);
    assert.equal(lines[0]!.arenaId, 'the-spire');
    assert.equal(lines[0]!.arenaPinned, true);
    assert.equal(lines[1]!.arenaId, seededPickFor('arena-override-log-2'));
    assert.equal('arenaPinned' in lines[1]!, false);
  });

  test('RoomManager: first request wins; a later joiner never retargets the lobby; absent stays absent', () => {
    // 2-capacity lobbies (mode-rotation.test.ts's pattern): the second
    // joinLobby fills the match and starts it, which clears the bot-fill
    // timer inside joinLobby -- no lingering timers to keep the runner alive.
    withArenaOverride(false, () => {
      const manager = new RoomManager(noopEvents, 2, 2);
      const first = manager.joinLobby('a', undefined, false, 'the-foundry');
      assert.equal(first.match.arenaRequest, 'the-foundry');
      const second = manager.joinLobby('b', undefined, false, 'the-quarry');
      assert.equal(second.match, first.match);
      assert.equal(first.match.arenaRequest, 'the-foundry');
      first.match.stop();

      const manager2 = new RoomManager(noopEvents, 2, 2);
      const plain = manager2.joinLobby('c');
      assert.equal(plain.match.arenaRequest, undefined);
      const later = manager2.joinLobby('d', undefined, false, 'the-undercroft');
      assert.equal(later.match, plain.match);
      // Claiming is per-request, not per-joiner: a joiner without a pin
      // neither claims nor blocks, so the next joiner that actually asks
      // still claims the (so-far unclaimed) lobby.
      assert.equal(plain.match.arenaRequest, 'the-undercroft');
      plain.match.stop();
    });
  });
});
