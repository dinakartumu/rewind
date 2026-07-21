# SQL-first MCP: query tool + annotated schema

**Date:** 2026-07-21
**Status:** Approved (user-directed)

## Goal

Replace most of the 49 purpose-built MCP tools with two primitives — a gated
read-only SQL tool and an annotated schema resource — while keeping the small
set of rich widget tools. Motivation: tool definitions cost context on every
chat, thin wrapper tools cap the question surface at what we anticipated, and
models compose SQLite well when given a good schema.

## Architecture

SQL execution happens in the API Worker (the only place with a D1 binding),
behind a new endpoint; the MCP server (remote Worker and local stdio) wraps it
over HTTP like every other tool.

### API: POST /v1/query (read scope)

Body `{ "sql": string }` → `{ columns: string[], rows: unknown[][], row_count,
truncated: boolean }`.

**The gate (server-side, single choke point):**

1. Single statement only (reject embedded `;` outside string literals).
2. Must parse as `SELECT` / `WITH … SELECT` (first meaningful token).
3. Deny-tokens anywhere: `ATTACH`, `PRAGMA`, `INSERT`, `UPDATE`, `DELETE`,
   `DROP`, `ALTER`, `CREATE`, `REPLACE`, `VACUUM`, `REINDEX`, `TRIGGER`.
4. **Table allowlist — the load-bearing control.** The DB holds secrets
   (`api_keys` hashes, `trakt_tokens`/`strava_tokens`/`google_tokens` OAuth
   tokens, `revalidation_hooks` secrets, `oauth_*`). Scan the SQL for any
   word-token matching a DENIED table name and reject the query outright
   (conservative: even inside strings). Allowlist = the domain data tables +
   `geo_cities` + `sync_runs` + `activity_feed` + `images` + `genres` etc.;
   deny everything else including `sqlite_master` (schema comes from the
   curated resource instead).
5. Enforce LIMIT: append `LIMIT 200` when absent; cap any explicit LIMIT at 500. Response size ceiling ~256 KB → `truncated: true`.
6. Read keys allowed; per-key rate limiting already applies.

### API: GET /v1/schema (read scope)

Returns the **hand-curated annotated schema** (checked-in markdown/JSON, not
live introspection): per allowlisted table, its columns with types plus the
semantic notes a model needs — source enums, `is_filtered` conventions,
1-10 vs 5-star ratings, ISO timestamps, join keys across domains, how
`images.r2_key` + `image_version` compose into
`https://cdn.dinakartumu.com/cdn-cgi/image/…` URLs, `user_id = 1`.
A test asserts every allowlisted table appears in the doc so it can't rot
silently.

### MCP server

- New tools: `query_rewind` (sql arg; returns columns/rows; description
  teaches the workflow: read the schema first, single SELECT, LIMIT applies)
  and `get_schema` (no args; returns the annotated schema; also exposed as an
  MCP resource).
- **Keep** the rich/widget tools (everything with a UI bundle: article,
  watches, games, top-albums/tracks-style visual tools), `search`,
  `semantic_search`, `get_now_playing`, `get_health`.
- **Retire** the thin wrappers (stats/recent/streaks/browse-style tools whose
  entire body is one parameterized query). Manifest snapshot regenerated;
  server instructions rewritten around the SQL-first workflow with 3-4
  worked examples including a cross-domain join.

## Safety posture

OAuth already gates the surface to the owner; the SQL gate is defense in
depth. Adversarial tests are part of the deliverable: multi-statement
smuggling, comment tricks (`/**/`, `--`), CTE writes, `PRAGMA` via whitespace
variants, denied-table references through aliases and quoted identifiers,
LIMIT bypass attempts.

## Out of scope

Query plans/EXPLAIN, write access of any kind, live schema introspection,
multi-user scoping beyond the existing `user_id = 1` convention.
