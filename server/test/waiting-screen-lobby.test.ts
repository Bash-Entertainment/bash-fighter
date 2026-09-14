// Waiting-screen fix (this task): the lobby message must carry an honest,
// server-driven countdown even for a lone human sitting through the
// bot-fill grace period, and a seat-holder must be able to force an
// immediate start ("Start now" on the client). See
// packages/app/src/ui/waiting-screen.ts. This test drives the real
// server as a child process and real WebSocket clients, the same
// pattern as bot-fill.test.ts and integration.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@bash-fighter/net/src/protocol.ts';

// 8099 collided with server/test/integration.test.ts's own hardcoded port;
// moved (2026-09-14) -- see server/test/port-registry.test.ts.
const PORT = 8208;
const CAPACITY = 6;

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

function spawnServer(env: Record<string, string>): ChildProcess {
  return spawn(
    process.execPath,
    ['--experimental-strip-types', new URL('../src/index.ts', import.meta.url).pathname],
    { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

test('lone human in a lobby is told a real countdown to the bot-fill deadline', async () => {
  const serverProc = spawnServer({
    PORT: String(PORT),
    MATCH_CAPACITY: String(CAPACITY),
    MATCH_MINIMUM: String(CAPACITY),
    MATCH_COUNTDOWN_SECONDS: '60',
    MATCH_BOT_FILL_SECONDS: '5',
    MATCH_BOT_FILL_TARGET: String(CAPACITY),
  });
  let serverLog = '';
  serverProc.stdout?.on('data', (d) => (serverLog += d.toString()));
  serverProc.stderr?.on('data', (d) => (serverLog += d.toString()));

  try {
    await waitForHealth(PORT, 90000);
    const ws = new WebSocket(`ws://localhost:${PORT}/socket`);
    const firstLobby: Promise<{ countdownTicks: number; players: number; capacity: number }> = new Promise(
      (resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no lobby message within timeout. log:\n${serverLog}`)), 8000);
        ws.on('open', () => {
          ws.send(JSON.stringify({ t: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'RealHuman' }));
        });
        ws.on('message', (data, isBinary) => {
          if (isBinary) return;
          const msg = JSON.parse(data.toString('utf8'));
          if (msg.t === 'lobby') {
            clearTimeout(timer);
            resolve(msg);
          }
        });
        ws.on('error', reject);
      },
    );

    const lobby = await firstLobby;
    assert.equal(lobby.players, 1);
    assert.equal(lobby.capacity, CAPACITY);
    assert.ok(lobby.countdownTicks >= 0, 'a lone human must see a real countdown, not an unset -1');
    assert.ok(lobby.countdownTicks <= 5 * 60, 'countdown must not exceed the configured bot-fill grace period');

    ws.close();
  } finally {
    serverProc.kill();
  }
});

test('"start now" from a seat-holder starts immediately with bots, and repeats are a no-op', async () => {
  const serverProc = spawnServer({
    PORT: String(PORT + 1),
    MATCH_CAPACITY: String(CAPACITY),
    MATCH_MINIMUM: String(CAPACITY),
    MATCH_COUNTDOWN_SECONDS: '60',
    MATCH_BOT_FILL_SECONDS: '60',
    MATCH_BOT_FILL_TARGET: String(CAPACITY),
  });
  let serverLog = '';
  serverProc.stdout?.on('data', (d) => (serverLog += d.toString()));
  serverProc.stderr?.on('data', (d) => (serverLog += d.toString()));

  try {
    await waitForHealth(PORT + 1, 90000);
    const ws = new WebSocket(`ws://localhost:${PORT + 1}/socket`);

    const matchStart: Promise<{ names: string[]; numFighters: number }> = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no matchStart within timeout. log:\n${serverLog}`)), 8000);
      ws.on('open', () => {
        ws.send(JSON.stringify({ t: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'Impatient' }));
      });
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        const msg = JSON.parse(data.toString('utf8'));
        if (msg.t === 'lobby') {
          ws.send(JSON.stringify({ t: 'startNow' }));
          setTimeout(() => ws.send(JSON.stringify({ t: 'startNow' })), 200);
        } else if (msg.t === 'matchStart') {
          clearTimeout(timer);
          resolve({ names: msg.names, numFighters: msg.numFighters });
        }
      });
      ws.on('error', reject);
    });

    const { names, numFighters } = await matchStart;
    assert.equal(numFighters, CAPACITY, 'start now should still fill up to the bot-fill target');
    assert.equal(names[0], 'Impatient');
    for (const n of names.slice(1)) {
      assert.ok(n.startsWith('CPU '), `bot name "${n}" should be clearly distinguishable from a human's`);
    }

    ws.close();
  } finally {
    serverProc.kill();
  }
});

test('"start now" from a connection with no seat (pre-hello) is ignored', async () => {
  const serverProc = spawnServer({
    PORT: String(PORT + 2),
    MATCH_CAPACITY: String(CAPACITY),
    MATCH_MINIMUM: String(CAPACITY),
    MATCH_COUNTDOWN_SECONDS: '60',
    MATCH_BOT_FILL_SECONDS: '60',
    MATCH_BOT_FILL_TARGET: String(CAPACITY),
  });
  let serverLog = '';
  serverProc.stdout?.on('data', (d) => (serverLog += d.toString()));
  serverProc.stderr?.on('data', (d) => (serverLog += d.toString()));

  try {
    await waitForHealth(PORT + 2, 90000);
    const ws = new WebSocket(`ws://localhost:${PORT + 2}/socket`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    ws.send(JSON.stringify({ t: 'startNow' }));

    await new Promise((r) => setTimeout(r, 500));
    assert.equal(ws.readyState, WebSocket.OPEN, 'server must not crash or drop the connection on a seatless startNow');
    const health = await fetch(`http://localhost:${PORT + 2}/api/health`).then((r) => r.json());
    assert.equal(health.playerCount, 0, 'no seat was ever taken, so no player should be counted');

    ws.close();
  } finally {
    serverProc.kill();
  }
});
