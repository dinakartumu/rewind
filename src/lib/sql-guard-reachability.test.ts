import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { validateReadOnlySql, ALLOWED_TABLES } from './sql-guard.js';
import { setupTestDbWithFts5 } from '../test-helpers.js';

/**
 * The guard's central promise, tested against the real schema rather than a
 * hand-written list:
 *
 *   anything not explicitly documented as safe must be unreachable by default
 *
 * Enumerating `sqlite_master` means this covers tables that do not exist yet.
 * A migration that adds a table without a `SCHEMA_DOC` entry fails here — which
 * is the whole point of an allow-list, and precisely the property that was
 * silently untrue for comma-separated FROM lists until #25.
 *
 * Reachability is probed through several syntactic routes, because the bypass
 * was not "the gate is wrong about this table" but "the gate never saw this
 * table" — a defect only visible by varying the shape of the query.
 */
describe('table reachability', () => {
  let realTables: string[] = [];

  beforeAll(async () => {
    // FTS5 variant: search_index and its shadow tables only exist under it, and
    // they were the tables actually exposed by the bypass.
    await setupTestDbWithFts5();
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all<{ name: string }>();
    realTables = results.map((r) => r.name);
  });

  it('enumerates the schema (guards against a vacuous pass on an empty DB)', () => {
    expect(realTables.length).toBeGreaterThan(20);
  });

  it('exposes no undocumented table through any FROM shape', () => {
    const routes = (t: string) => [
      `SELECT * FROM ${t}`,
      `SELECT * FROM movies, ${t}`,
      `SELECT * FROM movies m, ${t} x`,
      `SELECT * FROM movies AS m, ${t} AS x`,
      `SELECT * FROM movies, watch_history, ${t}`,
    ];

    const reachable = realTables
      .filter((t) => !ALLOWED_TABLES.has(t.toLowerCase()))
      .flatMap((t) =>
        routes(t)
          .filter((sql) => validateReadOnlySql(sql).ok)
          .map((sql) => `${t}  via  ${sql}`)
      );

    expect(
      reachable,
      `undocumented tables reachable from POST /v1/query:\n  ${reachable.join('\n  ')}`
    ).toEqual([]);
  });
});
