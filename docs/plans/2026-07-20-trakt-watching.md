# Trakt Watch History Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Sync Trakt movie + episode watch history and movie ratings into the watching domain.

**Architecture:** New `syncTraktHistory()` service mirrors the Letterboxd sync pattern: paginated fetch from Trakt, `resolveMovie()`/TMDB enrichment, dedup on Trakt history IDs, `afterSync` feed emission. The Plex-specific show tables are generalized (`plex_shows` → `shows`, `plex_episodes_watched` → `episodes_watched`) with TMDB ID as primary identity. Design doc: `docs/plans/2026-07-20-trakt-watching-design.md`.

**Tech Stack:** Hono on Cloudflare Workers, D1 + Drizzle ORM, Vitest (logic-level tests with mocked `fetch` — see `src/services/trakt/client.test.ts` for the house pattern).

**Context you need:**

- `src/services/trakt/client.ts` — existing `TraktClient` (collection endpoints only). Its private `request()` returns parsed JSON and never exposes headers.
- `src/services/trakt/auth.ts` — `getAccessToken(env, db)` handles OAuth token refresh. Reuse as-is.
- `src/services/trakt/sync.ts` — existing collection sync (collecting domain). DO NOT modify.
- `src/services/letterboxd/sync.ts` — the sync shape to imitate (sync_runs lifecycle, afterSync).
- `src/services/watching/resolve-movie.ts` — `resolveMovie(db, tmdbClient, {tmdbId, title, year})` returns `{id} | null`.
- `src/services/watching/tmdb.ts` — `TmdbClient.getTvShowDetail(tmdbId)` returns show metadata.
- Trakt API docs: `GET /sync/history/movies` and `/sync/history/episodes` return paginated arrays; response headers `X-Pagination-Page` and `X-Pagination-Page-Count` drive pagination; `start_at` (ISO 8601) filters. `GET /sync/ratings/movies` returns `[{rated_at, rating (1-10), type, movie: {title, year, ids}}]`.

Conventions: no emojis in logs (`[SYNC]`/`[ERROR]`/`[INFO]` prefixes), ISO 8601 dates, `user_id` on all tables. Commit after every task.

---

### Task 1: Schema — generalize watching tables

**Files:**

- Modify: `src/db/schema/watching.ts`
- Modify (mechanical identifier renames): `src/services/plex/sync.ts`, `src/services/plex/webhook.ts`, `src/routes/watching.ts`, `src/services/images/sync-images.ts`

**Step 1: Edit `src/db/schema/watching.ts`**

Three changes:

1. In `watchHistory`: extend the source enum and add the Trakt dedup column + index.

```ts
    source: text('source', { enum: ['plex', 'letterboxd', 'manual', 'trakt'] })
      .notNull()
      .default('plex'),
```

Add after `letterboxdGuid`:

```ts
    traktHistoryId: integer('trakt_history_id'),
```

Add to the index array:

```ts
    uniqueIndex('idx_watch_history_trakt_history_id').on(table.traktHistoryId),
```

2. Rename `plexShows` → `shows` (table name `'shows'`). `plexRatingKey` stays unique but is already nullable (no `.notNull()`) — remove the `.notNull()` it currently has. `tmdbId` becomes a unique index. Add `traktId`:

```ts
export const shows = sqliteTable(
  'shows',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    plexRatingKey: text('plex_rating_key').unique(),
    traktId: integer('trakt_id').unique(),
    title: text('title').notNull(),
    year: integer('year'),
    tmdbId: integer('tmdb_id'),
    summary: text('summary'),
    posterPath: text('poster_path'),
    backdropPath: text('backdrop_path'),
    contentRating: text('content_rating'),
    tmdbRating: real('tmdb_rating'),
    imageKey: text('image_key'),
    totalSeasons: integer('total_seasons'),
    totalEpisodes: integer('total_episodes'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_shows_user_id').on(table.userId),
    uniqueIndex('idx_shows_tmdb_id').on(table.tmdbId),
  ]
);
```

3. Rename `plexEpisodesWatched` → `episodesWatched` (table name `'episodes_watched'`), adding `source` and `traktHistoryId`:

```ts
export const episodesWatched = sqliteTable(
  'episodes_watched',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    showId: integer('show_id')
      .notNull()
      .references(() => shows.id),
    seasonNumber: integer('season_number').notNull(),
    episodeNumber: integer('episode_number').notNull(),
    title: text('title'),
    watchedAt: text('watched_at').notNull(),
    source: text('source', { enum: ['plex', 'trakt'] })
      .notNull()
      .default('plex'),
    traktHistoryId: integer('trakt_history_id'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_episodes_watched_show_id').on(table.showId),
    index('idx_episodes_watched_watched_at').on(table.watchedAt),
    index('idx_episodes_watched_user_id').on(table.userId),
    index('idx_episodes_timeline').on(table.userId, table.watchedAt),
    uniqueIndex('idx_episodes_unique').on(
      table.showId,
      table.seasonNumber,
      table.episodeNumber,
      table.watchedAt
    ),
    uniqueIndex('idx_episodes_trakt_history_id').on(table.traktHistoryId),
  ]
);
```

**Step 2: Rename identifiers in the four consumer files**

Every occurrence of `plexShows` → `shows` and `plexEpisodesWatched` → `episodesWatched` in:

- `src/services/plex/sync.ts` (imports at line 7-8, usages in `syncShows` and `computeWatchStats`)
- `src/services/plex/webhook.ts` (imports at lines 10-11, usages ~lines 340-427)
- `src/routes/watching.ts` (imports at lines 16-17, usages ~lines 1815-2540)
- `src/services/images/sync-images.ts` (import at line 10, usages ~lines 260-265)

Safe to do with sed from the worktree root, then eyeball the diff:

```bash
sed -i '' 's/plexEpisodesWatched/episodesWatched/g; s/plexShows/shows/g' \
  src/services/plex/sync.ts src/services/plex/webhook.ts \
  src/routes/watching.ts src/services/images/sync-images.ts
```

CAUTION: check the diff for accidental captures (e.g. a local variable already named `shows` in any of these files would now collide — if `git diff` shows a pre-existing `shows` identifier in the same scope, rename the local variable, not the table import).

**Step 3: Verify types compile**

Run: `npm run type-check` (if that script is missing, `npx tsc --noEmit`)
Expected: PASS with zero errors. Any error here is a missed rename.

**Step 4: Run the full test suite**

Run: `npm test`
Expected: all 1031 tests still pass (renames are behavior-neutral).

**Step 5: Commit**

```bash
git add -A src/
git commit -m "refactor(watching): generalize show tables for multi-source support"
```

---

### Task 2: Migration

**Files:**

- Create: `migrations/<generated>.sql` (via drizzle-kit)

**Step 1: Generate**

Run: `npm run db:generate`

drizzle-kit may prompt interactively about whether `shows` is a rename of `plex_shows` or a new table. Answer **rename** for both tables (and for any column prompts). If interactive prompts can't be answered in your environment, delete the partial output and instead run `npx drizzle-kit generate --custom --name=trakt_watching` and paste this SQL into the generated file:

```sql
ALTER TABLE `plex_shows` RENAME TO `shows`;--> statement-breakpoint
ALTER TABLE `plex_episodes_watched` RENAME TO `episodes_watched`;--> statement-breakpoint
ALTER TABLE `shows` ADD `trakt_id` integer;--> statement-breakpoint
ALTER TABLE `episodes_watched` ADD `source` text DEFAULT 'plex' NOT NULL;--> statement-breakpoint
ALTER TABLE `episodes_watched` ADD `trakt_history_id` integer;--> statement-breakpoint
ALTER TABLE `watch_history` ADD `trakt_history_id` integer;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_plex_shows_user_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_plex_shows_tmdb_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_plex_episodes_watched_show_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_plex_episodes_watched_watched_at`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_plex_episodes_watched_user_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_plex_episodes_timeline`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_plex_episodes_unique`;--> statement-breakpoint
CREATE INDEX `idx_shows_user_id` ON `shows` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_shows_tmdb_id` ON `shows` (`tmdb_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `shows_trakt_id_unique` ON `shows` (`trakt_id`);--> statement-breakpoint
CREATE INDEX `idx_episodes_watched_show_id` ON `episodes_watched` (`show_id`);--> statement-breakpoint
CREATE INDEX `idx_episodes_watched_watched_at` ON `episodes_watched` (`watched_at`);--> statement-breakpoint
CREATE INDEX `idx_episodes_watched_user_id` ON `episodes_watched` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_episodes_timeline` ON `episodes_watched` (`user_id`,`watched_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_episodes_unique` ON `episodes_watched` (`show_id`,`season_number`,`episode_number`,`watched_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_episodes_trakt_history_id` ON `episodes_watched` (`trakt_history_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_watch_history_trakt_history_id` ON `watch_history` (`trakt_history_id`);
```

**Step 2: Apply locally and verify**

Run: `npm run db:migrate`
Expected: applies cleanly.

Run: `npm test`
Expected: all pass.

**Step 3: Commit**

```bash
git add migrations/ src/db/
git commit -m "feat(watching): migrate show tables to source-neutral schema"
```

---

### Task 3: TraktClient — history and ratings endpoints

**Files:**

- Modify: `src/services/trakt/client.ts`
- Test: `src/services/trakt/client.test.ts`

**Step 1: Write the failing tests**

Append to the existing `describe('TraktClient')` block in `client.test.ts` (reuse its `client`/`beforeEach` setup):

```ts
describe('history endpoints', () => {
  const historyHeaders = {
    'X-Pagination-Page': '1',
    'X-Pagination-Page-Count': '3',
  };

  it('getMovieHistory requests /sync/history/movies with pagination params', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('[]', { headers: historyHeaders }));

    const result = await client.getMovieHistory({ page: 2, limit: 100 });

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain('/sync/history/movies');
    expect(url).toContain('page=2');
    expect(url).toContain('limit=100');
    expect(result.pageCount).toBe(3);
    expect(result.items).toEqual([]);
  });

  it('getMovieHistory passes start_at when provided', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('[]', { headers: historyHeaders }));

    await client.getMovieHistory({
      startAt: '2026-01-01T00:00:00.000Z',
      page: 1,
      limit: 100,
    });

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain('start_at=2026-01-01T00%3A00%3A00.000Z');
  });

  it('getMovieHistory defaults pageCount to 1 when header missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]'));
    const result = await client.getMovieHistory({ page: 1, limit: 100 });
    expect(result.pageCount).toBe(1);
  });

  it('getEpisodeHistory requests /sync/history/episodes and parses items', async () => {
    const item = {
      id: 9001,
      watched_at: '2026-05-01T20:00:00.000Z',
      action: 'watch',
      type: 'episode',
      episode: {
        season: 1,
        number: 3,
        title: 'The Pilot Ends',
        ids: { trakt: 111, tmdb: 222 },
      },
      show: {
        title: 'Severance',
        year: 2022,
        ids: { trakt: 333, slug: 'severance', imdb: 'tt11280740', tmdb: 95396 },
      },
    };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify([item]), { headers: historyHeaders })
      );

    const result = await client.getEpisodeHistory({ page: 1, limit: 100 });

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain('/sync/history/episodes');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].show.ids.tmdb).toBe(95396);
    expect(result.items[0].episode.season).toBe(1);
  });

  it('getMovieRatings requests /sync/ratings/movies', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('[]'));

    await client.getMovieRatings();

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain('/sync/ratings/movies');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/trakt/client.test.ts`
Expected: FAIL — `getMovieHistory is not a function`.

**Step 3: Implement in `client.ts`**

Add interfaces after the existing ones:

```ts
export interface TraktHistoryMovieItem {
  id: number;
  watched_at: string;
  action: string;
  type: 'movie';
  movie: {
    title: string;
    year: number;
    ids: TraktMovieIds;
  };
}

export interface TraktHistoryEpisodeItem {
  id: number;
  watched_at: string;
  action: string;
  type: 'episode';
  episode: {
    season: number;
    number: number;
    title: string | null;
    ids: { trakt: number; tmdb: number | null };
  };
  show: {
    title: string;
    year: number | null;
    ids: TraktMovieIds;
  };
}

export interface TraktRatingItem {
  rated_at: string;
  rating: number;
  type: 'movie';
  movie: {
    title: string;
    year: number;
    ids: TraktMovieIds;
  };
}

export interface TraktHistoryPage<T> {
  items: T[];
  page: number;
  pageCount: number;
}

export interface TraktHistoryOptions {
  startAt?: string;
  page?: number;
  limit?: number;
}
```

Refactor `request` to delegate to a headers-aware variant (keep the existing 429 retry and error handling — move them into `requestWithHeaders`, and have `request` return just `.data`):

```ts
  private async requestWithHeaders<T>(
    path: string,
    options?: RequestInit
  ): Promise<{ data: T; headers: Headers }> {
    const url = `${BASE_URL}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Rewind/1.0 (personal data aggregator)',
        'trakt-api-version': API_VERSION,
        'trakt-api-key': this.clientId,
        Authorization: `Bearer ${this.accessToken}`,
        ...options?.headers,
      },
    });

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 10000;
      console.log(
        `[INFO] Trakt rate limited, waiting ${waitMs}ms before retry`
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return this.requestWithHeaders<T>(path, options);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `[ERROR] Trakt API error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    const data = (await response.json()) as T;
    return { data, headers: response.headers };
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const { data } = await this.requestWithHeaders<T>(path, options);
    return data;
  }
```

Add a shared history helper and the three public methods:

```ts
  private async getHistoryPage<T>(
    kind: 'movies' | 'episodes',
    options: TraktHistoryOptions
  ): Promise<TraktHistoryPage<T>> {
    const params = new URLSearchParams({
      page: String(options.page ?? 1),
      limit: String(options.limit ?? 100),
    });
    if (options.startAt) {
      params.set('start_at', options.startAt);
    }
    const { data, headers } = await this.requestWithHeaders<T[]>(
      `/sync/history/${kind}?${params.toString()}`
    );
    return {
      items: data,
      page: parseInt(headers.get('X-Pagination-Page') ?? '1', 10),
      pageCount: parseInt(headers.get('X-Pagination-Page-Count') ?? '1', 10),
    };
  }

  /**
   * Get a page of the user's movie watch history, newest first.
   */
  async getMovieHistory(
    options: TraktHistoryOptions = {}
  ): Promise<TraktHistoryPage<TraktHistoryMovieItem>> {
    return this.getHistoryPage<TraktHistoryMovieItem>('movies', options);
  }

  /**
   * Get a page of the user's episode watch history, newest first.
   */
  async getEpisodeHistory(
    options: TraktHistoryOptions = {}
  ): Promise<TraktHistoryPage<TraktHistoryEpisodeItem>> {
    return this.getHistoryPage<TraktHistoryEpisodeItem>('episodes', options);
  }

  /**
   * Get all of the user's movie ratings.
   */
  async getMovieRatings(): Promise<TraktRatingItem[]> {
    return this.request<TraktRatingItem[]>('/sync/ratings/movies');
  }
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/trakt/client.test.ts`
Expected: PASS (existing collection tests must also still pass — the `request` refactor is behavior-preserving).

**Step 5: Commit**

```bash
git add src/services/trakt/client.ts src/services/trakt/client.test.ts
git commit -m "feat(trakt): add history and ratings client endpoints"
```

---

### Task 4: History sync — movies

**Files:**

- Create: `src/services/trakt/history-sync.ts`
- Test: `src/services/trakt/history-sync.test.ts`

The sync follows `letterboxd/sync.ts` structurally. Write it movies-first; episodes and ratings extend it in Tasks 5-6.

**Step 1: Write the failing tests**

Create `src/services/trakt/history-sync.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  syncTraktHistory,
  buildMovieFeedItem,
  shouldMarkRewatch,
} from './history-sync.js';

describe('syncTraktHistory', () => {
  it('exports the sync entrypoint', () => {
    expect(typeof syncTraktHistory).toBe('function');
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
```

**Step 2: Run to verify failure**

Run: `npx vitest run src/services/trakt/history-sync.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement `src/services/trakt/history-sync.ts`**

```ts
import { eq, and, sql, count, lt } from 'drizzle-orm';
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

async function syncMovieHistory(
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

  let page = 1;
  let pageCount = 1;
  do {
    const result = await client.getMovieHistory({
      startAt,
      page,
      limit: PAGE_LIMIT,
    });
    pageCount = result.pageCount;

    for (const item of result.items) {
      const tmdbId = item.movie.ids.tmdb;
      if (!tmdbId) {
        console.log(`[INFO] Skipping ${item.movie.title} - no TMDb ID`);
        skipped++;
        continue;
      }

      // Dedup on Trakt's per-event history ID
      const [existing] = await db
        .select({ id: watchHistory.id })
        .from(watchHistory)
        .where(eq(watchHistory.traktHistoryId, item.id))
        .limit(1);
      if (existing) {
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

    page++;
  } while (page <= pageCount);

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
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/trakt/history-sync.test.ts`
Expected: PASS.

Run: `npm run type-check` (or `npx tsc --noEmit`)
Expected: PASS.

**Step 5: Commit**

```bash
git add src/services/trakt/history-sync.ts src/services/trakt/history-sync.test.ts
git commit -m "feat(trakt): sync movie watch history into watching domain"
```

#### Amendment (post-Task-4 review)

Code review of the Task 4 implementation found two critical defects in the
original page-1-to-pageCount walk, fixed in
`fix(trakt): walk history chronologically for correct rewatch flags and resumable backfill`:

1. **Rewatch flags** — Trakt's `/sync/history/movies` returns events
   newest-first. Inserting in fetch order means the per-item earlier-watch
   count (`lt(watchedAt, item.watched_at)`) runs before the earlier watches
   exist in the DB, so a full backfill marks every row `rewatch=0`
   permanently (same bug when two watches of one movie land in a single
   incremental window).
2. **Resumability** — the incremental cursor is `max(watchedAt)` of
   trakt-sourced rows. A newest-first walk that gets interrupted leaves only
   the newest events inserted, so the next run's `start_at` silently skips
   everything older than the crash point.

**Required pattern (now implemented):** walk chronologically. Fetch page 1
(`limit 100`) only to learn `pageCount`, then iterate pages from `pageCount`
down to 1, processing items within each page in reverse (oldest first).
Insert order becomes chronological, so the earlier-watch count is correct at
insert time, and the cursor only ever covers completed work — an interrupted
backfill naturally resumes. Page 1 is simply refetched when the loop reaches
it; `traktHistoryId` dedup makes the reprocessing idempotent.

Also from the review:

- Dedup is batched per page: one `inArray(watchHistory.traktHistoryId, pageIds)`
  select per page instead of one select per item.
- The earlier-count query is additionally scoped by
  `eq(watchHistory.userId, userId)`.
- `movieCursor()` documents the retroactive-logging limitation: a watch
  back-dated in Trakt to before the cursor after it advanced is missed by
  incremental runs; a cursor-less full re-walk (idempotent via
  `traktHistoryId` dedup) is the escape hatch — see the Task 7 amendment.
- `syncMovieHistory` is exported so DB-backed tests can inject a fake
  `TraktClient` and a dummy `TmdbClient` against a real migrated D1
  (`setupTestDb`), with the movies pre-seeded by `tmdbId` so `resolveMovie`
  never reaches TMDB. Tests cover: chronological inserts with correct
  rewatch flags from a two-page newest-first backfill, dedup idempotence on
  re-run, and cursor advancement to the newest event.

---

### Task 5: History sync — episodes

**Files:**

- Modify: `src/services/trakt/history-sync.ts`
- Test: `src/services/trakt/history-sync.test.ts`

> **Amendment (post-Task-4 review):** the episode sync MUST use the identical
> pattern established by the amended Task 4: fetch page 1 to learn
> `pageCount`, then a reverse page walk (`pageCount` → 1) with items
> processed oldest-first within each page; page-level batched dedup via one
> `inArray(watchHistory.traktHistoryId, pageIds)` select per page; the
> earlier-count query scoped by `userId`; the same retroactive-logging
> limitation comment on the episode cursor; and equivalent DB-backed tests
> (real migrated D1 via `setupTestDb`, fake `TraktClient`, dummy
> `TmdbClient`, pre-seeded shows so no TMDB fetch happens) asserting
> chronological inserts/rewatch flags, dedup idempotence, and cursor
> advancement. Export the internal episode sync function for test injection.

**Step 1: Write the failing tests**

Append to `history-sync.test.ts`:

```ts
import { buildEpisodeFeedItem } from './history-sync.js';

describe('buildEpisodeFeedItem', () => {
  it('builds an episode_watched feed item with SxxExx code', () => {
    const item = buildEpisodeFeedItem({
      showId: 5,
      showTitle: 'Severance',
      seasonNumber: 2,
      episodeNumber: 3,
      episodeTitle: 'Who Is Alive?',
      watchedAt: '2026-06-03T21:00:00.000Z',
    });
    expect(item.eventType).toBe('episode_watched');
    expect(item.title).toBe('Watched Severance S02E03');
    expect(item.sourceId).toBe('trakt:episode:5:2:3:2026-06-03');
  });
});
```

(Merge the import with the existing import from `./history-sync.js` — one import statement, ESLint will complain otherwise.)

**Step 2: Run to verify failure**

Run: `npx vitest run src/services/trakt/history-sync.test.ts`
Expected: FAIL — `buildEpisodeFeedItem` not exported.

**Step 3: Implement**

In `history-sync.ts`, add imports: `shows`, `episodesWatched` from `../../db/schema/watching.js`.

Add types and the feed builder:

```ts
export interface SyncedEpisode {
  showId: number;
  showTitle: string;
  seasonNumber: number;
  episodeNumber: number;
  episodeTitle: string | null;
  watchedAt: string;
}

export function buildEpisodeFeedItem(ep: SyncedEpisode): FeedItem {
  const code = `S${String(ep.seasonNumber).padStart(2, '0')}E${String(ep.episodeNumber).padStart(2, '0')}`;
  return {
    domain: 'watching',
    eventType: 'episode_watched',
    occurredAt: ep.watchedAt,
    title: `Watched ${ep.showTitle} ${code}`,
    sourceId: `trakt:episode:${ep.showId}:${ep.seasonNumber}:${ep.episodeNumber}:${ep.watchedAt.substring(0, 10)}`,
  };
}
```

Add show resolution (cache per run) and the episode loop:

```ts
/**
 * Look up a show by TMDB ID, creating a TMDB-enriched row if new.
 */
async function ensureShow(
  db: Database,
  tmdbClient: TmdbClient,
  userId: number,
  show: { title: string; year: number | null; traktId: number; tmdbId: number },
  cache: Map<number, number>
): Promise<number> {
  const cached = cache.get(show.tmdbId);
  if (cached !== undefined) return cached;

  const [existing] = await db
    .select({ id: shows.id })
    .from(shows)
    .where(eq(shows.tmdbId, show.tmdbId))
    .limit(1);
  if (existing) {
    cache.set(show.tmdbId, existing.id);
    return existing.id;
  }

  let detail = null;
  try {
    detail = await tmdbClient.getTvShowDetail(show.tmdbId);
  } catch (error) {
    console.log(
      `[ERROR] TMDB TV enrichment failed for ${show.title}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const [inserted] = await db
    .insert(shows)
    .values({
      userId,
      traktId: show.traktId,
      tmdbId: show.tmdbId,
      title: detail?.title ?? show.title,
      year: detail?.year ?? show.year,
      summary: detail?.summary ?? null,
      posterPath: detail?.posterPath ?? null,
      backdropPath: detail?.backdropPath ?? null,
      contentRating: detail?.contentRating ?? null,
      tmdbRating: detail?.tmdbRating ?? null,
      totalSeasons: detail?.totalSeasons ?? null,
      totalEpisodes: detail?.totalEpisodes ?? null,
    })
    .returning({ id: shows.id });

  cache.set(show.tmdbId, inserted.id);
  return inserted.id;
}

/**
 * Most recent Trakt-sourced episode watch, used as the incremental cursor.
 */
async function episodeCursor(
  db: Database,
  userId: number
): Promise<string | undefined> {
  const [row] = await db
    .select({ max: sql<string | null>`max(${episodesWatched.watchedAt})` })
    .from(episodesWatched)
    .where(
      and(
        eq(episodesWatched.userId, userId),
        eq(episodesWatched.source, 'trakt')
      )
    );
  return row?.max ?? undefined;
}

async function syncEpisodeHistory(
  db: Database,
  client: TraktClient,
  tmdbClient: TmdbClient,
  userId: number
): Promise<{ synced: number; skipped: number; newEpisodes: SyncedEpisode[] }> {
  const startAt = await episodeCursor(db, userId);
  console.log(
    `[SYNC] Trakt episode history ${startAt ? `since ${startAt}` : 'full walk'}`
  );

  let synced = 0;
  let skipped = 0;
  const newEpisodes: SyncedEpisode[] = [];
  const showCache = new Map<number, number>();

  let page = 1;
  let pageCount = 1;
  do {
    const result = await client.getEpisodeHistory({
      startAt,
      page,
      limit: PAGE_LIMIT,
    });
    pageCount = result.pageCount;

    for (const item of result.items) {
      const showTmdbId = item.show.ids.tmdb;
      if (!showTmdbId) {
        console.log(`[INFO] Skipping ${item.show.title} - no TMDb ID`);
        skipped++;
        continue;
      }

      const [existing] = await db
        .select({ id: episodesWatched.id })
        .from(episodesWatched)
        .where(eq(episodesWatched.traktHistoryId, item.id))
        .limit(1);
      if (existing) {
        skipped++;
        continue;
      }

      const showId = await ensureShow(
        db,
        tmdbClient,
        userId,
        {
          title: item.show.title,
          year: item.show.year,
          traktId: item.show.ids.trakt,
          tmdbId: showTmdbId,
        },
        showCache
      );

      await db
        .insert(episodesWatched)
        .values({
          userId,
          showId,
          seasonNumber: item.episode.season,
          episodeNumber: item.episode.number,
          title: item.episode.title,
          watchedAt: item.watched_at,
          source: 'trakt',
          traktHistoryId: item.id,
        })
        .onConflictDoNothing();

      newEpisodes.push({
        showId,
        showTitle: item.show.title,
        seasonNumber: item.episode.season,
        episodeNumber: item.episode.number,
        episodeTitle: item.episode.title,
        watchedAt: item.watched_at,
      });
      synced++;
    }

    page++;
  } while (page <= pageCount);

  return { synced, skipped, newEpisodes };
}
```

Wire into the orchestrator (`syncTraktHistory`): after the movies call, add

```ts
const episodes = await syncEpisodeHistory(db, client, tmdbClient, userId);
```

Update `itemsSynced` to `movies.synced + episodes.synced`, add `episodesSynced: episodes.synced, episodesSkipped: episodes.skipped` to the metadata JSON, extend `feedItems` with `...episodes.newEpisodes.map(buildEpisodeFeedItem)`, update the final log line and return `{ moviesSynced: movies.synced, episodesSynced: episodes.synced }`.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/trakt/history-sync.test.ts` — PASS
Run: `npx tsc --noEmit` — PASS

**Step 5: Commit**

```bash
git add src/services/trakt/history-sync.ts src/services/trakt/history-sync.test.ts
git commit -m "feat(trakt): sync episode watch history"
```

---

### Task 6: Ratings application

**Files:**

- Modify: `src/services/trakt/history-sync.ts`
- Test: `src/services/trakt/history-sync.test.ts`

**Step 1: Write the failing test**

```ts
import { buildRatingsMap } from './history-sync.js';

describe('buildRatingsMap', () => {
  it('maps tmdb id to rating, skipping items without tmdb ids', () => {
    const map = buildRatingsMap([
      {
        rated_at: '2026-01-01T00:00:00.000Z',
        rating: 9,
        type: 'movie',
        movie: {
          title: 'Heat',
          year: 1995,
          ids: { trakt: 1, slug: 'heat', imdb: 'tt0113277', tmdb: 949 },
        },
      },
      {
        rated_at: '2026-01-02T00:00:00.000Z',
        rating: 7,
        type: 'movie',
        movie: {
          title: 'No Id',
          year: 2000,
          ids: { trakt: 2, slug: 'no-id', imdb: '', tmdb: 0 },
        },
      },
    ]);
    expect(map.get(949)).toBe(9);
    expect(map.size).toBe(1);
  });
});
```

(Again merge into the single `./history-sync.js` import.)

**Step 2: Run to verify failure** — `npx vitest run src/services/trakt/history-sync.test.ts` fails on missing export.

**Step 3: Implement**

Add imports `movies` from `../../db/schema/watching.js` and `TraktRatingItem` (type) from `./client.js`. Add:

```ts
export function buildRatingsMap(
  ratings: TraktRatingItem[]
): Map<number, number> {
  const map = new Map<number, number>();
  for (const item of ratings) {
    if (item.movie.ids.tmdb) {
      map.set(item.movie.ids.tmdb, item.rating);
    }
  }
  return map;
}
```

Replace the `applyMovieRatings` placeholder body:

```ts
async function applyMovieRatings(
  db: Database,
  client: TraktClient,
  userId: number
): Promise<number> {
  const ratings = buildRatingsMap(await client.getMovieRatings());
  if (ratings.size === 0) return 0;

  let applied = 0;
  for (const [tmdbId, rating] of ratings) {
    const [movie] = await db
      .select({ id: movies.id })
      .from(movies)
      .where(eq(movies.tmdbId, tmdbId))
      .limit(1);
    if (!movie) continue;

    const result = await db
      .update(watchHistory)
      .set({ userRating: rating })
      .where(
        and(
          eq(watchHistory.userId, userId),
          eq(watchHistory.movieId, movie.id),
          eq(watchHistory.source, 'trakt'),
          sql`${watchHistory.userRating} IS NOT ${rating}`
        )
      );
    if (result.meta.changes > 0) applied++;
  }

  console.log(`[SYNC] Applied ${applied} Trakt movie ratings`);
  return applied;
}
```

**Step 4: Run tests** — `npx vitest run src/services/trakt/history-sync.test.ts` PASS; `npx tsc --noEmit` PASS.

**Step 5: Commit**

```bash
git add src/services/trakt/history-sync.ts src/services/trakt/history-sync.test.ts
git commit -m "feat(trakt): apply movie ratings to watch history"
```

---

### Task 7: Cron and admin wiring

**Files:**

- Modify: `src/index.ts` (the `'0 */6 * * *'` case, ~line 322)
- Modify: `src/routes/admin-sync.ts` (WatchingSyncQuery + handler, ~lines 69-284)

> **Amendment (post-Task-4 review):** the admin sync route should accept an
> optional `full=true` query param that ignores the incremental cursor and
> performs a full idempotent re-walk of Trakt history (safe thanks to
> `traktHistoryId` dedup). This is the escape hatch for the
> retroactive-logging limitation documented on `movieCursor()`: watches
> back-dated in Trakt to before an already-advanced cursor are only picked
> up by a cursor-less full re-walk.

**Step 1: Wire the cron**

In `src/index.ts`, import `syncTraktHistory` alongside the other sync imports:

```ts
import { syncTraktHistory } from './services/trakt/history-sync.js';
```

In the `'0 */6 * * *'` case, guard Letterboxd on its env var and add the Trakt block. Replace the existing Letterboxd `ctx.waitUntil(...)` with:

```ts
if (env.LETTERBOXD_USERNAME) {
  console.log('[SYNC] Letterboxd RSS sync');
  ctx.waitUntil(
    (async () => {
      try {
        await syncLetterboxd(db, env);
      } catch (error) {
        console.log(
          `[ERROR] Letterboxd sync failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    })()
  );
}

if (env.TRAKT_CLIENT_ID) {
  console.log('[SYNC] Trakt watch history sync');
  ctx.waitUntil(
    (async () => {
      try {
        await syncTraktHistory(env);
        const skip = await shouldSkipWatchingImages(db);
        if (skip) {
          console.log(
            '[SYNC] Skipping watching image processing: Plex cron already ran it recently'
          );
        } else {
          await processWatchingImages(db, env);
        }
      } catch (error) {
        console.log(
          `[ERROR] Trakt history sync failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    })()
  );
}
```

(The image-processing step moves into the Trakt block since that's the active watching source; the Letterboxd block no longer needs it when Letterboxd is unconfigured. Keep the Instapaper half of the case unchanged.)

Check `src/types/env.ts`: if `LETTERBOXD_USERNAME` / `TRAKT_CLIENT_ID` are non-optional `string`, the truthiness guards still work for empty-string/unset secrets — no type change needed.

**Step 2: Extend the admin route**

In `src/routes/admin-sync.ts`:

```ts
const WatchingSyncQuery = z.object({
  source: z
    .enum(['plex', 'letterboxd', 'trakt'])
    .optional()
    .default('plex')
    .openapi({ example: 'plex' }),
});
```

Add a response schema and extend the union:

```ts
const WatchingTraktResponse = z
  .object({
    success: z.literal(true),
    source: z.literal('trakt'),
    movies_synced: z.number().int(),
    episodes_synced: z.number().int(),
  })
  .openapi('WatchingTraktSyncResponse');

const WatchingSyncResponse = z
  .union([
    WatchingPlexResponse,
    WatchingLetterboxdResponse,
    WatchingTraktResponse,
  ])
  .openapi('WatchingSyncResponse');
```

In the handler, add a branch before the `else`:

```ts
    } else if (source === 'trakt') {
      const result = await syncTraktHistory(c.env);
      c.executionCtx.waitUntil(
        processWatchingImages(db, c.env).catch((err) =>
          console.log(
            `[ERROR] Watching image processing failed: ${err instanceof Error ? err.message : String(err)}`
          )
        )
      );
      return c.json({
        success: true as const,
        source: 'trakt' as const,
        movies_synced: result.moviesSynced,
        episodes_synced: result.episodesSynced,
      });
```

with the import `import { syncTraktHistory } from '../services/trakt/history-sync.js';`.

**Step 3: Verify**

Run: `npx tsc --noEmit` — PASS
Run: `npm test` — all pass (route tests snapshot the OpenAPI spec in `openapi.snapshot.json`; if a spec-diff test fails, regenerate the snapshot per that test's instructions — the new enum/response is an intentional change).

**Step 4: Commit**

```bash
git add src/index.ts src/routes/admin-sync.ts openapi.snapshot.json
git commit -m "feat(trakt): wire history sync into cron and admin endpoints"
```

---

### Task 8: Docs

**Files:**

- Modify: `CLAUDE.md`
- Modify: `README.md`

**Step 1:** In `CLAUDE.md`: update the domain sentence to `watching (Plex + Letterboxd + Trakt + manual)`, add `src/services/trakt/history-sync.ts` implicitly via the services description (`trakt/ -- Trakt OAuth, API client, collection + watch history sync`), and in the env-var table change the `TRAKT_CLIENT_ID`/`TRAKT_CLIENT_SECRET` domain column to `Collecting, Watching`.

**Step 2:** In `README.md`: change the Watching row of the Domains table to `Plex, Letterboxd, Trakt`.

**Step 3: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: note Trakt as a watching-domain source"
```

---

### Task 9: Final verification

**Step 1:** `npm test` — full suite green.
**Step 2:** `npm run lint` — clean (fix any import-order/style complaints).
**Step 3:** `npx tsc --noEmit` — clean.
**Step 4:** `npm run db:migrate && npm run dev`, then in another shell:

```bash
curl -s -X POST "http://localhost:8787/v1/admin/sync/watching?source=trakt" \
  -H "Authorization: Bearer <admin key>"
```

Expected: `{"success":true,"source":"trakt","movies_synced":N,"episodes_synced":M}` (requires TRAKT\_\* secrets in `.dev.vars`; if unset, a 500 naming the missing credential is the expected outcome — note it and move on).
**Step 5:** Commit any stragglers; do not merge — leave the branch for review.
