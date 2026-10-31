import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QUICK_RATINGS, markRatedThisSession, wasRatedThisSession } from '../src/quick-rating.ts';
import { LEAVE_REASON_IDS } from '../../../server/src/feedback.ts';

test('every quick-rating button posts a reason id the server whitelists', () => {
  assert.deepEqual(QUICK_RATINGS.map((r) => r.label), ['Fun', 'Meh', 'Confusing']);
  for (const r of QUICK_RATINGS) assert.ok((LEAVE_REASON_IDS as readonly string[]).includes(r.id), r.id);
});

test('a tap posts one leave-reason with the rating id and trigger context', async () => {
  const posts: Array<Record<string, unknown>> = [];
  const realFetch = globalThis.fetch;
  const store = new Map<string, string>();
  Object.assign(globalThis, {
    window: { innerWidth: 390, innerHeight: 844 },
    location: { search: '?qa=1' },
    fetch: (_url: string, init: { body: string }) => {
      posts.push(JSON.parse(init.body) as Record<string, unknown>);
      return Promise.resolve();
    },
  });
  const { postLeaveReason } = await import('../src/feedback-post.ts');
  try {
    postLeaveReason('meh', '', true, { trigger: 'exit-intent', matchAgeSec: 12, matchIndex: 2 });
  } finally {
    globalThis.fetch = realFetch;
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'location');
  }
  assert.equal(posts.length, 1);
  const [post] = posts as [Record<string, unknown>];
  assert.equal(post.kind, 'leave-reason');
  assert.equal(post.reason, 'meh');
  assert.equal(post.qa, true);
  assert.deepEqual((post.context as Record<string, unknown>).trigger, 'exit-intent');

  const session = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  assert.equal(wasRatedThisSession(session), false);
  markRatedThisSession(session);
  assert.equal(wasRatedThisSession(session), true);
});
