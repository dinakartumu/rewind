import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { createDb } from '../db/client.js';
import { movies, watchHistory } from '../db/schema/watching.js';
import { setupTestDb, createTestApiKey } from '../test-helpers.js';

/**
 * Integration coverage for the SQL-first endpoints. The unit-level guard logic
 * lives in sql-guard.test.ts; here we verify the route wires the guard in,
 * executes valid queries against real D1, and maps failures to clean 400s.
 */
describe('POST /v1/query + GET /v1/schema', () => {
  let readToken: string;

  beforeAll(async () => {
    await setupTestDb();
    readToken = await createTestApiKey({ scope: 'read', name: 'query-test' });

    const db = createDb(env.DB);
    const [m1] = await db
      .insert(movies)
      .values({ title: 'Query Movie A', year: 1999, tmdbId: 900001 })
      .returning();
    const [m2] = await db
      .insert(movies)
      .values({ title: 'Query Movie B', year: 2001, tmdbId: 900002 })
      .returning();
    await db.insert(watchHistory).values([
      { movieId: m1.id, watchedAt: '2026-01-02T00:00:00.000Z', source: 'plex' },
      { movieId: m1.id, watchedAt: '2026-02-02T00:00:00.000Z', source: 'plex' },
      {
        movieId: m2.id,
        watchedAt: '2026-03-02T00:00:00.000Z',
        source: 'letterboxd',
      },
    ]);
  });

  async function query(sql: string, token = readToken) {
    return SELF.fetch('http://localhost/v1/query', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql }),
    });
  }

  it('requires auth', async () => {
    const res = await SELF.fetch('http://localhost/v1/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: 'SELECT 1' }),
    });
    expect(res.status).toBe(401);
  });

  it('executes a valid SELECT and returns columns + rows', async () => {
    const res = await query(
      'SELECT title, year FROM movies WHERE year >= 2000 ORDER BY year'
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      columns: string[];
      rows: unknown[][];
      row_count: number;
      truncated: boolean;
    };
    expect(body.columns).toEqual(['title', 'year']);
    expect(body.rows).toEqual([['Query Movie B', 2001]]);
    expect(body.row_count).toBe(1);
    expect(body.truncated).toBe(false);
  });

  it('runs a cross-table aggregate join', async () => {
    const res = await query(
      'SELECT m.title, count(*) AS watches FROM movies m JOIN watch_history wh ON wh.movie_id = m.id GROUP BY m.id ORDER BY watches DESC'
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[][] };
    expect(body.rows[0]).toEqual(['Query Movie A', 2]);
    expect(body.rows[1]).toEqual(['Query Movie B', 1]);
  });

  it('rejects a non-SELECT with 400', async () => {
    const res = await query("INSERT INTO movies (title) VALUES ('x')");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it('rejects access to a denied table with 400', async () => {
    const res = await query('SELECT * FROM api_keys');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/api_keys|not allowed/i);
  });

  it('rejects multi-statement smuggling with 400', async () => {
    const res = await query('SELECT 1; DROP TABLE movies');
    expect(res.status).toBe(400);
  });

  it('rejects a non-documented (but non-denied) table with 400', async () => {
    // C1 regression at the HTTP boundary: allow-list, not deny-list.
    const res = await query('SELECT * FROM plex_credentials');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/plex_credentials|not allowed/i);
  });

  it('executes a UNION query through the LIMIT wrap (valid SQL)', async () => {
    // The wrap form (`SELECT * FROM (<union>) AS _rewind_q LIMIT n`) must be
    // valid SQL that D1 accepts — an append-LIMIT would have been rejected.
    const res = await query(
      'SELECT title FROM movies WHERE year = 1999 UNION SELECT title FROM movies WHERE year = 2001 ORDER BY title'
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[][]; columns: string[] };
    expect(body.columns).toEqual(['title']);
    expect(body.rows.map((r) => r[0])).toEqual([
      'Query Movie A',
      'Query Movie B',
    ]);
  });

  it('executes a wrapped query with a user LIMIT capping the row count', async () => {
    const res = await query('SELECT title FROM movies ORDER BY title LIMIT 1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[][] };
    expect(body.rows.length).toBe(1);
    expect(body.rows[0]).toEqual(['Query Movie A']);
  });

  it('maps a D1 execution error (bad column) to a clean 400', async () => {
    const res = await query('SELECT no_such_column FROM movies');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it('rejects a non-string sql body with 400', async () => {
    const res = await SELF.fetch('http://localhost/v1/query', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${readToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql: 12345 }),
    });
    expect(res.status).toBe(400);
  });

  it('GET /v1/schema returns the annotated schema (read scope)', async () => {
    const res = await SELF.fetch('http://localhost/v1/schema', {
      headers: { Authorization: `Bearer ${readToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      notes: string[];
      tables: { name: string; columns: unknown[] }[];
    };
    expect(Array.isArray(body.notes)).toBe(true);
    expect(body.tables.length).toBeGreaterThan(30);
    const names = body.tables.map((t) => t.name);
    expect(names).toContain('movies');
    expect(names).toContain('lastfm_scrobbles');
    // No denied table is exposed.
    expect(names).not.toContain('api_keys');
    expect(names).not.toContain('strava_tokens');
  });

  it('GET /v1/schema requires auth', async () => {
    const res = await SELF.fetch('http://localhost/v1/schema');
    expect(res.status).toBe(401);
  });
});
