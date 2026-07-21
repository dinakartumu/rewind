import {
  integer,
  real,
  sqliteTable,
  text,
  index,
} from 'drizzle-orm/sqlite-core';

/**
 * Offline reverse-geocoding reference table, seeded from the GeoNames
 * cities15000 dump (~33k cities with population >= 15,000) via
 * scripts/tools/seed-geo-cities.ts. `id` is the GeoNames geonameid.
 *
 * Nearest-city lookup is a bounding-box scan on the lat index plus a
 * haversine distance sort in JS (see src/services/geo/reverse-geocode.ts).
 */
export const geoCities = sqliteTable(
  'geo_cities',
  {
    /** GeoNames geonameid (stable across re-seeds). */
    id: integer('id').primaryKey(),
    name: text('name').notNull(),
    /** Readable first-level admin division (state/region), e.g. "Oregon". */
    admin1: text('admin1'),
    /** ISO 3166-1 alpha-2 country code, e.g. "US". */
    countryCode: text('country_code').notNull(),
    lat: real('lat').notNull(),
    lng: real('lng').notNull(),
  },
  (table) => [index('idx_geo_cities_lat').on(table.lat)]
);
