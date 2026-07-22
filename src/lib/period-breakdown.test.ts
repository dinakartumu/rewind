import { describe, it, expect } from 'vitest';
import { bucketByPeriod } from './period-breakdown.js';

describe('bucketByPeriod', () => {
  it('groups by period, keeps top-N, folds the rest into Other, sums total', () => {
    const rows = [
      { period: '2026-01', name: 'Drama', count: 6 },
      { period: '2026-01', name: 'Comedy', count: 3 },
      { period: '2026-01', name: 'Horror', count: 2 },
      { period: '2026-02', name: 'Drama', count: 4 },
    ];
    const out = bucketByPeriod(rows, 2);
    expect(out).toEqual([
      {
        period: '2026-01',
        items: { Drama: 6, Comedy: 3, Other: 2 },
        total: 11,
      },
      { period: '2026-02', items: { Drama: 4 }, total: 4 },
    ]);
  });

  it('returns periods in ascending chronological order', () => {
    const out = bucketByPeriod(
      [
        { period: '2026-03', name: 'A', count: 1 },
        { period: '2026-01', name: 'A', count: 1 },
        { period: '2026-02', name: 'A', count: 1 },
      ],
      5
    );
    expect(out.map((b) => b.period)).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  it('skips null periods/names and omits Other when nothing overflows', () => {
    const out = bucketByPeriod(
      [
        { period: null, name: 'X', count: 9 },
        { period: '2026-01', name: null, count: 9 },
        { period: '2026-01', name: 'X', count: 5 },
      ],
      5
    );
    expect(out).toEqual([{ period: '2026-01', items: { X: 5 }, total: 5 }]);
  });
});
