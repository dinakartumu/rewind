import { describe, it, expect } from 'vitest';
import {
  validateReadOnlySql,
  DENIED_TABLES,
  ALLOWED_TABLES,
} from './sql-guard.js';

/**
 * The guard is security-critical: it is the single choke point that keeps a
 * read-scope SQL endpoint from exfiltrating secrets or mutating data. These
 * tests are adversarial by design - every rejection path has a dedicated case,
 * and legitimate analytical queries must survive untouched (aside from the
 * LIMIT subquery-wrap the guard applies).
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

/**
 * The enforced form: the validated (comment-stripped, trimmed) inner query
 * wrapped in `SELECT * FROM (<inner>) AS _rewind_q LIMIT <cap>`.
 */
function wrap(inner: string, cap = 200) {
  return `SELECT * FROM (${inner}) AS _rewind_q LIMIT ${cap}`;
}

describe('validateReadOnlySql - legitimate queries pass', () => {
  it('accepts a simple SELECT and wraps with the default LIMIT', () => {
    expect(ok('SELECT * FROM movies')).toBe(wrap('SELECT * FROM movies'));
  });

  it('accepts lowercase select', () => {
    expect(ok('select id, title from movies')).toBe(
      wrap('select id, title from movies')
    );
  });

  it('accepts a query that already has a LIMIT and wraps with that limit', () => {
    expect(ok('SELECT * FROM movies LIMIT 10')).toBe(
      wrap('SELECT * FROM movies LIMIT 10', 10)
    );
  });

  it('accepts a join across allowed tables', () => {
    const q =
      'SELECT m.title, wh.watched_at FROM movies m JOIN watch_history wh ON wh.movie_id = m.id';
    expect(ok(q)).toBe(wrap(q));
  });

  it('accepts a WITH … SELECT CTE', () => {
    const q =
      'WITH recent AS (SELECT id FROM lastfm_scrobbles ORDER BY scrobbled_at DESC LIMIT 50) SELECT * FROM recent';
    // Inner LIMIT is a subquery limit; the top-level query has no trailing
    // LIMIT, so the default cap is used.
    expect(ok(q)).toBe(wrap(q));
  });

  it('accepts an aggregate with GROUP BY', () => {
    const q =
      'SELECT artist_id, count(*) AS n FROM lastfm_scrobbles GROUP BY artist_id ORDER BY n DESC';
    expect(ok(q)).toBe(wrap(q));
  });

  it('accepts a subquery', () => {
    const q =
      'SELECT * FROM movies WHERE id IN (SELECT movie_id FROM watch_history)';
    expect(ok(q)).toBe(wrap(q));
  });

  it('accepts a cross-domain join over allowed tables', () => {
    const q =
      'SELECT c.venue_name, r.title AS release FROM checkins c JOIN discogs_collection dc ON 1=1 JOIN discogs_releases r ON r.id = dc.release_id';
    expect(ok(q)).toBe(wrap(q));
  });

  it('accepts a multi-table join across several allowed tables', () => {
    const q =
      'SELECT ar.name, al.name, t.name FROM lastfm_tracks t JOIN lastfm_albums al ON t.album_id = al.id JOIN lastfm_artists ar ON t.artist_id = ar.id LEFT JOIN lastfm_scrobbles s ON s.track_id = t.id';
    expect(ok(q)).toBe(wrap(q));
  });

  it('accepts INNER/LEFT/CROSS join keywords', () => {
    const q =
      'SELECT * FROM movies m INNER JOIN movie_genres mg ON mg.movie_id = m.id LEFT OUTER JOIN genres g ON g.id = mg.genre_id CROSS JOIN directors d';
    expect(ok(q)).toBe(wrap(q));
  });

  it('trims leading/trailing whitespace before wrapping', () => {
    expect(ok('   SELECT 1   ')).toBe(wrap('SELECT 1'));
  });

  it('tolerates a trailing semicolon on a single statement', () => {
    expect(ok('SELECT 1;')).toBe(wrap('SELECT 1'));
  });

  it('allows a string literal that contains a denied-looking word', () => {
    // "insert" appears only inside a string literal, not as a keyword.
    const q =
      "SELECT * FROM reading_items WHERE title = 'how to insert a coin'";
    expect(ok(q)).toBe(wrap(q));
  });

  it('allows a non-denied string literal that looks like a write keyword', () => {
    // The write-keyword scan runs on string-blanked SQL, so 'DELETE me'
    // inside a value does not trip it.
    const q = "SELECT * FROM movies WHERE title = 'DELETE me'";
    expect(ok(q)).toBe(wrap(q));
  });

  it('allows the replace() scalar function (not a REPLACE statement)', () => {
    const q =
      "SELECT replace(title, 'a', 'b') AS t FROM movies WHERE year > 2000";
    expect(ok(q)).toBe(wrap(q));
  });

  it('preserves an explicit LIMIT of exactly 500', () => {
    expect(ok('SELECT * FROM movies LIMIT 500')).toBe(
      wrap('SELECT * FROM movies LIMIT 500', 500)
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
    expect(ok("SELECT ';drop' AS x")).toBe(wrap("SELECT ';drop' AS x"));
  });

  it('handles an escaped quote inside a string with a semicolon', () => {
    const q = "SELECT 'O''Brien; DROP' AS name";
    expect(ok(q)).toBe(wrap(q));
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
      wrap('SELECT created_at FROM reading_items')
    );
    // "updated_at" contains "update".
    expect(ok('SELECT updated_at FROM movies')).toBe(
      wrap('SELECT updated_at FROM movies')
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

  it('rejects a table whose name contains a denied substring but is not documented', () => {
    // `api_keys_history` is NOT a whole-word match for `api_keys` (so the
    // legacy deny-scan lets it through), but it is also NOT in the allow-list,
    // so the allow-list gate rejects it. This is the fail-closed posture: only
    // documented tables are reachable.
    expect(err('SELECT * FROM api_keys_history')).toMatch(/not allowed/i);
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

describe('validateReadOnlySql - ALLOW-list table gate (C1)', () => {
  it('rejects a table that is not denied but also not documented (regression guard)', () => {
    // `plex_credentials` is invented — it is not on the deny-list, so a
    // deny-list gate would have LEAKED it. The allow-list gate rejects it
    // because it is not in SCHEMA_DOC. This is the C1 regression: secret
    // tables added in the future are unreachable by default.
    const e = err('SELECT * FROM plex_credentials');
    expect(e).toMatch(/plex_credentials/);
    expect(e).toMatch(/not allowed/i);
  });

  it('rejects a non-documented table referenced via a JOIN', () => {
    expect(
      err('SELECT m.title FROM movies m JOIN plex_credentials p ON 1=1')
    ).toMatch(/plex_credentials/);
  });

  it('rejects a quoted non-documented table', () => {
    expect(err('SELECT * FROM "plex_credentials"')).toMatch(/not allowed/i);
    expect(err('SELECT * FROM [plex_credentials]')).toMatch(/not allowed/i);
    expect(err('SELECT * FROM `plex_credentials`')).toMatch(/not allowed/i);
  });

  it('accepts a documented table referenced with a quoted identifier', () => {
    expect(ok('SELECT * FROM "movies"')).toBe(wrap('SELECT * FROM "movies"'));
    expect(ok('SELECT * FROM [movies]')).toBe(wrap('SELECT * FROM [movies]'));
    expect(ok('SELECT * FROM `movies`')).toBe(wrap('SELECT * FROM `movies`'));
  });

  it('accepts a `main.`-qualified documented table', () => {
    expect(ok('SELECT * FROM main.movies')).toBe(
      wrap('SELECT * FROM main.movies')
    );
  });

  it('rejects a cross-schema qualifier other than main', () => {
    expect(err('SELECT * FROM otherdb.movies')).toMatch(/cross-schema|not/i);
    expect(err('SELECT * FROM temp.movies')).toMatch(/cross-schema|not/i);
  });

  it('rejects a three-part qualified name outright', () => {
    expect(err('SELECT * FROM db.main.movies')).toMatch(/cross-schema|not/i);
  });

  it('allows a CTE name as a reference target while validating its body', () => {
    // CTE body reads an allowed table → whole query passes.
    const good = 'WITH k AS (SELECT * FROM movies) SELECT * FROM k';
    expect(ok(good)).toBe(wrap(good));
  });

  it('rejects a CTE whose body reads a denied table (inner reference validated)', () => {
    // The CTE name `k` is an allowed target, but its body's FROM api_keys is
    // still validated and rejected.
    expect(err('WITH k AS (SELECT * FROM api_keys) SELECT * FROM k')).toMatch(
      /api_keys|not allowed/i
    );
  });

  it('rejects a CTE whose body reads a non-documented table', () => {
    expect(
      err('WITH k AS (SELECT * FROM plex_credentials) SELECT * FROM k')
    ).toMatch(/plex_credentials/);
  });

  it('allows multiple CTEs referencing each other and allowed tables', () => {
    const q =
      'WITH a AS (SELECT id FROM movies), b AS (SELECT id FROM a) SELECT * FROM b JOIN a ON a.id = b.id';
    expect(ok(q)).toBe(wrap(q));
  });

  it('accepts a subquery source without a spurious table ref', () => {
    const q = 'SELECT * FROM (SELECT id FROM movies) AS sub';
    expect(ok(q)).toBe(wrap(q));
  });

  it('exposes ALLOWED_TABLES derived from the documented schema', () => {
    expect(ALLOWED_TABLES.has('movies')).toBe(true);
    expect(ALLOWED_TABLES.has('lastfm_scrobbles')).toBe(true);
    expect(ALLOWED_TABLES.has('api_keys')).toBe(false);
    expect(ALLOWED_TABLES.has('strava_tokens')).toBe(false);
    expect(ALLOWED_TABLES.has('plex_credentials')).toBe(false);
  });
});

describe('validateReadOnlySql - REPLACE handling (M1)', () => {
  it('accepts the replace() scalar function', () => {
    const q = "SELECT replace(name, ' ', '_') FROM lastfm_artists";
    expect(ok(q)).toBe(wrap(q));
  });

  it('rejects REPLACE INTO (write statement form)', () => {
    expect(err('REPLACE INTO movies VALUES (1)')).toBeTruthy();
  });

  it('rejects REPLACE INTO smuggled after a comment/whitespace', () => {
    // Statement-initial REPLACE is caught by the first-keyword check; the
    // REPLACE INTO scan is the belt-and-suspenders for other positions.
    expect(err('replace into movies values (1)')).toBeTruthy();
  });

  it('documents the fail-safe limitation: a bare `REPLACE` column alias is allowed', () => {
    // Because REPLACE was removed from DENY_TOKENS to protect replace(), a
    // column/alias literally named `replace` is not rejected by the keyword
    // scan. This is safe: it references no table and mutates nothing. (An
    // actual REPLACE statement is still blocked by first-keyword + REPLACE
    // INTO.) `replace` here is a bare identifier, no table read.
    expect(ok('SELECT 1 AS replace')).toBe(wrap('SELECT 1 AS replace'));
  });

  it('still rejects UPDATE/DELETE/INSERT as bare aliases (fail-safe, documented)', () => {
    // These remain in DENY_TOKENS, so `SELECT id AS delete` is rejected even
    // though it is harmless. Kept as fail-safe; documented limitation.
    expect(err('SELECT id AS delete FROM movies')).toBeTruthy();
    expect(err('SELECT id AS update FROM movies')).toBeTruthy();
    expect(err('SELECT id AS insert FROM movies')).toBeTruthy();
  });
});

describe('validateReadOnlySql - LIMIT enforcement (subquery wrap)', () => {
  it('wraps with the default cap of 200 when no LIMIT is present', () => {
    expect(ok('SELECT * FROM movies')).toBe(wrap('SELECT * FROM movies'));
    expect(ok('SELECT * FROM movies')).toMatch(/LIMIT 200$/);
  });

  it('caps an explicit LIMIT above 500 down to 500 in the outer wrap', () => {
    expect(ok('SELECT * FROM movies LIMIT 99999')).toBe(
      wrap('SELECT * FROM movies LIMIT 99999', 500)
    );
  });

  it('caps LIMIT 501 to 500', () => {
    expect(ok('SELECT * FROM movies LIMIT 501')).toBe(
      wrap('SELECT * FROM movies LIMIT 501', 500)
    );
  });

  it('uses the user LIMIT (with OFFSET) as the cap, preserving the inner clause', () => {
    // The inner query keeps its OFFSET; the outer wrap caps the row count.
    expect(ok('SELECT * FROM movies LIMIT 1000 OFFSET 20')).toBe(
      wrap('SELECT * FROM movies LIMIT 1000 OFFSET 20', 500)
    );
  });

  it('reads the count from the SQLite comma form for the outer cap', () => {
    // `LIMIT 20, 1000` means offset 20, count 1000 → outer cap 500.
    expect(ok('SELECT * FROM movies LIMIT 20, 1000')).toBe(
      wrap('SELECT * FROM movies LIMIT 20, 1000', 500)
    );
  });

  it('uses a small explicit LIMIT as the outer cap', () => {
    expect(ok('SELECT * FROM movies LIMIT 5')).toBe(
      wrap('SELECT * FROM movies LIMIT 5', 5)
    );
  });

  it('wraps a UNION query with a trailing LIMIT without producing invalid SQL', () => {
    // Append-LIMIT would break `… LIMIT 5 UNION …`; the wrap makes the LIMIT
    // genuinely top-level. Here the trailing LIMIT applies to the second arm,
    // so it is read as the cap and the wrap holds the whole compound query.
    const q =
      'SELECT title FROM movies LIMIT 5 UNION SELECT title FROM shows LIMIT 3';
    expect(ok(q)).toBe(wrap(q, 3));
  });

  it('wraps a UNION with no trailing LIMIT using the default cap', () => {
    const q = 'SELECT title FROM movies UNION SELECT title FROM shows';
    expect(ok(q)).toBe(wrap(q));
  });

  it('preserves ORDER BY inside each arm of a compound select through the wrap', () => {
    const q =
      'SELECT title, year FROM movies ORDER BY year DESC UNION ALL SELECT title, year FROM shows ORDER BY year ASC';
    expect(ok(q)).toBe(wrap(q));
  });

  it('handles an expression LIMIT (10+10) that append-LIMIT would corrupt', () => {
    // A bare `LIMIT 10+10` followed by ` LIMIT 200` is invalid SQL. The wrap
    // leaves the inner expression untouched and applies the default cap
    // outside (the trailing-LIMIT regex requires a plain integer, so the
    // expression form is treated as "no simple top-level LIMIT" → default).
    const q = 'SELECT * FROM movies LIMIT 10+10';
    expect(ok(q)).toBe(wrap(q));
  });
});
