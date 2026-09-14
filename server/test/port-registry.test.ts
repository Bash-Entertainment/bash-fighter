// Regression guard for 2026-09-14: server/test/no-public-activity-numbers.test.ts
// hardcoded port 8107, which server/test/reconnect.test.ts's "a match abandoned
// by every human seat is torn down promptly" test had already been using since
// 2026-09-11. Two test files spawning a real server on the same port race for
// the bind: whichever loses gets EADDRINUSE and (its own health-wait not
// checking that its own child actually bound the port) silently ends up
// talking to the *other* file's server instead, which runs with production
// defaults, not that test's short grace/reap overrides. The result looked
// exactly like a real teardown regression -- matchCount stuck at 1 for the
// entire 20s window the test polled -- with no code bug involved at all.
//
// This test is deliberately NOT a spawned-server integration test: it just
// greps every server/test/*.ts file for a hardcoded `PORT = <n>` / `port =
// <n>` literal and asserts no two files claim the same one. It runs in
// milliseconds, so the next accidental collision is caught before anyone
// burns half a minute chasing a phantom application bug.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

// Matches a top-level or indented `const PORT = <n>;` / `const port = <n>;`
// declaration -- every hardcoded-port style used across this directory
// today. Deliberately does NOT match a `BASE_PORT + attempt` style dynamic
// port (timed-brawl-online.test.ts) -- that already varies per attempt and
// is not a fixed collision risk.
const PORT_LITERAL_RE = /\bconst\s+PORT\s*=\s*(\d{4,5})\s*;|\bconst\s+port\s*=\s*(\d{4,5})\s*;/g;

test('no two server test files hardcode the same server port', () => {
  /** port -> list of "file:line" occurrences */
  const owners = new Map<string, string[]>();
  for (const entry of readdirSync(TEST_DIR)) {
    if (!entry.endsWith('.test.ts')) continue;
    const filePath = path.join(TEST_DIR, entry);
    const text = readFileSync(filePath, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m: RegExpExecArray | null;
      const re = new RegExp(PORT_LITERAL_RE);
      while ((m = re.exec(line))) {
        const port = m[1] ?? m[2];
        const list = owners.get(port) ?? [];
        list.push(`${entry}:${i + 1}`);
        owners.set(port, list);
      }
    }
  }

  const collisions = [...owners.entries()].filter(([, occurrences]) => {
    // Multiple hardcodes of the same port WITHIN one file (e.g.
    // reconnect.test.ts uses a fresh port per test in the same file, so a
    // given literal only ever appears once per file there) are fine; a
    // real collision is the same port claimed by two or more distinct files.
    const files = new Set(occurrences.map((o) => o.split(':')[0]));
    return files.size > 1;
  });

  assert.deepEqual(
    collisions,
    [],
    `hardcoded server port(s) reused across test files -- pick a fresh port for each: ${JSON.stringify(collisions)}`,
  );
});
