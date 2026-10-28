import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  activeSeries, recordSeriesMatch, markResultShown, matchLines, progressLine, resultLine, bestMatchLine,
  introLabel, isComplete, SERIES_KEY, SERIES_MAX_AGE_MS,
} from '../src/rookie-series.ts';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe('rookie series', () => {
  it('runs three matches and reports totals, lines and best', () => {
    const s = memory();
    let st = activeSeries(s, 0, true)!;
    assert.equal(introLabel(st), 'Rookie series \u00b7 match 1 of 3');
    st = recordSeriesMatch(st, s, 2, 1);
    st = recordSeriesMatch(st, s, 3, 2);
    assert.deepEqual(matchLines(st), ['Match 1: 2 KO', 'Match 2: 3 KO', 'Match 3: \u2014']);
    assert.equal(progressLine(st), 'One more to finish the series');
    st = recordSeriesMatch(st, s, 2, 3);
    assert.ok(isComplete(st));
    assert.equal(resultLine(st), 'Series complete: 7 KOs across 3 matches');
    assert.equal(bestMatchLine(st), 'Best match: 3 KOs (match 2)');
  });

  it('continues across sessions within 24h and restarts after', () => {
    const s = memory();
    recordSeriesMatch(activeSeries(s, 0, true)!, s, 4, 10);
    assert.deepEqual(activeSeries(s, 10 + SERIES_MAX_AGE_MS, false)!.kos, [4]);
    assert.deepEqual(activeSeries(s, 11 + SERIES_MAX_AGE_MS, true)!.kos, []);
    assert.equal(activeSeries(s, 11 + SERIES_MAX_AGE_MS, false), null);
  });

  it('ends for good once the result card was shown', () => {
    const s = memory();
    let st = activeSeries(s, 0, true)!;
    for (let i = 0; i < 3; i++) st = recordSeriesMatch(st, s, 1, i);
    assert.ok(isComplete(activeSeries(s, 5, false)!));
    markResultShown(st, s);
    assert.equal(activeSeries(s, 6, true), null);
  });

  it('treats corrupt storage as no series', () => {
    const s = memory();
    s.setItem(SERIES_KEY, '{"kos":[-1]}');
    assert.equal(activeSeries(s, 0, false), null);
  });
});
