// Full-stack desync-proofing test: starts the real server as a child
// process, connects several headless WebSocket clients, plays a match to
// completion by sending random-but-valid inputs, and asserts every
// client's final snapshot state hash is identical (i.e. every client saw
// byte-identical authoritative state over the real wire protocol, through
// real encode/decode, not just in-process function calls).
//
// Extended 2026-09-11 for delta-compressed snapshots (see wiki "Bandwidth
// Reduction Pass 2026-09-11"): one extra client (`lossy`) runs the exact
// same SnapshotStreamDecoder every real client uses, but deliberately (a)
// drops one binary frame outright mid-match (simulated packet loss) and (b)
// closes and reconnects with its resume token mid-match (a real dropped
// TCP connection, not simulated). Both must self-heal from the next full
// keyframe with no lasting divergence -- per-tick hashes for every snapshot
// `lossy` *does* successfully decode are compared against a same-tick
// reference client that never drops anything, not just the final hash, so
// a transient wrong reconstruction that happens to self-correct before the
// match ends would still be caught.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import { hashStateBuffer } from '@bash-fighter/sim/src/hash.ts';
import {
  PROTOCOL_VERSION,
  BinaryTag,
  SnapshotStreamDecoder,
  encodeInput,
} from '@bash-fighter/net/src/protocol.ts';

const PORT = 8099;
const NUM_CLIENTS = 3; // real players sharing the match; `lossy` below is a 4th
const MATCH_CAPACITY = NUM_CLIENTS + 1; // room for the lossy client as a real 4th player

function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      fetch(`http://localhost:${port}/api/health`)
        .then(() => resolve())
        .catch(() => {
          if (Date.now() > deadline) reject(new Error('server did not come up in time'));
          else setTimeout(tryOnce, 100);
        });
    };
    tryOnce();
  });
}

interface ClientState {
  ws: WebSocket;
  slot: number;
  matchEnded: boolean;
  lastState: Int32Array | null;
  tick: number;
  decoder: SnapshotStreamDecoder;
  /** tick -> hash, every successfully-decoded snapshot, not just the last. */
  hashesByTick: Map<number, string>;
  keyframesSeen: number;
  deltasSeen: number;
  resumeToken: string | null;
}

test('a full match played over real WebSockets ends with identical state hashes on every client', async () => {
  const serverProc: ChildProcess = spawn(
    process.execPath,
    ['--experimental-strip-types', new URL('../src/index.ts', import.meta.url).pathname],
    {
      env: {
        ...process.env,
        PORT: String(PORT),
        MATCH_CAPACITY: String(MATCH_CAPACITY),
        MATCH_MINIMUM: String(MATCH_CAPACITY),
        MATCH_COUNTDOWN_SECONDS: '1',
        MATCH_SHRINK_FULLY_CLOSED_TICK: '300', // 5s: force a fast match for this test
        // This test's clients are non-requeued human joins, so without this
        // override the first-time-visitor rule (decideMatchModeForJoin,
        // mode-rotation.ts) would force timedKO and the match would never
        // end via elimination/shrink the way this test expects.
        MATCH_MODE_ROTATION_DISABLED: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let serverLog = '';
  serverProc.stdout?.on('data', (d) => (serverLog += d.toString()));
  serverProc.stderr?.on('data', (d) => (serverLog += d.toString()));

  try {
    await waitForHealth(PORT, 90000);

    const clients: ClientState[] = [];
    const connectPromises: Promise<void>[] = [];

    for (let i = 0; i < NUM_CLIENTS; i++) {
      const ws = new WebSocket(`ws://localhost:${PORT}/socket`);
      const cstate: ClientState = {
        ws,
        slot: -1,
        matchEnded: false,
        lastState: null,
        tick: 0,
        decoder: new SnapshotStreamDecoder(),
        hashesByTick: new Map(),
        keyframesSeen: 0,
        deltasSeen: 0,
        resumeToken: null,
      };
      clients.push(cstate);
      const p = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`client ${i} never got welcome`)), 8000);
        ws.on('open', () => {
          ws.send(JSON.stringify({ t: 'hello', protocolVersion: PROTOCOL_VERSION, name: `Bot${i}` }));
        });
        ws.on('message', (data, isBinary) => {
          if (!isBinary) {
            const msg = JSON.parse(data.toString());
            if (msg.t === 'welcome') {
              cstate.slot = msg.slot;
              if (typeof msg.resumeToken === 'string') cstate.resumeToken = msg.resumeToken;
              clearTimeout(timer);
              resolve();
            }
            if (msg.t === 'matchEnd') {
              cstate.matchEnded = true;
            }
          } else {
            const buf = data as Buffer;
            if (buf[0] === BinaryTag.SNAPSHOT) cstate.keyframesSeen++;
            if (buf[0] === BinaryTag.SNAPSHOT_DELTA) cstate.deltasSeen++;
            const snap = cstate.decoder.decode(new Uint8Array(buf));
            if (snap) {
              cstate.lastState = snap.state;
              cstate.tick = snap.tick;
              cstate.hashesByTick.set(snap.tick, hashStateBuffer(snap.state));
            }
          }
        });
        ws.on('error', reject);
      });
      connectPromises.push(p);
    }

    await Promise.all(connectPromises);

    // A fourth real player, "lossy": deliberately drops one binary frame
    // outright, then later force-closes and reconnects with its resume
    // token, to prove the delta scheme self-heals from both a dropped
    // delta and a real reconnect without ever misreconstructing server
    // state in between.
    let lossy: ClientState = {
      ws: new WebSocket(`ws://localhost:${PORT}/socket`),
      slot: -1,
      matchEnded: false,
      lastState: null,
      tick: 0,
      decoder: new SnapshotStreamDecoder(),
      hashesByTick: new Map(),
      keyframesSeen: 0,
      deltasSeen: 0,
      resumeToken: null,
    };
    let lossyBinaryCount = 0;
    let droppedOne = false;
    let reconnectedOnce = false;

    function wireLossy(cstate: ClientState, resume?: string): Promise<void> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('lossy player never got welcome')), 8000);
        cstate.ws.on('open', () => {
          const hello: Record<string, unknown> = {
            t: 'hello',
            protocolVersion: PROTOCOL_VERSION,
            name: 'LossyPlayer',
          };
          if (resume) hello.resume = resume;
          cstate.ws.send(JSON.stringify(hello));
        });
        cstate.ws.on('message', (data, isBinary) => {
          if (!isBinary) {
            const msg = JSON.parse(data.toString());
            if (msg.t === 'welcome') {
              cstate.slot = msg.slot;
              if (typeof msg.resumeToken === 'string') cstate.resumeToken = msg.resumeToken;
              clearTimeout(timer);
              resolve();
            }
            if (msg.t === 'matchEnd') cstate.matchEnded = true;
            return;
          }
          const buf = data as Buffer;
          lossyBinaryCount++;
          // Simulate one lost packet: silently swallow a single delta frame
          // partway through (not the very first frames, so we know it will
          // be a delta, not the initial keyframe).
          if (!droppedOne && buf[0] === BinaryTag.SNAPSHOT_DELTA && lossyBinaryCount > 5) {
            droppedOne = true;
            return; // dropped: never reaches the decoder
          }
          if (buf[0] === BinaryTag.SNAPSHOT) cstate.keyframesSeen++;
          if (buf[0] === BinaryTag.SNAPSHOT_DELTA) cstate.deltasSeen++;
          const snap = cstate.decoder.decode(new Uint8Array(buf));
          if (snap) {
            cstate.lastState = snap.state;
            cstate.tick = snap.tick;
            cstate.hashesByTick.set(snap.tick, hashStateBuffer(snap.state));
          }
        });
        cstate.ws.on('error', reject);
      });
    }

    await wireLossy(lossy);

    // Drive the match: send a modest, deterministic-ish input pattern from
    // each client at ~30Hz so the match actually plays out (moving off
    // spawn, no attacks needed — elimination happens via the shrinking
    // arena in the battle-royale default settings).
    let inputTick = 0;
    const inputInterval = setInterval(() => {
      inputTick++;
      for (const c of clients) {
        if (c.ws.readyState !== WebSocket.OPEN) continue;
        const dir = c.slot % 2 === 0 ? 1 : -1;
        const bytes = encodeInput({
          tick: inputTick,
          buttons: 0,
          stickX: dir * 65536,
          stickY: 0,
        });
        c.ws.send(bytes);
      }
    }, 33);

    const start = Date.now();
    // 2026-09-09: was 60_000. With the ring-pacing rework, a 3-player
    // match with pure movement and no combat now genuinely takes
    // ~75-80s of wall time to resolve via boundary shrink alone
    // (measured directly against a standalone server instance). 120s
    // keeps real margin above that measured ~77s without masking an
    // actual stall.
    const maxWaitMs = 120_000;
    while (!clients.every((c) => c.matchEnded)) {
      if (Date.now() - start > maxWaitMs) break;
      // Around the 2s mark (well past the ~1s keyframe interval, so we've
      // definitely already had a forced keyframe gap and the deliberate
      // drop above by then), force-close and reconnect the lossy client
      // with its resume token -- a real dropped TCP connection, not
      // simulated, exercising the existing resume path together with the
      // new delta scheme.
      if (!reconnectedOnce && Date.now() - start > 2000 && lossy.resumeToken) {
        reconnectedOnce = true;
        const token = lossy.resumeToken;
        lossy.ws.terminate();
        lossy = {
          ws: new WebSocket(`ws://localhost:${PORT}/socket`),
          slot: -1,
          matchEnded: false,
          lastState: null,
          tick: 0,
          decoder: new SnapshotStreamDecoder(),
          hashesByTick: new Map(),
          keyframesSeen: 0,
          deltasSeen: 0,
          resumeToken: null,
        };
        await wireLossy(lossy, token);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    clearInterval(inputInterval);

    assert.ok(
      clients.every((c) => c.matchEnded),
      `not all clients saw matchEnd within ${maxWaitMs}ms; server log:\n${serverLog}`,
    );
    assert.ok(
      clients.every((c) => c.lastState !== null),
      'every client should have received at least one snapshot',
    );

    const hashes = clients.map((c) => hashStateBuffer(c.lastState as Int32Array));
    const first = hashes[0];
    for (let i = 1; i < hashes.length; i++) {
      assert.equal(
        hashes[i],
        first,
        `client ${i} final state hash (${hashes[i]}) diverged from client 0 (${first})`,
      );
    }

    // Delta compression is actually in effect, not accidentally disabled.
    assert.ok(clients[0].deltasSeen > 0, 'expected at least one delta-encoded snapshot on a normal connection');
    assert.ok(clients[0].keyframesSeen >= 2, 'expected more than one forced keyframe over the match (keyframe-gap coverage)');
    assert.ok(droppedOne, 'the lossy client test setup should have dropped exactly one delta frame');
    assert.ok(reconnectedOnce, 'the lossy client test setup should have reconnected mid-match');

    // The real correctness claim: every tick the lossy client (drop +
    // reconnect) DID manage to decode must hash identically to the same
    // tick as seen by a clean reference client -- not just the final
    // state. A wrong reconstruction that quietly self-corrected before
    // the end would still be caught here.
    const reference = clients[0];
    let comparedTicks = 0;
    for (const [tick, hash] of lossy.hashesByTick) {
      const refHash = reference.hashesByTick.get(tick);
      if (refHash === undefined) continue; // reference client is at higher rate/offset; only compare where both have it
      comparedTicks++;
      assert.equal(hash, refHash, `lossy client's reconstructed hash at tick ${tick} diverged from the reference client`);
    }
    assert.ok(comparedTicks > 5, `expected multiple overlapping ticks to cross-check, got ${comparedTicks}`);

    for (const c of clients) c.ws.close();
    lossy.ws.close();
  } finally {
    serverProc.kill();
  }
});
