import { describe, it, expect } from 'vitest';
import { validateReadOnlySql, MAX_TABLE_REFS } from './sql-guard.js';

/**
 * The guard bounds what a query may *read*. These cover what it may *consume*.
 *
 * The `LIMIT 200` wrapper does not help here: it caps rows returned, not rows
 * computed. An aggregate forces full materialisation before the limit applies,
 * and a blob allocator allocates per row on the way. So a query can be entirely
 * within the allow-list and still take the Worker down. See issue #20.
 */
describe('sql-guard resource limits', () => {
  const rejected = (sql: string) => {
    const r = validateReadOnlySql(sql);
    return r.ok ? null : r.error;
  };

  describe('unbounded recursion', () => {
    it('rejects a recursive CTE with no termination', () => {
      const err = rejected(
        'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c'
      );
      expect(err).toMatch(/recursive/i);
    });

    it('rejects recursion regardless of spacing or case', () => {
      expect(
        rejected('with\n  recursive c(x) AS (SELECT 1) SELECT * FROM c')
      ).toMatch(/recursive/i);
    });

    it('still allows an ordinary non-recursive CTE', () => {
      const r = validateReadOnlySql(
        'WITH recent AS (SELECT * FROM movies) SELECT title FROM recent'
      );
      expect(r.ok).toBe(true);
    });

    it('does not trip on the word "recursive" inside a string literal', () => {
      const r = validateReadOnlySql(
        "SELECT title FROM movies WHERE title = 'recursive descent'"
      );
      expect(r.ok).toBe(true);
    });
  });

  describe('blob allocation', () => {
    it('rejects randomblob', () => {
      expect(rejected('SELECT randomblob(1000000000)')).toMatch(/randomblob/i);
    });

    it('rejects zeroblob', () => {
      expect(rejected('SELECT hex(zeroblob(500000000))')).toMatch(/zeroblob/i);
    });
  });

  describe('extension loading', () => {
    // D1 already rejects this at the engine layer, but the guard should not
    // depend on a platform behaviour it does not control.
    it('rejects load_extension', () => {
      expect(rejected("SELECT load_extension('/tmp/x')")).toMatch(
        /load_extension/i
      );
    });
  });

  describe('cartesian products', () => {
    it('rejects more table references than the cap', () => {
      const refs = Array.from(
        { length: MAX_TABLE_REFS + 1 },
        (_, i) => `movies t${i}`
      ).join(', ');
      expect(rejected(`SELECT count(*) FROM ${refs}`)).toMatch(
        /table reference/i
      );
    });

    it('allows a join count a real query would plausibly need', () => {
      const refs = Array.from(
        { length: MAX_TABLE_REFS },
        (_, i) => `movies t${i}`
      ).join(', ');
      const r = validateReadOnlySql(`SELECT count(*) FROM ${refs}`);
      expect(r.ok).toBe(true);
    });
  });

  describe('regressions', () => {
    it('leaves ordinary queries alone', () => {
      const r = validateReadOnlySql(
        'SELECT m.title, w.watched_at FROM watch_history w JOIN movies m ON w.movie_id = m.id LIMIT 10'
      );
      expect(r.ok).toBe(true);
    });
  });
});
