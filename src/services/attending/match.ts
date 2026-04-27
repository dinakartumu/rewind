import { eq, and, like, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { venues, performers } from '../../db/schema/attending.js';
import { lastfmArtists } from '../../db/schema/lastfm.js';

// ─── Venue resolver ─────────────────────────────────────────────────
//
// resolveVenue(rawName) returns { venue_id, confidence }:
//   1.0 — exact match against venues.name
//   0.95 — alias match (case-insensitive substring inside aliases JSON)
//   0.5 — auto-created (we couldn't match; insert a new row)
//
// The auto-create path keeps the pipeline moving for unfamiliar venues
// (out-of-town games, new bars, typo'd names). Low confidence means
// the row is flagged for review during Phase 7's candidate-approval
// surface.
//
// Note: SQLite has no JSON_EACH index support in D1 yet, so we fetch
// all rows and match in memory. With ~tens of venues, that's fine.
// If it grows past a few hundred, switch to a normalized
// `venue_aliases` table.

export interface VenueMatch {
  venue_id: number;
  confidence: number;
  matched_via: 'name' | 'alias' | 'auto_created';
}

export async function resolveVenue(
  rawName: string,
  db: Database
): Promise<VenueMatch> {
  const cleanName = rawName.trim();
  if (!cleanName) {
    throw new Error('resolveVenue: empty name');
  }

  // The first calendar-event location we saw was "T-Mobile Park\nSeattle, WA".
  // Take just the venue name (first line / segment before comma).
  const venueOnly = extractVenueName(cleanName);

  // Reject obviously-not-a-venue inputs before they pollute the venues
  // table. Email parsers occasionally hand us body fragments
  // ("Please note: This email is not your ticket.", `<td align="left"`),
  // and the calendar extractor sometimes hands us street addresses from
  // unrelated meetings that hit the allowlist. We'd rather fail loudly
  // and fall back to enriched-side venue (e.g. MLB Stats `venue.name`)
  // than auto-create a junk row.
  if (looksLikeJunkVenue(venueOnly)) {
    throw new Error(
      `resolveVenue: input does not look like a venue: ${venueOnly.slice(0, 80)}`
    );
  }

  // Direct name match (case-insensitive)
  const allVenues = await db.select().from(venues).where(eq(venues.userId, 1));
  const cmp = venueOnly.toLowerCase();
  for (const v of allVenues) {
    if (v.name.toLowerCase() === cmp) {
      return { venue_id: v.id, confidence: 1.0, matched_via: 'name' };
    }
  }

  // Alias match
  for (const v of allVenues) {
    const aliases = parseAliases(v.aliases);
    for (const alias of aliases) {
      if (alias.toLowerCase() === cmp) {
        return { venue_id: v.id, confidence: 0.95, matched_via: 'alias' };
      }
    }
  }

  // Substring match (looser; catches "T-Mobile Park, Seattle" patterns
  // when extractVenueName didn't fully clean them).
  for (const v of allVenues) {
    if (cmp.includes(v.name.toLowerCase())) {
      return { venue_id: v.id, confidence: 0.85, matched_via: 'name' };
    }
    const aliases = parseAliases(v.aliases);
    for (const alias of aliases) {
      if (cmp.includes(alias.toLowerCase())) {
        return { venue_id: v.id, confidence: 0.8, matched_via: 'alias' };
      }
    }
  }

  // Auto-create
  const now = new Date().toISOString();
  const [created] = await db
    .insert(venues)
    .values({
      userId: 1,
      name: venueOnly,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: venues.id });

  return {
    venue_id: created.id,
    confidence: 0.5,
    matched_via: 'auto_created',
  };
}

/**
 * Extract just the venue name from a potentially multi-line / comma-laden
 * location string. Calendar events tend to use either:
 *   "T-Mobile Park\nSeattle, WA"
 *   "T-Mobile Park, Seattle, WA"
 *   "T-Mobile Park"
 * We take everything up to the first newline OR the first comma, whichever
 * comes first.
 */
export function extractVenueName(raw: string): string {
  const newlineIdx = raw.indexOf('\n');
  const commaIdx = raw.indexOf(',');
  let cutAt = -1;
  if (newlineIdx >= 0 && commaIdx >= 0) {
    cutAt = Math.min(newlineIdx, commaIdx);
  } else if (newlineIdx >= 0) {
    cutAt = newlineIdx;
  } else if (commaIdx >= 0) {
    cutAt = commaIdx;
  }
  return cutAt >= 0 ? raw.slice(0, cutAt).trim() : raw.trim();
}

/**
 * Heuristic gate to keep the `venues` table clean.
 *
 * Returns true when the input looks like an email body fragment, raw
 * HTML, a generic ticketing instruction, a bare street address, or
 * other non-venue text. False positives here are recoverable (the row
 * just doesn't get auto-created and the caller falls back to a sports
 * match's canonical venue), so the bar is "obviously not a venue."
 */
export function looksLikeJunkVenue(name: string): boolean {
  if (!name || name.length < 2) return true;
  // Anything over ~80 chars is almost certainly an email body excerpt.
  if (name.length > 80) return true;
  // HTML tags or attributes.
  if (/<[a-z][^>]*$|<\/?[a-z]+|style="|class="|src="/i.test(name)) return true;
  // Sentences ending with a period are language, not place names.
  // (Real venues don't end in periods: "T-Mobile Park", "Greek Theatre",
  // "Lumen Field". The seed list confirms this.)
  if (/[.!?]\s*$/.test(name)) return true;
  // Email-confirmation noise keywords. The `s?` plural suffix and the
  // `\b` word-boundary at the start let us catch both "ticket" and
  // "tickets", "transfer" and "transfers", etc.
  if (
    /\b(tickets?|emails?|orders?|transfers?|refunds?|reservations?|please respond|please note|electronic|do not reply|delivery|claim(ed)?)\b/i.test(
      name
    )
  ) {
    return true;
  }
  // Bare street addresses ("760 Market St", "1015 Folsom St",
  // "300 Occidental Ave S"). Match the street-type token mid-string,
  // allowing for a trailing directional ("S", "N", "Suite 12", etc.).
  if (
    /^\d+\s+[A-Z][a-z]+(\s+[A-Z][a-z]+)*\s+(St|Ave|Av|Blvd|Rd|Way|Ln|Dr|Ct|Pl|Pkwy|Hwy|Street|Avenue|Boulevard|Road|Lane|Drive)\.?\b/i.test(
      name
    )
  ) {
    return true;
  }
  return false;
}

function parseAliases(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Suppress unused-import warnings for and/like — kept for future
// query-side venue matching that uses them.
void and;
void like;
void sql;

// ─── Performer resolver ─────────────────────────────────────────────
//
// resolvePerformer(name, mbid) returns a performers row, creating one if
// needed. Critical step: the cross-domain probe — when no performer row
// exists, look in lastfm_artists for a name match, and if found create
// the performer with lastfm_artist_id set. That's how we wire up
// "concerts I went to by artists I scrobble" without manual linking.

export interface PerformerMatch {
  performer_id: number;
  matched_via: 'mbid' | 'name' | 'lastfm_cross_domain' | 'auto_created';
  lastfm_artist_id: number | null;
}

export async function resolvePerformer(
  name: string,
  mbid: string | null,
  db: Database
): Promise<PerformerMatch> {
  const cleanName = name.trim();
  if (!cleanName) throw new Error('resolvePerformer: empty name');

  // 1. mbid lookup (most precise)
  if (mbid) {
    const [byMbid] = await db
      .select()
      .from(performers)
      .where(and(eq(performers.userId, 1), eq(performers.mbid, mbid)))
      .limit(1);
    if (byMbid) {
      return {
        performer_id: byMbid.id,
        matched_via: 'mbid',
        lastfm_artist_id: byMbid.lastfmArtistId,
      };
    }
  }

  // 2. exact name lookup (case-insensitive)
  const allPerformers = await db
    .select()
    .from(performers)
    .where(eq(performers.userId, 1));
  const cmp = cleanName.toLowerCase();
  for (const p of allPerformers) {
    if (p.name.toLowerCase() === cmp) {
      return {
        performer_id: p.id,
        matched_via: 'name',
        lastfm_artist_id: p.lastfmArtistId,
      };
    }
  }

  // 3. cross-domain probe — does this name appear in lastfm_artists?
  // If yes, create a performers row linked to that artist.
  const [lastfmHit] = await db
    .select()
    .from(lastfmArtists)
    .where(
      and(
        eq(lastfmArtists.userId, 1),
        // Drizzle doesn't have lowercase comparison by default; use SQL.
        sql`lower(${lastfmArtists.name}) = ${cmp}`
      )
    )
    .limit(1);

  const now = new Date().toISOString();
  if (lastfmHit) {
    const [created] = await db
      .insert(performers)
      .values({
        userId: 1,
        name: cleanName,
        performerType: 'musical_artist',
        mbid: mbid ?? lastfmHit.mbid ?? null,
        lastfmArtistId: lastfmHit.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: performers.id });
    return {
      performer_id: created.id,
      matched_via: 'lastfm_cross_domain',
      lastfm_artist_id: lastfmHit.id,
    };
  }

  // 4. auto-create with no cross-link
  const [created] = await db
    .insert(performers)
    .values({
      userId: 1,
      name: cleanName,
      performerType: 'musical_artist',
      mbid: mbid ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: performers.id });
  return {
    performer_id: created.id,
    matched_via: 'auto_created',
    lastfm_artist_id: null,
  };
}
