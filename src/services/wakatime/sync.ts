import { and, eq, gte, lt } from 'drizzle-orm';
import { createDb, type Database } from '../../db/client.js';
import {
  wakatimeDurations,
  wakatimeDailySummaries,
  wakatimeDailyLanguages,
} from '../../db/schema/wakatime.js';
import { syncRuns } from '../../db/schema/system.js';
import { chunkForInsertValues } from '../../lib/d1-chunk.js';
import { WakatimeClient, WakatimeHistoryLimitError } from './client.js';
import type { Env } from '../../types/env.js';

/** Result of one bounded backfill chunk. */
export interface BackfillChunkResult {
  itemsSynced: number;
  /** The next cursor to resume from, or null when the walk is complete. */
  nextCursor: string | null;
}

/** Days fetched per WakaTime backfill invocation. */
const WAKATIME_BACKFILL_CHUNK_DAYS = 14;

/**
 * Thrown when the backfill cursor is malformed (not a YYYY-MM-DD date string).
 * The admin-sync route maps this to a 400 (client error — a bad resume token),
 * not a 500.
 */
export class WakatimeBackfillCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WakatimeBackfillCursorError';
  }
}

/** Accepts only calendar dates in YYYY-MM-DD form. */
const CURSOR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface WakatimeDaySyncResult {
  synced: number;
  totalSeconds: number;
  topLanguage: string | null;
  topProject: string | null;
}

/** Half-open UTC bounds [dateT00:00:00.000Z, nextDayT00:00:00.000Z). */
function dayBounds(date: string): { start: string; end: string } {
  const start = `${date}T00:00:00.000Z`;
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return { start, end: next.toISOString() };
}

/**
 * Sync one day. Delete + reinsert (NOT onConflictDoNothing) the day's
 * duration and language rows, then upsert the daily summary. Delete+reinsert
 * because today's slices GROW as the day progresses — a re-fetched slice has
 * the same start_time but a larger duration, so the stored value must be
 * replaced, and languages/summary must reflect the latest totals.
 *
 * @param date YYYY-MM-DD (UTC)
 */
export async function syncWakatimeDay(
  db: Database,
  client: WakatimeClient,
  date: string,
  userId = 1
): Promise<WakatimeDaySyncResult> {
  const { start, end } = dayBounds(date);

  const [rawDurations, summary] = await Promise.all([
    client.getDurations(date),
    client.getSummary(date),
  ]);

  // The Durations API can return multiple slices whose rounded start_time
  // collides on the same (project, entity) — inserting both would violate the
  // unique index and abort the batch. Dedup on the unique key, keeping the LAST
  // occurrence (mirroring the delete+reinsert "latest wins" semantics: a slice
  // re-observed later carries its grown duration).
  const bySlice = new Map<string, (typeof rawDurations)[number]>();
  for (const d of rawDurations) {
    bySlice.set(
      `${d.startTime}\u0000${d.project ?? ''}\u0000${d.entity ?? ''}`,
      d
    );
  }
  const durations = [...bySlice.values()];

  // Detail rows go in as MULTI-ROW VALUES inserts, chunked under D1's
  // parameter cap (chunkForInsertValues). We deliberately do NOT emit one
  // INSERT statement per slice: a heavy entity-sliced day can carry many
  // hundreds of slices, and a db.batch() of hundreds of statements blows D1's
  // per-batch CPU limit (the "D1 DB exceeded its CPU time limit and was reset"
  // failure seen deterministically during the coding backfill).
  //
  // TRADEOFF: strict single-batch atomicity is no longer possible for huge
  // days — the rebuild may span multiple batches. We preserve SAFE ORDERING
  // instead: deletes FIRST, then all insert chunks, then the summary/language
  // reconciliation LAST. If a mid-rebuild batch fails, the day is left
  // partially inserted; the next idempotent re-sync (delete + reinsert)
  // repairs it, so no double-counting or stale data survives a retry.
  const durationRows = durations.map((d) => ({
    userId,
    startTime: d.startTime,
    durationSeconds: d.durationSeconds,
    project: d.project,
    language: d.language,
    entity: d.entity,
  }));
  const languageRows = summary.languages.map((lang) => ({
    userId,
    date,
    language: lang.name,
    totalSeconds: lang.totalSeconds,
  }));

  const durationChunks = [...chunkForInsertValues(durationRows, 6)];
  const languageChunks = [...chunkForInsertValues(languageRows, 4)];

  // Primary batch: both deletes first, then the FIRST duration insert chunk
  // (when present). Keeping the deletes + first chunk atomic covers the common
  // small-day case in a single round-trip. Additional chunks follow in
  // sequence, preserving delete-before-insert ordering.
  const primary = [
    // Clear the day's duration rows (UTC window).
    db
      .delete(wakatimeDurations)
      .where(
        and(
          eq(wakatimeDurations.userId, userId),
          gte(wakatimeDurations.startTime, start),
          lt(wakatimeDurations.startTime, end)
        )
      ),
    // Clear the day's per-language rows.
    db
      .delete(wakatimeDailyLanguages)
      .where(
        and(
          eq(wakatimeDailyLanguages.userId, userId),
          eq(wakatimeDailyLanguages.date, date)
        )
      ),
    ...(durationChunks.length > 0
      ? [db.insert(wakatimeDurations).values(durationChunks[0])]
      : []),
  ];
  // The two deletes guarantee at least one element, satisfying db.batch's
  // non-empty-tuple signature.
  await db.batch(primary as [(typeof primary)[number]]);

  // Remaining duration chunks (heavy days only): insert after the deletes have
  // committed, in order.
  for (const chunk of durationChunks.slice(1)) {
    await db.insert(wakatimeDurations).values(chunk);
  }

  // Language rows and the summary upsert go LAST so the day's rollup is only
  // reconciled once its detail rows are in place.
  for (const chunk of languageChunks) {
    await db.insert(wakatimeDailyLanguages).values(chunk);
  }
  await db
    .insert(wakatimeDailySummaries)
    .values({
      userId,
      date,
      totalSeconds: summary.totalSeconds,
      topLanguage: summary.topLanguage,
      topProject: summary.topProject,
    })
    .onConflictDoUpdate({
      target: [wakatimeDailySummaries.userId, wakatimeDailySummaries.date],
      set: {
        totalSeconds: summary.totalSeconds,
        topLanguage: summary.topLanguage,
        topProject: summary.topProject,
      },
    });

  return {
    synced: durations.length,
    totalSeconds: summary.totalSeconds,
    topLanguage: summary.topLanguage,
    topProject: summary.topProject,
  };
}

/** UTC YYYY-MM-DD for a Date. */
function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The day (YYYY-MM-DD) one calendar day before the given YYYY-MM-DD (UTC). */
function previousDay(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return utcDate(d);
}

/**
 * One bounded WakaTime backfill chunk: syncs up to
 * WAKATIME_BACKFILL_CHUNK_DAYS days walking BACKWARD from `cursor` (the next
 * date to fetch). Defaults the start cursor to yesterday (UTC).
 *
 * The next cursor is the day immediately before the last day fetched — the
 * caller loops, passing it back, until nextCursor is null. The walk terminates
 * (nextCursor null) when:
 *   - the cursor walks below the account's data floor
 *     (`getAllTimeSinceToday().startDate`) — there is nothing older to fetch;
 *     this is the primary terminator and is gap-proof (a multi-week vacation
 *     no longer looks like the end of history), or
 *   - a WakatimeHistoryLimitError (402) is hit — the free-plan history window
 *     has been walked past.
 *
 * Empty-chunk termination is used ONLY as a fallback when no floor is available
 * (a brand-new/empty account whose all_time_since_today carries no start_date).
 * With a floor present, an empty chunk above the floor keeps walking, so
 * vacation gaps do not silently truncate the backfill.
 *
 * @param cursor YYYY-MM-DD next day to fetch; defaults to yesterday (UTC).
 */
export async function backfillWakatime(
  env: Env,
  cursor?: string
): Promise<BackfillChunkResult> {
  // Validate the cursor FIRST: a bad resume token is a client error (400) and
  // must surface regardless of credential state, so it isn't masked by a
  // missing-key 500.
  if (cursor !== undefined && !CURSOR_DATE_RE.test(cursor)) {
    throw new WakatimeBackfillCursorError(
      `Invalid backfill cursor (expected YYYY-MM-DD): ${cursor}`
    );
  }

  const apiKey = env.WAKATIME_API_KEY;
  if (!apiKey) {
    throw new Error('WAKATIME_API_KEY is not configured');
  }
  const client = new WakatimeClient(apiKey);
  const db = createDb(env.DB);

  // Account data floor, fetched once per invocation. null = no floor known;
  // fall back to empty-chunk termination in that case only.
  const { startDate } = await client.getAllTimeSinceToday();

  let day =
    cursor ??
    (() => {
      const yesterday = new Date();
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      return utcDate(yesterday);
    })();

  let itemsSynced = 0;
  let daysFetched = 0;

  for (let i = 0; i < WAKATIME_BACKFILL_CHUNK_DAYS; i++) {
    // With a known floor, terminate once the cursor drops below it rather than
    // fetching pre-history days (which would return empty and, without the
    // floor, be mistaken for the end of history after a gap).
    if (startDate !== null && day < startDate) {
      console.log(
        `[SYNC] WakaTime backfill: cursor ${day} passed data floor ${startDate}; stopping`
      );
      return { itemsSynced, nextCursor: null };
    }

    try {
      const result = await syncWakatimeDay(db, client, day);
      itemsSynced += result.synced;
    } catch (err) {
      if (err instanceof WakatimeHistoryLimitError) {
        // Past the accessible history window: terminal.
        console.log(
          `[SYNC] WakaTime backfill reached history limit at ${day}; stopping`
        );
        return { itemsSynced, nextCursor: null };
      }
      throw err;
    }
    daysFetched += 1;
    day = previousDay(day);
  }

  // No floor available: fall back to treating a fully-empty chunk as the end of
  // history. (With a floor, we never rely on this — the floor check above ends
  // the walk instead, so vacation gaps keep walking.)
  if (startDate === null && itemsSynced === 0) {
    console.log(
      `[SYNC] WakaTime backfill: no data floor and ${daysFetched} consecutive empty days; stopping`
    );
    return { itemsSynced, nextCursor: null };
  }

  return { itemsSynced, nextCursor: day };
}

/**
 * Coding domain WakaTime sync entrypoint: sync_runs lifecycle (domain
 * 'coding', syncType 'wakatime'). Syncs yesterday + today (UTC) so today's
 * still-growing slices are refreshed and yesterday is finalized.
 */
export async function syncWakatime(
  env: Env,
  userId = 1
): Promise<{ synced: number }> {
  const db = createDb(env.DB);
  const startedAt = new Date().toISOString();

  const [run] = await db
    .insert(syncRuns)
    .values({
      userId,
      domain: 'coding',
      syncType: 'wakatime',
      status: 'running',
      startedAt,
      itemsSynced: 0,
    })
    .returning({ id: syncRuns.id });

  try {
    const apiKey = env.WAKATIME_API_KEY;
    if (!apiKey) {
      throw new Error('WAKATIME_API_KEY is not configured');
    }
    const client = new WakatimeClient(apiKey);

    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const days = [utcDate(yesterday), utcDate(now)];

    let synced = 0;
    const perDay: Record<string, number> = {};
    for (const day of days) {
      const result = await syncWakatimeDay(db, client, day, userId);
      synced += result.synced;
      perDay[day] = result.totalSeconds;
    }

    await db
      .update(syncRuns)
      .set({
        status: 'completed',
        completedAt: new Date().toISOString(),
        itemsSynced: synced,
        metadata: JSON.stringify({ perDayTotalSeconds: perDay }),
      })
      .where(eq(syncRuns.id, run.id));

    console.log(
      `[SYNC] WakaTime sync complete: ${synced} duration slices across ${days.length} day(s)`
    );
    return { synced };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.log(`[ERROR] WakaTime sync failed: ${errorMsg}`);
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
