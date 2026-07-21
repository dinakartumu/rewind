/**
 * Output schemas for the places-domain tools.
 *
 * These schemas are the source of truth for the places tools' return
 * shapes: `places.ts` derives its `Checkin` / `PlacesStats` payload types
 * from them via `z.infer`, so the declared schema and the TypeScript type
 * cannot drift.
 *
 * Every object schema uses `.passthrough()` so the JSON Schema advertised
 * to clients stays `additionalProperties`-open -- a field the Rewind API
 * adds later does not break client-side validation. See schemas/shared.ts.
 */
import { z } from 'zod';
import { paginationSchema } from './shared.js';

// --- Element schemas ------------------------------------------------------

/** A single Foursquare/Swarm check-in, as listed by get_recent_checkins. */
export const checkinSchema = z
  .object({
    id: z.number(),
    venue_id: z.string().nullable(),
    venue_name: z.string(),
    venue_category: z.string().nullable(),
    venue_icon: z.string().nullable(),
    venue_city: z.string().nullable(),
    venue_state: z.string().nullable(),
    venue_country: z.string().nullable(),
    lat: z.number().nullable(),
    lng: z.number().nullable(),
    checked_in_at: z.string(),
    shout: z.string().nullable(),
  })
  .passthrough();

/** A category leaderboard entry with its Foursquare icon URL. */
const categoryCountSchema = z
  .object({
    category: z.string(),
    count: z.number(),
    icon: z.string().nullable(),
  })
  .passthrough();

/** A city leaderboard entry. */
const cityCountSchema = z
  .object({
    city: z.string(),
    count: z.number(),
  })
  .passthrough();

/** A venue leaderboard entry with a representative icon and city. */
const venueCountSchema = z
  .object({
    venue_name: z.string(),
    count: z.number(),
    icon: z.string().nullable(),
    city: z.string().nullable(),
  })
  .passthrough();

// --- Tool output schemas --------------------------------------------------

/**
 * outputSchema for get_recent_checkins. The empty-state branch returns
 * `{ items: [], pagination }`, which satisfies the same schema -- no union
 * needed.
 */
export const recentCheckinsOutputSchema = z
  .object({
    items: z.array(checkinSchema),
    pagination: paginationSchema(),
  })
  .passthrough();

/**
 * outputSchema for get_places_stats (flat stats object passed through
 * verbatim from the API). `this_year` always counts the current UTC year
 * regardless of any date filters -- see /v1/places/stats.
 */
export const placesStatsOutputSchema = z
  .object({
    total: z.number(),
    unique_venues: z.number(),
    this_year: z.number(),
    top_categories: z.array(categoryCountSchema),
    top_cities: z.array(cityCountSchema),
    top_venues: z.array(venueCountSchema),
  })
  .passthrough();
