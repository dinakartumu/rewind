import { describe, it, expect } from 'vitest';
import { validateReadOnlySql, MAX_SUBQUERY_DEPTH } from './sql-guard.js';

/**
 * `extractTableRefs` matched only the token immediately after FROM/JOIN, so in
 * a comma-separated FROM list every table after the first was never extracted
 * and the allow-list gate never saw it. `SELECT * FROM movies, search_index`
 * was accepted, reading a table the gate is supposed to make unreachable.
 *
 * The gate must also fail *closed*: silently skipping an item it cannot parse
 * is what turned a parsing limitation into an access-control hole. See #25.
 */
describe('comma-separated FROM lists', () => {
  const ok = (sql: string) => validateReadOnlySql(sql).ok;

  describe('the gate sees every item', () => {
    it('rejects an undocumented table in second position', () => {
      expect(ok('SELECT * FROM movies, search_index')).toBe(false);
    });

    it('rejects it when aliased', () => {
      expect(ok('SELECT * FROM movies m, search_index s')).toBe(false);
    });

    it('rejects it with an explicit AS alias', () => {
      expect(ok('SELECT * FROM movies AS m, search_index AS s')).toBe(false);
    });

    it('rejects it in third position', () => {
      expect(ok('SELECT * FROM movies, watch_history, search_index')).toBe(
        false
      );
    });

    it('rejects a secret table in second position', () => {
      expect(ok('SELECT * FROM movies, api_keys')).toBe(false);
    });

    it('rejects when mixing a comma list with a JOIN', () => {
      expect(ok('SELECT * FROM movies, search_index JOIN shows ON 1=1')).toBe(
        false
      );
    });
  });

  /**
   * Walking the list requires stepping over a derived table to reach the item
   * after it. Stepping over the group must not mean skipping what is inside
   * it: the outer walk resumes past the closing paren, so nothing else will
   * scan those contents.
   */
  describe('the gate sees inside derived tables', () => {
    // Deliberately NOT a table on DENIED_TABLES: that list is a raw-text scan
    // that matches regardless of parens, so a denied name would pass these
    // tests without the allow-list gate ever running. `_cf_METADATA` is a real
    // D1 internal that is undocumented and not denied, so it isolates the
    // allow-list — the layer these cases exist to protect.
    const undocumented = '_cf_METADATA';

    it('rejects an undocumented table in a FROM subquery', () => {
      expect(ok(`SELECT * FROM (SELECT * FROM ${undocumented}) x`)).toBe(false);
    });

    it('rejects it in a JOIN subquery', () => {
      expect(
        ok(`SELECT * FROM movies JOIN (SELECT * FROM ${undocumented}) s ON 1=1`)
      ).toBe(false);
    });

    it('rejects it in a derived table beside a comma list', () => {
      expect(
        ok(`SELECT * FROM movies, (SELECT * FROM ${undocumented}) y`)
      ).toBe(false);
    });

    it('rejects it nested two levels deep', () => {
      expect(
        ok(`SELECT * FROM (SELECT * FROM (SELECT * FROM ${undocumented}) y) x`)
      ).toBe(false);
    });

    it('rejects it in a list item after a derived table', () => {
      expect(ok(`SELECT * FROM (SELECT 1) a, ${undocumented} b`)).toBe(false);
    });

    const nest = (d: number) =>
      'SELECT * FROM '.concat('(SELECT * FROM '.repeat(d)) +
      'movies' +
      ') x'.repeat(d);

    it('still reads documented tables nested within the depth ceiling', () => {
      expect(ok(nest(MAX_SUBQUERY_DEPTH - 1))).toBe(true);
    });

    it('fails closed on nesting past the depth ceiling', () => {
      const r = validateReadOnlySql(nest(MAX_SUBQUERY_DEPTH + 5));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toContain('nested more than');
    });
  });

  describe('legitimate queries still work', () => {
    it('allows a two-table comma join of documented tables', () => {
      expect(ok('SELECT * FROM movies, watch_history')).toBe(true);
    });

    it('allows aliases on a comma join', () => {
      expect(
        ok(
          'SELECT m.title FROM movies m, watch_history w WHERE w.movie_id = m.id'
        )
      ).toBe(true);
    });

    it('allows an ordinary explicit JOIN', () => {
      expect(
        ok(
          'SELECT m.title FROM watch_history w JOIN movies m ON w.movie_id = m.id'
        )
      ).toBe(true);
    });

    it('does not mistake select-list commas for table refs', () => {
      expect(ok('SELECT title, year, tmdb_id FROM movies')).toBe(true);
    });

    it('does not mistake function-argument commas for table refs', () => {
      expect(ok('SELECT substr(title, 1, 3) FROM movies')).toBe(true);
    });

    it('allows a derived table over documented tables', () => {
      expect(ok('SELECT * FROM (SELECT movie_id FROM watch_history) w')).toBe(
        true
      );
    });

    it('allows a derived table joined to a base table', () => {
      expect(
        ok(
          'SELECT m.title FROM movies m JOIN (SELECT movie_id FROM watch_history) w ON w.movie_id = m.id'
        )
      ).toBe(true);
    });

    it('allows a constant derived table with no FROM at all', () => {
      expect(ok('SELECT * FROM (SELECT 1 AS n) t')).toBe(true);
    });
  });

  describe('attribution', () => {
    it('reports every base table read, not just the first', () => {
      const r = validateReadOnlySql('SELECT * FROM movies, watch_history');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect([...r.tables].sort()).toEqual(['movies', 'watch_history']);
    });
  });
});
