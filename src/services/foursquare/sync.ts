import { eq, sql } from 'drizzle-orm';
import { createDb, type Database } from '../../db/client.js';
import { checkins } from '../../db/schema/places.js';
import { syncRuns } from '../../db/schema/system.js';
import { FoursquareClient, type FoursquareCheckin } from './client.js';
import { afterSync } from '../../lib/after-sync.js';
import type { FeedItem, SearchItem } from '../../lib/after-sync.js';
import type { Env } from '../../types/env.js';
import { reconcileCheckinIcons } from './category-icons.js';

const PAGE_SIZE = 250;
const DEFAULT_MAX_PAGES = 8;

export interface SyncedCheckin {
  foursquareId: string;
  venueId: string;
  venueName: string;
  venueCity: string | null;
  checkedInAt: string;
}

export function buildCheckinFeedItem(c: SyncedCheckin): FeedItem {
  return {
    domain: 'places',
    eventType: 'checkin',
    occurredAt: c.checkedInAt,
    title: `Checked in at ${c.venueName}`,
    sourceId: `foursquare:checkin:${c.foursquareId}`,
  };
}

/**
 * Primary category, falling back to the first listed category.
 */
function primaryCategory(item: FoursquareCheckin) {
  const categories = item.venue?.categories;
  if (!categories || categories.length === 0) return null;
  return categories.find((c) => c.primary) ?? categories[0];
}

/** 64px icon URL composed from the category's prefix/suffix parts. */
function categoryIconUrl(
  category: ReturnType<typeof primaryCategory>
): string | null {
  const icon = category?.icon;
  if (!icon) return null;
  return `${icon.prefix}64${icon.suffix}`;
}

export interface CheckinSyncOptions {
  maxPages?: number;
  /** Batch size for the offset walk. Defaults to the API max of 250. */
  pageSize?: number;
}

export interface CheckinSyncResult {
  synced: number;
  skipped: number;
  remaining: number;
  newCheckins: SyncedCheckin[];
}

/**
 * Bounded, resumable end-anchored walk of the Foursquare checkin history.
 *
 * The v2 checkins feed is ALWAYS newest-first — the API ignores its sort
 * parameter (verified empirically) — so the walk anchors to the END of
 * the feed. Each batch fetches the oldest not-yet-stored window,
 * `offset = apiCount - localCount - limit` (limit clamped at the offset-0
 * boundary so windows never overlap), and moves from the deepest offset
 * toward 0. Page items arrive newest-first and are sorted by createdAt
 * ascending before insert so insert order stays chronological.
 *
 * The cursor is simply the local COUNT of stored checkins for the user.
 * Legacy checkins with no venue are inserted too (null venue fields,
 * excluded from feed/search output) so the count tracks the API frontier
 * exactly. New checkins arriving mid-walk prepend at offset 0 and do not
 * shift end-anchored offsets (apiCount refreshes from every response);
 * the final offset-0 batch may still interleave with a brand-new checkin,
 * in which case the unique foursquare_id index dedups the re-fetch, with
 * `meta.changes` guarding the counts (the episode-sync lesson).
 */
export async function syncCheckins(
  db: Database,
  client: FoursquareClient,
  userId: number,
  options: CheckinSyncOptions = {}
): Promise<CheckinSyncResult> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const pageSize = options.pageSize ?? PAGE_SIZE;

  const [cursor] = await db
    .select({ count: sql<number>`count(*)` })
    .from(checkins)
    .where(eq(checkins.userId, userId));
  let localCount = cursor?.count ?? 0;

  // Probe the newest page for the API's total count; items are ignored.
  const probe = await client.getCheckins({ offset: 0, limit: 1 });
  let apiCount = probe.count;

  console.log(
    `[SYNC] Foursquare end-anchored walk: ${localCount} stored of ${apiCount} total`
  );

  let synced = 0;
  let skipped = 0;
  const newCheckins: SyncedCheckin[] = [];

  for (let page = 0; page < maxPages; page++) {
    const unfetched = apiCount - localCount;
    if (unfetched <= 0) break;
    const limit = Math.min(pageSize, unfetched);
    const offset = unfetched - limit;

    const result = await client.getCheckins({ offset, limit });
    // Refresh so prepends at offset 0 don't shift later tail offsets.
    apiCount = result.count;
    if (result.items.length === 0) break;

    // The page is newest-first; insert oldest-first so autoincrement ids
    // follow chronology.
    const items = [...result.items].sort((a, b) => a.createdAt - b.createdAt);

    let inserted = 0;
    for (const item of items) {
      const venue = item.venue;
      const checkedInAt = new Date(item.createdAt * 1000).toISOString();
      const category = primaryCategory(item);
      const insertResult = await db
        .insert(checkins)
        .values({
          userId,
          foursquareId: item.id,
          venueId: venue?.id ?? null,
          venueName: venue?.name ?? item.shout ?? 'Unknown venue',
          venueCategory: category?.name ?? null,
          venueIcon: categoryIconUrl(category),
          venueCity: venue?.location?.city ?? null,
          venueState: venue?.location?.state ?? null,
          venueCountry: venue?.location?.country ?? null,
          lat: venue?.location?.lat ?? null,
          lng: venue?.location?.lng ?? null,
          checkedInAt,
          shout: item.shout ?? null,
        })
        .onConflictDoNothing();

      // Conflict on idx_checkins_foursquare_id: an interleaved re-fetch
      // of an already-stored checkin. Count as skipped for truthful
      // totals.
      if (insertResult.meta.changes === 0) {
        skipped++;
        continue;
      }

      inserted++;
      localCount++;
      synced++;

      // Venueless legacy checkins are stored for cursor integrity but
      // emit no feed/search items.
      if (venue) {
        newCheckins.push({
          foursquareId: item.id,
          venueId: venue.id,
          venueName: venue.name,
          venueCity: venue.location?.city ?? null,
          checkedInAt,
        });
      }
    }

    // A batch of pure dupes means localCount didn't advance and the next
    // window would be identical — stop instead of spinning to maxPages.
    if (inserted === 0) break;
  }

  const remaining = Math.max(0, apiCount - localCount);
  return { synced, skipped, remaining, newCheckins };
}

/**
 * Places domain sync entrypoint: bounded Foursquare checkin batch with
 * sync_runs lifecycle and feed/search side effects. Returns remaining so
 * the admin route's caller can loop until 0.
 */
export async function syncPlaces(
  env: Env,
  options: CheckinSyncOptions = {},
  userId: number = 1
): Promise<{ synced: number; remaining: number }> {
  const db = createDb(env.DB);
  const startedAt = new Date().toISOString();

  const [run] = await db
    .insert(syncRuns)
    .values({
      userId,
      domain: 'places',
      syncType: 'foursquare',
      status: 'running',
      startedAt,
      itemsSynced: 0,
    })
    .returning({ id: syncRuns.id });

  try {
    const accessToken = env.FOURSQUARE_ACCESS_TOKEN;
    if (!accessToken) {
      throw new Error('FOURSQUARE_ACCESS_TOKEN is not configured');
    }
    const client = new FoursquareClient(accessToken);

    const result = await syncCheckins(db, client, userId, options);

    // Mirror category glyphs to our CDN and rewrite any rows still pointing at
    // the raw 4sqi host (new inserts + any left behind by earlier syncs).
    // Isolated so an icon-mirror hiccup never fails the check-in sync.
    try {
      const { mirrored } = await reconcileCheckinIcons(env, db, userId);
      if (mirrored > 0) {
        console.log(`[SYNC] Foursquare mirrored ${mirrored} category icon(s)`);
      }
    } catch (iconErr) {
      console.log(
        `[ERROR] Foursquare icon mirror failed: ${iconErr instanceof Error ? iconErr.message : String(iconErr)}`
      );
    }

    await db
      .update(syncRuns)
      .set({
        status: 'completed',
        completedAt: new Date().toISOString(),
        itemsSynced: result.synced,
        metadata: JSON.stringify({
          skipped: result.skipped,
          remaining: result.remaining,
        }),
      })
      .where(eq(syncRuns.id, run.id));

    const feedItems: FeedItem[] = result.newCheckins.map(buildCheckinFeedItem);
    // One search item per venue: upsertSearchIndexBatch replaces on
    // (domain, entity_type, entity_id), so cross-run repeats are safe —
    // dedup here only avoids same-batch churn.
    const seenVenues = new Set<string>();
    const searchItems: SearchItem[] = [];
    for (const c of result.newCheckins) {
      if (seenVenues.has(c.venueId)) continue;
      seenVenues.add(c.venueId);
      searchItems.push({
        domain: 'places',
        entityType: 'venue',
        entityId: c.venueId,
        title: c.venueName,
        subtitle: c.venueCity ?? undefined,
      });
    }
    await afterSync(db, { domain: 'places', feedItems, searchItems });

    console.log(
      `[SYNC] Foursquare checkin batch complete: ${result.synced} synced, ${result.skipped} skipped, ${result.remaining} remaining`
    );
    return { synced: result.synced, remaining: result.remaining };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.log(`[ERROR] Foursquare sync failed: ${errorMsg}`);
    await db
      .update(syncRuns)
      .set({
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: errorMsg,
      })
      .where(eq(syncRuns.id, run.id));
    throw err;
  }
}
