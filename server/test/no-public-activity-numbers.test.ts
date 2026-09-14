// The owner's decision (2026-09-14) is that our activity numbers -- how many
// matches are running, how many people are connected -- are private while the
// game is in early growth. They are read over SSH via scripts/stats-report.mjs,
// never over HTTP.
//
// nginx adds X-Forwarded-For to every request it proxies, so its presence means
// the request came from the internet. These tests pin both halves of that rule:
// a request that looks proxied gets nothing, and a direct loopback request (the
// box itself, or this test suite) still gets the operational detail it needs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';

// An uncommon port: a leaked server from another run holding it would make
// these tests hang rather than fail, so keep it clear of the other suites.
// 8107 collided with server/test/reconnect.test.ts's own hardcoded port and
// was the root cause of that file's "abandoned match" test reading a
// phantom matchCount from whichever of the two servers won the race for the
// port (2026-09-14) -- see server/test/port-registry.test.ts, which now
// pins every test file to a distinct port so this can't happen silently
// again.
const PORT = 8207;

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

// One server for the whole file: spawning three is slower and leaks harder if a
// kill is missed. `before`/`after` guarantee teardown even when a test throws.
let child: ChildProcess | undefined;

before(async () => {
  // Spawn node directly on the source file (as every other server test file
  // does), not `npx tsx ...`. npx execs through an extra shell/loader layer,
  // so the process this test's ChildProcess handle refers to is not the one
  // that actually binds the port -- `child.kill()` in `after` killed only the
  // top of that chain and left the real server running forever as an orphan,
  // holding the port for good. That leaked server was the root cause behind
  // the reconnect.test.ts "abandoned match" phantom (2026-09-14): a stale,
  // never-killed instance of this file's server, still bound to a port,
  // answering health checks with its own stale state.
  child = spawn(
    process.execPath,
    ['--experimental-strip-types', new URL('../src/index.ts', import.meta.url).pathname],
    {
      env: { ...process.env, PORT: String(PORT), STATS_LOG_PATH: '/tmp/stats-test-public.jsonl' },
      stdio: 'ignore',
    },
  );
  await waitForHealth(PORT, 20000);
});

after(() => {
  child?.kill('SIGKILL');
});

test('a request that arrived through nginx gets no activity numbers', async () => {
    const res = await fetch(`http://localhost:${PORT}/api/health`, {
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { status: 'ok' }, 'public health must expose nothing but liveness');
    assert.equal('playerCount' in body, false);
    assert.equal('matchCount' in body, false);
    assert.equal('uptimeSeconds' in body, false);
});

test('tick metrics are not reachable from the internet at all', async () => {
    const res = await fetch(`http://localhost:${PORT}/api/metrics`, {
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    assert.equal(res.status, 404, 'proxied requests must not learn that metrics exist');
    assert.equal(await res.text(), 'not found', 'body must match any other 404 exactly');
});

test('a direct loopback request still gets the operational detail', async () => {
    const health = await (await fetch(`http://localhost:${PORT}/api/health`)).json();
    assert.equal(health.status, 'ok');
    assert.equal(typeof health.uptimeSeconds, 'number');
    assert.equal(typeof health.matchCount, 'number');
    assert.equal(typeof health.playerCount, 'number');

    const metrics = await fetch(`http://localhost:${PORT}/api/metrics`);
    assert.equal(metrics.status, 200);
    assert.equal(typeof (await metrics.json()).frameBudgetMs, 'number');
});
