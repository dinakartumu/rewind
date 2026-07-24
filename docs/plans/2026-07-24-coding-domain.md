# Coding Domain Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** New `coding` domain syncing WakaTime durations, RescueTime activities, and GitHub contribution activity (incl. private repos) into D1, with 4 REST endpoints, hourly cron sync, chunked admin backfill, and a daily feed rollup.

**Architecture:** Three sync services (`src/services/wakatime|rescuetime|github/`) each with `client.ts` / `sync.ts` following the `foursquare/` pattern (typed fetch client, `sync_runs` lifecycle, `afterSync` side effects). A `syncCoding()` orchestrator runs all three with per-source isolation on the hourly cron. Detail tables plus materialized daily-summary tables rebuilt each sync. Lean route surface in `src/routes/coding.ts`.

**Tech Stack:** Hono + @hono/zod-openapi, Drizzle ORM on D1, Vitest with @cloudflare/vitest-pool-workers.

**Design doc:** `docs/plans/2026-07-24-coding-domain-design.md` — read it first.

**Conventions that apply to every task** (from CLAUDE.md + observed code):

- Logging prefixes `[SYNC]` / `[ERROR]` / `[INFO]`, never emojis.
- ISO 8601 strings for all timestamps; `user_id` integer default 1 on every table.
- Tests live alongside source as `*.test.ts`; run a single file with `npx vitest run src/path/file.test.ts`.
- Commit after every green task. Prettier/ESLint run via lint-staged on commit.
- ESM imports end in `.js` even for TS files.

---

### Task 1: Schema files + migration + schema-doc entries

The `schema-doc coverage` test (`src/lib/schema-doc.test.ts`) fails if a Drizzle table exists without a `SCHEMA_DOC` entry, so schema, schema-doc, and the test's module import list change together in this task.

**Files:**

- Create: `src/db/schema/wakatime.ts`
- Create: `src/db/schema/rescuetime.ts`
- Create: `src/db/schema/github.ts`
- Modify: `src/lib/schema-doc.ts` (add 8 table entries)
- Modify: `src/lib/schema-doc.test.ts` (import the 3 new modules into `schemaModules`)

**Step 1: Write `src/db/schema/wakatime.ts`**

```ts
import {
  integer,
  real,
  sqliteTable,
  text,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * WakaTime duration slices (Durations API, sliced by entity). One row per
 * contiguous stretch of activity in one file/project. The unique
 * (start_time, project, entity) key makes the today+yesterday re-sync
 * idempotent: overlapping fetches deduplicate on conflict.
 */
export const wakatimeDurations = sqliteTable(
  'wakatime_durations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    startTime: text('start_time').notNull(),
    durationSeconds: real('duration_seconds').notNull(),
    project: text('project'),
    language: text('language'),
    /** File path when sliced by entity; null for non-file slices. */
    entity: text('entity'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_wakatime_durations_slice').on(
      table.startTime,
      table.project,
      table.entity
    ),
    index('idx_wakatime_durations_user_id').on(table.userId),
    index('idx_wakatime_durations_timeline').on(table.userId, table.startTime),
  ]
);

/**
 * Materialized per-day rollup, rebuilt from wakatime_durations on every
 * sync (delete + reinsert per day). Unique per (user, date).
 */
export const wakatimeDailySummaries = sqliteTable(
  'wakatime_daily_summaries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    /** YYYY-MM-DD */
    date: text('date').notNull(),
    totalSeconds: real('total_seconds').notNull(),
    topLanguage: text('top_language'),
    topProject: text('top_project'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_wakatime_daily_user_date').on(table.userId, table.date),
    index('idx_wakatime_daily_date').on(table.date),
  ]
);
```

**Step 2: Write `src/db/schema/rescuetime.ts`**

```ts
import {
  integer,
  sqliteTable,
  text,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * RescueTime 5-minute activity buckets (Analytic Data API, perspective=
 * interval, interval=minute). One row per (timestamp, activity). The
 * unique key makes today+yesterday re-syncs idempotent; late-arriving
 * buckets for a still-open 5-minute window are handled by delete+reinsert
 * of the synced day in sync.ts.
 */
export const rescuetimeActivities = sqliteTable(
  'rescuetime_activities',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    timestamp: text('timestamp').notNull(),
    durationSeconds: integer('duration_seconds').notNull(),
    /** App or site name, e.g. "VS Code", "github.com". */
    activity: text('activity').notNull(),
    category: text('category'),
    /** RescueTime productivity score: -2..+2. */
    productivity: integer('productivity').notNull().default(0),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_rescuetime_activities_slot').on(
      table.timestamp,
      table.activity
    ),
    index('idx_rescuetime_activities_user_id').on(table.userId),
    index('idx_rescuetime_activities_timeline').on(
      table.userId,
      table.timestamp
    ),
  ]
);

/**
 * Materialized per-day rollup rebuilt from rescuetime_activities each sync.
 * productivity_pulse comes from the daily_summary_feed API when available
 * (feed only covers ~2 recent weeks) and stays null for older days.
 */
export const rescuetimeDailySummaries = sqliteTable(
  'rescuetime_daily_summaries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    /** YYYY-MM-DD */
    date: text('date').notNull(),
    totalSeconds: integer('total_seconds').notNull(),
    productivityPulse: integer('productivity_pulse'),
    veryProductiveSeconds: integer('very_productive_seconds')
      .notNull()
      .default(0),
    productiveSeconds: integer('productive_seconds').notNull().default(0),
    neutralSeconds: integer('neutral_seconds').notNull().default(0),
    distractingSeconds: integer('distracting_seconds').notNull().default(0),
    veryDistractingSeconds: integer('very_distracting_seconds')
      .notNull()
      .default(0),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_rescuetime_daily_user_date').on(table.userId, table.date),
    index('idx_rescuetime_daily_date').on(table.date),
  ]
);
```

**Step 3: Write `src/db/schema/github.ts`**

```ts
import {
  integer,
  sqliteTable,
  text,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * Daily contribution counts from the GraphQL contributions calendar
 * (includes private contributions). Upserted on (user, date) — counts for
 * recent days keep changing until the day is over.
 */
export const githubContributionDays = sqliteTable(
  'github_contribution_days',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    /** YYYY-MM-DD */
    date: text('date').notNull(),
    contributionCount: integer('contribution_count').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_github_contrib_user_date').on(table.userId, table.date),
    index('idx_github_contrib_date').on(table.date),
  ]
);

/**
 * Individual commits authored by the user. Incremental source: the
 * authenticated events feed (PushEvents). additions/deletions come from a
 * capped per-commit detail fetch and stay null when skipped.
 */
export const githubCommits = sqliteTable(
  'github_commits',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    sha: text('sha').notNull(),
    /** owner/name */
    repo: text('repo').notNull(),
    message: text('message').notNull(),
    additions: integer('additions'),
    deletions: integer('deletions'),
    committedAt: text('committed_at').notNull(),
    isPrivate: integer('is_private').notNull().default(0),
    url: text('url').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_github_commits_sha').on(table.sha),
    index('idx_github_commits_user_id').on(table.userId),
    index('idx_github_commits_timeline').on(table.userId, table.committedAt),
    index('idx_github_commits_repo').on(table.repo),
  ]
);

/** PRs authored by the user, from the Search API (full history). */
export const githubPullRequests = sqliteTable(
  'github_pull_requests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    repo: text('repo').notNull(),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    /** open | closed | merged */
    state: text('state').notNull(),
    createdAtGithub: text('created_at_github').notNull(),
    mergedAt: text('merged_at'),
    closedAt: text('closed_at'),
    isPrivate: integer('is_private').notNull().default(0),
    url: text('url').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_github_prs_repo_number').on(table.repo, table.number),
    index('idx_github_prs_user_id').on(table.userId),
    index('idx_github_prs_timeline').on(table.userId, table.createdAtGithub),
  ]
);

/** Issues authored by the user, from the Search API (full history). */
export const githubIssues = sqliteTable(
  'github_issues',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    repo: text('repo').notNull(),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    /** open | closed */
    state: text('state').notNull(),
    createdAtGithub: text('created_at_github').notNull(),
    closedAt: text('closed_at'),
    isPrivate: integer('is_private').notNull().default(0),
    url: text('url').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_github_issues_repo_number').on(table.repo, table.number),
    index('idx_github_issues_user_id').on(table.userId),
    index('idx_github_issues_timeline').on(table.userId, table.createdAtGithub),
  ]
);
```

**Step 4: Add the 3 modules to `src/lib/schema-doc.test.ts`**

Find the `import * as watching from '../db/schema/watching.js';` block and the `schemaModules` array; add:

```ts
import * as wakatime from '../db/schema/wakatime.js';
import * as rescuetime from '../db/schema/rescuetime.js';
import * as github from '../db/schema/github.js';
```

and add `wakatime, rescuetime, github` to `schemaModules`.

**Step 5: Run the coverage test to see it fail**

Run: `npx vitest run src/lib/schema-doc.test.ts`
Expected: FAIL — 8 tables missing from SCHEMA_DOC.

**Step 6: Add SCHEMA_DOC entries in `src/lib/schema-doc.ts`**

Add a `// ─── Coding (WakaTime + RescueTime + GitHub) ───` section to the `tables` array with entries for all 8 tables, using the `c()` helper. Follow the existing tone: `purpose` explains what one row is; column notes carry semantics (rating scales, enums, join keys). Key notes to include:

- `wakatime_durations`: "One row per contiguous stretch of coding activity in one file (WakaTime Durations API)"; `start_time` ISO; `duration_seconds` real seconds.
- `wakatime_daily_summaries`: "Materialized per-day coding-time rollup; rebuilt each sync".
- `rescuetime_activities`: `productivity` note "-2 (very distracting) .. +2 (very productive)".
- `rescuetime_daily_summaries`: `productivity_pulse` note "0-100 RescueTime pulse; null for days outside the recent API feed window".
- `github_commits`: `repo` note "owner/name"; `additions`/`deletions` note "null when detail fetch was skipped".
- `github_pull_requests.state` note "open | closed | merged"; `github_issues.state` note "open | closed".
- `github_contribution_days`: "GitHub contribution calendar; includes private contributions".

Also append one entry to the top-level `notes` array:

```
'Coding domain: wakatime_durations/wakatime_daily_summaries (editor time), rescuetime_activities/rescuetime_daily_summaries (screen time; productivity -2..+2), github_commits/github_pull_requests/github_issues/github_contribution_days (authored activity incl. private repos). Cross-source join: wakatime project names often equal github repo short names (m.repo LIKE "%/" || project).',
```

**Step 7: Run the coverage test again**

Run: `npx vitest run src/lib/schema-doc.test.ts`
Expected: PASS.

**Step 8: Generate + apply the migration**

Run: `npm run db:generate` then `npm run db:migrate`
Expected: a new file in `migrations/` creating all 8 tables; local apply succeeds. Inspect the generated SQL — it must contain only CREATE TABLE/CREATE INDEX for the 8 new tables (no destructive statements).

**Step 9: Commit**

```bash
git add src/db/schema/ src/lib/schema-doc.ts src/lib/schema-doc.test.ts migrations/
git commit -m "feat(coding): schema for wakatime, rescuetime, github tables"
```

---

### Task 2: Env plumbing

**Files:**

- Modify: `src/types/env.ts`
- Modify: `CLAUDE.md` (Environment Variables table)
- Modify: `.dev.vars.example` if it exists (check with `ls .dev.vars*`)

**Step 1: Add to `src/types/env.ts`** (after the Foursquare block, matching its optional-with-comment style):

```ts
// Coding domain (WakaTime + RescueTime + GitHub). All optional —
// syncCoding() skips any source whose credentials are unset.
WAKATIME_API_KEY?: string;
RESCUETIME_API_KEY?: string;
GITHUB_TOKEN?: string;
GITHUB_USERNAME?: string;
```

**Step 2: Add 4 rows to the CLAUDE.md env table**, domain "Coding":
`WAKATIME_API_KEY` (WakaTime API key from wakatime.com/settings/api-key), `RESCUETIME_API_KEY` (rescuetime.com/anapi/manage), `GITHUB_TOKEN` (PAT with repo read + read:user for private activity), `GITHUB_USERNAME` (GitHub login for API queries).

**Step 3: Typecheck + commit**

Run: `npx tsc --noEmit` — expected clean.

```bash
git add src/types/env.ts CLAUDE.md
git commit -m "feat(coding): env vars for wakatime, rescuetime, github"
```

---

### Task 3: WakaTime client (TDD)

**Files:**

- Create: `src/services/wakatime/client.ts`
- Test: `src/services/wakatime/client.test.ts`

WakaTime API: base `https://wakatime.com/api/v1`, auth header `Authorization: Basic ${btoa(apiKey)}`. Two endpoints:

- `GET /users/current/durations?date=YYYY-MM-DD&slice_by=entity` → `{ data: [{ time: <epoch float>, duration: <seconds float>, project: string, entity?: string }] }` — sliced by entity, so `language` is always null on duration rows (the API slices by exactly one dimension). Per-language time comes from the Summaries API instead (see Task 4).
- `GET /users/current/summaries?start=D&end=D` → `{ data: [{ grand_total: { total_seconds }, languages: [{ name, total_seconds }], projects: [{ name, total_seconds }], range: { date } }] }`.
- 402 Payment Required = past the free-plan history window (backfill stop signal); surface as a typed `WakatimeHistoryLimitError`.

**Step 1: Write the failing test** — mock `fetch` (see `src/services/foursquare/client.test.ts` for the project's fetch-mocking idiom; reuse it exactly). Cases:

1. `getDurations('2026-07-23')` sends Basic auth header + correct URL, maps items to `{ startTime: ISO string from epoch, durationSeconds, project, language, entity }`.
2. `getSummary('2026-07-23')` returns `{ date, totalSeconds, topLanguage, topProject }` (top = highest total_seconds, null when arrays empty).
3. A 402 response throws `WakatimeHistoryLimitError`.
4. A 500 response throws a generic error containing the status.

**Step 2: Run to verify failure** — `npx vitest run src/services/wakatime/client.test.ts` → FAIL (module not found).

**Step 3: Implement `client.ts`** — class `WakatimeClient` with constructor `(apiKey: string)`, private `request<T>(path)` mirroring FoursquareClient (no bot-UA needed; no 429 retry loop — on 429 throw, hourly cron retries naturally).

**Step 4: Run tests** → PASS.

**Step 5: Commit** — `git add src/services/wakatime/ && git commit -m "feat(coding): wakatime client"`

---

### Task 4: WakaTime sync (TDD)

**Files:**

- Create: `src/services/wakatime/sync.ts`
- Test: `src/services/wakatime/sync.test.ts`

Design:

```ts
export interface WakatimeDaySyncResult {
  synced: number;
  totalSeconds: number;
  topLanguage: string | null;
  topProject: string | null;
}

/** Sync one day: delete that day's duration rows, reinsert from the API,
 *  upsert the daily summary. Delete+reinsert (not onConflictDoNothing)
 *  because today's slices GROW as the day progresses — the same slice
 *  re-fetched later has the same start_time but a larger duration. */
export async function syncWakatimeDay(
  db: Database,
  client: WakatimeClient,
  date: string, // YYYY-MM-DD
  userId?: number
): Promise<WakatimeDaySyncResult>;

/** Entrypoint: sync_runs lifecycle (domain 'coding', syncType 'wakatime'),
 *  syncs yesterday + today (UTC). */
export async function syncWakatime(
  env: Env,
  userId?: number
): Promise<{ synced: number }>;
```

`syncWakatimeDay` deletes `wakatime_durations` rows where `start_time` is within `[dateT00:00:00.000Z, nextDayT00:00:00.000Z)` and `user_id` matches, inserts fetched slices, then upserts `wakatime_daily_summaries` via `.onConflictDoUpdate({ target: [wakatimeDailySummaries.userId, wakatimeDailySummaries.date], set: {...} })` using the summary endpoint's totals. `syncWakatime` mirrors `syncPlaces`'s sync_runs open/complete/fail shape exactly (status `running` → `completed`/`failed`, `metadata` JSON with per-day totals).

**Language data (added after Task 3's slice_by=entity decision):** duration rows never carry language, so per-language time is materialized from the Summaries API:

1. Extend `WakatimeClient.getSummary` to also return `languages: Array<{ name: string; totalSeconds: number }>` (from the summary's `languages[]`); add a client test.
2. New table `wakatime_daily_languages` in `src/db/schema/wakatime.ts`: `id`, `user_id` default 1, `date` (YYYY-MM-DD), `language` text not null, `total_seconds` real not null, `created_at`; unique index on (user_id, date, language), index on date. Generate the migration and rename it `0047_wakatime_daily_languages.sql` (update the journal tag — see the repo's rename convention established in commit 5e33714). Add its SCHEMA_DOC entry (module already imported in schema-doc.test.ts; the coverage test will force this).
3. `syncWakatimeDay` delete+reinserts the day's `wakatime_daily_languages` rows from `summary.languages`.
4. Tests: language rows written and idempotent; day with no languages leaves zero rows.

WakaTime calls pin `timezone=UTC` so API days equal the UTC storage windows; RescueTime deliberately stays account-local (its API has no timezone override).

(Task 12's `GET /languages` reads this table, not `wakatime_durations`.)

**Step 1: Write failing tests** using the workers test env (`setupTestDb()` — copy the setup idiom from `src/services/foursquare/sync.test.ts`), with a stub client object (plain object implementing the two methods). Cases:

1. Syncing a day inserts duration rows + one summary row with correct totals.
2. **Idempotency:** running the same day twice yields the same row counts (no dupes).
3. **Growth:** second run where a slice's duration grew (same startTime, bigger duration) updates the stored value — total row count unchanged, durationSeconds reflects the new value.
4. `syncWakatime` records a completed sync_runs row; a client that throws records a failed row with the error message and rethrows.

**Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS. Also run `npx vitest run src/lib/schema-doc.test.ts` (still green).

**Step 5: Commit** — `git commit -m "feat(coding): wakatime sync with daily summary rebuild"`

---

### Task 5: RescueTime client (TDD)

**Files:**

- Create: `src/services/rescuetime/client.ts`
- Test: `src/services/rescuetime/client.test.ts`

RescueTime API (key as query param, no headers):

- `GET https://www.rescuetime.com/anapi/data?key=K&format=json&perspective=interval&restrict_kind=activity&interval=minute&restrict_begin=D&restrict_end=D` → `{ row_headers: [...], rows: [["2026-07-23T09:00:00", 280, 1, "VS Code", "Editing & IDEs", 2], ...] }` — columns: Date (local, NO timezone suffix), Time Spent (seconds), Number of People, Activity, Category, Productivity.
- `GET https://www.rescuetime.com/anapi/daily_summary_feed?key=K` → array of `{ date: "2026-07-23", productivity_pulse: 71, ... }` (recent ~2 weeks only).

Timestamp note for the implementer: RescueTime returns local times without offset. Store them as-is with `.000Z` appended (documented in schema-doc as "RescueTime-local time stored as ISO") — do NOT attempt timezone conversion; the account timezone is what the user thinks in. Keep this decision in a comment on the client.

**Step 1: Failing tests:** `getActivities(date)` builds the right URL and maps rows to `{ timestamp, durationSeconds, activity, category, productivity }`; `getDailySummaries()` maps to `{ date, productivityPulse }[]`; non-200 throws with status; empty `rows` → `[]`.

**Steps 2-4:** RED → implement `RescuetimeClient` → GREEN.

**Step 5: Commit** — `git commit -m "feat(coding): rescuetime client"`

---

### Task 6: RescueTime sync (TDD)

**Files:**

- Create: `src/services/rescuetime/sync.ts`
- Test: `src/services/rescuetime/sync.test.ts`

Mirror Task 4's shape exactly:

- `syncRescuetimeDay(db, client, date, pulseByDate?, userId?)` — delete the day's `rescuetime_activities` rows, reinsert, then upsert `rescuetime_daily_summaries` computed **from the inserted rows** (sum per productivity level: 2→veryProductive, 1→productive, 0→neutral, -1→distracting, -2→veryDistracting) with `productivityPulse` from the `pulseByDate` map (null when absent).
- `syncRescuetime(env, userId?)` — sync_runs lifecycle (domain `coding`, syncType `rescuetime`); fetches `getDailySummaries()` once into the pulse map, then syncs yesterday + today.

**Tests:** insert+rollup correctness (level sums), idempotency (double run, same counts), pulse applied when the feed has the date and null when not, sync_runs completed/failed rows.

**Commit** — `git commit -m "feat(coding): rescuetime sync with productivity rollups"`

---

### Task 7: GitHub client (TDD)

**Files:**

- Create: `src/services/github/client.ts`
- Test: `src/services/github/client.test.ts`

All requests: base `https://api.github.com`, headers `Authorization: Bearer ${token}`, `Accept: application/vnd.github+json`, `User-Agent: rewind-sync`, `X-GitHub-Api-Version: 2022-11-28`. GraphQL posts to `https://api.github.com/graphql`.

Methods:

```ts
/** Daily contribution counts for a ≤1-year window (GraphQL
 *  contributionsCollection → contributionCalendar). */
getContributionDays(from: string, to: string): Promise<Array<{ date: string; count: number }>>

/** Authenticated user's recent events, one page (30/page, max ~300 back).
 *  GET /users/{username}/events?page=N — returns PushEvents flattened to
 *  commits: { sha, repo, message, committedAt (event created_at), isPrivate
 *  (event.public === false) } plus raw event created_at for cursoring. */
getRecentCommits(page?: number): Promise<Array<{ sha: string; repo: string; message: string; committedAt: string; isPrivate: boolean }>>

/** Commit detail for additions/deletions.
 *  GET /repos/{repo}/commits/{sha} → { additions, deletions } from .stats;
 *  returns null on 404/409 (force-pushed or empty repos) instead of throwing. */
getCommitStats(repo: string, sha: string): Promise<{ additions: number; deletions: number } | null>

/** One page of authored PRs or issues via Search.
 *  GET /search/issues?q=author:{username}+type:{pr|issue}&sort=created&order=desc&per_page=100&page=N
 *  Maps items to { repo (from repository_url), number, title, state
 *  ('merged' when pull_request.merged_at set), createdAt, closedAt,
 *  mergedAt, isPrivate (from item), url (html_url) }.
 *  Returns { items, totalCount } for pagination. */
searchAuthored(type: 'pr' | 'issue', page?: number): Promise<{ items: GithubItem[]; totalCount: number }>
```

**Failing tests:** GraphQL body contains `contributionsCollection` and login/from/to variables; weeks→days flattening; PushEvent flattening (multi-commit push → N commit rows, non-push events ignored); search item mapping incl. merged-state derivation and repo extraction from `repository_url`; 403 with `x-ratelimit-remaining: 0` throws a typed `GithubRateLimitError`; getCommitStats 404 → null.

Fixtures: hand-write minimal JSON inline in the test file (one PushEvent with 2 commits, one WatchEvent to ignore; one search page with a merged PR; one GraphQL calendar with 2 weeks).

**ETag support (sync best practice):** `getRecentCommits(page?, etag?)` sends `If-None-Match: ${etag}` when provided and returns `{ commits, etag: string | null, notModified: boolean }` — GitHub returns an `ETag` header on `/users/{username}/events`, and a 304 response does not count against the rate limit. On 304 return `{ commits: [], etag, notModified: true }`. Only the events endpoint gets this (GraphQL has no conditional requests; Search ETags are not worth caching). Add test cases: etag sent as If-None-Match; 304 → notModified with empty commits; 200 → new etag captured from the response header.

**Commit** — `git commit -m "feat(coding): github client (graphql contributions, events, search)"`

---

### Task 8: GitHub sync (TDD)

**Files:**

- Create: `src/services/github/sync.ts`
- Test: `src/services/github/sync.test.ts`

```ts
const COMMIT_DETAIL_CAP = 25; // per run, keeps hourly runs cheap

/** Incremental: contributions for the last 30 days (upsert on user+date),
 *  events-feed commits (insert onConflictDoNothing on sha; fetch
 *  additions/deletions for at most COMMIT_DETAIL_CAP NEW commits),
 *  first page of PR + issue search (upsert on repo+number via
 *  onConflictDoUpdate — state/mergedAt/closedAt change over time). */
export async function syncGithubIncremental(
  db,
  client,
  username,
  userId?
): Promise<{ synced: number; newCommits: GithubNewCommit[] }>;

/** Entrypoint with sync_runs lifecycle (domain 'coding', syncType 'github'). */
export async function syncGithub(env, userId?): Promise<{ synced: number }>;
```

Commit inserts skip non-distinct push-event commits (rebase re-pushes); other-author commits inside own pushes are deliberately not filtered (documented tradeoff).

**ETag flow in `syncGithubIncremental`:** read the stored events ETag from KV (`env.REWIND_CACHE.get('coding:github:events:etag')`), pass it to `getRecentCommits(1, etag)`. On `notModified`, skip the commits phase entirely (log `[SYNC] GitHub events unchanged (304), skipping commits`). On a 200, store the new etag back (`put`, no TTL). Contributions + PR/issue search still run every time (they have no conditional support). `syncGithubIncremental` therefore takes `env` (or the KV binding) in addition to db/client — pick the cleaner signature and keep the KV interaction stubbed in tests via a minimal `{ get, put }` fake.

**Tests:** contribution upsert (run twice with changed count → updated, not duplicated); commit insert dedup on sha; commit-detail cap honored (stub counts calls); PR upsert updates state open→merged; sync_runs lifecycle; 304 path skips commit processing and preserves the stored etag; 200 path stores the new etag.

**Commit** — `git commit -m "feat(coding): github incremental sync"`

---

### Task 9: syncCoding orchestrator + daily feed rollup

**Files:**

- Create: `src/services/coding/sync.ts`
- Test: `src/services/coding/sync.test.ts`

```ts
/** Runs all configured sources with per-source isolation (one failure
 *  logs [ERROR] + its own failed sync_runs row via the source entrypoint,
 *  and does not block the others). Sources with unset credentials are
 *  skipped silently. After the sources, emits the feed rollup for
 *  YESTERDAY (UTC) — yesterday only, so the feed row is written once per
 *  day with final numbers; insertFeedItems dedups by sourceId on re-runs. */
export async function syncCoding(env: Env, userId = 1): Promise<void>;

/** Builds the rollup title from that day's summary tables + commit count:
 *  "Coded 4h 12m (TypeScript · rewind) · 9 commits across 2 repos".
 *  Segments drop out when a source has no data; returns null when ALL
 *  sources are empty for the day (no feed row for empty days). */
export async function buildDailyRollup(
  db: Database,
  date: string,
  userId: number
): Promise<FeedItem | null>;
```

Feed item shape: `{ domain: 'coding', eventType: 'daily_rollup', occurredAt: `${date}T23:59:59.000Z`, title, sourceId: `coding:day:${date}` }`. Duration formatting: `Xh Ym` (`4h 12m`, `47m` when under an hour). Use `afterSync(db, { domain: 'coding', feedItems: [item] })` — no search items (rollups aren't searchable entities).

**Tests:** rollup title composition for all-sources / wakatime-only / github-only / empty (null); syncCoding skips unconfigured sources (stub env with only one key set — assert others' fetch never called); one source throwing doesn't prevent the others (spy ordering).

Note: for testability, `syncCoding` should accept an optional injected factory or use dynamic imports the same way the existing tests handle it — check how `src/index.ts`-level orchestration is tested elsewhere first (`grep -rn "vi.mock" src/services | head`); follow the established mocking idiom rather than inventing one.

**Commit** — `git commit -m "feat(coding): sync orchestrator with daily feed rollup"`

---

### Task 10: Cron registration

**Files:**

- Modify: `src/index.ts` (hourly `'0 * * * *'` case, after the Foursquare block ~line 193-202)

**Step 1:** Import `syncCoding` at the top with the other sync imports. Add inside the hourly case:

```ts
if (env.WAKATIME_API_KEY || env.RESCUETIME_API_KEY || env.GITHUB_TOKEN) {
  console.log('[SYNC] Coding sync (hourly)');
  ctx.waitUntil(
    syncCoding(env).catch((error) =>
      console.log(
        `[ERROR] Coding sync failed: ${error instanceof Error ? error.message : String(error)}`
      )
    )
  );
}
```

Also update the case's explanatory comment to mention coding. No wrangler.toml change — the hourly trigger already exists.

**Step 2:** `npx tsc --noEmit` clean; run the full index-adjacent tests: `npx vitest run src/index.test.ts` if it exists, else full `npm test`.

**Step 3: Commit** — `git commit -m "feat(coding): hourly cron sync"`

---

### Task 11: Admin sync + backfill endpoints

**Files:**

- Modify: `src/routes/admin-sync.ts`
- Test: extend `src/routes/admin-sync.test.ts`

Two routes, following the `syncPlacesRoute` pattern (`'x-hidden': true`, tags `['Admin']`, `errorResponses(401, 500)`):

**`POST /admin/sync/coding`** — runs `syncCoding(env)`, returns `{ status: 'completed', timestamp }`.

**`POST /admin/sync/coding/backfill`** — body `{ source: 'wakatime' | 'rescuetime' | 'github', cursor?: string }`. One bounded chunk per invocation, response `{ status: 'completed', items_synced, next_cursor: string | null, timestamp }` (`next_cursor: null` = done). Chunk semantics, implemented as `backfillWakatime/Rescuetime/Github(env, cursor)` functions in the respective `sync.ts` files:

- **wakatime:** cursor = next date to fetch, walking backward; chunk = 14 days of `syncWakatimeDay`. Stop (return null cursor) on `WakatimeHistoryLimitError` or 14 consecutive empty days.
- **rescuetime:** cursor = day to end the chunk at (exclusive), walking backward; chunk = 1 month of days. Stop on empty month or API error indicating out-of-range.
- **github:** cursor = JSON string `{"phase":"contributions","year":2026}` → walks years backward via `getContributionDays` until a year returns all-zero/empty; then `{"phase":"prs","page":1}` → search pages until exhausted (GitHub Search caps at 1000 results — when `page * 100 >= min(totalCount, 1000)` the phase is done; log a `[INFO]` line when totalCount exceeded 1000 so truncation is visible); then `{"phase":"issues","page":1}` same; then null. One phase-step per invocation.

**Tests** (in the existing admin-sync.test.ts style, stubbing the service modules the way neighboring tests do): auth required; backfill rejects unknown source with 400; wakatime backfill returns next_cursor 14 days earlier; github backfill advances phases.

**Commit** — `git commit -m "feat(coding): admin sync + chunked backfill endpoints"`

---

### Task 12: Routes (TDD)

**Files:**

- Create: `src/routes/coding.ts`
- Test: `src/routes/coding.test.ts`
- Modify: `src/index.ts` (register `app.route('/v1/coding', coding)` — grep for `'/v1/places'` and mirror it, including any OpenAPI doc registration)

Follow `src/routes/places.ts` structurally (createOpenAPIApp, zod schemas with `.openapi()` examples, `setCache`, `DateFilterQuery`, snake_case response keys). Four endpoints:

1. **`GET /recent`** — cache `short`. Merged timeline of commits + PRs + issues (three selects, merged and sorted desc by their event time, paginated in JS after a per-source `limit` fetch — with `PaginationQuery.merge(DateFilterQuery)`). Response items: `{ type: 'commit' | 'pr' | 'issue', repo, title (message first line for commits), occurred_at, state (null for commits), url }`. Plus a `today` object: `{ coding_seconds, productivity_pulse }` from the two daily-summary tables for the current UTC date (0/null when absent).
2. **`GET /stats`** — cache `medium`, `DateFilterQuery`. `{ coding_seconds, coding_days, commits, prs, issues, screen_time: { total_seconds, very_productive_seconds, productive_seconds, neutral_seconds, distracting_seconds, very_distracting_seconds } }` — sums over the daily-summary tables + counts over the github tables, all date-scoped (commits/PRs/issues scope on their event-time columns).
3. **`GET /languages`** — cache `medium`, `DateFilterQuery` + `limit` (default 10, max 50). Groups `wakatime_daily_languages` by language, `{ data: [{ language, total_seconds, percent }] }`, percent of the range total, rounded to 1 decimal. Note the `date` column is YYYY-MM-DD (not a full ISO timestamp): scope with plain string compares on the first 10 chars of `from`/`to` (`gte(date, from.slice(0,10))` etc.) rather than `buildDateCondition`.
4. **`GET /projects`** — cache `medium`, `DateFilterQuery` + `limit`. Groups durations by project; for each project also count commits where `github_commits.repo` ends with `/{project}` (SQL `like '%/' || project`), `{ data: [{ project, total_seconds, commits }] }`.

**TDD:** write the route tests first (seed tables directly with drizzle inserts in the test, in the style of `src/routes/places.test.ts` — check it exists first; if the domain-route test idiom differs, copy from `src/routes/reading.test.ts`): empty responses, populated shapes, pagination, date filtering, auth-required (401 without bearer), limit clamping. Then implement until green.

**Commit** — `git commit -m "feat(coding): routes (recent, stats, languages, projects)"`

---

### Task 14: MCP server coding tools + UI

**Files:** under `mcp-server/` (separate package — run its own `npm test` / lint from that directory).

Add coding-domain tools to the MCP server following the existing per-domain pattern exactly. Before writing anything, study: one existing domain tool module in `mcp-server/src/tools/` (e.g. the places one), its Zod output schema in `mcp-server/src/tools/schemas/`, how `server.ts` registers tools, how `client.ts` wraps the REST endpoints, how visual/UI output is produced (image blocks, structuredContent, and any MCP Apps view resources — see how the query-result UI resource is allowlisted in the doc check), and how the docs check enumerates tools (a recent commit "allowlist query-result UI resource in doc check" implies a validation step that MUST be updated).

Tools to add (names and shapes following house conventions):

- `get_coding_stats` — wraps `GET /v1/coding/stats` (optional date range args).
- `get_recent_coding_activity` — wraps `GET /v1/coding/recent`; render commits/PRs/issues as markdown links to their GitHub URLs in the text block, structuredContent carries the raw rows.
- `get_coding_languages` — wraps `GET /v1/coding/languages`.

UI: match whatever richness the existing domain tools actually have — if domains expose MCP Apps views or formatted cards, give coding stats the equivalent (e.g. per-language breakdown suited to the stacked/chart views already supported by query_rewind result rendering); do NOT invent a new UI framework. If domain tools are text+structuredContent only, that is the bar. Also update the MCP server's tool docs/reference so the doc check passes, and add tests mirroring the existing tool tests.

**TDD:** write the tool tests first (the package has `mcp-server/src/__tests__/`), then implement. Run the mcp-server test suite + doc check green.

**Commit** — `git commit -m "feat(mcp): coding domain tools"`

---

### Task 15: End-to-end verification

Goal: prove the whole domain works against a real local server, and against real APIs where credentials exist.

**Step 1: Credentials.** Copy `.dev.vars` from the main checkout (`/Users/dinakartumu/Development/rewind/.dev.vars`) into the worktree if present (it is gitignored, so the worktree does not inherit it). For GitHub, if no `GITHUB_TOKEN` is present there, try `gh auth token` + `gh api user --jq .login` to obtain a real token/username. Note which of the three sources have real credentials; do not fail the task over missing WakaTime/RescueTime keys — report them as blocked-on-user instead.

**Step 2: Local stack.** `npm run db:migrate`, then start `npm run dev` (background). Find how a local API key is provisioned (check `src/routes/system.ts` key management + any seed script / docs) and create an admin key.

**Step 3: Exercise the API end to end.** With curl + the admin key: all four `GET /v1/coding/*` endpoints on the empty DB (correct empty shapes); `POST /v1/admin/sync/coding` (sources with creds sync real data; sources without are skipped cleanly); the backfill endpoint for at least one configured source until `next_cursor` advances; re-run the four GET endpoints and verify real rows flow through; `GET /v1/feed?…` (or the feed route's actual path) shows the daily rollup after a backfilled yesterday; `GET /v1/health/sync` shows the coding sync runs. Verify the GitHub 304 path by running sync twice and checking the second run's log line.

**Step 4: Report.** Endpoint-by-endpoint results, which sources ran live vs skipped, any bugs found (fix them TDD-style: failing test → fix → green).

---

### Task 13: Full verification

Runs LAST, after Tasks 14 and 15.

**Step 1:** `npm test` — full suite green (baseline was 111 files / 1274 tests; expect more now).
**Step 2:** `npm run lint` and `npx tsc --noEmit` — clean.
**Step 3:** `npx wrangler dev` smoke test if credentials are present in `.dev.vars`; otherwise verify `GET /v1/coding/stats` returns the empty shape against local D1 (`curl -H "Authorization: Bearer <local key>" http://localhost:8787/v1/coding/stats`). If no local key exists, skip and note it.
**Step 4:** Commit anything outstanding.

---

### Deliberately NOT in this plan (deferred per design)

Streaks/year-in-review endpoints, GitHub reviews/releases/stars/repo metadata, dedicated MCP tools, search-index items for coding, remote migration + secret provisioning + production backfill (post-merge operator steps).

### Post-merge operator checklist (for the human / later session)

1. `npm run db:remote`
2. `npx wrangler secret put WAKATIME_API_KEY` (+ RESCUETIME_API_KEY, GITHUB_TOKEN); add `GITHUB_USERNAME` to `[vars]` in wrangler.toml
3. `npm run deploy`
4. Loop `POST /v1/admin/sync/coding/backfill` per source until `next_cursor: null`
