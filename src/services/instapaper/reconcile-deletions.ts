/**
 * Full-archive deletion reconciliation for Instapaper.
 *
 * The normal sync (syncReading) detects deletions via the `have=` parameter
 * on bookmarks/list — Instapaper returns a `delete` entry for any source_id
 * in `have=` that's no longer in the queried folder. The catch is that
 * bookmarks/list hard-caps at 500 items per call regardless of `have=`,
 * so for accounts with thousands of archived bookmarks the deletion signal
 * never reaches us for items outside that 500-item window. Items deleted
 * on Instapaper years ago can leak in our DB indefinitely.
 *
 * This module fixes that with an enumerate-and-reconcile pass:
 *   1. For each folder (default + user-defined), page through ALL bookmarks
 *      using `have=` as a rolling pagination cursor.
 *   2. Accumulate the union of source_ids seen across every folder.
 *   3. Any reading_items.source_id NOT in that union is truly deleted on
 *      Instapaper — purge from reading_items + images.
 *
 * Cost: ~ceil(total_bookmarks / 500) API calls per folder, plus rate-limit
 * pauses between calls. For a 19k-bookmark account that's ~40 calls; with
 * 200ms latency + Instapaper's recommended <1 req/sec pacing, the full
 * pass takes ~40-60s. Run weekly via cron.
 */

import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { readingItems } from '../../db/schema/reading.js';
import { images } from '../../db/schema/system.js';
import { InstapaperClient } from './client.js';

const PAGE_SIZE = 500;
// How many source_ids to send per `have=` chunk. The string format is
// "id:hash,id:hash,..." — at ~25 chars per entry, 1k chunks stays well
// under any sane URL/body cap and keeps each request snappy.
const HAVE_CHUNK = 1000;
// Soft cap on pages per folder so a runaway loop can't burn the whole
// Worker invocation on a single misbehaving folder. 80 * 500 = 40k items,
// well over realistic account sizes.
const MAX_PAGES_PER_FOLDER = 80;
// D1 caps bound parameters per query at 100. Chunk DELETE statements
// well under that — we burn 2 slots on the domain/entity_type filters,
// leaving 98 for the IN list. Round down to leave headroom.
const DELETE_CHUNK = 80;
// Refuse to delete more than this fraction of the user's reading_items
// in a single reconcile pass — guards against algorithm bugs (like the
// have=-without-hash bug that mass-flagged 95% of items as missing).
// If we hit this, abort with a clear error rather than silently wipe.
const MAX_PURGE_FRACTION = 0.1;

export interface ReconcileResult {
  foldersScanned: number;
  pagesFetched: number;
  bookmarksSeen: number;
  candidates: number;
  deleted: number;
  imagesDeleted: number;
  tookMs: number;
  abortedReason?: string;
}

/**
 * Walk every bookmark in a single folder using have= as a pagination
 * cursor. The Instapaper `have=` parameter is a comma-separated list of
 * `id:hash` pairs; the server omits items from the response whose hash
 * matches what the client already has. We capture each returned
 * bookmark's hash so subsequent pages naturally exclude what we've
 * already seen — without the hash, the server would re-send the same
 * 500 items every page and pagination would never advance.
 *
 * Returns the set of source_ids found in this folder.
 */
async function paginateFolder(
  client: InstapaperClient,
  folderId: string
): Promise<{ ids: Set<string>; pages: number }> {
  const seen = new Map<string, string>(); // bookmark_id -> hash
  let pages = 0;

  for (let page = 0; page < MAX_PAGES_PER_FOLDER; page++) {
    const haveStr =
      seen.size === 0
        ? undefined
        : Array.from(seen.entries())
            .map(([id, hash]) => `${id}:${hash}`)
            .join(',');
    const result = await client.listBookmarks({
      folderId,
      limit: PAGE_SIZE,
      have: haveStr,
    });
    pages++;

    if (result.bookmarks.length === 0) break;

    let newCount = 0;
    for (const b of result.bookmarks) {
      const id = String(b.bookmark_id);
      if (!seen.has(id)) newCount++;
      seen.set(id, b.hash);
    }

    // Defensive: if a page returned only items we already had (could happen
    // if a server-side change made hashes mismatch and the API re-sent
    // unchanged items), bail to avoid an infinite loop.
    if (newCount === 0) break;

    // Last page: server returned fewer than the cap → no more to fetch.
    if (result.bookmarks.length < PAGE_SIZE) break;
  }

  return { ids: new Set(seen.keys()), pages };
}

/**
 * Cross-check folder presence for a chunk of known source_ids. For each
 * folder, send the chunk as `have=` and inspect which IDs come back as
 * deletes vs bookmarks. An item is "still present somewhere" if any
 * folder returns it as a bookmark; otherwise the user has either deleted
 * it or it lives in a folder we didn't enumerate.
 *
 * This is a defense-in-depth check on top of paginateFolder — covers the
 * case where pagination missed an item due to server-side reordering or
 * concurrent writes during the scan.
 */
async function verifyChunk(
  client: InstapaperClient,
  folders: string[],
  chunk: string[]
): Promise<Set<string>> {
  const stillPresent = new Set<string>();
  for (const folderId of folders) {
    // For verification we use plain ids (no hash) so the server treats
    // every item as "I have an unknown version" — it'll then return
    // either the current bookmark (still in this folder) or a delete
    // entry (not here). Hash matching would let it omit unchanged
    // items from the response, defeating the check.
    const haveStr = chunk.join(',');
    const result = await client.listBookmarks({
      folderId,
      limit: PAGE_SIZE,
      have: haveStr,
    });
    for (const b of result.bookmarks) {
      stillPresent.add(String(b.bookmark_id));
    }
  }
  return stillPresent;
}

export async function reconcileReadingDeletions(
  db: Database,
  env: {
    INSTAPAPER_CONSUMER_KEY: string;
    INSTAPAPER_CONSUMER_SECRET: string;
    INSTAPAPER_ACCESS_TOKEN: string;
    INSTAPAPER_ACCESS_TOKEN_SECRET: string;
  }
): Promise<ReconcileResult> {
  const t0 = Date.now();
  const client = new InstapaperClient(
    env.INSTAPAPER_CONSUMER_KEY,
    env.INSTAPAPER_CONSUMER_SECRET,
    env.INSTAPAPER_ACCESS_TOKEN,
    env.INSTAPAPER_ACCESS_TOKEN_SECRET
  );

  // Enumerate every folder we know about.
  const customFolders = await client.listFolders();
  const folders = [
    'unread',
    'starred',
    'archive',
    ...customFolders.map((f) => String(f.folder_id)),
  ];

  // Pass 1 — paginate each folder and union the bookmark IDs seen.
  const seenAnywhere = new Set<string>();
  let pagesFetched = 0;
  for (const folderId of folders) {
    const { ids, pages } = await paginateFolder(client, folderId);
    pagesFetched += pages;
    for (const id of ids) seenAnywhere.add(id);
  }

  // What does our DB think exists?
  const dbRows = await db
    .select({ sourceId: readingItems.sourceId, id: readingItems.id })
    .from(readingItems)
    .where(
      and(eq(readingItems.source, 'instapaper'), eq(readingItems.userId, 1))
    );

  const dbBySourceId = new Map<string, number>();
  for (const r of dbRows) {
    if (r.sourceId) dbBySourceId.set(r.sourceId, r.id);
  }

  // Candidates: in our DB but not seen by pagination.
  const candidates: string[] = [];
  for (const sourceId of dbBySourceId.keys()) {
    if (!seenAnywhere.has(sourceId)) candidates.push(sourceId);
  }

  // Pass 2 — for each candidate, do a chunked verify across all folders.
  // Anything that comes back as a bookmark from any folder is a false
  // positive (pagination raced or skipped it); only purge items confirmed
  // missing from every folder.
  const stillPresentAnywhere = new Set<string>();
  for (let i = 0; i < candidates.length; i += HAVE_CHUNK) {
    const chunk = candidates.slice(i, i + HAVE_CHUNK);
    const found = await verifyChunk(client, folders, chunk);
    for (const id of found) stillPresentAnywhere.add(id);
  }

  // Purge.
  const toDeleteSourceIds = candidates.filter(
    (id) => !stillPresentAnywhere.has(id)
  );
  let deleted = 0;
  let imagesDeleted = 0;
  let abortedReason: string | undefined;

  // Safety guard: if reconciliation flags more than MAX_PURGE_FRACTION of
  // the DB for deletion, something is wrong with the algorithm or the
  // Instapaper API responses. Bail rather than wipe the user's archive.
  const purgeFraction =
    dbBySourceId.size === 0 ? 0 : toDeleteSourceIds.length / dbBySourceId.size;
  if (purgeFraction > MAX_PURGE_FRACTION) {
    abortedReason = `safety_abort: ${toDeleteSourceIds.length}/${dbBySourceId.size} items (${(purgeFraction * 100).toFixed(1)}%) flagged for deletion exceeds MAX_PURGE_FRACTION=${MAX_PURGE_FRACTION * 100}%; refusing to purge`;
  } else if (toDeleteSourceIds.length > 0) {
    // Chunk DELETE statements to stay under D1's 100-bound-param cap.
    const toDeleteRowIds = toDeleteSourceIds
      .map((sid) => dbBySourceId.get(sid))
      .filter((id): id is number => id !== undefined);
    const toDeleteRowIdStrs = toDeleteRowIds.map(String);

    for (let i = 0; i < toDeleteRowIdStrs.length; i += DELETE_CHUNK) {
      const chunk = toDeleteRowIdStrs.slice(i, i + DELETE_CHUNK);
      const imgResult = await db
        .delete(images)
        .where(
          and(
            eq(images.domain, 'reading'),
            eq(images.entityType, 'articles'),
            inArray(images.entityId, chunk)
          )
        );
      imagesDeleted += Number(
        (imgResult as { meta?: { changes?: number } }).meta?.changes ?? 0
      );
    }

    for (let i = 0; i < toDeleteSourceIds.length; i += DELETE_CHUNK) {
      const chunk = toDeleteSourceIds.slice(i, i + DELETE_CHUNK);
      const itemResult = await db
        .delete(readingItems)
        .where(
          and(
            eq(readingItems.source, 'instapaper'),
            eq(readingItems.userId, 1),
            inArray(readingItems.sourceId, chunk)
          )
        );
      deleted += Number(
        (itemResult as { meta?: { changes?: number } }).meta?.changes ?? 0
      );
    }
  }

  return {
    foldersScanned: folders.length,
    pagesFetched,
    bookmarksSeen: seenAnywhere.size,
    candidates: candidates.length,
    deleted,
    imagesDeleted,
    tookMs: Date.now() - t0,
    ...(abortedReason ? { abortedReason } : {}),
  };
}

// Re-export for tests.
export const __TEST__ = {
  paginateFolder,
  verifyChunk,
  PAGE_SIZE,
  HAVE_CHUNK,
};
