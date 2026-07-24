import { and, eq, gte, lt } from 'drizzle-orm';
import { createDb, type Database } from '../../db/client.js';
import {
  rescuetimeActivities,
  rescuetimeDailySummaries,
} from '../../db/schema/rescuetime.js';
import { syncRuns } from '../../db/schema/system.js';
import { RescuetimeClient } from './client.js';
import type { Env } from '../../types/env.js';

/** Result of one bounded backfill chunk. */
export interface BackfillChunkResult {
  itemsSynced: number;
  /** The next cursor to resume from, or null when the walk is complete. */
  nextCursor: string | null;
}

/** Days fetched per RescueTime backfill invocation (one month). */
const RESCUETIME_BACKFILL_CHUNK_DAYS = 30;

/**
 * Thrown when the backfill cursor is malformed (not a YYYY-MM-DD date string).
 * The admin-sync route maps this to a 400 (client error — a bad resume token),
 * not a 500.
 */
export class RescuetimeBackfillCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RescuetimeBackfillCursorError';
  }
}

/** Accepts only calendar dates in YYYY-MM-DD form. */
const CURSOR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface RescuetimeDaySyncResult {
  synced: number;
  totalSeconds: number;
}

/**
 * Half-open bounds for a stored-timestamp window [dateT00:00:00.000Z,
 * nextDayT00:00:00.000Z). RescueTime timestamps are account-local wall-clock
 * strings with '.000Z' appended (see client.ts), and the day key is the date
 * part of those strings, so plain lexicographic string compares on the stored
 * text bound the day correctly.
 */
function dayBounds(date: string): { start: string; end: string } {
  const start = `${date}T00:00:00.000Z`;
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return { start, end: next.toISOString() };
}

interface LevelSums {
  totalSeconds: number;
  veryProductive: number;
  productive: number;
  neutral: number;
  distracting: number;
  veryDistracting: number;
}

/** Sum activity durations into RescueTime productivity levels (2..-2). */
function rollupLevels(
  activities: { durationSeconds: number; productivity: number }[]
): LevelSums {
  const sums: LevelSums = {
    totalSeconds: 0,
    veryProductive: 0,
    productive: 0,
    neutral: 0,
    distracting: 0,
    veryDistracting: 0,
  };
  for (const a of activities) {
    sums.totalSeconds += a.durationSeconds;
    switch (a.productivity) {
      case 2:
        sums.veryProductive += a.durationSeconds;
        break;
      case 1:
        sums.productive += a.durationSeconds;
        break;
      case 0:
        sums.neutral += a.durationSeconds;
        break;
      case -1:
        sums.distracting += a.durationSeconds;
        break;
      case -2:
        sums.veryDistracting += a.durationSeconds;
        break;
      default:
        // Out-of-range productivity value: route to neutral so the level
        // buckets always sum to totalSeconds.
        sums.neutral += a.durationSeconds;
        break;
    }
  }
  return sums;
}

/**
 * Sync one day. Delete + reinsert (NOT onConflictDoNothing) the day's activity
 * rows, then upsert the daily summary computed FROM the fetched rows. Delete+
 * reinsert because today's 5-minute buckets keep arriving as the day
 * progresses, so the whole day must reflect the latest fetch.
 *
 * A day with no activity rows writes NO summary row (mirroring the "no feed
 * row for empty days" philosophy): the whole day is rebuilt from scratch, and
 * an empty day contributes nothing. When a previously-populated day comes back
 * empty, its stale summary row is DELETED so the summary never outlives its
 * activities.
 *
 * @param date YYYY-MM-DD
 * @param pulseByDate map of date -> productivity pulse (from the feed API);
 *   pulse is null when the date is absent (feed only covers ~2 recent weeks).
 */
export async function syncRescuetimeDay(
  db: Database,
  client: RescuetimeClient,
  date: string,
  pulseByDate: Map<string, number> = new Map(),
  userId = 1
): Promise<RescuetimeDaySyncResult> {
  const { start, end } = dayBounds(date);
  const rawActivities = await client.getActivities(date);

  // The Analytic Data API can return rows colliding on (timestamp, activity) —
  // inserting both would violate the unique index and abort the batch. Dedup on
  // the unique key, keeping the LAST occurrence, so the rollup and the persisted
  // rows agree (no double-counting a bucket that appears twice).
  const bySlot = new Map<string, (typeof rawActivities)[number]>();
  for (const a of rawActivities) {
    bySlot.set(`${a.timestamp} ${a.activity}`, a);
  }
  const activities = [...bySlot.values()];
  const levels = rollupLevels(activities);
  const pulse = pulseByDate.has(date) ? pulseByDate.get(date)! : null;

  // Rebuild the whole day in one db.batch() so it runs as an implicit D1
  // transaction (all-or-nothing) and in a single round-trip. Delete the
  // activity window first, then reinsert, then reconcile the summary. When
  // there is data, upsert the summary; when the day is empty, DELETE any
  // stale summary row so it never outlives its activities.
  const summaryStatements =
    activities.length > 0
      ? [
          db
            .insert(rescuetimeDailySummaries)
            .values({
              userId,
              date,
              totalSeconds: levels.totalSeconds,
              productivityPulse: pulse,
              veryProductiveSeconds: levels.veryProductive,
              productiveSeconds: levels.productive,
              neutralSeconds: levels.neutral,
              distractingSeconds: levels.distracting,
              veryDistractingSeconds: levels.veryDistracting,
            })
            .onConflictDoUpdate({
              target: [
                rescuetimeDailySummaries.userId,
                rescuetimeDailySummaries.date,
              ],
              set: {
                totalSeconds: levels.totalSeconds,
                productivityPulse: pulse,
                veryProductiveSeconds: levels.veryProductive,
                productiveSeconds: levels.productive,
                neutralSeconds: levels.neutral,
                distractingSeconds: levels.distracting,
                veryDistractingSeconds: levels.veryDistracting,
              },
            }),
        ]
      : [
          db
            .delete(rescuetimeDailySummaries)
            .where(
              and(
                eq(rescuetimeDailySummaries.userId, userId),
                eq(rescuetimeDailySummaries.date, date)
              )
            ),
        ];

  const statements = [
    db
      .delete(rescuetimeActivities)
      .where(
        and(
          eq(rescuetimeActivities.userId, userId),
          gte(rescuetimeActivities.timestamp, start),
          lt(rescuetimeActivities.timestamp, end)
        )
      ),
    ...activities.map((a) =>
      db.insert(rescuetimeActivities).values({
        userId,
        timestamp: a.timestamp,
        durationSeconds: a.durationSeconds,
        activity: a.activity,
        category: a.category,
        productivity: a.productivity,
      })
    ),
    ...summaryStatements,
  ];

  // The delete guarantees at least one element, satisfying db.batch's
  // non-empty-tuple signature.
  await db.batch(statements as [(typeof statements)[number]]);

  return {
    synced: activities.length,
    totalSeconds: levels.totalSeconds,
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
 * One bounded RescueTime backfill chunk: syncs one month
 * (RESCUETIME_BACKFILL_CHUNK_DAYS days) walking BACKWARD from `cursor` (the
 * next date to fetch). Defaults the start cursor to yesterday (UTC). The pulse
 * feed is fetched once and shared across the whole chunk (it only covers ~2
 * recent weeks, so older days simply get a null pulse).
 *
 * The next cursor is the day immediately before the last day fetched — the
 * caller loops until nextCursor is null. The ONLY natural terminator is an
 * empty month (no data that far back — the walk has reached the start of, or a
 * point before, all accessible history).
 *
 * All API errors are rethrown, at any point in the walk. Day syncs are
 * idempotent (delete + reinsert upserts), so a transient failure surfaces as a
 * route 500 and the operator simply retries the SAME cursor — re-syncing the
 * already-synced days is harmless. Swallowing a mid-walk error as "end of
 * history" would silently truncate the backfill on a transient blip, so we do
 * not do that.
 *
 * @param cursor YYYY-MM-DD next day to fetch; defaults to yesterday (UTC).
 */
export async function backfillRescuetime(
  env: Env,
  cursor?: string
): Promise<BackfillChunkResult> {
  // Validate the cursor FIRST: a bad resume token is a client error (400) and
  // must surface regardless of credential state, so it isn't masked by a
  // missing-key 500.
  if (cursor !== undefined && !CURSOR_DATE_RE.test(cursor)) {
    throw new RescuetimeBackfillCursorError(
      `Invalid backfill cursor (expected YYYY-MM-DD): ${cursor}`
    );
  }

  const apiKey = env.RESCUETIME_API_KEY;
  if (!apiKey) {
    throw new Error('RESCUETIME_API_KEY is not configured');
  }
  const client = new RescuetimeClient(apiKey);
  const db = createDb(env.DB);

  // Pulse feed once for the whole chunk.
  const summaries = await client.getDailySummaries();
  const pulseByDate = new Map(
    summaries.map((s) => [s.date, s.productivityPulse])
  );

  let day =
    cursor ??
    (() => {
      const yesterday = new Date();
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      return utcDate(yesterday);
    })();

  let itemsSynced = 0;

  for (let i = 0; i < RESCUETIME_BACKFILL_CHUNK_DAYS; i++) {
    // Rethrow every error: day syncs are idempotent upserts, so a transient
    // failure should surface (route 500) and be retried on the same cursor,
    // never swallowed as "end of history".
    const result = await syncRescuetimeDay(db, client, day, pulseByDate);
    itemsSynced += result.synced;
    day = previousDay(day);
  }

  // A fully-empty month means we have walked past all available data.
  if (itemsSynced === 0) {
    console.log(
      `[SYNC] RescueTime backfill: empty month ending at ${cursor ?? 'yesterday'}; stopping`
    );
    return { itemsSynced, nextCursor: null };
  }

  return { itemsSynced, nextCursor: day };
}

/**
 * Coding domain RescueTime sync entrypoint: sync_runs lifecycle (domain
 * 'coding', syncType 'rescuetime'). Fetches the daily-summary pulse feed once,
 * then syncs yesterday + today so today's still-arriving buckets are refreshed
 * and yesterday is finalized.
 */
export async function syncRescuetime(
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
      syncType: 'rescuetime',
      status: 'running',
      startedAt,
      itemsSynced: 0,
    })
    .returning({ id: syncRuns.id });

  try {
    const apiKey = env.RESCUETIME_API_KEY;
    if (!apiKey) {
      throw new Error('RESCUETIME_API_KEY is not configured');
    }
    const client = new RescuetimeClient(apiKey);

    // Fetch the pulse feed once; map date -> pulse for the day rebuilds.
    const summaries = await client.getDailySummaries();
    const pulseByDate = new Map(
      summaries.map((s) => [s.date, s.productivityPulse])
    );

    // Day selection is UTC-based; tz-ahead accounts see only a morning lag on
    // "today" and the hourly cron self-heals once the UTC date catches up.
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const days = [utcDate(yesterday), utcDate(now)];

    let synced = 0;
    const perDay: Record<string, number> = {};
    for (const day of days) {
      const result = await syncRescuetimeDay(
        db,
        client,
        day,
        pulseByDate,
        userId
      );
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
      `[SYNC] RescueTime sync complete: ${synced} activity buckets across ${days.length} day(s)`
    );
    return { synced };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.log(`[ERROR] RescueTime sync failed: ${errorMsg}`);
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
