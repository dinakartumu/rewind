/**
 * Read-only SQL guard for the `POST /v1/query` endpoint.
 *
 * This is the single server-side choke point that keeps a read-scope SQL tool
 * from mutating data or exfiltrating secrets. OAuth already gates the surface
 * to the owner; this gate is defense in depth. It is deliberately conservative:
 * ambiguity resolves to rejection.
 *
 * Pipeline:
 *   1. Strip SQL comments (`-- … EOL` and `/* … *\/`, nested-safe) BEFORE any
 *      analysis, so comment-smuggled keywords/tables can't hide.
 *   2. The value we return (and therefore execute) is the comment-stripped,
 *      whitespace-normalized, LIMIT-enforced form. Executing the normalized
 *      form rather than the raw input means what the guard inspected is exactly
 *      what runs — no divergence between validated text and executed text.
 *   3. Reject > 1 statement (a `;` outside a string literal or comment).
 *   4. First meaningful keyword must be SELECT or WITH.
 *   5. Deny-token scan (word-boundary, case-insensitive) for write / DDL /
 *      side-effecting keywords anywhere in the stripped SQL.
 *   6. Denied-table scan (word-boundary) anywhere in the stripped SQL.
 *   7. LIMIT enforcement: append `LIMIT 200` when absent; cap any explicit
 *      top-level LIMIT count at 500.
 */

export type SqlGuardResult =
  | { ok: true; sql: string }
  | { ok: false; error: string };

/**
 * Tables that must never be reachable from the query endpoint.
 *
 * Derived by reading every `src/db/schema/*.ts` file:
 *   - `api_keys` — hashed API key material.
 *   - `*_tokens` — OAuth access/refresh tokens (Strava, Trakt, Google).
 *   - `revalidation_hooks` — cache-purge secrets.
 *   - `webhook_events` — inbound webhook payloads / provider secrets.
 *   - `sqlite_master` / `sqlite_schema` — live schema introspection is out of
 *     scope; the curated `/v1/schema` resource is the only schema surface.
 *
 * Everything else in the schema (domain data + `geo_cities`, `sync_runs`,
 * `activity_feed`, `images`, `genres`, `directors`, etc.) is allowed.
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
  // Defensive: block any table ending in `_tokens` even if a new provider is
  // added later without updating this list. Handled separately in the scan so
  // the exact-name allow-substring test still passes; kept here for docs.
] as const;

/**
 * Keywords that indicate a write, DDL, or side-effecting operation. A match on
 * any of these as a whole word (after comment stripping) rejects the query —
 * this also covers write-bodied CTEs (`WITH x AS (DELETE …)`).
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
  'REPLACE',
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
 * Enforce the LIMIT policy on a single-statement SELECT/WITH query.
 *   - If there is no top-level LIMIT, append `LIMIT 200`.
 *   - If there is a top-level LIMIT with a count > 500, cap the count at 500.
 *
 * We match the LAST `LIMIT … [OFFSET …]` clause, which for a well-formed query
 * is the top-level one (subquery/CTE LIMITs are followed by a closing paren
 * and more query text, so a trailing LIMIT is the outermost).
 */
function enforceLimit(sql: string): string {
  const trimmed = sql.trim();

  // Match a trailing LIMIT clause in either SQLite form:
  //   LIMIT <count> [OFFSET <n>]
  //   LIMIT <offset>, <count>
  const trailingLimit =
    /\bLIMIT\s+(\d+)\s*(?:,\s*(\d+))?\s*(?:OFFSET\s+(\d+)\s*)?$/i;
  const m = trimmed.match(trailingLimit);

  if (!m) {
    return `${trimmed} LIMIT 200`;
  }

  const commaForm = m[2] !== undefined;
  // In comma form `LIMIT a, b`, a=offset, b=count. In standard form, group 1
  // is the count.
  const count = commaForm ? Number(m[2]) : Number(m[1]);

  if (count <= 500) {
    return trimmed;
  }

  // Rebuild the clause with the count capped at 500.
  const start = trimmed.slice(0, m.index);
  if (commaForm) {
    return `${start.trimEnd()} LIMIT ${m[1]}, 500`;
  }
  const offsetPart = m[3] !== undefined ? ` OFFSET ${m[3]}` : '';
  return `${start.trimEnd()} LIMIT 500${offsetPart}`;
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

  // 6. Denied-table scan (word-boundary, anywhere — conservative).
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

  // 7. LIMIT enforcement.
  const finalSql = enforceLimit(trimmed);

  return { ok: true, sql: finalSql };
}
