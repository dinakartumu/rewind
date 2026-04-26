import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { createDb, type Database } from '../db/client.js';
import {
  lastfmArtists,
  lastfmAlbums,
  lastfmTracks,
  lastfmScrobbles,
} from '../db/schema/lastfm.js';
import { setupTestDb } from '../test-helpers.js';
import {
  buildSparklines,
  buildSparklinesForWindow,
  isSparklinePeriod,
  overallToWindow,
  periodToWindow,
  SPARKLINE_PERIODS,
  yearMonthToWindow,
  yearToWindow,
} from './listening-sparklines.js';

describe('isSparklinePeriod', () => {
  it('accepts the supported periods', () => {
    for (const p of SPARKLINE_PERIODS) {
      expect(isSparklinePeriod(p)).toBe(true);
    }
  });

  it('rejects 7day and overall', () => {
    expect(isSparklinePeriod('7day')).toBe(false);
    expect(isSparklinePeriod('overall')).toBe(false);
  });
});

describe('periodToWindow', () => {
  // Anchor on a Wednesday so Monday math is exercised non-trivially.
  // 2026-04-22 UTC is a Wednesday; the Monday of that week is 2026-04-20.
  const NOW = new Date('2026-04-22T15:30:00Z');

  it('1month: 28 daily buckets ending today', () => {
    const w = periodToWindow('1month', NOW);
    expect(w.granularity).toBe('day');
    expect(w.bucketCount).toBe(28);
    expect(w.bucketKeys).toHaveLength(28);
    expect(w.bucketKeys[27]).toBe('2026-04-22'); // most recent = today
    expect(w.bucketKeys[0]).toBe('2026-03-26'); // 27 days earlier
    expect(w.from).toBe('2026-03-26T00:00:00.000Z');
    // Exclusive upper bound is start of tomorrow:
    expect(w.to).toBe('2026-04-23T00:00:00.000Z');
  });

  it('3month: 13 weekly Monday buckets', () => {
    const w = periodToWindow('3month', NOW);
    expect(w.granularity).toBe('week');
    expect(w.bucketCount).toBe(13);
    expect(w.bucketKeys).toHaveLength(13);
    // Most recent Monday: 2026-04-20
    expect(w.bucketKeys[12]).toBe('2026-04-20');
    // 12 weeks earlier
    expect(w.bucketKeys[0]).toBe('2026-01-26');
    expect(w.from).toBe('2026-01-26T00:00:00.000Z');
    // Exclusive upper bound is the Monday after this one:
    expect(w.to).toBe('2026-04-27T00:00:00.000Z');
  });

  it('12month: 52 weekly buckets', () => {
    const w = periodToWindow('12month', NOW);
    expect(w.granularity).toBe('week');
    expect(w.bucketCount).toBe(52);
    expect(w.bucketKeys).toHaveLength(52);
    expect(w.bucketKeys[51]).toBe('2026-04-20');
    // All keys are 7 days apart, ascending.
    for (let i = 1; i < w.bucketKeys.length; i++) {
      const prev = new Date(`${w.bucketKeys[i - 1]}T00:00:00Z`);
      const curr = new Date(`${w.bucketKeys[i]}T00:00:00Z`);
      const diffDays =
        (curr.getTime() - prev.getTime()) / (24 * 60 * 60 * 1000);
      expect(diffDays).toBe(7);
    }
  });

  it('weekly: anchors to Monday when "now" lands on a Sunday', () => {
    // 2026-04-26 is a Sunday — the Monday of that week is 2026-04-20.
    const w = periodToWindow('3month', new Date('2026-04-26T20:00:00Z'));
    expect(w.bucketKeys[12]).toBe('2026-04-20');
  });

  it('weekly: stays put when "now" is a Monday', () => {
    // 2026-04-20 is a Monday — anchor is itself.
    const w = periodToWindow('3month', new Date('2026-04-20T01:00:00Z'));
    expect(w.bucketKeys[12]).toBe('2026-04-20');
  });

  it('handles month-boundary backtracking without day-of-month traps', () => {
    // Anchor near end of March; the 28-day window crosses February.
    const w = periodToWindow('1month', new Date('2026-03-31T12:00:00Z'));
    expect(w.bucketKeys[27]).toBe('2026-03-31');
    expect(w.bucketKeys[0]).toBe('2026-03-04');
    // Verify all 28 keys are 1 day apart, ascending.
    for (let i = 1; i < w.bucketKeys.length; i++) {
      const prev = new Date(`${w.bucketKeys[i - 1]}T00:00:00Z`);
      const curr = new Date(`${w.bucketKeys[i]}T00:00:00Z`);
      const diffDays =
        (curr.getTime() - prev.getTime()) / (24 * 60 * 60 * 1000);
      expect(diffDays).toBe(1);
    }
  });
});

describe('yearToWindow', () => {
  it('returns 12 monthly buckets across the calendar year', () => {
    const w = yearToWindow(2025);
    expect(w.granularity).toBe('month');
    expect(w.bucketCount).toBe(12);
    expect(w.bucketKeys).toEqual([
      '2025-01',
      '2025-02',
      '2025-03',
      '2025-04',
      '2025-05',
      '2025-06',
      '2025-07',
      '2025-08',
      '2025-09',
      '2025-10',
      '2025-11',
      '2025-12',
    ]);
    expect(w.from).toBe('2025-01-01T00:00:00.000Z');
    expect(w.to).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('yearMonthToWindow', () => {
  it('returns daily buckets for a 31-day month', () => {
    const w = yearMonthToWindow(2025, 1);
    expect(w.granularity).toBe('day');
    expect(w.bucketCount).toBe(31);
    expect(w.bucketKeys[0]).toBe('2025-01-01');
    expect(w.bucketKeys[30]).toBe('2025-01-31');
    expect(w.from).toBe('2025-01-01T00:00:00.000Z');
    expect(w.to).toBe('2025-02-01T00:00:00.000Z');
  });

  it('returns 28 days for a non-leap February', () => {
    const w = yearMonthToWindow(2025, 2);
    expect(w.bucketCount).toBe(28);
    expect(w.bucketKeys[27]).toBe('2025-02-28');
  });

  it('returns 29 days for a leap February', () => {
    const w = yearMonthToWindow(2024, 2);
    expect(w.bucketCount).toBe(29);
    expect(w.bucketKeys[28]).toBe('2024-02-29');
  });

  it('rolls year boundary at December', () => {
    const w = yearMonthToWindow(2025, 12);
    expect(w.bucketCount).toBe(31);
    expect(w.from).toBe('2025-12-01T00:00:00.000Z');
    expect(w.to).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('overallToWindow', () => {
  it('returns one bucket per year, oldest -> newest', () => {
    const w = overallToWindow(2012, 2026);
    expect(w.granularity).toBe('year');
    expect(w.bucketCount).toBe(15);
    expect(w.bucketKeys[0]).toBe('2012');
    expect(w.bucketKeys[14]).toBe('2026');
    expect(w.from).toBe('2012-01-01T00:00:00.000Z');
    expect(w.to).toBe('2027-01-01T00:00:00.000Z');
  });

  it('handles a single-year span', () => {
    const w = overallToWindow(2026, 2026);
    expect(w.bucketCount).toBe(1);
    expect(w.bucketKeys).toEqual(['2026']);
  });

  it('throws when currentYear precedes earliestYear', () => {
    expect(() => overallToWindow(2026, 2025)).toThrow();
  });
});

describe('buildSparklines', () => {
  let db: Database;

  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    db = createDb(env.DB);
    await db.delete(lastfmScrobbles);
    await db.delete(lastfmTracks);
    await db.delete(lastfmAlbums);
    await db.delete(lastfmArtists);
  });

  it('returns an empty map when no artistIds are passed', async () => {
    const map = await buildSparklines(db, [], '12month');
    expect(map.size).toBe(0);
  });

  it('zero-fills missing buckets and orders points oldest -> newest', async () => {
    const NOW = new Date('2026-04-22T12:00:00Z');

    // One artist, one track, scrobbles in week-49 (2026-04-13 Monday) and
    // week-51 (2026-04-20 Monday) of the 12-month window.
    const [artist] = await db
      .insert(lastfmArtists)
      .values({
        userId: 1,
        name: 'Test Artist',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returning();
    const [track] = await db
      .insert(lastfmTracks)
      .values({
        userId: 1,
        name: 'Track A',
        artistId: artist.id,
        isFiltered: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returning();

    await db.insert(lastfmScrobbles).values([
      {
        userId: 1,
        trackId: track.id,
        scrobbledAt: '2026-04-15T10:00:00Z', // week of 2026-04-13
        createdAt: new Date().toISOString(),
      },
      {
        userId: 1,
        trackId: track.id,
        scrobbledAt: '2026-04-15T11:00:00Z', // same week
        createdAt: new Date().toISOString(),
      },
      {
        userId: 1,
        trackId: track.id,
        scrobbledAt: '2026-04-21T09:00:00Z', // week of 2026-04-20
        createdAt: new Date().toISOString(),
      },
    ]);

    const map = await buildSparklines(db, [artist.id], '12month', NOW);
    const series = map.get(artist.id);
    expect(series).toBeDefined();
    expect(series!.granularity).toBe('week');
    expect(series!.points).toHaveLength(52);

    // Bucket keys: index 50 = 2026-04-13 (2 plays), index 51 = 2026-04-20 (1 play).
    expect(series!.points[50]).toBe(2);
    expect(series!.points[51]).toBe(1);

    // All other buckets are zero.
    const zeroes = series!.points.filter((p) => p === 0);
    expect(zeroes.length).toBe(50);
  });

  it('excludes filtered tracks from sparkline counts', async () => {
    const NOW = new Date('2026-04-22T12:00:00Z');

    const [artist] = await db
      .insert(lastfmArtists)
      .values({
        userId: 1,
        name: 'Filtered Test',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returning();
    const [unfilteredTrack] = await db
      .insert(lastfmTracks)
      .values({
        userId: 1,
        name: 'Real Track',
        artistId: artist.id,
        isFiltered: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returning();
    const [filteredTrack] = await db
      .insert(lastfmTracks)
      .values({
        userId: 1,
        name: 'Skit Track',
        artistId: artist.id,
        isFiltered: 1, // should be excluded
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returning();

    await db.insert(lastfmScrobbles).values([
      {
        userId: 1,
        trackId: unfilteredTrack.id,
        scrobbledAt: '2026-04-21T09:00:00Z',
        createdAt: new Date().toISOString(),
      },
      {
        userId: 1,
        trackId: filteredTrack.id,
        scrobbledAt: '2026-04-21T09:00:00Z',
        createdAt: new Date().toISOString(),
      },
      {
        userId: 1,
        trackId: filteredTrack.id,
        scrobbledAt: '2026-04-21T10:00:00Z',
        createdAt: new Date().toISOString(),
      },
    ]);

    const map = await buildSparklines(db, [artist.id], '12month', NOW);
    const series = map.get(artist.id);
    expect(series!.points[51]).toBe(1); // only the unfiltered scrobble counts
  });

  it('emits an entry per requested artistId even with no scrobbles', async () => {
    const NOW = new Date('2026-04-22T12:00:00Z');
    const [artist] = await db
      .insert(lastfmArtists)
      .values({
        userId: 1,
        name: 'Silent Artist',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returning();

    const map = await buildSparklines(db, [artist.id], '3month', NOW);
    const series = map.get(artist.id);
    expect(series).toBeDefined();
    expect(series!.granularity).toBe('week');
    expect(series!.points).toHaveLength(13);
    expect(series!.points.every((p) => p === 0)).toBe(true);
  });

  it('groups by album_id when entity is "album"', async () => {
    const NOW = new Date('2026-04-22T12:00:00Z');
    const [artist] = await db
      .insert(lastfmArtists)
      .values({
        userId: 1,
        name: 'Album Test',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returning();
    const [album] = await db
      .insert(lastfmAlbums)
      .values({
        userId: 1,
        name: 'Test Album',
        artistId: artist.id,
        isFiltered: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returning();
    const [trackOnAlbum] = await db
      .insert(lastfmTracks)
      .values({
        userId: 1,
        name: 'Track on album',
        artistId: artist.id,
        albumId: album.id,
        isFiltered: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returning();
    const [trackNoAlbum] = await db
      .insert(lastfmTracks)
      .values({
        userId: 1,
        name: 'Track without album',
        artistId: artist.id,
        albumId: null,
        isFiltered: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returning();

    await db.insert(lastfmScrobbles).values([
      {
        userId: 1,
        trackId: trackOnAlbum.id,
        scrobbledAt: '2026-04-21T09:00:00Z',
        createdAt: new Date().toISOString(),
      },
      {
        userId: 1,
        trackId: trackOnAlbum.id,
        scrobbledAt: '2026-04-21T10:00:00Z',
        createdAt: new Date().toISOString(),
      },
      // This scrobble has no album — must not show up under album.id.
      {
        userId: 1,
        trackId: trackNoAlbum.id,
        scrobbledAt: '2026-04-21T11:00:00Z',
        createdAt: new Date().toISOString(),
      },
    ]);

    const map = await buildSparklinesForWindow(
      db,
      [album.id],
      periodToWindow('12month', NOW),
      'album'
    );
    const series = map.get(album.id);
    expect(series).toBeDefined();
    expect(series!.points[51]).toBe(2);
  });

  it('groups by track_id when entity is "track"', async () => {
    const NOW = new Date('2026-04-22T12:00:00Z');
    const [artist] = await db
      .insert(lastfmArtists)
      .values({
        userId: 1,
        name: 'Track Test',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returning();
    const [trackA] = await db
      .insert(lastfmTracks)
      .values({
        userId: 1,
        name: 'Track A',
        artistId: artist.id,
        isFiltered: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returning();
    const [trackB] = await db
      .insert(lastfmTracks)
      .values({
        userId: 1,
        name: 'Track B',
        artistId: artist.id,
        isFiltered: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returning();

    await db.insert(lastfmScrobbles).values([
      {
        userId: 1,
        trackId: trackA.id,
        scrobbledAt: '2026-04-21T09:00:00Z',
        createdAt: new Date().toISOString(),
      },
      {
        userId: 1,
        trackId: trackB.id,
        scrobbledAt: '2026-04-21T10:00:00Z',
        createdAt: new Date().toISOString(),
      },
      {
        userId: 1,
        trackId: trackB.id,
        scrobbledAt: '2026-04-21T11:00:00Z',
        createdAt: new Date().toISOString(),
      },
    ]);

    const map = await buildSparklinesForWindow(
      db,
      [trackA.id, trackB.id],
      periodToWindow('12month', NOW),
      'track'
    );
    expect(map.get(trackA.id)!.points[51]).toBe(1);
    expect(map.get(trackB.id)!.points[51]).toBe(2);
  });

  it('respects the period window (does not count out-of-window scrobbles)', async () => {
    const NOW = new Date('2026-04-22T12:00:00Z');

    const [artist] = await db
      .insert(lastfmArtists)
      .values({
        userId: 1,
        name: 'Window Test',
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

    await db.insert(lastfmScrobbles).values([
      // Way in the past — should be ignored for a 1month window.
      {
        userId: 1,
        trackId: track.id,
        scrobbledAt: '2024-01-01T00:00:00Z',
        createdAt: new Date().toISOString(),
      },
      // Inside the window.
      {
        userId: 1,
        trackId: track.id,
        scrobbledAt: '2026-04-21T09:00:00Z',
        createdAt: new Date().toISOString(),
      },
    ]);

    const map = await buildSparklines(db, [artist.id], '1month', NOW);
    const series = map.get(artist.id);
    const total = series!.points.reduce((a, b) => a + b, 0);
    expect(total).toBe(1);
  });
});
