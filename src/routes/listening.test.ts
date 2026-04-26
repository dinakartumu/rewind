import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { setupTestDb, createTestApiKey } from '../test-helpers.js';
import {
  lastfmArtists,
  lastfmTopArtists,
  lastfmTracks,
  lastfmScrobbles,
  lastfmYearlyStats,
} from '../db/schema/lastfm.js';

describe('listening routes', () => {
  it('module can be imported', async () => {
    const mod = await import('./listening.js');
    expect(mod.default).toBeDefined();
  });

  describe('GET /v1/listening/top/artists?include_sparklines=true', () => {
    let token: string;

    beforeAll(async () => {
      await setupTestDb();
      token = await createTestApiKey({
        name: 'top-artists-sparklines-test',
        scope: 'read',
      });
    });

    beforeEach(async () => {
      const db = drizzle(env.DB);
      await db.delete(lastfmScrobbles);
      await db.delete(lastfmTopArtists);
      await db.delete(lastfmTracks);
      await db.delete(lastfmArtists);
    });

    async function seedArtistWithScrobbles(opts: {
      name: string;
      period: '12month' | '7day' | 'overall';
      rank: number;
      scrobbleAt: string;
      scrobbleCount: number;
    }) {
      const db = drizzle(env.DB);
      const [artist] = await db
        .insert(lastfmArtists)
        .values({
          userId: 1,
          name: opts.name,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .returning();
      await db.insert(lastfmTopArtists).values({
        userId: 1,
        period: opts.period,
        rank: opts.rank,
        artistId: artist.id,
        playcount: opts.scrobbleCount,
        computedAt: new Date().toISOString(),
      });
      const [track] = await db
        .insert(lastfmTracks)
        .values({
          userId: 1,
          name: `${opts.name} Track`,
          artistId: artist.id,
          isFiltered: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .returning();
      const scrobbles = Array.from({ length: opts.scrobbleCount }, () => ({
        userId: 1,
        trackId: track.id,
        scrobbledAt: opts.scrobbleAt,
        createdAt: new Date().toISOString(),
      }));
      await db.insert(lastfmScrobbles).values(scrobbles);
      return artist.id;
    }

    it('attaches sparkline to each item when flag is on and period is supported', async () => {
      // 2 days ago — comfortably inside the 12-month window and the most
      // recent weekly bucket (which spans the current Monday onward).
      const recentScrobble = new Date(
        Date.now() - 2 * 24 * 60 * 60 * 1000
      ).toISOString();
      await seedArtistWithScrobbles({
        name: 'Sparkline Artist',
        period: '12month',
        rank: 1,
        scrobbleAt: recentScrobble,
        scrobbleCount: 5,
      });

      const res = await SELF.fetch(
        'http://localhost/v1/listening/top/artists?period=12month&include_sparklines=true&limit=5',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(1);
      const item = body.data[0];
      expect(item.sparkline).toBeDefined();
      expect(item.sparkline.granularity).toBe('week');
      expect(item.sparkline.points).toHaveLength(52);
      // The 5 scrobbles should sum to 5 across all buckets.
      const total = item.sparkline.points.reduce(
        (a: number, b: number) => a + b,
        0
      );
      expect(total).toBe(5);
    });

    it('omits sparkline for unsupported period 7day', async () => {
      const recentScrobble = new Date(
        Date.now() - 60 * 60 * 1000
      ).toISOString();

      const db = drizzle(env.DB);
      await db.delete(lastfmScrobbles);
      await db.delete(lastfmTopArtists);
      await db.delete(lastfmTracks);
      await db.delete(lastfmArtists);

      await seedArtistWithScrobbles({
        name: 'Skip 7day',
        period: '7day',
        rank: 1,
        scrobbleAt: recentScrobble,
        scrobbleCount: 3,
      });

      const res = await SELF.fetch(
        `http://localhost/v1/listening/top/artists?period=7day&include_sparklines=true&limit=5`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(1);
      expect('sparkline' in body.data[0]).toBe(false);
    });

    it('returns yearly buckets for period=overall', async () => {
      const recentScrobble = new Date(
        Date.now() - 60 * 60 * 1000
      ).toISOString();

      const db = drizzle(env.DB);
      await db.delete(lastfmScrobbles);
      await db.delete(lastfmTopArtists);
      await db.delete(lastfmTracks);
      await db.delete(lastfmArtists);

      await seedArtistWithScrobbles({
        name: 'Overall Test',
        period: 'overall',
        rank: 1,
        scrobbleAt: recentScrobble,
        scrobbleCount: 3,
      });

      const res = await SELF.fetch(
        `http://localhost/v1/listening/top/artists?period=overall&include_sparklines=true&limit=5`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(1);
      const item = body.data[0];
      expect(item.sparkline).toBeDefined();
      expect(item.sparkline.granularity).toBe('year');
      // At least one bucket exists, all 3 scrobbles land in the current year.
      expect(item.sparkline.points.length).toBeGreaterThanOrEqual(1);
      const total = item.sparkline.points.reduce(
        (a: number, b: number) => a + b,
        0
      );
      expect(total).toBe(3);
    });

    it('omits sparkline when the flag is not passed', async () => {
      const recentScrobble = new Date(
        Date.now() - 2 * 24 * 60 * 60 * 1000
      ).toISOString();
      await seedArtistWithScrobbles({
        name: 'No Flag',
        period: '12month',
        rank: 1,
        scrobbleAt: recentScrobble,
        scrobbleCount: 4,
      });

      const res = await SELF.fetch(
        'http://localhost/v1/listening/top/artists?period=12month&limit=5',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect('sparkline' in body.data[0]).toBe(false);
    });
  });

  describe('GET /v1/listening/years', () => {
    let token: string;

    beforeAll(async () => {
      await setupTestDb();
      token = await createTestApiKey({
        name: 'listening-years-test',
        scope: 'read',
      });
    });

    beforeEach(async () => {
      const db = drizzle(env.DB);
      await db.delete(lastfmYearlyStats);
      await db.delete(lastfmArtists);
    });

    it('returns one entry per year, newest first, with top_artist joined', async () => {
      const db = drizzle(env.DB);
      const [taylor] = await db
        .insert(lastfmArtists)
        .values({
          userId: 1,
          name: 'Taylor Swift',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .returning();

      await db.insert(lastfmYearlyStats).values([
        {
          userId: 1,
          year: 2024,
          scrobbles: 5000,
          uniqueArtists: 200,
          uniqueAlbums: 400,
          uniqueTracks: 1500,
          topArtistId: null,
          computedAt: new Date().toISOString(),
        },
        {
          userId: 1,
          year: 2025,
          scrobbles: 8500,
          uniqueArtists: 300,
          uniqueAlbums: 600,
          uniqueTracks: 2400,
          topArtistId: taylor.id,
          computedAt: new Date().toISOString(),
        },
      ]);

      const res = await SELF.fetch('http://localhost/v1/listening/years', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(2);
      expect(body.data[0].year).toBe(2025);
      expect(body.data[0].total_scrobbles).toBe(8500);
      expect(body.data[0].unique_artists).toBe(300);
      expect(body.data[0].unique_albums).toBe(600);
      expect(body.data[0].unique_tracks).toBe(2400);
      expect(body.data[0].top_artist).toEqual({
        id: taylor.id,
        name: 'Taylor Swift',
      });
      expect(body.data[1].year).toBe(2024);
      expect(body.data[1].top_artist).toBeNull();
    });

    it('returns empty data when no yearly stats exist', async () => {
      const res = await SELF.fetch('http://localhost/v1/listening/years', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toEqual([]);
    });
  });

  describe('GET /v1/listening/genres?compare_to=previous_year', () => {
    let token: string;

    beforeAll(async () => {
      await setupTestDb();
      token = await createTestApiKey({
        name: 'genres-compare-test',
        scope: 'read',
      });
    });

    beforeEach(async () => {
      const db = drizzle(env.DB);
      await db.delete(lastfmScrobbles);
      await db.delete(lastfmTracks);
      await db.delete(lastfmArtists);
    });

    async function seedScrobbles(opts: {
      genre: string;
      scrobbledAt: string;
      count: number;
    }) {
      const db = drizzle(env.DB);
      const [artist] = await db
        .insert(lastfmArtists)
        .values({
          userId: 1,
          name: `${opts.genre} Artist ${opts.scrobbledAt}`,
          genre: opts.genre,
          isFiltered: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .returning();
      const [track] = await db
        .insert(lastfmTracks)
        .values({
          userId: 1,
          name: 'T',
          artistId: artist.id,
          isFiltered: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .returning();
      const rows = Array.from({ length: opts.count }, () => ({
        userId: 1,
        trackId: track.id,
        scrobbledAt: opts.scrobbledAt,
        createdAt: new Date().toISOString(),
      }));
      await db.insert(lastfmScrobbles).values(rows);
    }

    it('returns compare array with the prior-year window', async () => {
      // Current window: 2025-01-15 — 1 Rock scrobble
      await seedScrobbles({
        genre: 'Rock',
        scrobbledAt: '2025-01-15T12:00:00Z',
        count: 1,
      });
      // Prior window: 2024-01-15 — 3 Pop scrobbles
      await seedScrobbles({
        genre: 'Pop',
        scrobbledAt: '2024-01-15T12:00:00Z',
        count: 3,
      });

      const res = await SELF.fetch(
        'http://localhost/v1/listening/genres?from=2025-01-01&to=2025-12-31&group_by=year&compare_to=previous_year',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.data).toHaveLength(1);
      expect(body.data[0].period).toBe('2025');
      expect(body.data[0].genres.Rock).toBe(1);
      expect(body.data[0].total).toBe(1);

      expect(body.compare).toBeDefined();
      expect(body.compare).toHaveLength(1);
      expect(body.compare[0].period).toBe('2024');
      expect(body.compare[0].genres.Pop).toBe(3);
      expect(body.compare[0].total).toBe(3);
    });

    it('omits compare key when flag is not set (backward-compatible)', async () => {
      await seedScrobbles({
        genre: 'Rock',
        scrobbledAt: '2025-06-15T12:00:00Z',
        count: 2,
      });

      const res = await SELF.fetch(
        'http://localhost/v1/listening/genres?from=2025-01-01&to=2025-12-31',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toBeDefined();
      expect('compare' in body).toBe(false);
    });
  });
});
