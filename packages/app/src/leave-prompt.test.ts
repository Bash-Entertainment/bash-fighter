import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markLeftMidMatch, settleLeavePrompt, shouldShowLeavePrompt } from './leave-prompt.ts';

function memStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

test('leave prompt shows only after a mid-match leave, and only once ever', () => {
  const s = memStore();
  assert.equal(shouldShowLeavePrompt(s), false);
  markLeftMidMatch(s);
  assert.equal(shouldShowLeavePrompt(s), true);
  settleLeavePrompt(s);
  assert.equal(shouldShowLeavePrompt(s), false);
  markLeftMidMatch(s);
  assert.equal(shouldShowLeavePrompt(s), false);
});
