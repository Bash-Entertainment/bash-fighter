import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnnouncerTracker } from '../src/announcer.ts';

const texts = (calls: { text: string }[]) => calls.map((c) => c.text);

test('KOs within 4s chain Double, Triple, Rampage; a slow KO starts over', () => {
  const a = new AnnouncerTracker();
  assert.deepEqual(texts(a.onLocalKnockout(0)), []);
  assert.deepEqual(texts(a.onLocalKnockout(1000)), ['Double KO!']);
  assert.deepEqual(texts(a.onLocalKnockout(2000)), ['Triple KO!', 'On a roll']);
  assert.deepEqual(texts(a.onLocalKnockout(3000)), ['Rampage!']);
  assert.deepEqual(texts(a.onLocalKnockout(20000)), ['Unstoppable']);
});

test('streak milestones fire at 3, 5 and 8 slow KOs', () => {
  const a = new AnnouncerTracker();
  const seen: string[] = [];
  for (let i = 0; i < 8; i++) seen.push(...texts(a.onLocalKnockout(i * 10000)));
  assert.deepEqual(seen, ['On a roll', 'Unstoppable', 'Legendary']);
});

test('being knocked out resets the streak and the multi-KO window', () => {
  const a = new AnnouncerTracker();
  a.onLocalKnockout(0);
  a.onLocalKnockout(10000);
  a.onLocalDeath();
  assert.deepEqual(texts(a.onLocalKnockout(10500)), []);
  assert.deepEqual(texts(a.onLocalKnockout(20000)), []);
  assert.deepEqual(texts(a.onLocalKnockout(30000)), ['On a roll']);
});
