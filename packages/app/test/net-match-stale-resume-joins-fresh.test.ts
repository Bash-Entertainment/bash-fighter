// Issue #60: a resume token from an earlier page load, rejected after a
// server restart, used to dead-end on "Disconnected". Before any match has
// started it must join fresh; a failed mid-match resume must still surface
// the error. No live socket in `npm test`, so this pins it at source level.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/net-match.ts'), 'utf8');

function errorCase(): string {
  const start = src.indexOf("case 'error':", src.indexOf('private handleControl('));
  assert.ok(start >= 0, "expected handleControl's 'error' case");
  return src.slice(start, src.indexOf('default:', start));
}

test('a rejected resume before any match started clears the token and joins fresh', () => {
  const body = errorCase();
  assert.match(
    body,
    /setResumeToken\(null\);\s*if \(!this\.hasStarted\(\)\) \{[\s\S]*?this\.connect\(this\.name, this\.characterId\);\s*return;/,
  );
});

test('a rejected resume mid-match still surfaces the error', () => {
  const body = errorCase();
  const freshJoin = body.indexOf('return;');
  const surfaced = body.indexOf("onStateChange?.('error'");
  assert.ok(surfaced > freshJoin, 'the error state change must follow the early fresh-join return, so started matches still reach it');
});
