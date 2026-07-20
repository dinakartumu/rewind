import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import { env } from 'cloudflare:test';
import { createDb, type Database } from '../../db/client.js';
import { stravaActivities, stravaTokens } from '../../db/schema/strava.js';
import { syncRuns } from '../../db/schema/system.js';
import { setupTestDb } from '../../test-helpers.js';
import { syncRunning, syncSingleActivity } from './sync.js';
import type { Env } from '../../types/env.js';
import { eq } from 'drizzle-orm';

function makeApiActivity(
  id: number,
  sportType: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    id,
    name: `${sportType} ${id}`,
    type: sportType,
    sport_type: sportType,
    workout_type: null,
    distance: 8046.7,
    moving_time: 2400,
    elapsed_time: 2500,
    total_elevation_gain: 30,
    start_date: '2024-06-15T14:00:00Z',
    start_date_local: '2024-06-15T07:00:00Z',
    timezone: 'America/Los_Angeles',
    start_latlng: null,
    end_latlng: null,
    location_city: null,
    location_state: null,
    location_country: null,
    average_speed: 3.35,
    max_speed: 4.0,
    average_heartrate: null,
    max_heartrate: null,
    average_cadence: null,
    calories: null,
    suffer_score: null,
    map: null,
    gear_id: null,
    achievement_count: 0,
    pr_count: 0,
    ...overrides,
  };
}

function stravaResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-RateLimit-Limit': '200,2000',
      'X-RateLimit-Usage': '1,1',
    },
  });
}

/**
 * Stub global fetch with a router over the Strava API.
 * Records every request URL (pathname + search) into `calls`.
 */
function installFetchStub(
  activities: ReturnType<typeof makeApiActivity>[],
  calls: string[]
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      );
      calls.push(url.pathname + url.search);

      if (url.pathname === '/api/v3/athlete/activities') {
        const page = url.searchParams.get('page');
        return stravaResponse(page === '1' ? activities : []);
      }

      const detailMatch = url.pathname.match(/^\/api\/v3\/activities\/(\d+)$/);
      if (detailMatch) {
        const found = activities.find((a) => a.id === Number(detailMatch[1]));
        if (found) return stravaResponse(found);
        return new Response('not found', { status: 404 });
      }

      return stravaResponse([]);
    })
  );
}

describe('Strava sync', () => {
  let db: Database;

  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    db = createDb(env.DB);
    await db.delete(stravaActivities);
    await db.delete(syncRuns);
    await db.delete(stravaTokens);
    await db.insert(stravaTokens).values({
      userId: 1,
      accessToken: 'test-access',
      refreshToken: 'test-refresh',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('syncRunning', () => {
    it('imports all sport types, not just runs', async () => {
      const calls: string[] = [];
      installFetchStub(
        [
          makeApiActivity(1, 'Run'),
          makeApiActivity(2, 'Ride'),
          makeApiActivity(3, 'Hike'),
        ],
        calls
      );

      const synced = await syncRunning(env as unknown as Env, db);

      expect(synced).toBe(3);
      const rows = await db.select().from(stravaActivities);
      expect(rows.map((r) => r.sportType).sort()).toEqual([
        'Hike',
        'Ride',
        'Run',
      ]);
    });

    it('skips the per-activity detail fetch for already-imported activities', async () => {
      // Seed activity 100 as already imported
      await db.insert(stravaActivities).values({
        stravaId: 100,
        name: 'Existing Run',
        sportType: 'Run',
        distanceMeters: 8046.7,
        distanceMiles: 5.0,
        movingTimeSeconds: 2400,
        elapsedTimeSeconds: 2500,
        totalElevationGainMeters: 30,
        totalElevationGainFeet: 98.4,
        startDate: '2024-06-15T14:00:00Z',
        startDateLocal: '2024-06-15T07:00:00Z',
        isRace: 0,
        isDeleted: 0,
      });

      const calls: string[] = [];
      installFetchStub(
        [
          makeApiActivity(100, 'Run'),
          makeApiActivity(200, 'Ride', {
            start_date: '2024-06-16T14:00:00Z',
            start_date_local: '2024-06-16T07:00:00Z',
          }),
        ],
        calls
      );

      const synced = await syncRunning(env as unknown as Env, db);

      expect(synced).toBe(1);
      expect(calls.some((c) => c.startsWith('/api/v3/activities/100'))).toBe(
        false
      );
      expect(calls.some((c) => c.startsWith('/api/v3/activities/200'))).toBe(
        true
      );
    });

    it('re-imports soft-deleted activities rather than skipping them', async () => {
      await db.insert(stravaActivities).values({
        stravaId: 300,
        name: 'Deleted Run',
        sportType: 'Run',
        distanceMeters: 8046.7,
        distanceMiles: 5.0,
        movingTimeSeconds: 2400,
        elapsedTimeSeconds: 2500,
        totalElevationGainMeters: 30,
        totalElevationGainFeet: 98.4,
        startDate: '2024-06-15T14:00:00Z',
        startDateLocal: '2024-06-15T07:00:00Z',
        isRace: 0,
        isDeleted: 1,
      });

      const calls: string[] = [];
      installFetchStub([makeApiActivity(300, 'Run')], calls);

      // Soft-deleted rows don't advance the cursor, and existence check
      // must not treat them as present.
      await syncRunning(env as unknown as Env, db, { full: true });

      expect(calls.some((c) => c.startsWith('/api/v3/activities/300'))).toBe(
        true
      );
    });

    it('uses the incremental cursor by default', async () => {
      await db.insert(stravaActivities).values({
        stravaId: 400,
        name: 'Cursor Run',
        sportType: 'Run',
        distanceMeters: 8046.7,
        distanceMiles: 5.0,
        movingTimeSeconds: 2400,
        elapsedTimeSeconds: 2500,
        totalElevationGainMeters: 30,
        totalElevationGainFeet: 98.4,
        startDate: '2024-05-01T00:00:00Z',
        startDateLocal: '2024-04-30T17:00:00Z',
        isRace: 0,
        isDeleted: 0,
      });

      const calls: string[] = [];
      installFetchStub([], calls);

      await syncRunning(env as unknown as Env, db);

      const expectedAfter = Math.floor(
        new Date('2024-05-01T00:00:00Z').getTime() / 1000
      );
      expect(
        calls.some(
          (c) =>
            c.startsWith('/api/v3/athlete/activities') &&
            c.includes(`after=${expectedAfter}`)
        )
      ).toBe(true);
    });

    it('full option ignores the incremental cursor and walks from the beginning', async () => {
      await db.insert(stravaActivities).values({
        stravaId: 400,
        name: 'Cursor Run',
        sportType: 'Run',
        distanceMeters: 8046.7,
        distanceMiles: 5.0,
        movingTimeSeconds: 2400,
        elapsedTimeSeconds: 2500,
        totalElevationGainMeters: 30,
        totalElevationGainFeet: 98.4,
        startDate: '2024-05-01T00:00:00Z',
        startDateLocal: '2024-04-30T17:00:00Z',
        isRace: 0,
        isDeleted: 0,
      });

      const calls: string[] = [];
      installFetchStub([], calls);

      await syncRunning(env as unknown as Env, db, { full: true });

      expect(
        calls.some(
          (c) =>
            c.startsWith('/api/v3/athlete/activities') && c.includes('after=1&')
        )
      ).toBe(true);
    });
  });

  describe('syncSingleActivity', () => {
    it('imports non-run activity types from webhooks', async () => {
      const calls: string[] = [];
      installFetchStub([makeApiActivity(555, 'Ride')], calls);

      await syncSingleActivity(env as unknown as Env, db, 555);

      const [row] = await db
        .select()
        .from(stravaActivities)
        .where(eq(stravaActivities.stravaId, 555));
      expect(row).toBeDefined();
      expect(row.sportType).toBe('Ride');
    });
  });

  describe('incremental cursor math', () => {
    it('computes incremental sync after timestamp correctly', () => {
      const lastActivityDate = '2024-01-15T12:00:00Z';
      const afterEpoch = Math.floor(
        new Date(lastActivityDate).getTime() / 1000
      );

      expect(afterEpoch).toBe(1705320000);
      expect(typeof afterEpoch).toBe('number');
    });
  });
});
