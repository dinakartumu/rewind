import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { setupTestDb, createTestApiKey } from '../test-helpers.js';
import {
  lastfmArtists,
  lastfmTopArtists,
  lastfmTracks,
  lastfmScrobbles,
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

    it('omits sparkline for unsupported periods (7day, overall)', async () => {
      const recentScrobble = new Date(
        Date.now() - 60 * 60 * 1000
      ).toISOString();

      for (const period of ['7day', 'overall'] as const) {
        const db = drizzle(env.DB);
        await db.delete(lastfmScrobbles);
        await db.delete(lastfmTopArtists);
        await db.delete(lastfmTracks);
        await db.delete(lastfmArtists);

        await seedArtistWithScrobbles({
          name: `Skip ${period}`,
          period,
          rank: 1,
          scrobbleAt: recentScrobble,
          scrobbleCount: 3,
        });

        const res = await SELF.fetch(
          `http://localhost/v1/listening/top/artists?period=${period}&include_sparklines=true&limit=5`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as any;
        expect(body.data).toHaveLength(1);
        expect('sparkline' in body.data[0]).toBe(false);
      }
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
});
