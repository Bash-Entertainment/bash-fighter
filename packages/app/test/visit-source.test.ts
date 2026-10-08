import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visitSource } from '../src/session-report.ts';

test('referrer is reduced to its hostname, never a path or query', () => {
  assert.equal(visitSource('', 'https://github.com/lappemic/awesome-ai-built-games?x=1', 'bashfighter.com'), 'github.com');
  assert.equal(visitSource('', 'https://www.google.com/search?q=me', 'bashfighter.com'), 'google.com');
});

test('a ?ref= tag wins and is prefixed; junk is dropped', () => {
  assert.equal(visitSource('?ref=gamesbyai', 'https://github.com/x', 'bashfighter.com'), 'ref.gamesbyai');
  assert.equal(visitSource('?ref=<script>', '', 'bashfighter.com'), undefined);
});

test('own host and empty referrer give no source', () => {
  assert.equal(visitSource('', 'https://www.bashfighter.com/', 'bashfighter.com'), undefined);
  assert.equal(visitSource('', '', 'bashfighter.com'), undefined);
});
