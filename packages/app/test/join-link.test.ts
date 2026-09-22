import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateJoinCode, buildShareLink } from '../src/join-link.ts';
import { JOIN_CODE_ALPHABET, JOIN_CODE_LENGTH, sanitiseJoinCode } from '@bash-fighter/net';

const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const netMatch = readFileSync(new URL('../src/net-match.ts', import.meta.url), 'utf8');

test('generateJoinCode only emits characters from the shared alphabet, at the shared length', () => {
  const alphabetSet = new Set(JOIN_CODE_ALPHABET.split(''));
  for (let i = 0; i < 200; i++) {
    const code = generateJoinCode();
    assert.equal(code.length, JOIN_CODE_LENGTH);
    for (const ch of code) assert.ok(alphabetSet.has(ch), `${ch} not in shared alphabet`);
  }
});

test('every generated code round-trips through the shared validator unchanged', () => {
  for (let i = 0; i < 50; i++) {
    const code = generateJoinCode();
    assert.equal(sanitiseJoinCode(code), code);
  }
});

test('buildShareLink is built from the given origin, never a hardcoded domain', () => {
  assert.equal(buildShareLink('https://example.test', 'AB12'), 'https://example.test/?join=AB12');
  assert.equal(buildShareLink('http://localhost:5199', 'ZZZZ'), 'http://localhost:5199/?join=ZZZZ');
});

test('main.ts sources join codes from location.origin, not a literal domain', () => {
  assert.match(main, /buildShareLink\(location\.origin, /);
  assert.doesNotMatch(main, /buildShareLink\(['"]https?:\/\//);
});

test('main.ts sanitises a ?join= URL param through the shared validator before using it', () => {
  assert.match(main, /sanitiseJoinCode\(rawJoin\)/);
  assert.match(main, /import \{ sanitiseJoinCode \} from '@bash-fighter\/net';/);
});

test('main.ts falls back to an ordinary public match when the code is malformed', () => {
  assert.match(main, /if \(!sanitised\) \{/);
  assert.match(main, /void beginOnlineMatch\(false, sanitised\);/);
});

test('net-match.ts sends the join code only on a fresh hello, never alongside a resume token', () => {
  assert.match(netMatch, /if \(this\.joinCodeRequest && !this\.resumeToken\) hello\.joinCode = this\.joinCodeRequest;/);
});

test('net-match.ts displays the code the server actually echoed back, not the one requested', () => {
  assert.match(netMatch, /this\.events\.onJoinCode\?\.\(msg\.joinCode\);/);
});
