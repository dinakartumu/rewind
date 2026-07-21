import { describe, it, expect } from 'vitest';
import { validateReadOnlySql, DENIED_TABLES } from './sql-guard.js';

/**
 * The guard is security-critical: it is the single choke point that keeps a
 * read-scope SQL endpoint from exfiltrating secrets or mutating data. These
 * tests are adversarial by design - every rejection path has a dedicated case,
 * and legitimate analytical queries must survive untouched (aside from LIMIT
 * normalization).
 */

function ok(sql: string) {
  const r = validateReadOnlySql(sql);
  if (!r.ok) {
    throw new Error(`expected ok, got error: ${r.error}`);
  }
  return r.sql;
}

function err(sql: string) {
  const r = validateReadOnlySql(sql);
  if (r.ok) {
    throw new Error(`expected error, got ok: ${r.sql}`);
  }
  return r.error;
}

describe('validateReadOnlySql - legitimate queries pass', () => {
  it('accepts a simple SELECT and appends LIMIT', () => {
    expect(ok('SELECT * FROM movies')).toBe('SELECT * FROM movies LIMIT 200');
  });

  it('accepts lowercase select', () => {
    expect(ok('select id, title from movies')).toBe(
      'select id, title from movies LIMIT 200'
    );
  });

  it('accepts a query that already has a LIMIT and leaves it', () => {
    expect(ok('SELECT * FROM movies LIMIT 10')).toBe(
      'SELECT * FROM movies LIMIT 10'
    );
  });

  it('accepts a join across allowed tables', () => {
    const q =
      'SELECT m.title, wh.watched_at FROM movies m JOIN watch_history wh ON wh.movie_id = m.id';
    expect(ok(q)).toBe(q + ' LIMIT 200');
  });

  it('accepts a WITH … SELECT CTE', () => {
    const q =
      'WITH recent AS (SELECT id FROM lastfm_scrobbles ORDER BY scrobbled_at DESC LIMIT 50) SELECT * FROM recent';
    // Inner LIMIT is a subquery limit; the top-level query has no LIMIT so one is appended.
    expect(ok(q)).toBe(q + ' LIMIT 200');
  });

  it('accepts an aggregate with GROUP BY', () => {
    const q =
      'SELECT artist_id, count(*) AS n FROM lastfm_scrobbles GROUP BY artist_id ORDER BY n DESC';
    expect(ok(q)).toBe(q + ' LIMIT 200');
  });

  it('accepts a subquery', () => {
    const q =
      'SELECT * FROM movies WHERE id IN (SELECT movie_id FROM watch_history)';
    expect(ok(q)).toBe(q + ' LIMIT 200');
  });

  it('accepts a cross-domain join over allowed tables', () => {
    const q =
      'SELECT c.title, r.title AS release FROM checkins c JOIN discogs_collection dc ON 1=1 JOIN discogs_releases r ON r.id = dc.release_id';
    expect(ok(q)).toBe(q + ' LIMIT 200');
  });

  it('trims leading/trailing whitespace before appending LIMIT', () => {
    expect(ok('   SELECT 1   ')).toBe('SELECT 1 LIMIT 200');
  });

  it('tolerates a trailing semicolon on a single statement', () => {
    expect(ok('SELECT 1;')).toBe('SELECT 1 LIMIT 200');
  });

  it('allows a string literal that contains a denied-looking word', () => {
    // "insert" appears only inside a string literal, not as a keyword.
    const q =
      "SELECT * FROM reading_items WHERE title = 'how to insert a coin'";
    expect(ok(q)).toBe(q + ' LIMIT 200');
  });

  it('preserves an explicit LIMIT of exactly 500', () => {
    expect(ok('SELECT * FROM movies LIMIT 500')).toBe(
      'SELECT * FROM movies LIMIT 500'
    );
  });
});

describe('validateReadOnlySql - multi-statement smuggling', () => {
  it('rejects a second statement after a semicolon', () => {
    expect(err('SELECT 1; DROP TABLE movies')).toMatch(/single statement/i);
  });

  it('rejects two selects', () => {
    expect(err('SELECT 1; SELECT 2')).toMatch(/single statement/i);
  });

  it('does not treat a semicolon inside a single-quoted string as a separator', () => {
    // Whole thing is one statement; the ';drop' lives inside a string literal.
    expect(ok("SELECT ';drop' AS x")).toBe("SELECT ';drop' AS x LIMIT 200");
  });

  it('handles an escaped quote inside a string with a semicolon', () => {
    const q = "SELECT 'O''Brien; DROP' AS name";
    expect(ok(q)).toBe(q + ' LIMIT 200');
  });
});

describe('validateReadOnlySql - first keyword must be SELECT/WITH', () => {
  it('rejects an INSERT', () => {
    expect(err("INSERT INTO movies (title) VALUES ('x')")).toMatch(
      /SELECT|WITH|read-only/i
    );
  });

  it('rejects an UPDATE', () => {
    expect(err('UPDATE movies SET title = 1')).toBeTruthy();
  });

  it('rejects a DELETE', () => {
    expect(err('DELETE FROM movies')).toBeTruthy();
  });

  it('rejects an empty query', () => {
    expect(err('')).toBeTruthy();
    expect(err('   ')).toBeTruthy();
  });

  it('rejects a query that is only a comment', () => {
    expect(err('-- just a comment')).toBeTruthy();
    expect(err('/* nothing here */')).toBeTruthy();
  });
});

describe('validateReadOnlySql - CTE write bodies', () => {
  it('rejects a WITH whose CTE body is a DELETE', () => {
    expect(
      err('WITH x AS (DELETE FROM movies RETURNING *) SELECT * FROM x')
    ).toMatch(/DELETE|write|denied/i);
  });

  it('rejects a WITH whose CTE body is an INSERT', () => {
    expect(
      err(
        "WITH x AS (INSERT INTO movies(title) VALUES('a') RETURNING id) SELECT * FROM x"
      )
    ).toBeTruthy();
  });

  it('rejects a WITH whose CTE body is an UPDATE', () => {
    expect(
      err('WITH x AS (UPDATE movies SET title = 1 RETURNING *) SELECT * FROM x')
    ).toBeTruthy();
  });
});

describe('validateReadOnlySql - deny-token scan (comment tricks)', () => {
  it('rejects PRAGMA', () => {
    expect(err('SELECT * FROM movies; PRAGMA table_info(movies)')).toBeTruthy();
    expect(err('PRAGMA table_info(movies)')).toBeTruthy();
  });

  it('rejects PRAGMA hidden behind a block comment', () => {
    expect(err('SELECT/**/PRAGMA/**/table_list')).toBeTruthy();
  });

  it('rejects PRAGMA with tab/newline whitespace', () => {
    expect(err('SELECT 1\tWHERE\t1=1;\nPRAGMA\tkey')).toBeTruthy();
  });

  it('rejects ATTACH', () => {
    expect(err("ATTACH DATABASE 'x.db' AS y")).toBeTruthy();
    expect(err("SELECT 1; ATTACH DATABASE 'x.db' AS y")).toBeTruthy();
  });

  it('rejects DETACH', () => {
    expect(err('SELECT 1; DETACH DATABASE y')).toBeTruthy();
  });

  it('rejects VACUUM, REINDEX, TRIGGER, ALTER, CREATE, REPLACE, DROP', () => {
    expect(err('SELECT 1; VACUUM')).toBeTruthy();
    expect(err('SELECT 1; REINDEX movies')).toBeTruthy();
    expect(
      err('CREATE TRIGGER t AFTER INSERT ON movies BEGIN SELECT 1; END')
    ).toBeTruthy();
    expect(err('ALTER TABLE movies ADD COLUMN x')).toBeTruthy();
    expect(err('CREATE TABLE x (a int)')).toBeTruthy();
    expect(err('REPLACE INTO movies VALUES (1)')).toBeTruthy();
    expect(err('DROP TABLE movies')).toBeTruthy();
  });

  it('is case-insensitive for deny tokens', () => {
    expect(err('SeLeCt 1; DrOp TABLE movies')).toBeTruthy();
    expect(err('select 1; pRaGmA foo')).toBeTruthy();
  });

  it('strips a -- line comment used to smuggle a UNION across a newline', () => {
    // After comment stripping, the -- ... to EOL is gone, leaving
    // `SELECT * FROM movies \nUNION SELECT * FROM strava_tokens` which must be
    // rejected by the denied-table scan.
    const q =
      'SELECT * FROM movies -- ; DROP TABLE x\nUNION SELECT * FROM strava_tokens';
    expect(err(q)).toBeTruthy();
  });

  it('does not falsely reject a column named like a partial keyword', () => {
    // "created_at" contains "create" as a substring but not as a word.
    expect(ok('SELECT created_at FROM reading_items')).toBe(
      'SELECT created_at FROM reading_items LIMIT 200'
    );
    // "updated_at" contains "update".
    expect(ok('SELECT updated_at FROM movies')).toBe(
      'SELECT updated_at FROM movies LIMIT 200'
    );
  });
});

describe('validateReadOnlySql - denied table scan', () => {
  it('rejects api_keys', () => {
    expect(err('SELECT * FROM api_keys')).toMatch(
      /denied|not allowed|api_keys/i
    );
  });

  it('rejects quoted api_keys identifier', () => {
    expect(err('select * from "api_keys"')).toBeTruthy();
  });

  it('rejects every *_tokens table', () => {
    expect(err('SELECT * FROM strava_tokens')).toBeTruthy();
    expect(err('SELECT * FROM trakt_tokens')).toBeTruthy();
    expect(err('SELECT * FROM google_tokens')).toBeTruthy();
  });

  it('rejects revalidation_hooks and webhook_events', () => {
    expect(err('SELECT * FROM revalidation_hooks')).toBeTruthy();
    expect(err('SELECT * FROM webhook_events')).toBeTruthy();
  });

  it('rejects sqlite_master and sqlite_schema', () => {
    expect(err('SELECT * FROM sqlite_master')).toBeTruthy();
    expect(err('SELECT * FROM sqlite_schema')).toBeTruthy();
  });

  it('rejects a denied table referenced via a join', () => {
    expect(
      err(
        'SELECT m.title FROM movies m JOIN api_keys k ON k.user_id = m.user_id'
      )
    ).toBeTruthy();
  });

  it('rejects a denied table even inside a string literal (conservative)', () => {
    // Design chose conservative: any word-token match anywhere rejects.
    expect(err("SELECT 'api_keys'")).toBeTruthy();
  });

  it('rejects a denied table hidden behind a comment', () => {
    expect(err('SELECT * FROM /* x */ strava_tokens')).toBeTruthy();
  });

  it('does not reject an allowed table whose name contains a denied substring', () => {
    // No such table exists, but confirm word-boundary logic:
    // "api_keys_history" should NOT match "api_keys" as a whole word.
    expect(ok('SELECT * FROM api_keys_history')).toBe(
      'SELECT * FROM api_keys_history LIMIT 200'
    );
  });

  it('rejects table-valued pragma functions (introspection bypass)', () => {
    // `pragma_table_info` is a single word token, so a word-boundary PRAGMA
    // match alone would not see it.
    expect(err("SELECT * FROM pragma_table_info('movies')")).toMatch(
      /pragma_table_info/i
    );
    expect(err('SELECT * FROM pragma_table_list')).toBeTruthy();
    expect(err('SELECT name FROM pragma_function_list()')).toBeTruthy();
    expect(err("SELECT * FROM PRAGMA_TABLE_XINFO('movies')")).toBeTruthy();
  });

  it('rejects SQLite/D1 internal tables', () => {
    expect(err('SELECT * FROM sqlite_sequence')).toBeTruthy();
    expect(err('SELECT * FROM sqlite_temp_master')).toBeTruthy();
    expect(err('SELECT * FROM d1_migrations')).toBeTruthy();
    expect(err('SELECT * FROM _cf_KV')).toBeTruthy();
  });

  it('exposes the denylist including tokens and sqlite internals', () => {
    expect(DENIED_TABLES).toContain('api_keys');
    expect(DENIED_TABLES).toContain('strava_tokens');
    expect(DENIED_TABLES).toContain('trakt_tokens');
    expect(DENIED_TABLES).toContain('google_tokens');
    expect(DENIED_TABLES).toContain('revalidation_hooks');
    expect(DENIED_TABLES).toContain('webhook_events');
    expect(DENIED_TABLES).toContain('sqlite_master');
    expect(DENIED_TABLES).toContain('sqlite_schema');
  });
});

describe('validateReadOnlySql - LIMIT enforcement', () => {
  it('appends LIMIT 200 when absent', () => {
    expect(ok('SELECT * FROM movies')).toMatch(/LIMIT 200$/);
  });

  it('caps an explicit LIMIT above 500 down to 500', () => {
    expect(ok('SELECT * FROM movies LIMIT 99999')).toBe(
      'SELECT * FROM movies LIMIT 500'
    );
  });

  it('caps LIMIT 501 to 500', () => {
    expect(ok('SELECT * FROM movies LIMIT 501')).toBe(
      'SELECT * FROM movies LIMIT 500'
    );
  });

  it('keeps a LIMIT with an OFFSET, capping the row count', () => {
    expect(ok('SELECT * FROM movies LIMIT 1000 OFFSET 20')).toBe(
      'SELECT * FROM movies LIMIT 500 OFFSET 20'
    );
  });

  it('keeps LIMIT with the SQLite comma form (offset, count) capped on count', () => {
    // `LIMIT 20, 1000` means offset 20, count 1000 → cap count to 500.
    expect(ok('SELECT * FROM movies LIMIT 20, 1000')).toBe(
      'SELECT * FROM movies LIMIT 20, 500'
    );
  });

  it('leaves a small explicit LIMIT untouched', () => {
    expect(ok('SELECT * FROM movies LIMIT 5')).toBe(
      'SELECT * FROM movies LIMIT 5'
    );
  });
});
