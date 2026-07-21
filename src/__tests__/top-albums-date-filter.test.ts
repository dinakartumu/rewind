import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { createDb } from '../db/client.js';
import {
  lastfmArtists,
  lastfmAlbums,
  lastfmTracks,
  lastfmScrobbles,
} from '../db/schema/lastfm.js';
import { setupTestDb, createTestApiKey } from '../test-helpers.js';

describe('GET /v1/listening/top/albums with date filters', () => {
  let token: string;

  beforeAll(async () => {
    await setupTestDb();
    token = await createTestApiKey({ scope: 'read', name: 'top-albums-test' });

    const db = createDb(env.DB);

    const [artist1] = await db
      .insert(lastfmArtists)
      .values({ name: 'Filter Artist One', playcount: 10, isFiltered: 0 })
      .returning();
    const [artist2] = await db
      .insert(lastfmArtists)
      .values({ name: 'Filter Artist Two', playcount: 10, isFiltered: 0 })
      .returning();

    const [albumFeb] = await db
      .insert(lastfmAlbums)
      .values({
        name: 'February Favorite',
        artistId: artist1.id,
        playcount: 3,
        isFiltered: 0,
      })
      .returning();
    const [albumBoth] = await db
      .insert(lastfmAlbums)
      .values({
        name: 'Mostly March',
        artistId: artist2.id,
        playcount: 7,
        isFiltered: 0,
      })
      .returning();

    const [trackFeb] = await db
      .insert(lastfmTracks)
      .values({
        name: 'Feb Track',
        artistId: artist1.id,
        albumId: albumFeb.id,
        isFiltered: 0,
      })
      .returning();
    const [trackBoth] = await db
      .insert(lastfmTracks)
      .values({
        name: 'Both Track',
        artistId: artist2.id,
        albumId: albumBoth.id,
        isFiltered: 0,
      })
      .returning();

    await db.insert(lastfmScrobbles).values([
      // February 2025: albumFeb x3
      { trackId: trackFeb.id, scrobbledAt: '2025-02-05T10:00:00.000Z' },
      { trackId: trackFeb.id, scrobbledAt: '2025-02-10T10:00:00.000Z' },
      { trackId: trackFeb.id, scrobbledAt: '2025-02-15T10:00:00.000Z' },
      // February 2025: albumBoth x2
      { trackId: trackBoth.id, scrobbledAt: '2025-02-07T10:00:00.000Z' },
      { trackId: trackBoth.id, scrobbledAt: '2025-02-20T10:00:00.000Z' },
      // March 2025: albumBoth x5 (must be excluded by the Feb window)
      { trackId: trackBoth.id, scrobbledAt: '2025-03-01T10:00:00.000Z' },
      { trackId: trackBoth.id, scrobbledAt: '2025-03-05T10:00:00.000Z' },
      { trackId: trackBoth.id, scrobbledAt: '2025-03-10T10:00:00.000Z' },
      { trackId: trackBoth.id, scrobbledAt: '2025-03-15T10:00:00.000Z' },
      { trackId: trackBoth.id, scrobbledAt: '2025-03-20T10:00:00.000Z' },
    ]);
  });

  it('live-aggregates from scrobbles when from/to params are present', async () => {
    const res = await SELF.fetch(
      'http://localhost/v1/listening/top/albums?from=2025-02-01T00:00:00Z&to=2025-02-28T23:59:59Z&limit=10',
      { headers: { Authorization: `Bearer ${token}` } }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      period: string;
      data: Array<{
        rank: number;
        id: number;
        name: string;
        detail: string;
        playcount: number;
        image: unknown;
        url: string;
        apple_music_url: string | null;
      }>;
      pagination: { page: number; limit: number; total: number };
    };

    expect(body.data.length).toBe(2);
    expect(body.pagination.total).toBe(2);

    // February Favorite has 3 Feb plays; Mostly March has only 2 in Feb.
    expect(body.data[0].name).toBe('February Favorite');
    expect(body.data[0].rank).toBe(1);
    expect(body.data[0].playcount).toBe(3);
    expect(body.data[0].detail).toBe('Filter Artist One');

    // The 5 March scrobbles must be excluded from the window.
    expect(body.data[1].name).toBe('Mostly March');
    expect(body.data[1].rank).toBe(2);
    expect(body.data[1].playcount).toBe(2);
    expect(body.data[1].detail).toBe('Filter Artist Two');

    // Response shape matches the precomputed path.
    for (const item of body.data) {
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('image');
      expect(item).toHaveProperty('url');
      expect(item).toHaveProperty('apple_music_url');
    }
  });

  it('excludes everything outside the window', async () => {
    const res = await SELF.fetch(
      'http://localhost/v1/listening/top/albums?from=2025-03-01T00:00:00Z&to=2025-03-31T23:59:59Z&limit=10',
      { headers: { Authorization: `Bearer ${token}` } }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ name: string; playcount: number }>;
      pagination: { total: number };
    };
    expect(body.pagination.total).toBe(1);
    expect(body.data.length).toBe(1);
    expect(body.data[0].name).toBe('Mostly March');
    expect(body.data[0].playcount).toBe(5);
  });
});
