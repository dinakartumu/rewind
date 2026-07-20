# Trakt watch history as a watching-domain source

**Date:** 2026-07-20
**Status:** Approved

## Goal

Make Trakt the source for the watching domain: movie watch history, TV episode
history, and movie ratings. This instance is Trakt-only for watching — Plex and
Letterboxd are not in use, so no cross-source dedup is needed. The existing
Sunday Trakt collection sync (collecting domain) is unchanged.

## Sync architecture

New sync in `src/services/trakt/history-sync.ts`, recorded in `sync_runs` as
`domain: 'watching'`, `syncType: 'trakt_history'`. Runs on the existing
`0 */6 * * *` cron slot and is callable via `POST /v1/admin/sync` for manual
backfill.

Each run:

1. **Movie history** — `/sync/history/movies`, paginated. First run walks the
   full history; later runs pass `start_at` = most recent stored watch. Overlap
   is harmless: every event carries a unique Trakt history ID used for dedup.
2. **Episode history** — `/sync/history/episodes`, same pattern.
3. **Movie ratings** — `/sync/ratings/movies` once per run, building a
   TMDB-ID → rating map applied to matching `watch_history` rows.
4. **Stats + feed** — recompute watch stats and emit `movie_watched` /
   `episode_watched` feed items via `afterSync`, matching Plex/Letterboxd.

Movie events reuse `resolveMovie()` (TMDB lookup + enrichment) and insert into
`watch_history` with `source: 'trakt'`. Trakt does not flag rewatches, so
`rewatch = 1` is set when an earlier watch of the same movie exists. Episode
events ensure a TMDB-enriched `shows` row, then insert into `episodes_watched`.

`TraktClient` gains paginated `getMovieHistory()` / `getEpisodeHistory()` and
`getMovieRatings()`. Pagination reads the `X-Pagination-Page-Count` header,
which requires a small extension to `request()` to expose response headers.

## Schema changes

`watch_history`:

- `source` enum gains `'trakt'` → `['plex', 'letterboxd', 'manual', 'trakt']`
- new nullable `trakt_history_id` with a unique index (dedup key, mirroring
  `letterboxd_guid`)

`plex_shows` → `shows` (generalized, source-neutral):

- `tmdb_id` becomes the primary identity (unique; required for Trakt rows)
- new `trakt_id` column (unique, nullable)
- `plex_rating_key` becomes nullable (was the required unique key)
- all other columns unchanged

`plex_episodes_watched` → `episodes_watched`:

- new `source` column: `'plex' | 'trakt'`, default `'plex'`
- new nullable `trakt_history_id` with a unique index
- existing unique index on `(show_id, season, episode, watched_at)` stays as
  the natural-key backstop

Migration generated with `npm run db:generate`. Database is empty, so there is
no data-migration risk. The rename ripples mechanically (no logic changes)
through `src/db/schema/watching.ts`, `src/services/plex/sync.ts`,
`src/routes/watching.ts`, and the search/feed emitters. Plex sync keeps working
against the new names — it sets `plex_rating_key`, Trakt rows set `trakt_id`.

## Wiring and error handling

- `src/index.ts`: register `syncTraktHistory` on the 6-hour cron; guard each
  sync in that slot on its env vars being present. Add to the admin sync route.
- Collection sync (Sunday, collecting domain) is untouched; both syncs share
  `TraktClient` and OAuth token refresh via `getAccessToken`.
- House error pattern: try/catch marks the `sync_runs` row `failed` and
  rethrows. 429s already handled in `TraktClient` with Retry-After backoff.
  Unresolvable movies/episodes are logged and skipped, never fatal.
  `sync-retry` (max 2 retries on consecutive failures) applies.

## Testing

Follow `trakt/sync.test.ts` conventions:

- Client: pagination, `start_at` handling.
- History sync (mocked client): first-run backfill, incremental sync, dedup on
  `trakt_history_id`, rewatch detection, ratings application, episode → show
  resolution.
- Existing Plex sync tests updated for the table renames and kept green — they
  prove the rename didn't break the Plex path.
