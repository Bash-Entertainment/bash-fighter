// Shareable lobby links (see [[Shareable lobby links]]): a client-generated
// 4-character join code lets a group land in the same private lobby via a
// URL, with no server-side allocation handshake. This test drives the real
// server as a child process and real WebSocket clients, the same pattern as
// waiting-screen-lobby.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@bash-fighter/net/src/protocol.ts';

const PORT = 8230;
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

function spawnServer(port: number, env: Record<string, string>): ChildProcess {
  return spawn(
    process.execPath,
    ['--experimental-strip-types', new URL('../src/index.ts', import.meta.url).pathname],
    { env: { ...process.env, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function connectAndHello(port: number, name: string, joinCode?: string): Promise<{ ws: WebSocket; welcome: any }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/socket`);
    const timer = setTimeout(() => reject(new Error('no welcome within timeout')), 8000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'hello', protocolVersion: PROTOCOL_VERSION, name, ...(joinCode ? { joinCode } : {}) }));
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString('utf8'));
      if (msg.t === 'welcome') {
        clearTimeout(timer);
        resolve({ ws, welcome: msg });
      }
    });
    ws.on('error', reject);
  });
}

test('a sanitised good code creates a coded lobby, echoed back in welcome', async () => {
  const port = PORT;
  const serverProc = spawnServer(port, {
    MATCH_CAPACITY: String(CAPACITY),
    MATCH_MINIMUM: String(CAPACITY),
    MATCH_COUNTDOWN_SECONDS: '60',
    MATCH_BOT_FILL_SECONDS: '60',
    MATCH_PRIVATE_BOT_FILL_SECONDS: '60',
  });
  try {
    await waitForHealth(port, 90000);
    const { ws, welcome } = await connectAndHello(port, 'Host', 'ab-c!d'); // lowercase + junk chars
    assert.equal(welcome.joinCode, 'ABCD', 'code must be sanitised: uppercased, junk stripped');
    ws.close();
  } finally {
    serverProc.kill();
  }
});

test('a malformed code is dropped, landing the joiner in the normal public lobby', async () => {
  const port = PORT + 1;
  const serverProc = spawnServer(port, {
    MATCH_CAPACITY: String(CAPACITY),
    MATCH_MINIMUM: String(CAPACITY),
    MATCH_COUNTDOWN_SECONDS: '60',
    MATCH_BOT_FILL_SECONDS: '60',
  });
  try {
    await waitForHealth(port, 90000);
    const { ws, welcome } = await connectAndHello(port, 'Solo', '!!'); // too short after stripping
    assert.equal(welcome.joinCode, undefined, 'malformed code must be dropped, not surfaced as a coded lobby');
    ws.close();
  } finally {
    serverProc.kill();
  }
});

test('two connections with the same code land in the same match, never the public lobby', async () => {
  const port = PORT + 2;
  const serverProc = spawnServer(port, {
    MATCH_CAPACITY: String(CAPACITY),
    MATCH_MINIMUM: String(CAPACITY),
    MATCH_COUNTDOWN_SECONDS: '60',
    MATCH_BOT_FILL_SECONDS: '60',
    MATCH_PRIVATE_BOT_FILL_SECONDS: '60',
  });
  try {
    await waitForHealth(port, 90000);
    const { ws: ws1, welcome: w1 } = await connectAndHello(port, 'Friend1', 'WXYZ');
    const { ws: ws2, welcome: w2 } = await connectAndHello(port, 'Friend2', 'WXYZ');
    assert.equal(w1.matchId, w2.matchId, 'same code must land both connections in the same match');
    assert.equal(w2.joinCode, 'WXYZ');

    // A third, code-less connection must never land in the coded match.
    const { ws: ws3, welcome: w3 } = await connectAndHello(port, 'Stranger');
    assert.notEqual(w3.matchId, w1.matchId, 'an uncoded join must never land in a coded lobby');
    assert.equal(w3.joinCode, undefined);

    ws1.close();
    ws2.close();
    ws3.close();
  } finally {
    serverProc.kill();
  }
});

test('a coded lobby does not start on the public countdown-on-minimum, only its own longer bot-fill timer', async () => {
  const port = PORT + 3;
  const serverProc = spawnServer(port, {
    MATCH_CAPACITY: String(CAPACITY),
    MATCH_MINIMUM: '2',
    MATCH_COUNTDOWN_SECONDS: '2', // would fire almost immediately if it applied
    MATCH_BOT_FILL_SECONDS: '60',
    MATCH_PRIVATE_BOT_FILL_SECONDS: '3',
  });
  let serverLog = '';
  serverProc.stdout?.on('data', (d) => (serverLog += d.toString()));
  serverProc.stderr?.on('data', (d) => (serverLog += d.toString()));
  try {
    await waitForHealth(port, 90000);
    const { ws: ws1 } = await connectAndHello(port, 'Friend1', 'QRST');
    const { ws: ws2 } = await connectAndHello(port, 'Friend2', 'QRST');

    // Minimum (2) is met immediately, which would fire the public
    // countdown within MATCH_COUNTDOWN_SECONDS=2s. Wait past that and
    // confirm the match is still in the lobby (no matchStart yet).
    let matchStarted = false;
    ws1.on('message', (data, isBinary) => {
      if (!isBinary && JSON.parse(data.toString('utf8')).t === 'matchStart') matchStarted = true;
    });
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(matchStarted, false, `coded lobby must not start on the public minimum countdown. log:\n${serverLog}`);

    // But it does start via its own (short, for this test) bot-fill timer.
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal(matchStarted, true, 'coded lobby must still start via its own longer bot-fill grace period');

    ws1.close();
    ws2.close();
  } finally {
    serverProc.kill();
  }
});

test('a code is cleaned up once its match leaves the lobby phase: a later joiner with the same code gets a fresh lobby', async () => {
  const port = PORT + 4;
  const serverProc = spawnServer(port, {
    MATCH_CAPACITY: '2',
    MATCH_MINIMUM: '2',
    MATCH_COUNTDOWN_SECONDS: '60',
    MATCH_BOT_FILL_SECONDS: '60',
    MATCH_PRIVATE_BOT_FILL_SECONDS: '60',
  });
  try {
    await waitForHealth(port, 90000);
    // Fill the coded lobby to capacity so it starts immediately.
    const { ws: ws1, welcome: w1 } = await connectAndHello(port, 'Friend1', 'LMNP');
    const { ws: ws2, welcome: w2 } = await connectAndHello(port, 'Friend2', 'LMNP');
    assert.equal(w1.matchId, w2.matchId);

    // A third connection presenting the same code now must get a brand
    // new match: the old one has left the lobby phase and its code entry
    // must have been cleaned up rather than silently reused or blocking.
    const { ws: ws3, welcome: w3 } = await connectAndHello(port, 'Friend3', 'LMNP');
    assert.notEqual(w3.matchId, w1.matchId, 'a code must be freed once its match leaves the lobby phase');
    assert.equal(w3.joinCode, 'LMNP');

    ws1.close();
    ws2.close();
    ws3.close();
  } finally {
    serverProc.kill();
  }
});
