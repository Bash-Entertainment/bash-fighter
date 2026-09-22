// Spectate by link (see [[Spectate by link]], ?watch=CODE): a spectate
// hello must never take a seat, must land on the coded match when the
// code is live, and must fall back to the current public match (never
// erroring, never creating a fresh private lobby) when the code is
// unknown or that match already ended.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@bash-fighter/net/src/protocol.ts';
import { generateJoinCode } from '../../packages/app/src/join-link.ts';

const PORT = 8235;

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

interface ControlMsg {
  t: string;
  [k: string]: unknown;
}

function connect(
  port: number,
  hello: Record<string, unknown>,
): Promise<{ ws: WebSocket; waitFor: (pred: (m: ControlMsg) => boolean, timeoutMs?: number) => Promise<ControlMsg> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/socket`);
    const controls: ControlMsg[] = [];
    const waiters: { pred: (m: ControlMsg) => boolean; resolve: (m: ControlMsg) => void }[] = [];
    const openTimer = setTimeout(() => reject(new Error('never opened')), 20000);
    ws.on('open', () => {
      clearTimeout(openTimer);
      ws.send(JSON.stringify({ t: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'X', ...hello }));
      resolve({
        ws,
        waitFor: (pred, timeoutMs = 20000) =>
          new Promise((res, rej) => {
            const existing = controls.find(pred);
            if (existing) {
              res(existing);
              return;
            }
            const t = setTimeout(() => rej(new Error('timed out waiting for control message')), timeoutMs);
            waiters.push({ pred, resolve: (m) => { clearTimeout(t); res(m); } });
          }),
      });
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString()) as ControlMsg;
      controls.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(msg)) {
          const [w] = waiters.splice(i, 1);
          w.resolve(msg);
        }
      }
    });
    ws.on('error', reject);
  });
}

test('spectate-by-code: lands on the coded lobby without taking a seat, and falls back when the code is unknown', async () => {
  const server: ChildProcess = spawn(
    process.execPath,
    ['--experimental-strip-types', new URL('../src/index.ts', import.meta.url).pathname],
    {
      env: {
        ...process.env,
        PORT: String(PORT),
        MATCH_CAPACITY: '20',
        MATCH_MINIMUM: '20',
        MATCH_COUNTDOWN_SECONDS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let log = '';
  server.stdout?.on('data', (d) => (log += d.toString()));
  server.stderr?.on('data', (d) => (log += d.toString()));
  try {
    await waitForHealth(PORT, 90000);

    // Host a coded lobby, as "Play with a friend" does: the client
    // generates the code and sends it in hello.joinCode.
    const code = generateJoinCode();
    const host = await connect(PORT, { joinCode: code });
    const hostWelcome = (await host.waitFor((m) => m.t === 'welcome')) as ControlMsg & {
      matchId: string;
      joinCode?: string;
    };
    assert.equal(hostWelcome.joinCode, code, 'sanity: hosting produced the requested join code');

    // A watcher presenting that exact code lands on the same match as a
    // pure spectator: welcome.slot === -1, no seat, correct matchId.
    const watcher = await connect(PORT, { spectate: true, joinCode: code });
    const watcherWelcome = (await watcher.waitFor((m) => m.t === 'welcome')) as ControlMsg & {
      matchId: string;
      slot: number;
      joinCode?: string;
    };
    assert.equal(watcherWelcome.slot, -1, 'a spectate hello never takes a seat');
    assert.equal(watcherWelcome.matchId, hostWelcome.matchId);
    assert.equal(watcherWelcome.joinCode, code);

    // A second player actually joins the lobby with a real seat --
    // proves the watcher above did not consume one.
    const friend = await connect(PORT, { joinCode: code });
    const friendWelcome = (await friend.waitFor((m) => m.t === 'welcome')) as ControlMsg & { slot: number };
    assert.equal(friendWelcome.slot, 1, 'the friend gets the second real seat, unaffected by the watcher');

    // A plain public joiner, so there is a real public match to fall
    // back to below.
    const pub = await connect(PORT, {});
    const pubWelcome = (await pub.waitFor((m) => m.t === 'welcome')) as ControlMsg & { matchId: string };

    // An unknown code falls back to the current public match instead of
    // erroring or creating a fresh private lobby.
    const stranger = await connect(PORT, { spectate: true, joinCode: 'ZZZZ' });
    const strangerWelcome = (await stranger.waitFor((m) => m.t === 'welcome')) as ControlMsg & {
      matchId: string;
      slot: number;
      joinCode?: string;
    };
    assert.equal(strangerWelcome.slot, -1);
    assert.notEqual(strangerWelcome.joinCode, 'ZZZZ');
    assert.equal(strangerWelcome.matchId, pubWelcome.matchId, 'unknown code falls back to the public match');

    host.ws.close();
    watcher.ws.close();
    friend.ws.close();
    pub.ws.close();
    stranger.ws.close();
  } catch (err) {
    console.error('server log:\n' + log);
    throw err;
  } finally {
    server.kill();
  }
});
