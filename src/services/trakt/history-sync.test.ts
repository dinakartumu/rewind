import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { asc, eq, sql } from 'drizzle-orm';
import { createDb } from '../../db/client.js';
import {
  movies,
  directors,
  movieDirectors,
  watchHistory,
} from '../../db/schema/watching.js';
import { setupTestDb } from '../../test-helpers.js';
import {
  syncTraktHistory,
  syncMovieHistory,
  buildMovieFeedItem,
  shouldMarkRewatch,
} from './history-sync.js';
import type { TraktClient, TraktHistoryMovieItem } from './client.js';
import type { TmdbClient } from '../watching/tmdb.js';

describe('syncTraktHistory', () => {
  it('exports the sync entrypoint', () => {
    expect(typeof syncTraktHistory).toBe('function');
  });
});

describe('syncMovieHistory', () => {
  // TMDB must never be reached: movies are pre-seeded by tmdbId with full
  // metadata and directors, so resolveMovie short-circuits in the DB.
  const tmdbStub = {
    searchMovie: async () => {
      throw new Error('TMDB searchMovie should not be called');
    },
    getMovieDetail: async () => {
      throw new Error('TMDB getMovieDetail should not be called');
    },
  } as unknown as TmdbClient;

  function movieEvent(
    id: number,
    watchedAt: string,
    tmdbId: number,
    title: string,
    year: number
  ): TraktHistoryMovieItem {
    return {
      id,
      watched_at: watchedAt,
      action: 'watch',
      type: 'movie',
      movie: {
        title,
        year,
        ids: { trakt: id, slug: 'slug', imdb: 'tt0000000', tmdb: tmdbId },
      },
    };
  }

  // Trakt returns history newest-first: page 1 holds the newest events.
  // Fight Club (tmdb 550) is watched twice, split across the two pages.
  const pages: TraktHistoryMovieItem[][] = [
    [movieEvent(1003, '2026-05-01T21:00:00.000Z', 550, 'Fight Club', 1999)],
    [
      movieEvent(1002, '2025-03-10T19:00:00.000Z', 603, 'The Matrix', 1999),
      movieEvent(1001, '2024-01-05T20:00:00.000Z', 550, 'Fight Club', 1999),
    ],
  ];

  function makeClient(fixture: TraktHistoryMovieItem[][]): TraktClient {
    return {
      getMovieHistory: async (options: { page?: number } = {}) => {
        const page = options.page ?? 1;
        return {
          items: fixture[page - 1] ?? [],
          page,
          pageCount: fixture.length,
        };
      },
    } as unknown as TraktClient;
  }

  beforeAll(async () => {
    await setupTestDb();
    const db = createDb(env.DB);

    // Pre-seed the movies referenced by the fake history so resolveMovie
    // finds them by tmdbId without any TMDB fetch. Full metadata plus a
    // director row also keeps the TMDB backfill path dormant.
    const [fightClub] = await db
      .insert(movies)
      .values({
        title: 'Fight Club',
        year: 1999,
        tmdbId: 550,
        contentRating: 'R',
        tmdbRating: 8.4,
      })
      .returning({ id: movies.id });
    const [matrix] = await db
      .insert(movies)
      .values({
        title: 'The Matrix',
        year: 1999,
        tmdbId: 603,
        contentRating: 'R',
        tmdbRating: 8.2,
      })
      .returning({ id: movies.id });

    const [fincher] = await db
      .insert(directors)
      .values({ name: 'David Fincher' })
      .returning({ id: directors.id });
    const [wachowski] = await db
      .insert(directors)
      .values({ name: 'Lana Wachowski' })
      .returning({ id: directors.id });
    await db.insert(movieDirectors).values([
      { movieId: fightClub.id, directorId: fincher.id },
      { movieId: matrix.id, directorId: wachowski.id },
    ]);
  });

  it('backfills a two-page newest-first history chronologically with correct rewatch flags', async () => {
    const db = createDb(env.DB);
    const result = await syncMovieHistory(db, makeClient(pages), tmdbStub, 1);

    expect(result.synced).toBe(3);

    const rows = await db
      .select({
        traktHistoryId: watchHistory.traktHistoryId,
        watchedAt: watchHistory.watchedAt,
        rewatch: watchHistory.rewatch,
      })
      .from(watchHistory)
      .orderBy(asc(watchHistory.id));

    // Insert order is chronological despite newest-first pages
    expect(rows.map((r) => r.traktHistoryId)).toEqual([1001, 1002, 1003]);
    expect(rows.map((r) => r.watchedAt)).toEqual([
      '2024-01-05T20:00:00.000Z',
      '2025-03-10T19:00:00.000Z',
      '2026-05-01T21:00:00.000Z',
    ]);

    // First Fight Club watch is not a rewatch; the later one is
    expect(rows[0].rewatch).toBe(0);
    expect(rows[1].rewatch).toBe(0);
    expect(rows[2].rewatch).toBe(1);
  });

  it('is idempotent: re-running the same sync inserts nothing new', async () => {
    const db = createDb(env.DB);
    const client = makeClient(pages);

    const firstRun = await syncMovieHistory(db, client, tmdbStub, 1);
    expect(firstRun.synced).toBe(3);

    const secondRun = await syncMovieHistory(db, client, tmdbStub, 1);
    expect(secondRun.synced).toBe(0);
    expect(secondRun.newWatches).toEqual([]);

    const [row] = await db
      .select({ total: sql<number>`count(*)` })
      .from(watchHistory)
      .where(eq(watchHistory.source, 'trakt'));
    expect(row.total).toBe(3);
  });

  it('advances the cursor to the newest event after a completed run', async () => {
    const db = createDb(env.DB);
    await syncMovieHistory(db, makeClient(pages), tmdbStub, 1);

    const [row] = await db
      .select({ max: sql<string | null>`max(${watchHistory.watchedAt})` })
      .from(watchHistory)
      .where(eq(watchHistory.source, 'trakt'));
    expect(row.max).toBe('2026-05-01T21:00:00.000Z');
  });
});

describe('buildMovieFeedItem', () => {
  it('builds a movie_watched feed item with trakt source id', () => {
    const item = buildMovieFeedItem({
      movieId: 42,
      title: 'Heat',
      year: 1995,
      watchedAt: '2026-06-01T20:00:00.000Z',
    });
    expect(item.domain).toBe('watching');
    expect(item.eventType).toBe('movie_watched');
    expect(item.title).toBe('Watched Heat (1995)');
    expect(item.sourceId).toBe('trakt:movie:42:2026-06-01');
    expect(item.occurredAt).toBe('2026-06-01T20:00:00.000Z');
  });

  it('omits year when null', () => {
    const item = buildMovieFeedItem({
      movieId: 7,
      title: 'Unknown Film',
      year: null,
      watchedAt: '2026-06-02T10:00:00.000Z',
    });
    expect(item.title).toBe('Watched Unknown Film');
  });
});

describe('shouldMarkRewatch', () => {
  it('is a rewatch when an earlier watch exists', () => {
    expect(shouldMarkRewatch(1)).toBe(true);
    expect(shouldMarkRewatch(3)).toBe(true);
  });

  it('is not a rewatch for the first watch', () => {
    expect(shouldMarkRewatch(0)).toBe(false);
  });
});
