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

1. **Single statement only (LOAD-BEARING).** Reject any embedded `;` outside
   string literals. D1 executes chained `;`-separated statements, so a missed
   `;` would let a write ride behind a SELECT — this is not just hygiene.
2. Must parse as `SELECT` / `WITH … SELECT` (first meaningful token).
3. Deny-tokens anywhere (on string-blanked SQL): `ATTACH`, `DETACH`, `PRAGMA`,
   `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `VACUUM`,
   `REINDEX`, `TRIGGER`. `REPLACE` is handled separately as `REPLACE INTO` /
   statement-initial only, so the `replace()` scalar function still works.
4. **Table ALLOW-list — the load-bearing control.** The DB holds secrets
   (`api_keys` hashes, `trakt_tokens`/`strava_tokens`/`google_tokens` OAuth
   tokens, `revalidation_hooks` secrets) and D1 gives no read-side row
   protection, so the gate is an allow-list, not a deny-list: a future secret
   table is unreachable by default. Extract every FROM/JOIN target (handling
   quoted `"x"`/`[x]`/`` `x` ``, `main.x` qualifiers, and CTE names) and
   require each to be a table documented in `SCHEMA_DOC` — the single source of
   truth — or a CTE defined in the same query. A CTE name is an allowed
   reference target, but its body's own FROM/JOIN targets are still validated.
   The legacy denied-table word-scan is kept as cheap redundant defense.
   `sqlite_master`/`pragma_*` are excluded (schema comes from the curated
   resource instead).
5. Enforce LIMIT by WRAPPING: `SELECT * FROM (<validated sql>) AS _rewind_q
LIMIT <n>` where n = min(user's top-level LIMIT, 500) or 200 if absent.
   Wrapping (not appending) keeps the cap top-level and robust to
   UNION/compound and expression LIMITs. Response size ceiling ~256 KB →
   `truncated: true`.
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

OAuth gates the surface to the owner, but the SQL gate is not merely defense in
depth: multi-statement blocking and the ALLOW-list table gate are load-bearing
controls (D1 chains statements; the DB holds secrets with no read-side row
protection). Adversarial tests are part of the deliverable: multi-statement
smuggling, comment tricks (`/**/`, `--`), CTE writes, `PRAGMA` via whitespace
variants, denied-table references through aliases and quoted identifiers,
LIMIT bypass attempts.

## Out of scope

Query plans/EXPLAIN, write access of any kind, live schema introspection,
multi-user scoping beyond the existing `user_id = 1` convention.
