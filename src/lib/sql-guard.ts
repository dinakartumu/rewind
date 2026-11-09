/**
 * Read-only SQL guard for the `POST /v1/query` endpoint.
 *
 * This is the single server-side choke point that keeps a read-scope SQL tool
 * from mutating data or exfiltrating secrets. OAuth already gates the surface
 * to the owner, but two of these controls are LOAD-BEARING, not merely
 * defense-in-depth:
 *   - Multi-statement blocking: D1 executes chained `;`-separated statements,
 *     so a single missed `;` would let a write ride along behind a SELECT.
 *   - The table gate is an ALLOW-list: the DB holds `api_keys` hashes and
 *     OAuth tokens, and D1 gives no read-side row protection, so anything not
 *     explicitly documented as safe must be unreachable by default.
 * It is deliberately conservative: ambiguity resolves to rejection.
 *
 * Pipeline:
 *   1. Strip SQL comments (`-- … EOL` and `/* … *\/`, nested-safe) BEFORE any
 *      analysis, so comment-smuggled keywords/tables can't hide.
 *   2. Reject > 1 statement (a `;` outside a string literal or comment).
 *   3. First meaningful keyword must be SELECT or WITH.
 *   4. Deny-token scan (word-boundary, case-insensitive) for write / DDL /
 *      side-effecting keywords, on string-BLANKED SQL.
 *   5. Denied-table scan (word-boundary) on the un-blanked SQL — redundant
 *      belt-and-suspenders now that the allow-list is authoritative.
 *   6. ALLOW-list table gate: every FROM/JOIN target must be a documented
 *      table (from SCHEMA_DOC) or a CTE name defined in the same query.
 *   7. LIMIT enforcement: wrap the validated query in
 *      `SELECT * FROM (<query>) AS _rewind_q LIMIT <n>` so the cap is genuinely
 *      top-level and robust to UNION/compound and expression LIMITs.
 *
 * The value we return (and therefore execute) is the comment-stripped,
 * whitespace-normalized, LIMIT-wrapped form. Executing the normalized form
 * rather than the raw input means what the guard inspected is exactly what
 * runs — no divergence between validated text and executed text.
 */

import { allowedTableNames } from './schema-doc.js';

export type SqlGuardResult =
  | {
      ok: true;
      sql: string;
      /**
       * Every base table the query reads, lower-cased and de-duplicated (CTE
       * names excluded — they are not data sources). The gate already parses
       * these to enforce the allow-list; surfacing them lets callers tell WHICH
       * integration a result came from without re-parsing the SQL.
       */
      tables: string[];
    }
  | { ok: false; error: string };

/**
 * The allow-list of table names any FROM/JOIN may target, derived from the
 * curated SCHEMA_DOC (the single source of truth for safe tables). Computed
 * once at module load; the set is lower-cased for case-insensitive matching.
 */
export const ALLOWED_TABLES: ReadonlySet<string> = allowedTableNames();

/**
 * Tables that must never be reachable from the query endpoint.
 *
 * NOTE: this is NO LONGER the authoritative control — `ALLOWED_TABLES` (derived
 * from SCHEMA_DOC) is. Any table not documented in the schema is unreachable by
 * default, so a future secret table is safe even if it is never added here.
 * This list is kept as cheap, redundant belt-and-suspenders and to give a
 * precise, named error for the well-known secret tables:
 *   - `api_keys` — hashed API key material.
 *   - `*_tokens` — OAuth access/refresh tokens (Strava, Trakt, Google).
 *   - `revalidation_hooks` — cache-purge secrets.
 *   - `webhook_events` — inbound webhook payloads / provider secrets.
 *   - `sqlite_master` / `sqlite_schema` / other SQLite/D1 internals — schema
 *     introspection is out of scope; the curated `/v1/schema` resource is the
 *     only schema surface.
 */
export const DENIED_TABLES: readonly string[] = [
  'api_keys',
  'strava_tokens',
  'trakt_tokens',
  'google_tokens',
  'revalidation_hooks',
  'webhook_events',
  'sqlite_master',
  'sqlite_schema',
  // SQLite/D1 internals — nothing secret, but they are not part of the
  // curated schema surface and give away structure.
  'sqlite_sequence',
  'sqlite_temp_master',
  'sqlite_temp_schema',
  'd1_migrations',
  '_cf_KV',
  '_cf_METADATA',
  // FTS5 index + its shadow tables. Undocumented (so the allow-list already
  // excludes them), but they were the tables actually reachable through the
  // comma-join bypass in #25 — named here so the redundant layer covers them
  // too, and so the error is precise rather than a generic allow-list miss.
  'search_index',
  'search_index_config',
  'search_index_content',
  'search_index_data',
  'search_index_docsize',
  'search_index_idx',
  // Defensive: block any table ending in `_tokens` even if a new provider is
  // added later without updating this list. Handled separately in the scan so
  // the exact-name allow-substring test still passes; kept here for docs.
] as const;

/**
 * Builtins whose whole purpose is to allocate. `randomblob(1e9)` is a gigabyte
 * per row, and the LIMIT wrapper does not save us — it caps rows returned,
 * while the allocation happens on the way to producing them. Nothing in a
 * personal data archive has a legitimate use for either.
 *
 * `load_extension` is refused by D1 at the engine layer today
 * (`D1_ERROR: not authorized`), but the guard should not depend on a platform
 * behaviour it does not control.
 */
const DENY_FUNCTIONS = ['randomblob', 'zeroblob', 'load_extension'] as const;

/**
 * Ceiling on FROM/JOIN targets in a single query. A cross join of n tables is
 * O(rows^n): four references to a 1,800-row table is 10^13 row combinations,
 * which the row LIMIT cannot help with because an aggregate must materialise
 * before the limit applies. Ten is far above any real cross-domain analytics
 * join and far below anything that could hurt.
 */
export const MAX_TABLE_REFS = 10;

/**
 * Ceiling on subquery nesting the ref walker will descend into. The walk
 * recurses into derived tables, so this bounds the recursion; past the limit
 * it fails closed rather than returning a short list the allow-list would
 * then wave through.
 */
export const MAX_SUBQUERY_DEPTH = 25;

/**
 * Keywords that indicate a write, DDL, or side-effecting operation. A match on
 * any of these as a whole word (after comment stripping) rejects the query —
 * this also covers write-bodied CTEs (`WITH x AS (DELETE …)`).
 *
 * `REPLACE` is deliberately absent here: it collides with the very common
 * `replace(str, from, to)` scalar function. The only side-effecting form of
 * REPLACE is a statement (`REPLACE INTO …` / a statement-initial `REPLACE`),
 * which is caught separately (first-keyword check + the dedicated REPLACE-INTO
 * scan below) without breaking legitimate `replace()` calls.
 */
const DENY_TOKENS = [
  'ATTACH',
  'DETACH',
  'PRAGMA',
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'ALTER',
  'CREATE',
  'VACUUM',
  'REINDEX',
  'TRIGGER',
] as const;

/**
 * Strip SQL comments. Handles:
 *   - `-- …` to end of line
 *   - `/* … *\/` block comments, tracking nesting depth so a stray `*\/`
 *     inside a legit nested comment doesn't terminate early
 *   - string literals: comment markers inside `'…'` are NOT comments
 *
 * Replaces each comment with a single space to preserve token boundaries.
 */
function stripComments(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  let inString = false;
  let blockDepth = 0;

  while (i < n) {
    const ch = sql[i];
    const next = i + 1 < n ? sql[i + 1] : '';

    if (blockDepth > 0) {
      // Inside a block comment. Look for nested open or close.
      if (ch === '/' && next === '*') {
        blockDepth++;
        i += 2;
        continue;
      }
      if (ch === '*' && next === '/') {
        blockDepth--;
        i += 2;
        if (blockDepth === 0) out += ' ';
        continue;
      }
      i++;
      continue;
    }

    if (inString) {
      out += ch;
      if (ch === "'") {
        // Escaped quote ('') stays in string.
        if (next === "'") {
          out += next;
          i += 2;
          continue;
        }
        inString = false;
      }
      i++;
      continue;
    }

    // Not in a string or block comment.
    if (ch === "'") {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '-' && next === '-') {
      // Line comment: skip to EOL (do not consume the newline).
      i += 2;
      while (i < n && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      blockDepth = 1;
      i += 2;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * Count top-level statements by scanning for `;` outside string literals.
 * Returns the SQL with a single trailing `;` (and surrounding whitespace)
 * removed, plus whether more than one statement was present.
 *
 * Comments are already stripped before this runs.
 */
function analyzeStatements(sql: string): {
  multiple: boolean;
  trimmed: string;
} {
  let inString = false;
  let sawNonWsAfterSemicolon = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inString) {
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          i++;
          continue;
        }
        inString = false;
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      continue;
    }
    if (ch === ';') {
      // A semicolon that has non-whitespace content after it starts a new
      // statement. A trailing semicolon (only whitespace after) is fine.
      if (sql.slice(i + 1).trim().length > 0) {
        sawNonWsAfterSemicolon = true;
      }
    }
  }

  // Build the trimmed form: drop a single trailing semicolon if the only
  // statement. If there are multiple statements we reject anyway, so the
  // trimmed form is only meaningful in the single-statement case.
  let trimmed = sql.trim();
  if (trimmed.endsWith(';')) trimmed = trimmed.slice(0, -1).trim();

  return { multiple: sawNonWsAfterSemicolon, trimmed };
}

function firstKeyword(sql: string): string | null {
  const m = sql.match(/^[\s(]*([A-Za-z_]+)/);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Replace every single-quoted string literal's contents with a neutral
 * placeholder, so keyword scans don't false-positive on words that appear
 * only inside string data (e.g. `WHERE title = 'how to insert a coin'`).
 * Escaped quotes (`''`) are handled. Comments are already stripped upstream.
 *
 * Used ONLY for the deny-keyword scan. The denied-table scan intentionally
 * runs against the un-blanked SQL (conservative: even a table name inside a
 * string literal is rejected).
 */
function blankStringLiterals(sql: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inString) {
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          i++;
          continue;
        }
        inString = false;
        out += "'";
      }
      // else: drop the character (blanked)
      continue;
    }
    if (ch === "'") {
      inString = true;
      out += "'";
      continue;
    }
    out += ch;
  }
  return out;
}

function hasWord(sql: string, word: string): boolean {
  const re = new RegExp(`(^|[^A-Za-z0-9_])${word}([^A-Za-z0-9_]|$)`, 'i');
  return re.test(sql);
}

/**
 * A single table reference extracted from a FROM/JOIN clause.
 *   - `name` is the lower-cased, unquoted table identifier.
 *   - `ok` is false when the reference is structurally disallowed regardless of
 *     the allow-list (a cross-schema qualifier other than `main`).
 */
interface TableRef {
  name: string;
  ok: boolean;
  raw: string;
  /** Why the ref failed to parse, when the default explanation would mislead. */
  reason?: string;
}

/**
 * Unwrap a quoted identifier: `"x"`, `[x]`, `` `x` ``, or a bare word. Returns
 * the inner name (lower-cased) or null if the token isn't an identifier.
 */
function unquoteIdentifier(token: string): string | null {
  const t = token.trim();
  if (t.length === 0) return null;
  const first = t[0];
  const last = t[t.length - 1];
  if (first === '"' && last === '"') return t.slice(1, -1).toLowerCase();
  if (first === '[' && last === ']') return t.slice(1, -1).toLowerCase();
  if (first === '`' && last === '`') return t.slice(1, -1).toLowerCase();
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) return t.toLowerCase();
  return null;
}

/**
 * Parse one dotted-or-bare table reference token (e.g. `movies`, `main.movies`,
 * `"main"."movies"`, `db.schema.tbl`). Rules:
 *   - bare name → that name
 *   - `main.x` → `x` (the only allowed schema qualifier)
 *   - any other single qualifier, or more than one dot → reject (ok:false),
 *     since we never need cross-schema access and won't reason about it.
 */
function parseTableToken(token: string): TableRef {
  const raw = token.trim();
  // Split on dots that are not inside quotes/brackets/backticks.
  const parts: string[] = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      cur += ch;
      if (
        (quote === '"' && ch === '"') ||
        (quote === '`' && ch === '`') ||
        (quote === '[' && ch === ']')
      ) {
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === '`' || ch === '[') {
      quote = ch === '[' ? '[' : ch;
      cur += ch;
      continue;
    }
    if (ch === '.') {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  parts.push(cur);

  if (parts.length === 1) {
    const name = unquoteIdentifier(parts[0]);
    if (name === null) return { name: '', ok: false, raw };
    return { name, ok: true, raw };
  }
  if (parts.length === 2) {
    const schema = unquoteIdentifier(parts[0]);
    const name = unquoteIdentifier(parts[1]);
    if (name === null) return { name: '', ok: false, raw };
    // Only the default `main` schema is acceptable.
    if (schema === 'main') return { name, ok: true, raw };
    return { name: name ?? '', ok: false, raw };
  }
  // Three-part (or more) qualifiers are always rejected.
  return { name: '', ok: false, raw };
}

/**
 * Extract the CTE names defined by a top-level `WITH [RECURSIVE] a AS (…), b AS
 * (…)` prelude. These are reference targets that are allowed IN ADDITION to the
 * base-table allow-list — their bodies' own FROM/JOIN targets are still
 * validated by the FROM/JOIN scan (which runs over the whole query).
 *
 * Run on comment-stripped, string-blanked SQL.
 */
function extractCteNames(sql: string): Set<string> {
  const names = new Set<string>();
  const m = sql.match(/^[\s(]*WITH\s+(?:RECURSIVE\s+)?/i);
  if (!m) return names;

  // A CTE name is `<ident> [(col, …)] AS (`. Match each such definition; the
  // `AS (` anchor keeps us from picking up table names in the bodies. We match
  // anywhere in the query (a `<ident> AS (SELECT …)` following FROM/WHERE isn't
  // a CTE, but adding it as an allowed reference target is harmless — its body
  // FROM/JOIN targets are still validated separately). The point of this set is
  // only to WHITELIST names that would otherwise fail the FROM/JOIN scan.
  const cteRe =
    /("[^"]+"|\[[^\]]+\]|`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?\s+AS\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = cteRe.exec(sql)) !== null) {
    const name = unquoteIdentifier(match[1]);
    if (name) names.add(name);
  }
  return names;
}

/** A table token: dotted/quoted identifier forms. */
const TABLE_TOKEN_SRC =
  '"[^"]+"(?:\\.[^\\s,()]+)?|\\[[^\\]]+\\](?:\\.[^\\s,()]+)?|`[^`]+`(?:\\.[^\\s,()]+)?|[A-Za-z_][A-Za-z0-9_."[\\]`]*';

/**
 * Words that end a FROM table list. Needed to tell an alias (`FROM movies m`)
 * from the next clause (`FROM movies WHERE …`) — both are a bare word after a
 * table token.
 */
const CLAUSE_KEYWORDS = new Set([
  'where',
  'group',
  'order',
  'limit',
  'having',
  'union',
  'intersect',
  'except',
  'join',
  'inner',
  'left',
  'right',
  'full',
  'cross',
  'natural',
  'on',
  'using',
  'window',
  'offset',
]);

/** Index just past the `(` … `)` group starting at `open`, or -1 if unbalanced. */
function skipBalancedParens(sql: string, open: number): number {
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')' && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * Extract every table a query reads from. Run on comment-stripped,
 * string-blanked SQL so a table-name-looking token inside a string literal is
 * not treated as a table reference. A table-valued function (`FROM foo(...)`)
 * yields `foo`, which then fails the allow-list (e.g. `pragma_table_info` is
 * already blocked upstream).
 *
 * This walks the *whole* comma-separated FROM list, not just the token
 * immediately after the keyword. Matching only the first one meant
 * `SELECT * FROM movies, search_index` never presented `search_index` to the
 * allow-list gate at all — an undocumented table read through a control that
 * promises the opposite (issue #25).
 *
 * It fails CLOSED: a list item that cannot be parsed is returned as
 * `ok: false` so the caller rejects the query. Silently skipping what we
 * cannot read is exactly what turned a parsing limitation into an
 * access-control hole; an unparseable FROM item must never mean "no table
 * here".
 */
function extractTableRefs(sql: string, depth = 0): TableRef[] {
  const refs: TableRef[] = [];

  // Fail closed on absurd nesting rather than risking the stack. Real
  // analytics queries nest a handful of levels; nothing legitimate is
  // anywhere near this.
  if (depth > MAX_SUBQUERY_DEPTH) {
    return [
      {
        name: '',
        ok: false,
        raw: sql.slice(0, 40),
        reason: `Subqueries are nested more than ${MAX_SUBQUERY_DEPTH} deep, past what the guard will read.`,
      },
    ];
  }

  const re = new RegExp(`\\b(FROM|JOIN)\\s+`, 'gi');
  let match: RegExpExecArray | null;

  while ((match = re.exec(sql)) !== null) {
    const isFrom = match[1].toUpperCase() === 'FROM';
    let pos = re.lastIndex;

    // Each iteration consumes one table-list item, then looks for a comma.
    for (;;) {
      const rest = sql.slice(pos);

      if (rest.startsWith('(')) {
        // A derived table is not itself a base table, but it READS base
        // tables, and the outer walk resumes past the closing paren — so
        // nothing else will ever look inside it. Recurse: stepping over the
        // group to find the next list item must not mean leaving its contents
        // unexamined, which is how `FROM (SELECT * FROM secret) x` slipped the
        // allow-list entirely.
        const after = skipBalancedParens(sql, pos);
        if (after === -1) {
          refs.push({ name: '', ok: false, raw: rest.slice(0, 40) });
          break;
        }
        refs.push(
          ...extractTableRefs(sql.slice(pos + 1, after - 1), depth + 1)
        );
        pos = after;
      } else {
        const tok = new RegExp(`^(${TABLE_TOKEN_SRC})`).exec(rest);
        if (!tok || tok[1].length === 0) {
          refs.push({ name: '', ok: false, raw: rest.slice(0, 40) });
          break;
        }
        refs.push(parseTableToken(tok[1]));
        pos += tok[1].length;
      }

      // Optional alias, with or without AS. A clause keyword here is the end
      // of the list, not an alias.
      const alias = /^\s+(?:(?:AS)\s+)?([A-Za-z_][A-Za-z0-9_]*)/i.exec(
        sql.slice(pos)
      );
      if (alias && !CLAUSE_KEYWORDS.has(alias[1].toLowerCase())) {
        pos += alias[0].length;
      }

      // Only FROM takes a comma-separated list; JOIN takes exactly one table.
      const comma = isFrom ? /^\s*,\s*/.exec(sql.slice(pos)) : null;
      if (!comma) break;
      pos += comma[0].length;
    }

    re.lastIndex = pos;
  }

  return refs;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

/**
 * Enforce the LIMIT policy by WRAPPING the validated query in an outer SELECT:
 *
 *   SELECT * FROM (<validated user sql>) AS _rewind_q LIMIT <n>
 *
 * Wrapping (rather than appending `LIMIT` to the user's text) makes the cap
 * genuinely top-level and robust to compound/expression LIMITs: a bare append
 * would break `… LIMIT 5 UNION …` and `… LIMIT 10+10`. ORDER BY inside the
 * user query (including inside each arm of a compound/UNION select) still
 * applies within the subquery; the outer LIMIT only bounds the row count.
 *
 * The row cap is:
 *   - `DEFAULT_LIMIT` (200) when the user gave no top-level LIMIT, or
 *   - min(userTopLevelLimit, MAX_LIMIT) when they did.
 *
 * We detect a trailing top-level LIMIT the same way as before (a well-formed
 * query's outermost LIMIT is the trailing one; subquery/CTE LIMITs are followed
 * by a closing paren and more text). If detection is ambiguous we fall back to
 * the default cap, which is always safe (never larger than MAX_LIMIT).
 */
function enforceLimit(sql: string): string {
  const trimmed = sql.trim();

  // Match a trailing LIMIT clause in either SQLite form:
  //   LIMIT <count> [OFFSET <n>]
  //   LIMIT <offset>, <count>
  const trailingLimit =
    /\bLIMIT\s+(\d+)\s*(?:,\s*(\d+))?\s*(?:OFFSET\s+\d+\s*)?$/i;
  const m = trimmed.match(trailingLimit);

  let cap = DEFAULT_LIMIT;
  if (m) {
    const commaForm = m[2] !== undefined;
    // In comma form `LIMIT a, b`, a=offset, b=count; else group 1 is the count.
    const userLimit = commaForm ? Number(m[2]) : Number(m[1]);
    cap = Math.min(userLimit, MAX_LIMIT);
  }

  return `SELECT * FROM (${trimmed}) AS _rewind_q LIMIT ${cap}`;
}

export function validateReadOnlySql(input: unknown): SqlGuardResult {
  if (typeof input !== 'string') {
    return { ok: false, error: 'SQL must be a string.' };
  }

  const stripped = stripComments(input);

  if (stripped.trim().length === 0) {
    return { ok: false, error: 'Empty query.' };
  }

  // 3. Single statement only.
  const { multiple, trimmed } = analyzeStatements(stripped);
  if (multiple) {
    return {
      ok: false,
      error:
        'Only a single statement is allowed (no `;`-separated statements).',
    };
  }

  // 4. First meaningful keyword must be SELECT or WITH.
  const kw = firstKeyword(trimmed);
  if (kw !== 'SELECT' && kw !== 'WITH') {
    return {
      ok: false,
      error: 'Only read-only SELECT / WITH queries are allowed.',
    };
  }

  // 5. Deny-token scan (covers write-bodied CTEs and DDL/side-effects).
  //    Run against string-blanked SQL so a keyword-like word inside a string
  //    literal (e.g. 'how to insert a coin') doesn't trip the guard.
  const codeOnly = blankStringLiterals(trimmed);
  for (const token of DENY_TOKENS) {
    if (hasWord(codeOnly, token)) {
      return {
        ok: false,
        error: `Disallowed keyword: ${token}. Only read-only queries are permitted.`,
      };
    }
  }

  // 5a. Cost controls. Everything above bounds what a query may READ; these
  //      bound what it may CONSUME. All run on the string-blanked SQL so a
  //      literal like 'recursive descent' is not mistaken for the keyword.
  if (/\bWITH\s+RECURSIVE\b/i.test(codeOnly)) {
    return {
      ok: false,
      error:
        'Recursive CTEs are not allowed: a non-terminating recursion cannot be bounded by the row limit and will exhaust the Worker.',
    };
  }

  for (const fn of DENY_FUNCTIONS) {
    if (hasWord(codeOnly.toLowerCase(), fn)) {
      return {
        ok: false,
        error: `Disallowed function: ${fn}. It has no read-only use and can exhaust memory or load native code.`,
      };
    }
  }

  // 5b. REPLACE is not in DENY_TOKENS (it collides with the `replace()` scalar
  //     function, which is common and legitimate). The only side-effecting
  //     form is a statement: `REPLACE INTO …` or a statement-initial REPLACE.
  //     Statement-initial REPLACE is already blocked by the first-keyword check
  //     above; catch `REPLACE INTO` explicitly here so `replace(a,b,c)` passes.
  if (/\bREPLACE\s+INTO\b/i.test(codeOnly)) {
    return {
      ok: false,
      error:
        'Disallowed keyword: REPLACE. Only read-only queries are permitted.',
    };
  }

  // 6. Denied-table scan (word-boundary, anywhere — conservative). Redundant
  //    belt-and-suspenders now that the allow-list (step 7) is authoritative,
  //    but cheap and it gives a precise error for known-secret tables.
  const lowered = trimmed.toLowerCase();
  for (const table of DENIED_TABLES) {
    if (hasWord(lowered, table)) {
      return {
        ok: false,
        error: `Access to table \`${table}\` is not allowed.`,
      };
    }
  }
  // Also block any *_tokens table not explicitly listed (future providers).
  const tokensMatch = lowered.match(/(^|[^a-z0-9_])([a-z0-9_]*_tokens)\b/);
  if (tokensMatch) {
    return {
      ok: false,
      error: `Access to table \`${tokensMatch[2]}\` is not allowed.`,
    };
  }

  // Block SQLite's table-valued pragma functions. `PRAGMA table_info(x)` is
  // caught by the deny-token scan, but `SELECT * FROM pragma_table_info('x')`
  // is a single word (`pragma_table_info`) that a word-boundary PRAGMA match
  // cannot see — and it is exactly the live schema introspection the curated
  // /v1/schema resource exists to replace.
  const pragmaFnMatch = lowered.match(/(^|[^a-z0-9_])(pragma_[a-z0-9_]+)\b/);
  if (pragmaFnMatch) {
    return {
      ok: false,
      error: `Disallowed identifier: ${pragmaFnMatch[2]}. Schema introspection is not permitted — use GET /v1/schema instead.`,
    };
  }

  // 7. ALLOW-list table gate (load-bearing). Every FROM/JOIN target must be a
  //    documented table or a CTE name defined in this query. Runs on the
  //    string-blanked SQL so a table-name-looking token inside a string literal
  //    isn't treated as a table reference.
  const cteNames = extractCteNames(codeOnly);
  const refs = extractTableRefs(codeOnly);

  // Bound the cross-product before validating individual names: the cost of a
  // cartesian blow-up does not depend on which allowed tables are involved.
  if (refs.length > MAX_TABLE_REFS) {
    return {
      ok: false,
      error: `Too many table references (${refs.length}, max ${MAX_TABLE_REFS}). Large cross joins cannot be bounded by the row limit.`,
    };
  }

  for (const ref of refs) {
    if (!ref.ok) {
      return {
        ok: false,
        error: `Disallowed table reference: \`${ref.raw.trim()}\`. ${
          ref.reason ?? 'Cross-schema/qualified table names are not permitted.'
        }`,
      };
    }
    if (ALLOWED_TABLES.has(ref.name) || cteNames.has(ref.name)) continue;
    return {
      ok: false,
      error: `Access to table \`${ref.name}\` is not allowed. Only documented tables (see GET /v1/schema) may be queried.`,
    };
  }

  // 8. LIMIT enforcement (subquery wrap — robust to UNION/compound queries).
  const finalSql = enforceLimit(trimmed);

  // Base tables only: a CTE name is a label for a subquery, not a data source.
  const tables = [
    ...new Set(
      refs
        .filter((r) => r.ok && !cteNames.has(r.name))
        .map((r) => r.name as string)
    ),
  ];

  return { ok: true, sql: finalSql, tables };
}
