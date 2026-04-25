import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { createDb, type Database } from '../db/client.js';
import {
  lastfmArtists,
  lastfmTracks,
  lastfmScrobbles,
} from '../db/schema/lastfm.js';
import { setupTestDb } from '../test-helpers.js';
import {
  buildSparklines,
  isSparklinePeriod,
  periodToWindow,
  SPARKLINE_PERIODS,
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

describe('buildSparklines', () => {
  let db: Database;

  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    db = createDb(env.DB);
    await db.delete(lastfmScrobbles);
    await db.delete(lastfmTracks);
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
