// Proves the spectator/eliminated snapshot-rate reduction added in
// "server: halve snapshot rate for spectator/eliminated connections":
// a connection that opts into spectating should receive roughly half as
// many binary SNAPSHOT messages as an active in-match connection over the
// same wall-clock window, over the real WebSocket wire.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, BinaryTag } from '@bash-fighter/net/src/protocol.ts';

// 8111 collided with server/test/player-names.test.ts's own hardcoded port;
// moved (2026-09-14) -- see server/test/port-registry.test.ts.
const PORT = 8209;
const NUM_CLIENTS = 2;

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

test('a spectating connection receives roughly half the snapshot rate of an active connection', async () => {
  const serverProc: ChildProcess = spawn(
    process.execPath,
    ['--experimental-strip-types', new URL('../src/index.ts', import.meta.url).pathname],
    {
      env: {
        ...process.env,
        PORT: String(PORT),
        MATCH_CAPACITY: String(NUM_CLIENTS),
        MATCH_MINIMUM: String(NUM_CLIENTS),
        MATCH_COUNTDOWN_SECONDS: '1',
        // Keep the arena from shrinking/eliminating anyone during the
        // measurement window -- we want a stable "active vs spectator"
        // comparison, not a match that ends mid-measurement.
        MATCH_SHRINK_FULLY_CLOSED_TICK: '100000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let serverLog = '';
  serverProc.stdout?.on('data', (d) => (serverLog += d.toString()));
  serverProc.stderr?.on('data', (d) => (serverLog += d.toString()));

  try {
    await waitForHealth(PORT, 90000);

    const activeWs = new WebSocket(`ws://localhost:${PORT}/socket`);
    const spectatorWs = new WebSocket(`ws://localhost:${PORT}/socket`);
    let activeSnapshots = 0;
    let spectatorSnapshots = 0;

    function countSnapshots(ws: WebSocket, onCount: () => void): void {
      ws.on('message', (data, isBinary) => {
        // Count any snapshot frame, full keyframe or delta -- rate is about
        // frequency of updates, not which encoding a given tick happened to use.
        if (isBinary && ((data as Buffer)[0] === BinaryTag.SNAPSHOT || (data as Buffer)[0] === BinaryTag.SNAPSHOT_DELTA)) onCount();
      });
    }
    countSnapshots(activeWs, () => activeSnapshots++);
    countSnapshots(spectatorWs, () => spectatorSnapshots++);

    await Promise.all(
      [activeWs, spectatorWs].map(
        (ws) =>
          new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('never got welcome')), 8000);
            ws.on('open', () => {
              ws.send(JSON.stringify({ t: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'Bot' }));
            });
            ws.on('message', (data, isBinary) => {
              if (isBinary) return;
              const msg = JSON.parse(data.toString());
              if (msg.t === 'welcome') {
                clearTimeout(timer);
                resolve();
              }
            });
            ws.on('error', reject);
          }),
      ),
    );

    // Opt the second connection into pure spectating right away.
    spectatorWs.send(JSON.stringify({ t: 'spectate' }));

    // Let the match start (countdown) and run for a measurement window.
    // Reset counters after the countdown so we only measure in-match rate.
    await new Promise((r) => setTimeout(r, 2500));
    activeSnapshots = 0;
    spectatorSnapshots = 0;
    const measureMs = 4000;
    await new Promise((r) => setTimeout(r, measureMs));

    activeWs.close();
    spectatorWs.close();

    assert.ok(activeSnapshots > 0, `active connection got no snapshots; server log:\n${serverLog}`);
    assert.ok(spectatorSnapshots > 0, `spectator connection got no snapshots; server log:\n${serverLog}`);

    const ratio = activeSnapshots / spectatorSnapshots;
    assert.ok(
      ratio > 1.5 && ratio < 2.5,
      `expected active/spectator snapshot ratio near 2, got ${ratio.toFixed(2)} ` +
        `(active=${activeSnapshots}, spectator=${spectatorSnapshots})`,
    );
  } finally {
    serverProc.kill();
  }
});
