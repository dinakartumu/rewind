import { createRoute, z } from '@hono/zod-openapi';
import { createOpenAPIApp } from '../lib/openapi.js';
import { errorResponses } from '../lib/schemas/common.js';
import { badRequest } from '../lib/errors.js';
import { setCache } from '../lib/cache.js';
import { validateReadOnlySql } from '../lib/sql-guard.js';
import { SCHEMA_DOC } from '../lib/schema-doc.js';

/**
 * SQL-first MCP surface. Two read-scope endpoints:
 *   - POST /v1/query  — run a gated, read-only SELECT/WITH query.
 *   - GET  /v1/schema — the curated annotated schema for the query endpoint.
 *
 * The security gate lives in `lib/sql-guard.ts`; this route wires it in and
 * executes the validated SQL against D1. Two of the gate's controls are
 * LOAD-BEARING (not merely defense-in-depth): multi-statement blocking (D1
 * executes chained `;`-separated statements, so one missed `;` would let a
 * write ride along behind a SELECT) and the ALLOW-list table gate (the DB
 * holds `api_keys` hashes and OAuth tokens with no read-side row protection).
 */

/**
 * Response size ceiling. Rows past this JSON-serialized budget are dropped and
 * `truncated` is set true, so a pathological `SELECT *` on a wide table can't
 * return a multi-megabyte payload.
 */
const MAX_RESPONSE_BYTES = 256 * 1024;

// Read-scope auth is applied by the global `/v1/*` middleware in index.ts
// (which correctly exempts /v1/openapi.json and /v1/health). This sub-app is
// mounted at the `/` base path, so a blanket `query.use('*', …)` here would
// wrap EVERY /v1 route — including the public spec endpoint — and must not be
// added. Both /v1/query and /v1/schema fall through to the global read gate.
const query = createOpenAPIApp();

// ─── Schemas ────────────────────────────────────────────────────────

const QueryRequestSchema = z
  .object({
    sql: z.string().openapi({
      description:
        'A single read-only SELECT (or WITH … SELECT) statement. A LIMIT is applied automatically (200 default, 500 max).',
      example:
        "SELECT strftime('%Y', scrobbled_at) AS year, count(*) AS plays FROM lastfm_scrobbles GROUP BY year ORDER BY year",
    }),
  })
  .openapi('QueryRequest');

const QueryResponseSchema = z
  .object({
    columns: z.array(z.string()).openapi({ example: ['year', 'plays'] }),
    rows: z.array(z.array(z.unknown())).openapi({
      example: [
        ['2024', 18234],
        ['2025', 21012],
      ],
    }),
    row_count: z.number().int().openapi({ example: 2 }),
    truncated: z.boolean().openapi({
      example: false,
      description: 'True when rows were dropped to fit the response ceiling.',
    }),
  })
  .openapi('QueryResponse');

const SchemaColumnSchema = z.object({
  name: z.string(),
  type: z.string(),
  note: z.string().optional(),
});

const SchemaTableSchema = z.object({
  name: z.string(),
  purpose: z.string(),
  columns: z.array(SchemaColumnSchema),
  joins: z.array(z.string()).optional(),
});

const SchemaResponseSchema = z
  .object({
    notes: z.array(z.string()).openapi({
      description: 'Global conventions a model needs before writing queries.',
    }),
    tables: z.array(SchemaTableSchema).openapi({
      description: 'Every queryable table with columns, notes, and join keys.',
    }),
  })
  .openapi('SchemaResponse');

// ─── POST /v1/query ─────────────────────────────────────────────────

const runQueryRoute = createRoute({
  method: 'post',
  path: '/query',
  operationId: 'runQuery',
  tags: ['Query'],
  summary: 'Run a read-only SQL query',
  description:
    'Executes a single read-only SELECT (or WITH … SELECT) statement against the Rewind database and returns column names plus array-of-array row tuples. Gated server-side: writes, DDL, multi-statement input, and access to secret tables are rejected. A LIMIT is enforced automatically (200 default, 500 max). Fetch GET /v1/schema first for the annotated table list.',
  request: {
    body: {
      content: {
        'application/json': { schema: QueryRequestSchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Query results as column names plus row tuples',
      content: {
        'application/json': { schema: QueryResponseSchema },
      },
    },
    ...errorResponses(400, 401),
  },
});

query.openapi(runQueryRoute, async (c) => {
  setCache(c, 'none');

  // Parse defensively so a malformed body is a clean 400, not a 500.
  let parsed: { sql?: unknown };
  try {
    parsed = await c.req.json<{ sql?: unknown }>();
  } catch {
    return badRequest(
      c,
      'Request body must be JSON with a `sql` field.'
    ) as never;
  }

  const gate = validateReadOnlySql(parsed.sql);
  if (!gate.ok) {
    return badRequest(c, gate.error) as never;
  }

  // Belt-and-suspenders: the validated SQL is a single statement and the LIMIT
  // wrap adds no `;`. If one is somehow present, refuse to hand it to D1 (which
  // would execute chained statements). This should be unreachable.
  if (gate.sql.includes(';')) {
    console.log('[ERROR] /v1/query: validated SQL contained a semicolon');
    return badRequest(c, 'Query failed validation.') as never;
  }

  let raw: [string[], ...unknown[][]];
  try {
    raw = await c.env.DB.prepare(gate.sql).raw({ columnNames: true });
  } catch (err) {
    // D1 surfaces SQL errors (unknown column, syntax) here — return them as a
    // clean 400 so the caller can fix the query rather than a 500.
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[ERROR] /v1/query failed: ${message}`);
    return badRequest(c, `Query failed: ${message}`) as never;
  }

  const [columns, ...allRows] = raw;

  // Trim rows until the serialized payload fits the ceiling. Incremental byte
  // accounting avoids re-stringifying the whole set per row.
  let bytes = JSON.stringify(columns ?? []).length + 64;
  let truncated = false;
  const rows: unknown[][] = [];
  for (const row of allRows) {
    bytes += JSON.stringify(row).length + 1;
    if (bytes > MAX_RESPONSE_BYTES && rows.length > 0) {
      truncated = true;
      break;
    }
    rows.push(row);
  }

  return c.json({
    columns: columns ?? [],
    rows,
    row_count: rows.length,
    truncated,
  });
});

// ─── GET /v1/schema ─────────────────────────────────────────────────

const getSchemaRoute = createRoute({
  method: 'get',
  path: '/schema',
  operationId: 'getSchema',
  tags: ['Query'],
  summary: 'Annotated database schema',
  description:
    'Returns the curated, annotated schema for the query endpoint: every queryable table with its columns, types, semantic notes, join keys, and global conventions (single user_id, ISO timestamps, rating scales, image URL composition). Secret/system tables are intentionally omitted.',
  responses: {
    200: {
      description: 'Annotated schema',
      content: {
        'application/json': { schema: SchemaResponseSchema },
      },
    },
    ...errorResponses(401),
  },
});

query.openapi(getSchemaRoute, (c) => {
  setCache(c, 'medium');
  return c.json(SCHEMA_DOC);
});

export default query;
