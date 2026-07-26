import { describe, it, expect } from 'vitest';
import { validateReadOnlySql } from './sql-guard.js';

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
