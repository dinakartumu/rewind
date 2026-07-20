import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { eq, sql, asc } from 'drizzle-orm';
import { createDb } from '../../db/client.js';
import { checkins } from '../../db/schema/places.js';
import { syncRuns } from '../../db/schema/system.js';
import { setupTestDbWithFts5 } from '../../test-helpers.js';
import { syncCheckins, syncPlaces, buildCheckinFeedItem } from './sync.js';
import type { FoursquareClient, FoursquareCheckin } from './client.js';
import type { Env } from '../../types/env.js';

function checkin(
  n: number,
  overrides: Partial<FoursquareCheckin> = {}
): FoursquareCheckin {
  return {
    id: `chk${n}`,
    createdAt: 1700000000 + n * 86400,
    venue: {
      id: `venue${n}`,
      name: `Venue ${n}`,
      categories: [
        { name: 'Secondary Category' },
        { name: 'Coffee Shop', primary: true },
      ],
      location: {
        city: 'Seattle',
        state: 'WA',
        country: 'United States',
        lat: 47.6 + n * 0.001,
        lng: -122.3,
      },
    },
    ...overrides,
  };
}

/** Newest-first feed of n checkins: index 0 is the newest (`chk{n-1}`). */
function newestFirstFeed(n: number): FoursquareCheckin[] {
  return Array.from({ length: n }, (_, i) => checkin(n - 1 - i));
}

/**
 * Fixture-serving fake: the feed is a FIXED newest-first array and the
 * fake honors offset/limit exactly like the real API (which ignores its
 * sort parameter and always serves newest-first). Tests may mutate the
 * array between runs to simulate new checkins prepending at offset 0.
 */
function makeClient(feed: FoursquareCheckin[]): {
  client: FoursquareClient;
  calls: { offset: number; limit: number }[];
} {
  const calls: { offset: number; limit: number }[] = [];
  const client = {
    getCheckins: async ({ offset = 0, limit = 250 } = {}) => {
      calls.push({ offset, limit });
      return { items: feed.slice(offset, offset + limit), count: feed.length };
    },
  } as unknown as FoursquareClient;
  return { client, calls };
}

beforeAll(async () => {
  await setupTestDbWithFts5();
});

describe('buildCheckinFeedItem', () => {
  it('builds a places checkin feed item with a stable source id', () => {
    const item = buildCheckinFeedItem({
      foursquareId: 'abc123',
      venueId: 'v1',
      venueName: 'Victrola Coffee',
      venueCity: 'Seattle',
      checkedInAt: '2026-07-01T18:00:00.000Z',
    });
    expect(item).toEqual({
      domain: 'places',
      eventType: 'checkin',
      occurredAt: '2026-07-01T18:00:00.000Z',
      title: 'Checked in at Victrola Coffee',
      sourceId: 'foursquare:checkin:abc123',
    });
  });
});

describe('syncCheckins', () => {
  it('walks end-anchored from the deepest offsets and inserts chronologically', async () => {
    const db = createDb(env.DB);
    const feed = newestFirstFeed(10);
    const { client, calls } = makeClient(feed);

    const result = await syncCheckins(db, client, 1, {
      maxPages: 2,
      pageSize: 2,
    });

    expect(result.synced).toBe(4);
    expect(result.skipped).toBe(0);
    expect(result.remaining).toBe(6);
    // Probe for the total count, then two batches anchored to the end of
    // the newest-first feed, walking toward offset 0.
    expect(calls).toEqual([
      { offset: 0, limit: 1 },
      { offset: 8, limit: 2 },
      { offset: 6, limit: 2 },
    ]);

    // Insert order (autoincrement id) is chronological even though each
    // fetched page arrives newest-first.
    const rows = await db.select().from(checkins).orderBy(asc(checkins.id));
    expect(rows.map((r) => r.foursquareId)).toEqual([
      'chk0',
      'chk1',
      'chk2',
      'chk3',
    ]);
    expect(rows[0].venueName).toBe('Venue 0');
    expect(rows[0].venueCategory).toBe('Coffee Shop'); // primary wins
    expect(rows[0].venueCity).toBe('Seattle');
    expect(rows[0].venueState).toBe('WA');
    expect(rows[0].venueCountry).toBe('United States');
    expect(rows[0].lat).toBeCloseTo(47.6);
    expect(rows[0].lng).toBeCloseTo(-122.3);
    expect(rows[0].userId).toBe(1);
    // Epoch seconds converted to ISO 8601
    expect(rows[0].checkedInAt).toBe(new Date(1700000000 * 1000).toISOString());
  });

  it('resumes from the local count cursor at the exact tail offsets', async () => {
    const db = createDb(env.DB);
    const feed = newestFirstFeed(10);

    const firstBatch = makeClient(feed);
    await syncCheckins(db, firstBatch.client, 1, { maxPages: 2, pageSize: 2 });

    const secondBatch = makeClient(feed);
    const result = await syncCheckins(db, secondBatch.client, 1, {
      maxPages: 8,
      pageSize: 2,
    });

    // 4 already stored: the resumed walk targets the remaining tail
    // windows and ends at offset 0.
    expect(secondBatch.calls).toEqual([
      { offset: 0, limit: 1 },
      { offset: 4, limit: 2 },
      { offset: 2, limit: 2 },
      { offset: 0, limit: 2 },
    ]);
    expect(result.synced).toBe(6);
    expect(result.remaining).toBe(0);

    const [row] = await db
      .select({ count: sql<number>`count(*)` })
      .from(checkins);
    expect(row.count).toBe(10);
  });

  it('clamps the boundary batch when the count is not divisible by the page size', async () => {
    const db = createDb(env.DB);
    const feed = newestFirstFeed(5);
    const { client, calls } = makeClient(feed);

    const result = await syncCheckins(db, client, 1, {
      maxPages: 8,
      pageSize: 2,
    });

    // The final batch shrinks its limit so windows never overlap: 5 items
    // in pages of 2 means the offset-0 batch fetches exactly 1 item.
    expect(calls).toEqual([
      { offset: 0, limit: 1 },
      { offset: 3, limit: 2 },
      { offset: 1, limit: 2 },
      { offset: 0, limit: 1 },
    ]);
    expect(result.synced).toBe(5);
    expect(result.skipped).toBe(0);
    expect(result.remaining).toBe(0);

    const rows = await db.select().from(checkins).orderBy(asc(checkins.id));
    expect(rows.map((r) => r.foursquareId)).toEqual([
      'chk0',
      'chk1',
      'chk2',
      'chk3',
      'chk4',
    ]);
  });

  it('ignores other users when computing the count cursor', async () => {
    const db = createDb(env.DB);
    await db.insert(checkins).values({
      userId: 2,
      foursquareId: 'other-user-chk',
      venueName: 'Elsewhere',
      checkedInAt: '2020-01-01T00:00:00.000Z',
    });

    const { calls, client } = makeClient([checkin(1)]);
    const result = await syncCheckins(db, client, 1, { maxPages: 1 });

    // If user 2's row leaked into the cursor the walk would see nothing
    // unfetched and skip the batch entirely.
    expect(calls).toEqual([
      { offset: 0, limit: 1 },
      { offset: 0, limit: 1 },
    ]);
    expect(result.synced).toBe(1);
  });

  it('inserts venueless checkins with null venue fields and no feed items', async () => {
    const db = createDb(env.DB);
    const feed = [
      checkin(2),
      checkin(1, { venue: undefined, shout: 'From the road' }),
      checkin(0, { venue: undefined }),
    ];
    const { client } = makeClient(feed);

    const result = await syncCheckins(db, client, 1, { maxPages: 8 });

    expect(result.synced).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.remaining).toBe(0);
    // Only the venued checkin surfaces as a feed/search candidate.
    expect(result.newCheckins.map((c) => c.foursquareId)).toEqual(['chk2']);

    const rows = await db.select().from(checkins).orderBy(asc(checkins.id));
    expect(rows.map((r) => r.foursquareId)).toEqual(['chk0', 'chk1', 'chk2']);
    expect(rows[0].venueName).toBe('Unknown venue');
    expect(rows[0].venueId).toBeNull();
    expect(rows[0].venueCategory).toBeNull();
    expect(rows[0].venueCity).toBeNull();
    expect(rows[0].venueState).toBeNull();
    expect(rows[0].venueCountry).toBeNull();
    expect(rows[0].lat).toBeNull();
    expect(rows[0].lng).toBeNull();
    // Shout doubles as the venue name fallback and is still stored.
    expect(rows[1].venueName).toBe('From the road');
    expect(rows[1].shout).toBe('From the road');
    expect(rows[2].venueName).toBe('Venue 2');
  });

  it('counts venueless rows in the cursor so the next run fetches nothing', async () => {
    const db = createDb(env.DB);
    const feed = [checkin(2), checkin(1, { venue: undefined }), checkin(0)];

    await syncCheckins(db, makeClient(feed).client, 1, { maxPages: 8 });

    // Venueless rows advance the count cursor to the API frontier, so a
    // fully-synced history costs exactly one probe request per run.
    const second = makeClient(feed);
    const result = await syncCheckins(db, second.client, 1, { maxPages: 8 });

    expect(second.calls).toEqual([{ offset: 0, limit: 1 }]);
    expect(result.synced).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.remaining).toBe(0);

    const [row] = await db
      .select({ count: sql<number>`count(*)` })
      .from(checkins);
    expect(row.count).toBe(3);
  });

  it('picks up checkins prepended between runs without gaps or dupes', async () => {
    const db = createDb(env.DB);
    const feed = newestFirstFeed(5);

    const run1 = await syncCheckins(db, makeClient(feed).client, 1, {
      maxPages: 2,
      pageSize: 2,
    });
    expect(run1.synced).toBe(4); // chk0..chk3 stored, chk4 still unfetched
    expect(run1.remaining).toBe(1);

    // Two new checkins arrive; they prepend at offset 0 and do not shift
    // the tail offsets the resumed walk targets.
    feed.unshift(checkin(6), checkin(5));

    const second = makeClient(feed);
    const run2 = await syncCheckins(db, second.client, 1, {
      maxPages: 8,
      pageSize: 2,
    });

    expect(second.calls).toEqual([
      { offset: 0, limit: 1 },
      { offset: 1, limit: 2 },
      { offset: 0, limit: 1 },
    ]);
    expect(run2.synced).toBe(3); // chk4 (old tail) + chk5 + chk6
    expect(run2.skipped).toBe(0);
    expect(run2.remaining).toBe(0);

    const rows = await db.select().from(checkins);
    expect(rows.map((r) => r.foursquareId).sort()).toEqual([
      'chk0',
      'chk1',
      'chk2',
      'chk3',
      'chk4',
      'chk5',
      'chk6',
    ]);
  });

  it('dedups an interleaved final batch with truthful counts and stops instead of spinning', async () => {
    const db = createDb(env.DB);
    const feed = newestFirstFeed(3); // [chk2, chk1, chk0]
    const calls: { offset: number; limit: number }[] = [];
    let served = 0;
    const client = {
      getCheckins: async ({ offset = 0, limit = 250 } = {}) => {
        calls.push({ offset, limit });
        const page = {
          items: feed.slice(offset, offset + limit),
          count: feed.length,
        };
        // A brand-new checkin lands right after the first data batch,
        // while the walk still holds the pre-prepend count.
        served++;
        if (served === 2) feed.unshift(checkin(3));
        return page;
      },
    } as unknown as FoursquareClient;

    const result = await syncCheckins(db, client, 1, {
      maxPages: 8,
      pageSize: 2,
    });

    // The offset-0 batch computed from the stale count fetched the
    // brand-new chk3 instead of chk2; the immediate re-fetch of chk3 is
    // deduplicated by foursquare_id, counted as skipped, and ends the run
    // rather than spinning through maxPages. chk2 stays visible in
    // remaining rather than being silently absorbed. Accepted race: the
    // window is a single request during an active check-in.
    expect(calls).toEqual([
      { offset: 0, limit: 1 },
      { offset: 1, limit: 2 },
      { offset: 0, limit: 1 },
      { offset: 0, limit: 1 },
    ]);
    expect(result.synced).toBe(3); // chk0, chk1, chk3
    expect(result.skipped).toBe(1); // the chk3 re-fetch
    expect(result.remaining).toBe(1);

    const rows = await db.select().from(checkins);
    expect(rows.map((r) => r.foursquareId).sort()).toEqual([
      'chk0',
      'chk1',
      'chk3',
    ]);
  });

  it('reports zero remaining when the API has no checkins', async () => {
    const db = createDb(env.DB);
    const { client, calls } = makeClient([]);

    const result = await syncCheckins(db, client, 1, { maxPages: 8 });
    expect(result).toMatchObject({ synced: 0, skipped: 0, remaining: 0 });
    expect(calls).toEqual([{ offset: 0, limit: 1 }]);
  });
});

describe('syncPlaces', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function placesEnv(token?: string): Env {
    return { ...env, FOURSQUARE_ACCESS_TOKEN: token } as unknown as Env;
  }

  it('records a completed sync run and writes feed and search items', async () => {
    const items = [checkin(2), checkin(1)];
    // Fresh Response per call: the walk makes a probe request before the
    // data batch and a Response body is single-use.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          meta: { code: 200 },
          response: { checkins: { count: 2, items } },
        })
      );
    });

    const result = await syncPlaces(placesEnv('test-token'));

    expect(result).toEqual({ synced: 2, remaining: 0 });

    const [run] = await createDb(env.DB)
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.domain, 'places'));
    expect(run.syncType).toBe('foursquare');
    expect(run.status).toBe('completed');
    expect(run.itemsSynced).toBe(2);

    const feedRows = await env.DB.prepare(
      "SELECT source_id, event_type, title FROM activity_feed WHERE domain = 'places' ORDER BY source_id"
    ).all();
    expect(feedRows.results).toHaveLength(2);
    expect(feedRows.results[0]).toMatchObject({
      source_id: 'foursquare:checkin:chk1',
      event_type: 'checkin',
      title: 'Checked in at Venue 1',
    });

    const searchRows = await env.DB.prepare(
      "SELECT entity_type, entity_id, title FROM search_index WHERE domain = 'places' ORDER BY entity_id"
    ).all();
    expect(searchRows.results).toHaveLength(2);
    expect(searchRows.results[0]).toMatchObject({
      entity_type: 'venue',
      entity_id: 'venue1',
    });
  });

  it('marks the run failed and rethrows when the token is missing', async () => {
    await expect(syncPlaces(placesEnv(undefined))).rejects.toThrow(
      'FOURSQUARE_ACCESS_TOKEN'
    );

    const [run] = await createDb(env.DB)
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.domain, 'places'));
    expect(run.status).toBe('failed');
    expect(run.error).toContain('FOURSQUARE_ACCESS_TOKEN');
  });
});
