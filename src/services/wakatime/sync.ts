import { and, eq, gte, lt } from 'drizzle-orm';
import { createDb, type Database } from '../../db/client.js';
import {
  wakatimeDurations,
  wakatimeDailySummaries,
  wakatimeDailyLanguages,
} from '../../db/schema/wakatime.js';
import { syncRuns } from '../../db/schema/system.js';
import { WakatimeClient } from './client.js';
import type { Env } from '../../types/env.js';

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

  // Rebuild the day's duration rows.
  await db
    .delete(wakatimeDurations)
    .where(
      and(
        eq(wakatimeDurations.userId, userId),
        gte(wakatimeDurations.startTime, start),
        lt(wakatimeDurations.startTime, end)
      )
    );

  for (const d of durations) {
    await db.insert(wakatimeDurations).values({
      userId,
      startTime: d.startTime,
      durationSeconds: d.durationSeconds,
      project: d.project,
      language: d.language,
      entity: d.entity,
    });
  }

  // Rebuild the day's per-language rows from the Summaries API.
  await db
    .delete(wakatimeDailyLanguages)
    .where(
      and(
        eq(wakatimeDailyLanguages.userId, userId),
        eq(wakatimeDailyLanguages.date, date)
      )
    );

  for (const lang of summary.languages) {
    await db.insert(wakatimeDailyLanguages).values({
      userId,
      date,
      language: lang.name,
      totalSeconds: lang.totalSeconds,
    });
  }

  // Upsert the daily summary.
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
