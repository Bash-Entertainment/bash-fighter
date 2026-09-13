// Tests for POST /api/feedback (see server/src/feedback.ts and wiki
// "Bash Entertainment Overview" -> the account-free player feedback
// mechanism, 2026-09-13). Pattern follows stock-loss-logging.test.ts:
// exercise the real handler, not a mock of it, and assert on what it
// actually wrote/returned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFeedbackHandler, FEEDBACK_MAX_BODY_BYTES, FEEDBACK_MAX_COMMENT_LENGTH } from '../src/feedback.ts';

function readLines(logPath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Starts a bare http server running only the feedback handler, on an
 *  ephemeral port, pointed at a fresh scratch log file under a temp dir
 *  (never the real /srv/bash-fighter/shared path). Returns the base URL,
 *  the log path, and a teardown function. */
async function withServer(
  options: Parameters<typeof createFeedbackHandler>[0],
  run: (baseUrl: string, logPath: string) => Promise<void>,
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-test-'));
  const logPath = options?.logPath ?? path.join(dir, 'nested', 'feedback.jsonl');
  const handler = createFeedbackHandler({ ...options, logPath });
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as { port: number };
  try {
    await run(`http://localhost:${port}`, logPath);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('feedback: a valid submission is persisted with the expected shape and no client address', async () => {
  await withServer(undefined, async (baseUrl, logPath) => {
    const res = await fetch(`${baseUrl}/api/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        comment: 'Combat felt floaty near the ledge.',
        ratings: { combatWeight: 2, funFactor: 4 },
        context: {
          matchId: 'match-123',
          arenaId: 'the-foundry',
          mode: 'battleRoyale',
          placement: 7,
          result: 'eliminated',
          touchControls: false,
          viewport: { width: 1280, height: 720 },
          buildSha: 'abc1234',
        },
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, true);

    const lines = readLines(logPath);
    assert.equal(lines.length, 1);
    const record = lines[0] as Record<string, unknown>;
    assert.equal(typeof record.receivedAt, 'string');
    assert.ok(!Number.isNaN(Date.parse(record.receivedAt as string)));
    assert.equal(record.comment, 'Combat felt floaty near the ledge.');
    assert.deepEqual(record.ratings, { combatWeight: 2, funFactor: 4 });
    assert.deepEqual(record.context, {
      matchId: 'match-123',
      arenaId: 'the-foundry',
      mode: 'battleRoyale',
      placement: 7,
      result: 'eliminated',
      touchControls: false,
      viewport: { width: 1280, height: 720 },
      buildSha: 'abc1234',
    });

    // Never written: no ip/address field anywhere in the stored record.
    const serialised = JSON.stringify(record).toLowerCase();
    assert.ok(!serialised.includes('127.0.0.1'));
    assert.ok(!('ip' in record));
    assert.ok(!('address' in record));
    assert.ok(!('remoteAddress' in record));
  });
});

test('feedback: comment-only and ratings-only submissions are both accepted', async () => {
  await withServer(undefined, async (baseUrl, logPath) => {
    const r1 = await fetch(`${baseUrl}/api/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ comment: 'Camera felt too tight at 20 players.' }),
    });
    assert.equal(r1.status, 200);

    const r2 = await fetch(`${baseUrl}/api/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ratings: { funFactor: 5 } }),
    });
    assert.equal(r2.status, 200);

    assert.equal(readLines(logPath).length, 2);
  });
});

test('feedback: rejects a submission with neither comment nor ratings', async () => {
  await withServer(undefined, async (baseUrl, logPath) => {
    const res = await fetch(`${baseUrl}/api/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ context: { mode: 'battleRoyale' } }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.ok(body.error.length > 0);
    assert.equal(readLines(logPath).length, 0);
  });
});

test('feedback: rejects non-JSON content type and malformed JSON, always with a JSON response', async () => {
  await withServer(undefined, async (baseUrl, logPath) => {
    const wrongType = await fetch(`${baseUrl}/api/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'comment=hello',
    });
    assert.equal(wrongType.status, 400);
    assert.equal(wrongType.headers.get('content-type'), 'application/json');

    const malformed = await fetch(`${baseUrl}/api/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not valid json',
    });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.headers.get('content-type'), 'application/json');

    assert.equal(readLines(logPath).length, 0);
  });
});

test('feedback: rejects an oversized body via Content-Length and via actual streamed bytes', async () => {
  await withServer(undefined, async (baseUrl, logPath) => {
    const hugeComment = 'x'.repeat(FEEDBACK_MAX_BODY_BYTES + 1000);

    // Content-Length lies would be unusual from a browser fetch, but the
    // handler must also cope with a body that really does stream past the
    // cap regardless of what Content-Length said -- this request's real
    // body is what trips it.
    const res = await fetch(`${baseUrl}/api/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ comment: hugeComment }),
    });
    assert.equal(res.status, 413);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, false);
    assert.equal(readLines(logPath).length, 0);
  });
});

test('feedback: a comment over the per-field cap is clamped, not rejected', async () => {
  await withServer(undefined, async (baseUrl, logPath) => {
    const longButUnderBodyCap = 'y'.repeat(FEEDBACK_MAX_COMMENT_LENGTH + 500);
    const res = await fetch(`${baseUrl}/api/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ comment: longButUnderBodyCap }),
    });
    assert.equal(res.status, 200);
    const lines = readLines(logPath);
    assert.equal((lines[0]?.comment as string).length, FEEDBACK_MAX_COMMENT_LENGTH);
  });
});

test('feedback: control characters are stripped from the stored comment', async () => {
  await withServer(undefined, async (baseUrl, logPath) => {
    const res = await fetch(`${baseUrl}/api/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ comment: 'bad\u0007bell and \u001bescape stripped, newline\nkept' }),
    });
    assert.equal(res.status, 200);
    const lines = readLines(logPath);
    assert.equal(lines[0]?.comment, 'badbell and escape stripped, newline\nkept');
  });
});

test('feedback: out-of-range or malformed ratings are dropped, not stored verbatim', async () => {
  await withServer(undefined, async (baseUrl, logPath) => {
    const res = await fetch(`${baseUrl}/api/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ratings: { combatWeight: 999, cameraReadability: 'great', funFactor: 3, notARealField: 1 },
      }),
    });
    assert.equal(res.status, 200);
    const lines = readLines(logPath);
    assert.deepEqual(lines[0]?.ratings, { funFactor: 3 });
  });
});

test('feedback: rate limits by client address, returns 429, and never logs the address', async () => {
  await withServer({ rateLimitMax: 5, rateLimitWindowMs: 10 * 60 * 1000 }, async (baseUrl, logPath) => {
    const submit = () =>
      fetch(`${baseUrl}/api/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ comment: 'spam?' }),
      });

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await submit();
      statuses.push(res.status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);

    const lines = readLines(logPath);
    assert.equal(lines.length, 5);
    for (const record of lines) {
      assert.ok(!('address' in record));
      assert.ok(!('ip' in record));
    }
  });
});

test('feedback: rate limit window expiring allows submissions again', async () => {
  let fakeNow = 1_000_000;
  await withServer({ rateLimitMax: 1, rateLimitWindowMs: 1000, now: () => fakeNow }, async (baseUrl, logPath) => {
    const submit = () =>
      fetch(`${baseUrl}/api/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ comment: 'again' }),
      });

    assert.equal((await submit()).status, 200);
    assert.equal((await submit()).status, 429);
    fakeNow += 1001;
    assert.equal((await submit()).status, 200);
    assert.equal(readLines(logPath).length, 2);
  });
});

test('feedback: non-POST methods are rejected with a JSON response', async () => {
  await withServer(undefined, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/feedback`, { method: 'GET' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('content-type'), 'application/json');
  });
});

test('feedback: emits one [feedback] console line per submission', async () => {
  const lines: string[] = [];
  const realLog = console.log;
  console.log = ((...args: unknown[]) => {
    if (typeof args[0] === 'string') lines.push(args[0]);
  }) as typeof console.log;
  try {
    await withServer(undefined, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ comment: 'journalctl should see this' }),
      });
      assert.equal(res.status, 200);
    });
  } finally {
    console.log = realLog;
  }
  const feedbackLines = lines.filter((l) => l.startsWith('[feedback]'));
  assert.equal(feedbackLines.length, 1);
  assert.ok(feedbackLines[0]!.includes('journalctl should see this'));
});

test('feedback: a missing/unwritable log directory falls back to stdout instead of crashing', async () => {
  // Point at a path whose parent cannot be created (a file, not a
  // directory, sits where a directory is expected) to force the
  // fs.mkdirSync/appendFileSync path to fail.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-test-badpath-'));
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'not a directory');
  const badLogPath = path.join(blocker, 'nested', 'feedback.jsonl');

  const consoleLines: string[] = [];
  const realLog = console.log;
  console.log = ((...args: unknown[]) => {
    if (typeof args[0] === 'string') consoleLines.push(args[0]);
  }) as typeof console.log;

  try {
    await withServer({ logPath: badLogPath }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ comment: 'should not crash the process' }),
      });
      // The request must still succeed from the client's point of view --
      // a broken log path on the server is not the submitter's problem.
      assert.equal(res.status, 200);
    });
  } finally {
    console.log = realLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  assert.ok(consoleLines.some((l) => l.includes('should not crash the process')));
});
