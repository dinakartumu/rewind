import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { createDb, type Database } from '../../db/client.js';
import { geoCities } from '../../db/schema/geo.js';
import { stravaActivities } from '../../db/schema/strava.js';
import { setupTestDb } from '../../test-helpers.js';
import { reverseGeocode, geocodeStravaActivities } from './reverse-geocode.js';
import { eq } from 'drizzle-orm';

/** Mini GeoNames fixture: Pacific Northwest + one non-US city. */
const FIXTURE_CITIES = [
  {
    id: 5746545,
    name: 'Portland',
    admin1: 'Oregon',
    countryCode: 'US',
    lat: 45.52345,
    lng: -122.67621,
  },
  {
    id: 5809844,
    name: 'Seattle',
    admin1: 'Washington',
    countryCode: 'US',
    lat: 47.60621,
    lng: -122.33207,
  },
  {
    id: 5747882,
    name: 'Beaverton',
    admin1: 'Oregon',
    countryCode: 'US',
    lat: 45.48706,
    lng: -122.80371,
  },
  {
    id: 6173331,
    name: 'Vancouver',
    admin1: 'British Columbia',
    countryCode: 'CA',
    lat: 49.24966,
    lng: -123.11934,
  },
];

function makeActivity(
  stravaId: number,
  overrides: Partial<typeof stravaActivities.$inferInsert> = {}
): typeof stravaActivities.$inferInsert {
  return {
    stravaId,
    name: `Run ${stravaId}`,
    sportType: 'Run',
    startDate: '2024-06-15T14:00:00Z',
    startDateLocal: '2024-06-15T07:00:00',
    ...overrides,
  };
}

describe('reverseGeocode', () => {
  let db: Database;

  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    db = createDb(env.DB);
    await db.delete(geoCities);
    await db.insert(geoCities).values(FIXTURE_CITIES);
  });

  it('returns the nearest city for coordinates', async () => {
    // Downtown Portland waterfront
    const result = await reverseGeocode(db, 45.515, -122.67);
    expect(result).toEqual({
      city: 'Portland',
      state: 'Oregon',
      country: 'United States',
    });
  });

  it('picks the nearest city when several are inside the box', async () => {
    // Closer to Beaverton than Portland
    const result = await reverseGeocode(db, 45.49, -122.79);
    expect(result?.city).toBe('Beaverton');
  });

  it('resolves non-US coordinates with their country', async () => {
    const result = await reverseGeocode(db, 49.26, -123.1);
    expect(result).toEqual({
      city: 'Vancouver',
      state: 'British Columbia',
      country: 'Canada',
    });
  });

  it('returns null when no city is inside the bounding box', async () => {
    // Middle of the Pacific
    const result = await reverseGeocode(db, 30.0, -150.0);
    expect(result).toBeNull();
  });

  it('finds a city just inside the bounding box boundary', async () => {
    // ~0.59 degrees north of Seattle: still inside the +/-0.6 box
    const result = await reverseGeocode(db, 48.196, -122.33207);
    expect(result?.city).toBe('Seattle');
  });

  it('returns null just outside the bounding box boundary', async () => {
    // Remove everything but Seattle, then query 0.61 degrees away in lat
    await db.delete(geoCities).where(eq(geoCities.countryCode, 'CA'));
    await db.delete(geoCities).where(eq(geoCities.admin1, 'Oregon'));
    const result = await reverseGeocode(db, 48.22, -122.33207);
    expect(result).toBeNull();
  });
});

describe('geocodeStravaActivities', () => {
  let db: Database;

  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    db = createDb(env.DB);
    await db.delete(geoCities);
    await db.delete(stravaActivities);
    await db.insert(geoCities).values(FIXTURE_CITIES);
  });

  it('fills city/state/country for rows with coords and no city', async () => {
    await db.insert(stravaActivities).values([
      makeActivity(1, { startLat: 45.515, startLng: -122.67 }),
      makeActivity(2, { startLat: 47.61, startLng: -122.33 }),
      makeActivity(3), // no coords: must be ignored
      makeActivity(4, {
        startLat: 45.515,
        startLng: -122.67,
        city: 'Portland',
        state: 'Oregon',
        country: 'United States',
      }), // already geocoded: must be ignored
    ]);

    const result = await geocodeStravaActivities(db);
    expect(result).toEqual({ updated: 2, remaining: 0 });

    const [a1] = await db
      .select()
      .from(stravaActivities)
      .where(eq(stravaActivities.stravaId, 1));
    expect(a1.city).toBe('Portland');
    expect(a1.state).toBe('Oregon');
    expect(a1.country).toBe('United States');

    const [a2] = await db
      .select()
      .from(stravaActivities)
      .where(eq(stravaActivities.stravaId, 2));
    expect(a2.city).toBe('Seattle');
    expect(a2.state).toBe('Washington');

    const [a3] = await db
      .select()
      .from(stravaActivities)
      .where(eq(stravaActivities.stravaId, 3));
    expect(a3.city).toBeNull();
  });

  it('respects the batch limit and reports remaining', async () => {
    await db
      .insert(stravaActivities)
      .values(
        [1, 2, 3].map((i) =>
          makeActivity(i, { startLat: 45.515, startLng: -122.67 })
        )
      );

    const result = await geocodeStravaActivities(db, 2);
    expect(result.updated).toBe(2);
    expect(result.remaining).toBe(1);

    const second = await geocodeStravaActivities(db, 2);
    expect(second.updated).toBe(1);
    expect(second.remaining).toBe(0);
  });

  it('leaves un-geocodable rows untouched and counts them as remaining', async () => {
    await db.insert(stravaActivities).values([
      makeActivity(1, { startLat: 30.0, startLng: -150.0 }), // mid-Pacific
      makeActivity(2, { startLat: 45.515, startLng: -122.67 }),
    ]);

    const result = await geocodeStravaActivities(db);
    expect(result.updated).toBe(1);
    expect(result.remaining).toBe(1);

    const [a1] = await db
      .select()
      .from(stravaActivities)
      .where(eq(stravaActivities.stravaId, 1));
    expect(a1.city).toBeNull();
  });
});
