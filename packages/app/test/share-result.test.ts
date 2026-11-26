import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shareMessage, withShareRef } from '../src/share-result.ts';

test('share message names the placement, or the win', () => {
  assert.equal(shareMessage(4, 20), 'I finished #4 of 20 in Bash Fighter. Think you can beat me?');
  assert.match(shareMessage(1, 20), /^I won a 20-player Bash Fighter match/);
});

test('share link is tagged ref=share, replacing any existing ref', () => {
  assert.equal(withShareRef('https://bashfighter.com/'), 'https://bashfighter.com/?ref=share');
  assert.equal(withShareRef('https://bashfighter.com/?ref=crazygames'), 'https://bashfighter.com/?ref=share');
});
