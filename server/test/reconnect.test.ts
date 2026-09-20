// Reconnection: a dropped socket must not permanently lose a seat. Covers
// the four cases from the task brief: (a) reconnect resumes the same slot
// and keeps playing to an identical final hash, (b) a forged token is
// rejected cleanly, (c) a seat is released after its grace window expires
// and the token stops working, (d) reconnecting after the match already
// ended reports the outcome instead of erroring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import { hashStateBuffer } from '@bash-fighter/sim/src/hash.ts';
import { PROTOCOL_VERSION, SnapshotStreamDecoder, encodeInput } from '@bash-fighter/net/src/protocol.ts';

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

function startServer(port: number, extraEnv: Record<string, string>): ChildProcess {
  const proc = spawn(
    process.execPath,
    ['--experimental-strip-types', new URL('../src/index.ts', import.meta.url).pathname],
    {
      env: {
        ...process.env,
        PORT: String(port),
        MATCH_CAPACITY: '3',
        MATCH_MINIMUM: '3',
        MATCH_COUNTDOWN_SECONDS: '1',
        MATCH_SHRINK_FULLY_CLOSED_TICK: '100000', // effectively no arena-shrink elimination in these tests
        // These tests join as non-requeued humans and expect a normal
        // Last-Fighter-Standing match (elimination ends it quickly).
        // Without this override the first-time-visitor rule
        // (decideMatchModeForJoin, mode-rotation.ts) would force timedKO
        // and matchEnd would never fire the way these tests expect.
        MATCH_MODE_ROTATION_DISABLED: 'true',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return proc;
}

interface ControlMsg {
  t: string;
  [k: string]: unknown;
}

/** Connects one client, sends hello (optionally with a resume token), and
 *  resolves with every control message and binary snapshot seen, plus
 *  helpers to send input and close. */
function connectClient(
  port: number,
  name: string,
  resume?: string,
): Promise<{
  ws: WebSocket;
  controls: ControlMsg[];
  waitFor: (pred: (m: ControlMsg) => boolean, timeoutMs?: number) => Promise<ControlMsg>;
  lastSnapshot: () => { tick: number; state: Int32Array } | null;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/socket`);
    const controls: ControlMsg[] = [];
    const waiters: { pred: (m: ControlMsg) => boolean; resolve: (m: ControlMsg) => void }[] = [];
    let last: { tick: number; state: Int32Array } | null = null;
    const snapshotDecoder = new SnapshotStreamDecoder();
    const timer = setTimeout(() => reject(new Error(`${name} never opened`)), 20000);

    ws.on('open', () => {
      clearTimeout(timer);
      const hello: Record<string, unknown> = { t: 'hello', protocolVersion: PROTOCOL_VERSION, name };
      if (resume) hello.resume = resume;
      ws.send(JSON.stringify(hello));
      resolve({
        ws,
        controls,
        waitFor: (pred, timeoutMs = 20000) =>
          new Promise((res, rej) => {
            const existing = controls.find(pred);
            if (existing) {
              res(existing);
              return;
            }
            const t = setTimeout(() => rej(new Error(`${name}: timed out waiting for control message`)), timeoutMs);
            waiters.push({
              pred,
              resolve: (m) => {
                clearTimeout(t);
                res(m);
              },
            });
          }),
        lastSnapshot: () => last,
      });
    });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        const msg = JSON.parse(data.toString()) as ControlMsg;
        controls.push(msg);
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i].pred(msg)) {
            const [w] = waiters.splice(i, 1);
            w.resolve(msg);
          }
        }
      } else {
        const buf = data as Buffer;
        const snap = snapshotDecoder.decode(new Uint8Array(buf));
        if (snap) last = { tick: snap.tick, state: snap.state };
      }
    });
    ws.on('error', reject);
  });
}

test('client drops mid-match, reconnects with its token, resumes the same slot, and finishes with a matching state hash', async () => {
  const port = 8101;
  const server = startServer(port, {});
  let log = '';
  server.stdout?.on('data', (d) => (log += d.toString()));
  server.stderr?.on('data', (d) => (log += d.toString()));
  try {
    await waitForHealth(port, 90000);

    const a = await connectClient(port, 'Alice');
    const b = await connectClient(port, 'Bob');
    const c = await connectClient(port, 'Cara');
    const welcomeA = (await a.waitFor((m) => m.t === 'welcome')) as ControlMsg & { resumeToken: string; slot: number };
    await b.waitFor((m) => m.t === 'welcome');
    await c.waitFor((m) => m.t === 'welcome');
    await a.waitFor((m) => m.t === 'matchStart');
    await b.waitFor((m) => m.t === 'matchStart');
    await c.waitFor((m) => m.t === 'matchStart');

    assert.ok(welcomeA.resumeToken, 'a real seat must get a resume token');
    const tokenA = welcomeA.resumeToken;
    const slotA = welcomeA.slot;

    // Drive some input from everyone so the sim actually advances.
    let tick = 0;
    const drive = (ws: WebSocket, slot: number) => {
      const dir = slot % 2 === 0 ? 1 : -1;
      ws.send(encodeInput({ tick, buttons: 0, stickX: dir * 65536, stickY: 0 }));
    };
    const interval = setInterval(() => {
      tick++;
      if (a.ws.readyState === WebSocket.OPEN) drive(a.ws, slotA);
      drive(b.ws, 1);
      drive(c.ws, 2);
    }, 33);

    // Let the match run a bit, then drop Alice's socket (not via stop() --
    // a raw close, like a network drop).
    await new Promise((r) => setTimeout(r, 500));
    a.ws.close();
    await new Promise((r) => setTimeout(r, 300));

    // Reconnect with the token: must land back on the SAME slot.
    const a2 = await connectClient(port, 'Alice', tokenA);
    const welcomeA2 = (await a2.waitFor((m) => m.t === 'welcome')) as ControlMsg & { slot: number; resumed: boolean };
    assert.equal(welcomeA2.resumed, true, 'reconnect welcome must be marked resumed');
    assert.equal(welcomeA2.slot, slotA, 'reconnecting must resume the SAME slot, not a new one');
    await a2.waitFor((m) => m.t === 'matchStart');

    // Play on a little longer with the reconnected client, then compare a
    // live snapshot hash across all three clients (avoids depending on
    // combat RNG to actually end the match here).
    await new Promise((r) => setTimeout(r, 500));
    clearInterval(interval);

    // Each client's lastSnapshot() is populated by its own independent
    // websocket 'message' event, and the server keeps ticking (and
    // broadcasting a fresh snapshot every SNAPSHOT_EVERY_N_TICKS) after
    // clearInterval above -- there is no barrier guaranteeing all three
    // sockets have drained their *most recent* broadcast at the same
    // wall-clock instant. A fixed sleep here was a race: long enough on
    // most runs, but not a guarantee the three clients landed on the same
    // authoritative tick before we hash-compare their state -- a slower or
    // faster event-loop scheduling (observed reliably on Node 22, never on
    // Node 24) can catch two of them one broadcast apart, which is a real
    // difference between two genuinely different ticks, not a reconnect or
    // hash bug. Poll until all three explicitly agree on the same tick (or
    // time out with a clear message) instead of trusting a sleep to have
    // been long enough.
    const sameTickDeadline = Date.now() + 5000;
    let snapA: ReturnType<typeof a2.lastSnapshot> = null;
    let snapB: ReturnType<typeof b.lastSnapshot> = null;
    let snapC: ReturnType<typeof c.lastSnapshot> = null;
    while (Date.now() < sameTickDeadline) {
      snapA = a2.lastSnapshot();
      snapB = b.lastSnapshot();
      snapC = c.lastSnapshot();
      if (snapA && snapB && snapC && snapA.tick === snapB.tick && snapA.tick === snapC.tick) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(snapA && snapB && snapC, 'all three clients should have a snapshot after reconnect');
    assert.equal(
      snapA.tick,
      snapB.tick,
      `clients never converged on the same authoritative tick within the deadline (A=${snapA.tick} B=${snapB.tick} C=${snapC.tick}); server log:\n${log}`,
    );
    assert.equal(
      snapA.tick,
      snapC.tick,
      `clients never converged on the same authoritative tick within the deadline (A=${snapA.tick} B=${snapB.tick} C=${snapC.tick}); server log:\n${log}`,
    );
    const hashA = hashStateBuffer((snapA as { state: Int32Array }).state);
    const hashB = hashStateBuffer((snapB as { state: Int32Array }).state);
    const hashC = hashStateBuffer((snapC as { state: Int32Array }).state);
    assert.equal(hashA, hashB, `reconnected client's state hash diverged from client B; server log:\n${log}`);
    assert.equal(hashA, hashC, `reconnected client's state hash diverged from client C; server log:\n${log}`);

    a2.ws.close();
    b.ws.close();
    c.ws.close();
  } finally {
    server.kill();
  }
});

test('a wrong/forged token is rejected with an error frame and gets no seat', async () => {
  const port = 8102;
  const server = startServer(port, {});
  try {
    await waitForHealth(port, 90000);
    const forged = await connectClient(port, 'Mallory', 'not-a-real-token-'.padEnd(64, '0'));
    const err = (await forged.waitFor((m) => m.t === 'error' || m.t === 'welcome')) as ControlMsg;
    assert.equal(err.t, 'error', 'a forged token must not be granted a seat via welcome');
    assert.equal(err.code, 'resume_invalid');
    forged.ws.close();
  } finally {
    server.kill();
  }
});

test('a seat is released after the grace window expires and the token no longer works', async () => {
  const port = 8103;
  // Tiny grace window so the test doesn't wait out a real 30-60s default.
  const server = startServer(port, { MATCH_RECONNECT_GRACE_MS: '500' });
  let log = '';
  server.stdout?.on('data', (d) => (log += d.toString()));
  server.stderr?.on('data', (d) => (log += d.toString()));
  try {
    await waitForHealth(port, 90000);
    const a = await connectClient(port, 'Alice');
    const b = await connectClient(port, 'Bob');
    const c = await connectClient(port, 'Cara');
    const welcomeA = (await a.waitFor((m) => m.t === 'welcome')) as ControlMsg & { resumeToken: string };
    await a.waitFor((m) => m.t === 'matchStart');
    await b.waitFor((m) => m.t === 'matchStart');
    await c.waitFor((m) => m.t === 'matchStart');

    const tokenA = welcomeA.resumeToken;
    a.ws.close();
    // Wait past the grace window. The margin here (6x the grace window,
    // not ~2.4x) is deliberate: this test was observed to flake on a
    // contended/low-power runner, where event-loop lag alone can eat
    // several hundred ms and leave a thinner margin unreliable.
    await new Promise((r) => setTimeout(r, 3000));

    const late = await connectClient(port, 'Alice-again', tokenA);
    const result = (await late.waitFor((m) => m.t === 'error' || m.t === 'welcome')) as ControlMsg;
    assert.equal(result.t, 'error', 'an expired token must not be granted a seat');
    assert.equal(result.code, 'resume_invalid');

    // Regression: the seat's grace expiry must be observable in the server
    // log, not just inferable from client-side behaviour -- this is the
    // exact gap the production incident (undiagnosable early disconnects)
    // was about.
    assert.match(log, /"event":"seat_grace_expired"/, `expected a seat_grace_expired log line; server log:\n${log}`);
    assert.doesNotMatch(log, /resumeToken/i, 'log must never contain a resume token');

    late.ws.close();
    b.ws.close();
    c.ws.close();
  } finally {
    server.kill();
  }
});

test('a duplicate connection presenting a token for a currently-connected seat is refused and the live player is never kicked', async () => {
  const port = 8105;
  const server = startServer(port, {});
  try {
    await waitForHealth(port, 90000);
    const a = await connectClient(port, 'Alice');
    const b = await connectClient(port, 'Bob');
    const c = await connectClient(port, 'Cara');
    const welcomeA = (await a.waitFor((m) => m.t === 'welcome')) as ControlMsg & { resumeToken: string };
    await a.waitFor((m) => m.t === 'matchStart');
    await b.waitFor((m) => m.t === 'matchStart');
    await c.waitFor((m) => m.t === 'matchStart');
    const tokenA = welcomeA.resumeToken;

    // Alice's original socket stays open and live -- this is a second,
    // racing/duplicate connection presenting the same still-valid token.
    const dupe = await connectClient(port, 'Alice-duplicate', tokenA);
    const result = (await dupe.waitFor((m) => m.t === 'error' || m.t === 'welcome')) as ControlMsg;
    assert.equal(result.t, 'error', 'a token for a live, connected seat must not be granted to a second connection');
    assert.equal(result.code, 'resume_seat_taken');

    // The incumbent must not have been kicked: Alice's original socket is
    // still open and the match still treats her seat as connected.
    assert.equal(a.ws.readyState, WebSocket.OPEN, "the live player's socket must not be closed by the duplicate");
    let tick = 0;
    a.ws.send(encodeInput({ tick, buttons: 0, stickX: 65536, stickY: 0 }));
    const snap = await new Promise<boolean>((resolve) => {
      const check = setInterval(() => {
        if (a.lastSnapshot()) {
          clearInterval(check);
          resolve(true);
        }
      }, 50);
      setTimeout(() => {
        clearInterval(check);
        resolve(false);
      }, 3000);
    });
    assert.ok(snap, "Alice's original connection must keep receiving snapshots after the duplicate was refused");

    dupe.ws.close();
    a.ws.close();
    b.ws.close();
    c.ws.close();
  } finally {
    server.kill();
  }
});

test('reconnecting after the match already ended reports the outcome instead of erroring', async () => {
  const port = 8104;
  const server = startServer(port, { MATCH_SHRINK_FULLY_CLOSED_TICK: '120' }); // ~2s: force a fast finish
  try {
    await waitForHealth(port, 90000);
    const a = await connectClient(port, 'Alice');
    const b = await connectClient(port, 'Bob');
    const c = await connectClient(port, 'Cara');
    const welcomeA = (await a.waitFor((m) => m.t === 'welcome')) as ControlMsg & { resumeToken: string };
    await a.waitFor((m) => m.t === 'matchStart');
    await b.waitFor((m) => m.t === 'matchStart');
    await c.waitFor((m) => m.t === 'matchStart');
    const tokenA = welcomeA.resumeToken;

    // Alice drops without ever getting eliminated; B and C keep playing
    // (neutral input from Alice's now-empty seat) until the shrinking
    // arena ends the match.
    let tick = 0;
    const interval = setInterval(() => {
      tick++;
      if (b.ws.readyState === WebSocket.OPEN) b.ws.send(encodeInput({ tick, buttons: 0, stickX: 65536, stickY: 0 }));
      if (c.ws.readyState === WebSocket.OPEN) c.ws.send(encodeInput({ tick, buttons: 0, stickX: -65536, stickY: 0 }));
    }, 33);
    a.ws.close();

    await b.waitFor((m) => m.t === 'matchEnd', 20000);
    clearInterval(interval);
    await new Promise((r) => setTimeout(r, 200)); // let the server settle phase='ended'

    const reconnected = await connectClient(port, 'Alice-again', tokenA);
    const msg = (await reconnected.waitFor((m) => m.t === 'welcome' || m.t === 'error')) as ControlMsg;
    assert.equal(msg.t, 'welcome', `reconnect after match end should still be honoured; got: ${JSON.stringify(msg)}`);
    const outcome = await reconnected.waitFor((m) => m.t === 'matchEnd');
    assert.ok('winner' in outcome && 'leaderboard' in outcome, 'must report the actual match outcome, not an error');

    reconnected.ws.close();
    b.ws.close();
    c.ws.close();
  } finally {
    server.kill();
  }
});

test('several rapid reconnects in a row with the same token all land back on a playable seat', async () => {
  // Regression for the load-test finding that a resume token can start
  // rejecting a legitimately reconnecting player after enough rapid
  // reconnects. Five cycles of close-then-resume in quick succession, each
  // one asserting the player is actually back in the match (receiving
  // snapshots, seat still theirs) -- not just that no exception was
  // thrown.
  const port = 8106;
  const server = startServer(port, {});
  try {
    await waitForHealth(port, 90000);
    let a = await connectClient(port, 'Alice');
    const b = await connectClient(port, 'Bob');
    const c = await connectClient(port, 'Cara');
    const welcomeA = (await a.waitFor((m) => m.t === 'welcome')) as ControlMsg & { resumeToken: string; slot: number };
    await a.waitFor((m) => m.t === 'matchStart');
    await b.waitFor((m) => m.t === 'matchStart');
    await c.waitFor((m) => m.t === 'matchStart');
    const token = welcomeA.resumeToken;
    const slot = welcomeA.slot;

    for (let i = 0; i < 5; i++) {
      a.ws.close();
      // Small, deliberately tight gap: a flaky connection reconnects fast,
      // it doesn't politely wait a full second.
      await new Promise((r) => setTimeout(r, 120));
      const next = await connectClient(port, `Alice-retry-${i}`, token);
      const msg = (await next.waitFor((m) => m.t === 'welcome' || m.t === 'error')) as ControlMsg & {
        slot?: number;
      };
      assert.equal(msg.t, 'welcome', `reconnect #${i} must succeed, got: ${JSON.stringify(msg)}`);
      assert.equal(msg.slot, slot, `reconnect #${i} must land back on the same seat`);

      // Prove the seat is genuinely playable, not just accepted: send an
      // input and see a fresh snapshot come back.
      next.ws.send(encodeInput({ tick: 0, buttons: 0, stickX: 65536, stickY: 0 }));
      const gotSnapshot = await new Promise<boolean>((resolve) => {
        const check = setInterval(() => {
          if (next.lastSnapshot()) {
            clearInterval(check);
            resolve(true);
          }
        }, 50);
        setTimeout(() => {
          clearInterval(check);
          resolve(false);
        }, 3000);
      });
      assert.ok(gotSnapshot, `reconnect #${i} must keep receiving snapshots, not just an accepted hello`);
      a = next;
    }

    a.ws.close();
    b.ws.close();
    c.ws.close();
  } finally {
    server.kill();
  }
});

test('a match abandoned by every human seat is torn down promptly, not left as a phantom in /api/health', async () => {
  // Regression for the observed matchCount:1, playerCount:0 reading that
  // lingered for minutes after every human left. A match with zero humans
  // left who could ever reconnect must end and get reaped quickly -- on
  // the order of the grace window plus one reap sweep, not on the order
  // of a full bot-only battle royale playing itself out.
  const port = 8107;
  const server = startServer(port, {
    MATCH_RECONNECT_GRACE_MS: '400',
    MATCH_REAP_INTERVAL_MS: '300',
    MATCH_REAP_MAX_AGE_MS: '200',
  });
  try {
    await waitForHealth(port, 90000);
    const a = await connectClient(port, 'Alice');
    const b = await connectClient(port, 'Bob');
    const c = await connectClient(port, 'Cara');
    await a.waitFor((m) => m.t === 'matchStart');
    await b.waitFor((m) => m.t === 'matchStart');
    await c.waitFor((m) => m.t === 'matchStart');

    const before = await fetch(`http://localhost:${port}/api/health`).then((r) => r.json());
    assert.equal(before.matchCount, 1, 'sanity check: exactly one match should exist while it is being played');

    // Every human walks away for good -- no reconnect follows.
    a.ws.close();
    b.ws.close();
    c.ws.close();

    // Grace (400ms) + one reap sweep (server runs it every 30s in
    // production; that's too slow for a test, so poll instead of waiting
    // out a fixed sleep) -- give it a generous but bounded window that is
    // nowhere near "minutes".
    const deadline = Date.now() + 20000;
    let last = before;
    while (Date.now() < deadline) {
      last = await fetch(`http://localhost:${port}/api/health`).then((r) => r.json());
      if (last.matchCount === 0) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(
      last.matchCount,
      0,
      `an abandoned match must be torn down within a few seconds, not linger; last health: ${JSON.stringify(last)}`,
    );
  } finally {
    server.kill();
  }
});
