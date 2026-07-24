# Coding domain: WakaTime + RescueTime + GitHub

**Date:** 2026-07-24
**Status:** Approved

## Goal

A new `coding` domain aggregating three sources — WakaTime (editor time),
RescueTime (screen time/productivity), and GitHub (contribution activity,
including private repos) — into D1, served through a lean route surface plus
the SQL-first MCP `query_rewind` tool. Mirrors how `watching` merges
Plex + Letterboxd + Trakt into one domain.

## Scope decisions (user-confirmed)

- One combined `coding` domain, not two or three.
- GitHub: contribution activity (commits, PRs, issues) including private
  repos. Deferred: reviews, releases, stars, repo-metadata tables.
- WakaTime/RescueTime: **detailed events**, not just daily summaries
  (durations table / 5-minute activity buckets), plus materialized daily
  summary tables for fast stats.
- Backfill: whatever the APIs allow (GitHub full history; WakaTime ~2 weeks
  and RescueTime ~3 months on free tiers; more on paid — code walks backward
  until the API returns empty/forbidden). No export-file import path.
- API surface: lean at launch — sync + 4 core endpoints. Streaks and
  year-in-review deferred until data accumulates.
- Feed: one daily rollup `activity_feed` row per day, upserted (not
  per-commit/per-heartbeat entries).

## Auth

Three new Worker secrets, following the Discogs personal-token pattern
(no OAuth flows, no token tables):

| Secret               | Source                                            |
| -------------------- | ------------------------------------------------- |
| `WAKATIME_API_KEY`   | wakatime.com/settings/api-key                     |
| `RESCUETIME_API_KEY` | rescuetime.com/anapi/manage                       |
| `GITHUB_TOKEN`       | PAT with repo read + read:user (private activity) |
| `GITHUB_USERNAME`    | plain var, for API queries                        |

## Schema

Per-source schema files, matching the `lastfm.ts`/`strava.ts` convention.
All tables: `user_id` (default 1), ISO 8601 date strings, indexes on
`user_id` + primary time column.

`src/db/schema/wakatime.ts`:

- `wakatime_durations` — one row per duration slice from the Durations API:
  `start_time`, `duration_seconds`, `project`, `language`, `entity`
  (file path, nullable), `editor`. Dedup key: (start_time, project, entity).
- `wakatime_daily_summaries` — `date` (unique per user), `total_seconds`,
  `top_language`, `top_project`. Rebuilt from durations each sync.

`src/db/schema/rescuetime.ts`:

- `rescuetime_activities` — 5-minute buckets from the Analytic Data API
  (interval perspective): `timestamp`, `duration_seconds`, `activity`
  (app/site), `category`, `productivity` (-2..+2). Dedup key:
  (timestamp, activity).
- `rescuetime_daily_summaries` — `date` (unique per user), `total_seconds`,
  `productivity_pulse`, seconds per productivity level (very_productive
  .. very_distracting).

`src/db/schema/github.ts`:

- `github_contribution_days` — `date` (unique per user),
  `contribution_count`. From the GraphQL contributions calendar (includes
  private contributions; full history via yearly ranges).
- `github_commits` — `sha` (unique), `repo`, `message`, `additions`,
  `deletions`, `committed_at`, `is_private`, `url`.
- `github_pull_requests` — `repo`, `number` (unique with repo), `title`,
  `state`, `created_at`, `merged_at`, `closed_at`, `url`.
- `github_issues` — `repo`, `number` (unique with repo), `title`, `state`,
  `created_at`, `closed_at`, `url`.

Update the MCP schema resource so all tables are documented for
`query_rewind`.

## Sync

`src/services/wakatime/`, `src/services/rescuetime/`, `src/services/github/`
— each with `client.ts` / `transforms.ts` / `sync.ts` and tests.

- `syncCoding()` orchestrator on an **hourly cron**: runs all three sources
  with per-source isolation — a failure logs `[ERROR]`, records a failed
  `sync_runs` row, and does not block the other sources (same pattern as
  the existing cron blocks in `index.ts`).
- Each run fetches **today + yesterday** and upserts. Idempotent; corrects
  late-arriving data (RescueTime buckets finalize with lag; WakaTime today
  keeps growing). Daily summary tables rebuilt from detail rows in the
  same pass.
- GitHub incremental: recent events feed for commits (push events) +
  Search API for PR/issue creation and state changes.
- Feed: after sync, upsert one `activity_feed` row per synced day —
  "Coded 4h 12m (TypeScript · rewind) · 9 commits across 2 repos".
- `sync_runs` + existing `sync-retry` (max 2 retries) + `/v1/health/sync`
  visibility. Rate limits: GitHub 5,000/hr is ample; WakaTime/RescueTime
  get 429 backoff-and-abort (next hourly run picks up).

## Backfill

Through the existing `POST /v1/admin/sync` admin endpoint with a `backfill`
flag, **chunked by month** to stay inside free-plan Worker CPU limits. Each
invocation processes one chunk and returns the next cursor; the caller
repeats until done.

- GitHub: contributions via yearly GraphQL ranges; PRs/issues via Search
  API (full history); commits best-effort via commit search.
- WakaTime: Durations API day-by-day, walking backward until 402/empty
  (~2 weeks on free).
- RescueTime: Analytic Data API by month until empty (~3 months on free).

## Routes

`src/routes/coding.ts` — Bearer auth, `DateFilterQuery` support, standard
pagination envelope and `{error, status}` errors, short-lived-stats
Cache-Control tier:

- `GET /v1/coding/recent` — merged commits/PRs/issues timeline + today's
  coding seconds and productivity pulse.
- `GET /v1/coding/stats` — range totals: coding seconds, commit/PR/issue
  counts, screen time by productivity level.
- `GET /v1/coding/languages` — top languages by WakaTime seconds.
- `GET /v1/coding/projects` — top projects by time, cross-referenced with
  commit counts where project/repo names match.

## Testing

Vitest per service, mirroring `foursquare/`: client parsing against fixture
JSON, transform correctness, sync idempotency (double-run produces no
duplicates), route tests for the four endpoints.

## Deferred

- Streaks, year-in-review, charts endpoints (wait for data volume).
- GitHub reviews, releases, stars, repo metadata.
- WakaTime branch/dependency dimensions; RescueTime document-level detail.
