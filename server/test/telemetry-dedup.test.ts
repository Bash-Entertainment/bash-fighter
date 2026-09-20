// Telemetry double-counting fix (2026-09-20): a human seat's whole stay in
// one match must produce exactly ONE sessionEnd record in stats.jsonl, no
// matter how many times it disconnects/resumes. Covers the four outcomes
// from the task brief: (a) disconnect+resume+match end -> one record,
// reconnectCount 1; (b) disconnect with no resume -> one record, reason
// "disconnected"; (c) a seat that never disconnects -> one record,
// reconnectCount 0; (d) resuming into an already-ended match must never
// itself produce a record (the actual bug: that branch used to leave
// hadLiveSeat true on the resumed connection, so its later close emitted a
// second, all-null record).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, encodeInput } from '@bash-fighter/net/src/protocol.ts';

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

function startServer(port: number, statsPath: string, extraEnv: Record<string, string>): ChildProcess {
  return spawn(
    process.execPath,
    ['--experimental-strip-types', new URL('../src/index.ts', import.meta.url).pathname],
    {
      env: {
        ...process.env,
        PORT: String(port),
        STATS_LOG_PATH: statsPath,
        MATCH_CAPACITY: '2',
        MATCH_MINIMUM: '2',
        MATCH_COUNTDOWN_SECONDS: '1',
        MATCH_SHRINK_FULLY_CLOSED_TICK: '100000',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

interface ControlMsg {
  t: string;
  [k: string]: unknown;
}

function connectClient(
  port: number,
  name: string,
  resume?: string,
): Promise<{
  ws: WebSocket;
  waitFor: (pred: (m: ControlMsg) => boolean, timeoutMs?: number) => Promise<ControlMsg>;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/socket`);
    const controls: ControlMsg[] = [];
    const waiters: { pred: (m: ControlMsg) => boolean; resolve: (m: ControlMsg) => void }[] = [];
    const timer = setTimeout(() => reject(new Error(`${name} never opened`)), 20000);
    ws.on('open', () => {
      clearTimeout(timer);
      const hello: Record<string, unknown> = {
        t: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        name,
        profile: { touchActive: true },
      };
      if (resume) hello.resume = resume;
      ws.send(JSON.stringify(hello));
      resolve({
        ws,
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

function readSessionEndRecords(statsPath: string): Array<Record<string, unknown>> {
  if (!existsSync(statsPath)) return [];
  return readFileSync(statsPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((r) => r.type === 'sessionEnd');
}

const PORT = 8211;

test('disconnect, resume, then match end: exactly one sessionEnd record, reconnectCount 1', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bf-stats-'));
  const statsPath = path.join(dir, 'stats.jsonl');
  const server = startServer(PORT, statsPath, { MATCH_RECONNECT_GRACE_MS: '30000', MATCH_SHRINK_FULLY_CLOSED_TICK: '150' });
  let log = '';
  server.stdout?.on('data', (d) => (log += d.toString()));
  server.stderr?.on('data', (d) => (log += d.toString()));
  try {
    await waitForHealth(PORT, 90000);
    const a = await connectClient(PORT, 'Alice');
    const b = await connectClient(PORT, 'Bob');
    const welcomeA = (await a.waitFor((m) => m.t === 'welcome')) as ControlMsg & { resumeToken: string };
    await a.waitFor((m) => m.t === 'matchStart');
    await b.waitFor((m) => m.t === 'matchStart');
    const tokenA = welcomeA.resumeToken;

    let tick = 0;
    const interval = setInterval(() => {
      tick++;
      if (a.ws.readyState === WebSocket.OPEN) a.ws.send(encodeInput({ tick, buttons: 0, stickX: 65536, stickY: 0 }));
      if (b.ws.readyState === WebSocket.OPEN) b.ws.send(encodeInput({ tick, buttons: 0, stickX: -65536, stickY: 0 }));
    }, 33);

    await new Promise((r) => setTimeout(r, 400));
    a.ws.close();
    await new Promise((r) => setTimeout(r, 300));

    const a2 = await connectClient(PORT, 'Alice', tokenA);
    const welcomeA2 = (await a2.waitFor((m) => m.t === 'welcome')) as ControlMsg & { resumed: boolean };
    assert.equal(welcomeA2.resumed, true);

    await b.waitFor((m) => m.t === 'matchEnd', 20000);
    clearInterval(interval);
    await new Promise((r) => setTimeout(r, 300));

    a2.ws.close();
    b.ws.close();
    await new Promise((r) => setTimeout(r, 500));

    const records = readSessionEndRecords(statsPath).filter((r) => r.eliminated === false);
    assert.equal(records.length, 1, `expected exactly one sessionEnd record for Alice's seat; got ${records.length}: ${JSON.stringify(records)}; log:\n${log}`);
    assert.equal(records[0].reconnectCount, 1);
    assert.equal(records[0].touchActive, true, 'the surviving record must still carry profile-derived data, not go null on resume');
  } finally {
    server.kill();
  }
});

test('disconnect with no resume: exactly one sessionEnd record, endReason disconnected', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bf-stats-'));
  const statsPath = path.join(dir, 'stats.jsonl');
  const server = startServer(PORT + 1, statsPath, { MATCH_RECONNECT_GRACE_MS: '400' });
  try {
    await waitForHealth(PORT + 1, 90000);
    const a = await connectClient(PORT + 1, 'Alice');
    const b = await connectClient(PORT + 1, 'Bob');
    await a.waitFor((m) => m.t === 'welcome');
    await a.waitFor((m) => m.t === 'matchStart');
    await b.waitFor((m) => m.t === 'matchStart');

    a.ws.close();
    await new Promise((r) => setTimeout(r, 1500)); // outlast the grace window

    const records = readSessionEndRecords(statsPath);
    assert.equal(records.length, 1, `expected exactly one sessionEnd record; got ${records.length}: ${JSON.stringify(records)}`);
    assert.equal(records[0].endReason, 'disconnected');
    assert.equal(records[0].reconnectCount, 0);

    b.ws.close();
  } finally {
    server.kill();
  }
});

test('a seat that stays connected to the end: exactly one sessionEnd record, reconnectCount 0', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bf-stats-'));
  const statsPath = path.join(dir, 'stats.jsonl');
  const server = startServer(PORT + 2, statsPath, { MATCH_SHRINK_FULLY_CLOSED_TICK: '150' });
  try {
    await waitForHealth(PORT + 2, 90000);
    const a = await connectClient(PORT + 2, 'Alice');
    const b = await connectClient(PORT + 2, 'Bob');
    await a.waitFor((m) => m.t === 'welcome');
    await a.waitFor((m) => m.t === 'matchStart');
    await b.waitFor((m) => m.t === 'matchStart');

    let tick = 0;
    const interval = setInterval(() => {
      tick++;
      if (a.ws.readyState === WebSocket.OPEN) a.ws.send(encodeInput({ tick, buttons: 0, stickX: 65536, stickY: 0 }));
      if (b.ws.readyState === WebSocket.OPEN) b.ws.send(encodeInput({ tick, buttons: 0, stickX: -65536, stickY: 0 }));
    }, 33);

    await a.waitFor((m) => m.t === 'matchEnd', 20000);
    clearInterval(interval);
    await new Promise((r) => setTimeout(r, 200));

    a.ws.close();
    b.ws.close();
    await new Promise((r) => setTimeout(r, 500));

    const records = readSessionEndRecords(statsPath);
    assert.equal(records.length, 2, `expected one record per seat (2 seats); got ${records.length}: ${JSON.stringify(records)}`);
    for (const r of records) assert.equal(r.reconnectCount, 0);
  } finally {
    server.kill();
  }
});

test('resuming into an already-ended match never produces its own sessionEnd record', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bf-stats-'));
  const statsPath = path.join(dir, 'stats.jsonl');
  const server = startServer(PORT + 3, statsPath, { MATCH_SHRINK_FULLY_CLOSED_TICK: '150' });
  try {
    await waitForHealth(PORT + 3, 90000);
    const a = await connectClient(PORT + 3, 'Alice');
    const b = await connectClient(PORT + 3, 'Bob');
    const welcomeA = (await a.waitFor((m) => m.t === 'welcome')) as ControlMsg & { resumeToken: string };
    await a.waitFor((m) => m.t === 'matchStart');
    await b.waitFor((m) => m.t === 'matchStart');
    const tokenA = welcomeA.resumeToken;

    let tick = 0;
    const interval = setInterval(() => {
      tick++;
      if (a.ws.readyState === WebSocket.OPEN) a.ws.send(encodeInput({ tick, buttons: 0, stickX: 65536, stickY: 0 }));
      if (b.ws.readyState === WebSocket.OPEN) b.ws.send(encodeInput({ tick, buttons: 0, stickX: -65536, stickY: 0 }));
    }, 33);

    await b.waitFor((m) => m.t === 'matchEnd', 20000);
    clearInterval(interval);
    await new Promise((r) => setTimeout(r, 200));

    // Alice's original connection is still open through the match end
    // (never disconnected) -- close it now, after the match already ended.
    a.ws.close();
    await new Promise((r) => setTimeout(r, 300));

    const afterFirstClose = readSessionEndRecords(statsPath);
    assert.equal(afterFirstClose.length, 1, `expected exactly Alice's record after her original connection closed; got ${afterFirstClose.length}: ${JSON.stringify(afterFirstClose)}`);

    // Now resume with Alice's token into the already-ended match, then
    // close that connection too -- this must NOT add a third record.
    const again = await connectClient(PORT + 3, 'Alice-again', tokenA);
    const msg = await again.waitFor((m) => m.t === 'welcome' || m.t === 'error');
    assert.equal(msg.t, 'welcome');
    await again.waitFor((m) => m.t === 'matchEnd');
    again.ws.close();
    await new Promise((r) => setTimeout(r, 400));

    b.ws.close();
    await new Promise((r) => setTimeout(r, 300));

    const finalRecords = readSessionEndRecords(statsPath);
    assert.equal(
      finalRecords.length,
      2,
      `resuming into an ended match then closing must not add a third record (1 for Alice + 1 for Bob); got ${finalRecords.length}: ${JSON.stringify(finalRecords)}`,
    );
  } finally {
    server.kill();
  }
});
