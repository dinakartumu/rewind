/**
 * Offline reverse geocoding against the geo_cities reference table
 * (GeoNames cities15000, seeded by scripts/tools/seed-geo-cities.ts).
 *
 * Lookup strategy: bounding-box SQL query (+/- BOX_DEGREES around the
 * point, using the lat index) then a haversine distance sort in JS.
 * Returns null when the box is empty — no fallback to a wider search,
 * so results are always within ~66 km of a known city.
 */
import { and, gte, lte, isNull, isNotNull, sql, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { geoCities } from '../../db/schema/geo.js';
import { stravaActivities } from '../../db/schema/strava.js';

/** Bounding-box half-width in degrees (~66 km of latitude). */
const BOX_DEGREES = 0.6;

export interface GeocodedLocation {
  city: string;
  state: string | null;
  country: string;
}

/** Great-circle distance in kilometers. */
export function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * ISO 3166-1 alpha-2 code -> English country name. Uses Intl.DisplayNames
 * (full ICU is available in workerd); falls back to the raw code if the
 * runtime can't resolve it.
 */
export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * Nearest-city lookup. Returns null when no city falls inside the
 * +/- BOX_DEGREES bounding box around the point.
 */
export async function reverseGeocode(
  db: Database,
  lat: number,
  lng: number
): Promise<GeocodedLocation | null> {
  const candidates = await db
    .select({
      name: geoCities.name,
      admin1: geoCities.admin1,
      countryCode: geoCities.countryCode,
      lat: geoCities.lat,
      lng: geoCities.lng,
    })
    .from(geoCities)
    .where(
      and(
        gte(geoCities.lat, lat - BOX_DEGREES),
        lte(geoCities.lat, lat + BOX_DEGREES),
        gte(geoCities.lng, lng - BOX_DEGREES),
        lte(geoCities.lng, lng + BOX_DEGREES)
      )
    );

  if (candidates.length === 0) return null;

  let nearest = candidates[0];
  let nearestKm = haversineKm(lat, lng, nearest.lat, nearest.lng);
  for (const candidate of candidates.slice(1)) {
    const km = haversineKm(lat, lng, candidate.lat, candidate.lng);
    if (km < nearestKm) {
      nearest = candidate;
      nearestKm = km;
    }
  }

  return {
    city: nearest.name,
    state: nearest.admin1,
    country: countryName(nearest.countryCode),
  };
}

/**
 * Backfill city/state/country on strava_activities rows that have start
 * coordinates but no city yet. Processes up to `limit` rows per call.
 *
 * Returns { updated, remaining }: `remaining` counts every row still
 * matching (start_lat NOT NULL AND city IS NULL) after the batch, which
 * includes rows whose bounding box was empty — those stay null and are
 * retried on later calls (harmless: same cheap indexed query).
 */
export async function geocodeStravaActivities(
  db: Database,
  limit = 200
): Promise<{ updated: number; remaining: number }> {
  const pendingCondition = and(
    isNotNull(stravaActivities.startLat),
    isNull(stravaActivities.city)
  );

  const rows = await db
    .select({
      id: stravaActivities.id,
      startLat: stravaActivities.startLat,
      startLng: stravaActivities.startLng,
    })
    .from(stravaActivities)
    .where(pendingCondition)
    .limit(limit);

  let updated = 0;
  for (const row of rows) {
    if (row.startLat === null || row.startLng === null) continue;
    const location = await reverseGeocode(db, row.startLat, row.startLng);
    if (!location) continue;

    await db
      .update(stravaActivities)
      .set({
        city: location.city,
        state: location.state,
        country: location.country,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(stravaActivities.id, row.id));
    updated++;
  }

  const [remainingRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(stravaActivities)
    .where(pendingCondition);

  return { updated, remaining: remainingRow?.count ?? 0 };
}
