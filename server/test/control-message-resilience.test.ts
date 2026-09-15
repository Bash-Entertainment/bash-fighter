// A real player reported "Connection dropped all the time". The cause was
// ours: the client's sessionReport exceeded a 512-byte control-message cap,
// failed to parse, and the server responded by CLOSING the socket -- so
// every session ended in a forced disconnect, and every session's client
// telemetry was lost (which is why frame fields read null in production
// logs). Two rules are pinned here:
//   1. an unparseable control message must never end a live connection;
//   2. a realistically sized sessionReport must be accepted.
// Control messages are advisory; the authoritative sim never depends on
// them, so dropping one is always safer than dropping the player.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@bash-fighter/net/src/protocol.ts';

// Unique port -- see server/test/port-registry.test.ts.
const PORT = 8210;

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

test('garbage control messages are ignored, and the player keeps playing', async () => {
  const serverProc = spawnServer({
    PORT: String(PORT),
    MATCH_CAPACITY: '4',
    MATCH_MINIMUM: '4',
    MATCH_BOT_FILL_SECONDS: '1',
    MATCH_BOT_FILL_TARGET: '4',
  });
  let serverLog = '';
  serverProc.stdout?.on('data', (d) => (serverLog += d.toString()));
  serverProc.stderr?.on('data', (d) => (serverLog += d.toString()));

  try {
    await waitForHealth(PORT, 90000);
    const ws = new WebSocket(`ws://localhost:${PORT}/socket`);
    let closeCode: number | null = null;
    ws.on('close', (code) => (closeCode = code));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket never opened')), 10000);
      ws.on('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    ws.send(JSON.stringify({ t: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'Tester' }));
    await new Promise((r) => setTimeout(r, 500));

    // Every shape of nonsense a client could plausibly emit.
    ws.send('not json at all');
    ws.send(JSON.stringify({ t: 'noSuchMessageType' }));
    ws.send(JSON.stringify({ t: 'pong' })); // missing id
    ws.send(JSON.stringify({ t: 'sessionReport', pad: 'x'.repeat(20000) })); // over the hard cap
    await new Promise((r) => setTimeout(r, 1500));

    assert.equal(closeCode, null, `server closed the connection (code ${closeCode}). log:\n${serverLog}`);
    assert.equal(ws.readyState, WebSocket.OPEN, 'connection must still be open after bad control messages');
    assert.match(serverLog, /control_message_ignored/, 'the ignored message should be logged for diagnosis');
    assert.doesNotMatch(serverLog, /malformed control message/, 'must not close with bad_message any more');
    ws.close();
  } finally {
    serverProc.kill('SIGKILL');
  }
});
