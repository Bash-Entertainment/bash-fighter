// Direct coverage for getMatchesPlayed() and recordMatchPlayed() in
// matches-played.ts (issue #46). The count feeds the tapered rookie
// knockback and the session telemetry, and both functions are meant to
// be best-effort: no `window`, a bad stored value, or a localStorage
// that throws must all read as "0 matches", never as an exception.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MATCHES_PLAYED_KEY, getMatchesPlayed, recordMatchPlayed } from '../src/matches-played.ts';

interface FakeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function memoryStorage(initial: Record<string, string> = {}): FakeStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

function throwingStorage(): FakeStorage {
  const denied = (): never => {
    throw new Error('storage denied');
  };
  return { getItem: denied, setItem: denied };
}

/** Runs `fn` with `globalThis.window` set to a stub holding `storage`,
 *  then puts back whatever was there (normally nothing under node). */
function withWindow(storage: FakeStorage, fn: () => void): void {
  const g = globalThis as Record<string, unknown>;
  const had = 'window' in g;
  const prev = g.window;
  g.window = { localStorage: storage };
  try {
    fn();
  } finally {
    if (had) g.window = prev;
    else delete g.window;
  }
}

test('getMatchesPlayed returns 0 and recordMatchPlayed does nothing when there is no window', () => {
  assert.equal(typeof window, 'undefined');
  assert.equal(getMatchesPlayed(), 0);
  assert.doesNotThrow(() => recordMatchPlayed());
  assert.equal(typeof window, 'undefined');
});

test('getMatchesPlayed returns 0 when the key is missing or empty', () => {
  withWindow(memoryStorage(), () => assert.equal(getMatchesPlayed(), 0));
  withWindow(memoryStorage({ [MATCHES_PLAYED_KEY]: '' }), () => assert.equal(getMatchesPlayed(), 0));
});

test('getMatchesPlayed reads a stored count, including 0', () => {
  withWindow(memoryStorage({ [MATCHES_PLAYED_KEY]: '7' }), () => assert.equal(getMatchesPlayed(), 7));
  withWindow(memoryStorage({ [MATCHES_PLAYED_KEY]: '0' }), () => assert.equal(getMatchesPlayed(), 0));
});

test('getMatchesPlayed returns 0 for non-numeric and negative values', () => {
  for (const raw of ['abc', 'NaN', 'Infinity', '{}', '-1', '-20']) {
    withWindow(memoryStorage({ [MATCHES_PLAYED_KEY]: raw }), () => {
      assert.equal(getMatchesPlayed(), 0, `stored value ${JSON.stringify(raw)}`);
    });
  }
});

test('recordMatchPlayed adds 1 to the stored count on each call', () => {
  const storage = memoryStorage();
  withWindow(storage, () => {
    recordMatchPlayed();
    assert.equal(storage.data.get(MATCHES_PLAYED_KEY), '1');
    recordMatchPlayed();
    recordMatchPlayed();
    assert.equal(storage.data.get(MATCHES_PLAYED_KEY), '3');
    assert.equal(getMatchesPlayed(), 3);
  });
});

test('recordMatchPlayed starts again from 1 when the stored value is corrupt', () => {
  const storage = memoryStorage({ [MATCHES_PLAYED_KEY]: 'abc' });
  withWindow(storage, () => {
    recordMatchPlayed();
    assert.equal(storage.data.get(MATCHES_PLAYED_KEY), '1');
  });
});

test('recordMatchPlayed only writes its own key', () => {
  const storage = memoryStorage({ other: 'kept' });
  withWindow(storage, () => {
    recordMatchPlayed();
    assert.deepEqual([...storage.data.keys()].sort(), [MATCHES_PLAYED_KEY, 'other'].sort());
    assert.equal(storage.data.get('other'), 'kept');
  });
});

test('both functions swallow a localStorage that throws', () => {
  withWindow(throwingStorage(), () => {
    assert.equal(getMatchesPlayed(), 0);
    assert.doesNotThrow(() => recordMatchPlayed());
  });
});

test('recordMatchPlayed swallows a write that fails after a good read', () => {
  const storage = memoryStorage({ [MATCHES_PLAYED_KEY]: '4' });
  storage.setItem = () => {
    throw new Error('quota exceeded');
  };
  withWindow(storage, () => {
    assert.doesNotThrow(() => recordMatchPlayed());
    assert.equal(getMatchesPlayed(), 4);
  });
});
