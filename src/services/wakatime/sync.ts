import { and, eq, gte, lt } from 'drizzle-orm';
import { createDb, type Database } from '../../db/client.js';
import {
  wakatimeDurations,
  wakatimeDailySummaries,
  wakatimeDailyLanguages,
} from '../../db/schema/wakatime.js';
import { syncRuns } from '../../db/schema/system.js';
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

  const [durations, summary] = await Promise.all([
    client.getDurations(date),
    client.getSummary(date),
  ]);

  // Rebuild the whole day in one db.batch() so it runs as an implicit D1
  // transaction (all-or-nothing) and in a single round-trip. Order matters:
  // delete both tables first, then reinsert, then upsert the summary.
  const statements = [
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
    // Reinsert duration rows.
    ...durations.map((d) =>
      db.insert(wakatimeDurations).values({
        userId,
        startTime: d.startTime,
        durationSeconds: d.durationSeconds,
        project: d.project,
        language: d.language,
        entity: d.entity,
      })
    ),
    // Reinsert per-language rows from the Summaries API.
    ...summary.languages.map((lang) =>
      db.insert(wakatimeDailyLanguages).values({
        userId,
        date,
        language: lang.name,
        totalSeconds: lang.totalSeconds,
      })
    ),
    // Upsert the daily summary.
    db
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
      }),
  ];

  // The two deletes guarantee at least one element, satisfying db.batch's
  // non-empty-tuple signature.
  await db.batch(statements as [(typeof statements)[number]]);

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
 *   - a WakatimeHistoryLimitError (402) is hit — the free-plan history window
 *     has been walked past; there is nothing older to fetch, or
 *   - the whole chunk of WAKATIME_BACKFILL_CHUNK_DAYS days was empty — no data
 *     that far back, treat it as the end of history.
 *
 * @param cursor YYYY-MM-DD next day to fetch; defaults to yesterday (UTC).
 */
export async function backfillWakatime(
  env: Env,
  cursor?: string
): Promise<BackfillChunkResult> {
  const apiKey = env.WAKATIME_API_KEY;
  if (!apiKey) {
    throw new Error('WAKATIME_API_KEY is not configured');
  }
  const client = new WakatimeClient(apiKey);
  const db = createDb(env.DB);

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

  // A fully-empty chunk means we have walked past all available data.
  if (itemsSynced === 0) {
    console.log(
      `[SYNC] WakaTime backfill: ${daysFetched} consecutive empty days; stopping`
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
