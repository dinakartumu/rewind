import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { createDb } from '../db/client.js';
import { shows, episodesWatched } from '../db/schema/watching.js';
import { setupTestDb, createTestApiKey } from '../test-helpers.js';

describe('Shows endpoints against migrated source-neutral tables', () => {
  let token: string;
  let showId: number;

  beforeAll(async () => {
    await setupTestDb();
    token = await createTestApiKey({ scope: 'read', name: 'shows-test' });

    const db = createDb(env.DB);

    // Insert into the renamed `shows` table, exercising the new trakt_id column
    const [show] = await db
      .insert(shows)
      .values({
        title: 'Migrated Show',
        year: 2024,
        tmdbId: 88801,
        traktId: 77701,
        totalSeasons: 1,
        totalEpisodes: 10,
      })
      .returning();
    showId = show.id;

    // Insert into the renamed `episodes_watched` table, exercising the new
    // source + trakt_history_id columns alongside the default plex source
    await db.insert(episodesWatched).values([
      {
        showId: show.id,
        seasonNumber: 1,
        episodeNumber: 1,
        title: 'Pilot',
        watchedAt: '2024-05-01T20:00:00.000Z',
      },
      {
        showId: show.id,
        seasonNumber: 1,
        episodeNumber: 2,
        title: 'Second Episode',
        watchedAt: '2024-05-02T20:00:00.000Z',
        source: 'trakt',
        traktHistoryId: 555001,
      },
    ]);
  });

  describe('GET /v1/watching/shows', () => {
    it('returns the show with its watched episode count', async () => {
      const res = await SELF.fetch('http://localhost/v1/watching/shows', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{
          id: number;
          title: string;
          year: number | null;
          tmdb_id: number | null;
          episodes_watched: number;
        }>;
        pagination: { total: number };
      };
      const show = body.data.find((s) => s.id === showId);
      expect(show).toBeDefined();
      expect(show?.title).toBe('Migrated Show');
      expect(show?.tmdb_id).toBe(88801);
      expect(show?.episodes_watched).toBe(2);
    });
  });

  describe('GET /v1/watching/shows/:id', () => {
    it('returns show detail with episodes grouped by season', async () => {
      const res = await SELF.fetch(
        `http://localhost/v1/watching/shows/${showId}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        title: string;
        seasons: Array<{
          episodes: Array<{ episode: number; title: string | null }>;
        }>;
      };
      expect(body.title).toBe('Migrated Show');
      const episodes = body.seasons.flatMap((s) => s.episodes);
      expect(episodes.length).toBe(2);
      expect(episodes.map((e) => e.title)).toEqual(
        expect.arrayContaining(['Pilot', 'Second Episode'])
      );
    });
  });

  describe('source and trakt columns round-trip', () => {
    it('persists source and trakt_history_id on episodes_watched', async () => {
      const db = createDb(env.DB);
      const rows = await db.select().from(episodesWatched);
      const seeded = rows.filter((r) => r.showId === showId);
      expect(seeded.length).toBe(2);
      const plexEp = seeded.find((r) => r.episodeNumber === 1);
      const traktEp = seeded.find((r) => r.episodeNumber === 2);
      expect(plexEp?.source).toBe('plex');
      expect(plexEp?.traktHistoryId).toBeNull();
      expect(traktEp?.source).toBe('trakt');
      expect(traktEp?.traktHistoryId).toBe(555001);
    });

    it('persists trakt_id on shows', async () => {
      const db = createDb(env.DB);
      const [row] = await db.select().from(shows);
      expect(row.traktId).toBe(77701);
    });
  });
});
