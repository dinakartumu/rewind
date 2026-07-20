import { eq, and, sql, count, lt, inArray } from 'drizzle-orm';
import { createDb, type Database } from '../../db/client.js';
import { syncRuns } from '../../db/schema/system.js';
import { watchHistory } from '../../db/schema/watching.js';
import { TraktClient } from './client.js';
import { getAccessToken } from './auth.js';
import { TmdbClient } from '../watching/tmdb.js';
import { resolveMovie } from '../watching/resolve-movie.js';
import { computeWatchStats } from '../plex/sync.js';
import { afterSync } from '../../lib/after-sync.js';
import type { FeedItem, SearchItem } from '../../lib/after-sync.js';
import type { Env } from '../../types/env.js';

const PAGE_LIMIT = 100;

export interface SyncedWatch {
  movieId: number;
  title: string;
  year: number | null;
  watchedAt: string;
}

export function buildMovieFeedItem(watch: SyncedWatch): FeedItem {
  return {
    domain: 'watching',
    eventType: 'movie_watched',
    occurredAt: watch.watchedAt,
    title: `Watched ${watch.title}${watch.year ? ` (${watch.year})` : ''}`,
    sourceId: `trakt:movie:${watch.movieId}:${watch.watchedAt.substring(0, 10)}`,
  };
}

export function shouldMarkRewatch(earlierWatchCount: number): boolean {
  return earlierWatchCount > 0;
}

/**
 * Most recent Trakt-sourced movie watch, used as the incremental cursor.
 * Returns undefined on first run (full history walk).
 *
 * Known limitation: a watch back-dated in Trakt to before this cursor after
 * the cursor has already advanced will never fall inside an incremental
 * window and is silently missed. The escape hatch is a cursor-less full
 * re-walk, which is idempotent thanks to traktHistoryId dedup — an admin
 * full-resync option (`full=true`) arrives in Task 7.
 */
async function movieCursor(
  db: Database,
  userId: number
): Promise<string | undefined> {
  const [row] = await db
    .select({ max: sql<string | null>`max(${watchHistory.watchedAt})` })
    .from(watchHistory)
    .where(
      and(eq(watchHistory.userId, userId), eq(watchHistory.source, 'trakt'))
    );
  return row?.max ?? undefined;
}

export async function syncMovieHistory(
  db: Database,
  client: TraktClient,
  tmdbClient: TmdbClient,
  userId: number
): Promise<{ synced: number; skipped: number; newWatches: SyncedWatch[] }> {
  const startAt = await movieCursor(db, userId);
  console.log(
    `[SYNC] Trakt movie history ${startAt ? `since ${startAt}` : 'full walk'}`
  );

  let synced = 0;
  let skipped = 0;
  const newWatches: SyncedWatch[] = [];

  // Trakt returns history newest-first. Walk pages from last to first, and
  // items within each page in reverse, so inserts happen chronologically:
  // the earlier-watch count for the rewatch flag is correct at insert time,
  // and the cursor (max watchedAt of trakt rows) only ever covers completed
  // work, so an interrupted backfill resumes without gaps. The page-1 fetch
  // below only discovers pageCount; the loop refetches page 1 when it gets
  // there, and traktHistoryId dedup keeps the reprocessing idempotent.
  const first = await client.getMovieHistory({
    startAt,
    page: 1,
    limit: PAGE_LIMIT,
  });

  for (let page = first.pageCount; page >= 1; page--) {
    const result = await client.getMovieHistory({
      startAt,
      page,
      limit: PAGE_LIMIT,
    });

    // Oldest first within the page
    const items = [...result.items].reverse();

    // Batched dedup on Trakt's per-event history ID
    const pageIds = items.map((item) => item.id);
    const existingIds = new Set<number>();
    if (pageIds.length > 0) {
      const existingRows = await db
        .select({ traktHistoryId: watchHistory.traktHistoryId })
        .from(watchHistory)
        .where(inArray(watchHistory.traktHistoryId, pageIds));
      for (const row of existingRows) {
        if (row.traktHistoryId !== null) existingIds.add(row.traktHistoryId);
      }
    }

    for (const item of items) {
      if (existingIds.has(item.id)) {
        skipped++;
        continue;
      }

      const tmdbId = item.movie.ids.tmdb;
      if (!tmdbId) {
        console.log(`[INFO] Skipping ${item.movie.title} - no TMDb ID`);
        skipped++;
        continue;
      }

      const resolved = await resolveMovie(db, tmdbClient, {
        tmdbId,
        title: item.movie.title,
        year: item.movie.year,
      });
      if (!resolved) {
        skipped++;
        continue;
      }

      const [earlier] = await db
        .select({ count: count() })
        .from(watchHistory)
        .where(
          and(
            eq(watchHistory.userId, userId),
            eq(watchHistory.movieId, resolved.id),
            lt(watchHistory.watchedAt, item.watched_at)
          )
        );

      await db.insert(watchHistory).values({
        userId,
        movieId: resolved.id,
        watchedAt: item.watched_at,
        source: 'trakt',
        traktHistoryId: item.id,
        rewatch: shouldMarkRewatch(earlier?.count ?? 0) ? 1 : 0,
      });

      newWatches.push({
        movieId: resolved.id,
        title: item.movie.title,
        year: item.movie.year ?? null,
        watchedAt: item.watched_at,
      });
      synced++;
    }
  }

  return { synced, skipped, newWatches };
}

/**
 * Apply Trakt movie ratings to trakt-sourced watch history rows.
 * Implemented in Task 6 — placeholder keeps the orchestrator stable.
 */
async function applyMovieRatings(
  _db: Database,
  _client: TraktClient,
  _userId: number
): Promise<number> {
  return 0;
}

/**
 * Full Trakt watch-history sync: movies, episodes, ratings, stats, feed.
 */
export async function syncTraktHistory(
  env: Env,
  userId: number = 1
): Promise<{ moviesSynced: number; episodesSynced: number }> {
  const db = createDb(env.DB);
  const startedAt = new Date().toISOString();

  const [run] = await db
    .insert(syncRuns)
    .values({
      userId,
      domain: 'watching',
      syncType: 'trakt_history',
      status: 'running',
      startedAt,
      itemsSynced: 0,
    })
    .returning({ id: syncRuns.id });

  try {
    const accessToken = await getAccessToken(env, db);
    const client = new TraktClient(accessToken, env.TRAKT_CLIENT_ID);
    const tmdbClient = new TmdbClient(env.TMDB_API_KEY);

    const movies = await syncMovieHistory(db, client, tmdbClient, userId);
    const ratingsApplied = await applyMovieRatings(db, client, userId);

    await computeWatchStats(db);

    await db
      .update(syncRuns)
      .set({
        status: 'completed',
        completedAt: new Date().toISOString(),
        itemsSynced: movies.synced,
        metadata: JSON.stringify({
          moviesSynced: movies.synced,
          moviesSkipped: movies.skipped,
          ratingsApplied,
        }),
      })
      .where(eq(syncRuns.id, run.id));

    const feedItems: FeedItem[] = movies.newWatches.map(buildMovieFeedItem);
    const searchItems: SearchItem[] = movies.newWatches.map((m) => ({
      domain: 'watching',
      entityType: 'movie',
      entityId: String(m.movieId),
      title: m.title,
      subtitle: m.year ? String(m.year) : undefined,
    }));
    await afterSync(db, { domain: 'watching', feedItems, searchItems });

    console.log(
      `[SYNC] Trakt history sync complete: ${movies.synced} movies, ${movies.skipped} skipped`
    );
    return { moviesSynced: movies.synced, episodesSynced: 0 };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.log(`[ERROR] Trakt history sync failed: ${errorMsg}`);
    await db
      .update(syncRuns)
      .set({
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: errorMsg,
      })
      .where(eq(syncRuns.id, run.id));
    throw err;
  }
}
