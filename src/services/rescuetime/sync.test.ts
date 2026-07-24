import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { eq, sql, asc } from 'drizzle-orm';
import { createDb } from '../../db/client.js';
import {
  rescuetimeActivities,
  rescuetimeDailySummaries,
} from '../../db/schema/rescuetime.js';
import { syncRuns } from '../../db/schema/system.js';
import { setupTestDb } from '../../test-helpers.js';
import {
  syncRescuetimeDay,
  syncRescuetime,
  backfillRescuetime,
} from './sync.js';
import type {
  RescuetimeClient,
  RescuetimeActivity,
  RescuetimeDailySummary,
} from './client.js';
import type { Env } from '../../types/env.js';

/**
 * Stub client: canned activities keyed by date + a fixed daily-summary feed.
 * Records calls so tests can assert which days were fetched.
 */
function makeClient(
  activitiesByDate: Record<string, RescuetimeActivity[]>,
  summaries: RescuetimeDailySummary[] = []
): {
  client: RescuetimeClient;
  calls: { activities: string[]; summaries: number };
} {
  const calls = { activities: [] as string[], summaries: 0 };
  const client = {
    getActivities: async (date: string) => {
      calls.activities.push(date);
      return activitiesByDate[date] ?? [];
    },
    getDailySummaries: async () => {
      calls.summaries += 1;
      return summaries;
    },
  } as unknown as RescuetimeClient;
  return { client, calls };
}

function activity(
  timestamp: string,
  durationSeconds: number,
  productivity: number,
  overrides: Partial<RescuetimeActivity> = {}
): RescuetimeActivity {
  return {
    timestamp,
    durationSeconds,
    activity: 'VS Code',
    category: 'Editing & IDEs',
    productivity,
    ...overrides,
  };
}

beforeAll(async () => {
  await setupTestDb();
});

describe('syncRescuetimeDay', () => {
  it('inserts activity rows and one summary row with productivity-level sums', async () => {
    const db = createDb(env.DB);
    const date = '2026-07-23';
    const { client } = makeClient({
      [date]: [
        activity('2026-07-23T09:00:00.000Z', 300, 2), // very productive
        activity('2026-07-23T09:05:00.000Z', 120, 1), // productive
        activity('2026-07-23T09:10:00.000Z', 60, 0), // neutral
        activity('2026-07-23T09:15:00.000Z', 90, -1), // distracting
        activity('2026-07-23T09:20:00.000Z', 30, -2), // very distracting
      ],
    });

    const result = await syncRescuetimeDay(db, client, date);

    expect(result.synced).toBe(5);
    expect(result.totalSeconds).toBe(600);

    const rows = await db
      .select()
      .from(rescuetimeActivities)
      .orderBy(asc(rescuetimeActivities.timestamp));
    expect(rows).toHaveLength(5);
    expect(rows[0].timestamp).toBe('2026-07-23T09:00:00.000Z');
    expect(rows[0].durationSeconds).toBe(300);
    expect(rows[0].userId).toBe(1);

    const summaries = await db.select().from(rescuetimeDailySummaries);
    expect(summaries).toHaveLength(1);
    const s = summaries[0];
    expect(s.date).toBe(date);
    expect(s.totalSeconds).toBe(600);
    expect(s.veryProductiveSeconds).toBe(300);
    expect(s.productiveSeconds).toBe(120);
    expect(s.neutralSeconds).toBe(60);
    expect(s.distractingSeconds).toBe(90);
    expect(s.veryDistractingSeconds).toBe(30);
    expect(s.productivityPulse).toBeNull();
  });

  it('is idempotent: running the same day twice yields the same row counts', async () => {
    const db = createDb(env.DB);
    const date = '2026-07-24';
    const acts = {
      [date]: [
        activity('2026-07-24T09:00:00.000Z', 300, 2),
        activity('2026-07-24T09:05:00.000Z', 120, 1),
      ],
    };

    await syncRescuetimeDay(db, makeClient(acts).client, date);
    await syncRescuetimeDay(db, makeClient(acts).client, date);

    const [actCount] = await db
      .select({ n: sql<number>`count(*)` })
      .from(rescuetimeActivities)
      .where(eq(rescuetimeActivities.timestamp, '2026-07-24T09:00:00.000Z'));
    const [total] = await db
      .select({ n: sql<number>`count(*)` })
      .from(rescuetimeActivities);
    expect(total.n).toBe(2);
    expect(actCount.n).toBe(1);

    const [summCount] = await db
      .select({ n: sql<number>`count(*)` })
      .from(rescuetimeDailySummaries)
      .where(eq(rescuetimeDailySummaries.date, date));
    expect(summCount.n).toBe(1);
  });

  it('applies productivityPulse from the pulse map when present', async () => {
    const db = createDb(env.DB);
    const date = '2026-07-25';
    const pulseByDate = new Map([[date, 71]]);
    const { client } = makeClient({
      [date]: [activity('2026-07-25T09:00:00.000Z', 300, 2)],
    });

    await syncRescuetimeDay(db, client, date, pulseByDate);

    const [s] = await db
      .select()
      .from(rescuetimeDailySummaries)
      .where(eq(rescuetimeDailySummaries.date, date));
    expect(s.productivityPulse).toBe(71);
  });

  it('leaves productivityPulse null when the pulse map has no entry for the date', async () => {
    const db = createDb(env.DB);
    const date = '2026-07-26';
    const pulseByDate = new Map([['2026-07-01', 50]]);
    const { client } = makeClient({
      [date]: [activity('2026-07-26T09:00:00.000Z', 300, 2)],
    });

    await syncRescuetimeDay(db, client, date, pulseByDate);

    const [s] = await db
      .select()
      .from(rescuetimeDailySummaries)
      .where(eq(rescuetimeDailySummaries.date, date));
    expect(s.productivityPulse).toBeNull();
  });

  it('writes no summary row for a day with no activity rows', async () => {
    const db = createDb(env.DB);
    const date = '2026-07-27';
    const { client } = makeClient({ [date]: [] });

    const result = await syncRescuetimeDay(db, client, date);
    expect(result.synced).toBe(0);
    expect(result.totalSeconds).toBe(0);

    const [actCount] = await db
      .select({ n: sql<number>`count(*)` })
      .from(rescuetimeActivities)
      .where(sql`substr(timestamp, 1, 10) = ${date}`);
    expect(actCount.n).toBe(0);

    const [summCount] = await db
      .select({ n: sql<number>`count(*)` })
      .from(rescuetimeDailySummaries)
      .where(eq(rescuetimeDailySummaries.date, date));
    expect(summCount.n).toBe(0);
  });

  it('deletes a stale summary row when a previously-populated day comes back empty', async () => {
    const db = createDb(env.DB);
    const date = '2026-07-28';

    // First sync: the day has activity, producing a summary row.
    await syncRescuetimeDay(
      db,
      makeClient({
        [date]: [activity('2026-07-28T09:00:00.000Z', 300, 2)],
      }).client,
      date
    );

    const [beforeSumm] = await db
      .select({ n: sql<number>`count(*)` })
      .from(rescuetimeDailySummaries)
      .where(eq(rescuetimeDailySummaries.date, date));
    expect(beforeSumm.n).toBe(1);

    // Re-sync: the API now returns no activity for that day.
    const result = await syncRescuetimeDay(
      db,
      makeClient({ [date]: [] }).client,
      date
    );
    expect(result.synced).toBe(0);

    // Both the activity rows and the stale summary row must be gone.
    const [actCount] = await db
      .select({ n: sql<number>`count(*)` })
      .from(rescuetimeActivities)
      .where(sql`substr(timestamp, 1, 10) = ${date}`);
    expect(actCount.n).toBe(0);

    const [summCount] = await db
      .select({ n: sql<number>`count(*)` })
      .from(rescuetimeDailySummaries)
      .where(eq(rescuetimeDailySummaries.date, date));
    expect(summCount.n).toBe(0);
  });

  it('deletes only the target day rows (timestamp window), leaving other days intact', async () => {
    const db = createDb(env.DB);
    const dayA = '2026-08-01';
    const dayB = '2026-08-02';

    await syncRescuetimeDay(
      db,
      makeClient({
        [dayA]: [activity('2026-08-01T23:59:00.000Z', 60, 2)],
      }).client,
      dayA
    );
    await syncRescuetimeDay(
      db,
      makeClient({
        [dayB]: [activity('2026-08-02T00:00:00.000Z', 60, 2)],
      }).client,
      dayB
    );

    // Re-sync dayB with new data — dayA's row must survive.
    await syncRescuetimeDay(
      db,
      makeClient({
        [dayB]: [activity('2026-08-02T00:05:00.000Z', 120, 1)],
      }).client,
      dayB
    );

    const [aCount] = await db
      .select({ n: sql<number>`count(*)` })
      .from(rescuetimeActivities)
      .where(eq(rescuetimeActivities.timestamp, '2026-08-01T23:59:00.000Z'));
    expect(aCount.n).toBe(1);

    const bRows = await db
      .select()
      .from(rescuetimeActivities)
      .where(sql`substr(timestamp, 1, 10) = ${dayB}`);
    expect(bRows).toHaveLength(1);
    expect(bRows[0].timestamp).toBe('2026-08-02T00:05:00.000Z');
  });

  it('dedups activity rows that share (timestamp, activity), keeping the last', async () => {
    // The Analytic Data API can return rows colliding on (timestamp, activity)
    // — inserting both would violate the unique index and abort the batch.
    // Dedup on the unique key, keeping the last occurrence.
    const db = createDb(env.DB);
    const date = '2026-08-05';
    const { client } = makeClient({
      [date]: [
        activity('2026-08-05T09:00:00.000Z', 100, 2, { activity: 'VS Code' }),
        activity('2026-08-05T09:00:00.000Z', 200, 2, { activity: 'VS Code' }),
        activity('2026-08-05T09:05:00.000Z', 60, 1, { activity: 'Chrome' }),
      ],
    });

    const result = await syncRescuetimeDay(db, client, date);

    const rows = await db
      .select()
      .from(rescuetimeActivities)
      .where(eq(rescuetimeActivities.timestamp, '2026-08-05T09:00:00.000Z'));
    expect(rows).toHaveLength(1);
    expect(rows[0].durationSeconds).toBe(200);

    const all = await db
      .select()
      .from(rescuetimeActivities)
      .where(sql`substr(timestamp, 1, 10) = ${date}`);
    expect(all).toHaveLength(2);
    // The rollup reflects only the de-duplicated rows (200 + 60), not 100+200+60.
    expect(result.totalSeconds).toBe(260);
    expect(result.synced).toBe(2);
  });
});

describe('syncRescuetime', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function rescuetimeEnv(apiKey?: string): Env {
    return { ...env, RESCUETIME_API_KEY: apiKey } as unknown as Env;
  }

  it('records a completed sync run syncing yesterday + today with exact per-day metadata keys', async () => {
    // Empty data endpoints; assert lifecycle + shape, not real data.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('daily_summary_feed')) {
        return new Response(JSON.stringify([]));
      }
      // Analytic data endpoint — empty rows.
      return new Response(
        JSON.stringify({
          row_headers: [
            'Date',
            'Time Spent (seconds)',
            'Number of People',
            'Activity',
            'Category',
            'Productivity',
          ],
          rows: [],
        })
      );
    });

    const result = await syncRescuetime(rescuetimeEnv('rescue_test'));
    expect(result.synced).toBe(0);

    const [run] = await createDb(env.DB)
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.syncType, 'rescuetime'));
    expect(run.domain).toBe('coding');
    expect(run.status).toBe('completed');

    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const expectedDays = [
      yesterday.toISOString().slice(0, 10),
      now.toISOString().slice(0, 10),
    ];
    const metadata = JSON.parse(run.metadata ?? '{}') as {
      perDayTotalSeconds: Record<string, number>;
    };
    expect(Object.keys(metadata.perDayTotalSeconds)).toEqual(expectedDays);
  });

  it('records a failed run and rethrows when the client throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'));

    await expect(syncRescuetime(rescuetimeEnv('rescue_test'))).rejects.toThrow(
      'boom'
    );

    const runs = await createDb(env.DB)
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.syncType, 'rescuetime'));
    const failed = runs.find((r) => r.status === 'failed');
    expect(failed).toBeDefined();
    expect(failed?.error).toContain('boom');
  });

  it('records a failed run when RESCUETIME_API_KEY is unset', async () => {
    await expect(syncRescuetime(rescuetimeEnv(undefined))).rejects.toThrow(
      'RESCUETIME_API_KEY'
    );

    const runs = await createDb(env.DB)
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.syncType, 'rescuetime'));
    const failed = runs.find((r) => r.error?.includes('RESCUETIME_API_KEY'));
    expect(failed).toBeDefined();
    expect(failed?.status).toBe('failed');
  });
});

describe('backfillRescuetime', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function rescuetimeEnv(apiKey?: string): Env {
    return { ...env, RESCUETIME_API_KEY: apiKey } as unknown as Env;
  }

  /** Build an analytic-data Response for a given date with one activity row. */
  function dataResponse(date: string, empty = false): Response {
    return new Response(
      JSON.stringify({
        row_headers: [
          'Date',
          'Time Spent (seconds)',
          'Number of People',
          'Activity',
          'Category',
          'Productivity',
        ],
        rows: empty
          ? []
          : [[`${date}T09:00:00`, 300, 1, 'VS Code', 'Editing & IDEs', 2]],
      })
    );
  }

  it('walks one month (30 days) backward and returns the next cursor 30 days earlier', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('daily_summary_feed')) {
        return new Response(JSON.stringify([]));
      }
      const date = new URL(url).searchParams.get('restrict_begin')!;
      return dataResponse(date);
    });

    const result = await backfillRescuetime(
      rescuetimeEnv('rescue'),
      '2026-06-30'
    );

    expect(result.itemsSynced).toBeGreaterThan(0);
    // 30-day chunk: 2026-06-30 .. 2026-06-01 inclusive; next cursor = 2026-05-31.
    expect(result.nextCursor).toBe('2026-05-31');
  });

  it('fetches the daily_summary_feed pulse map exactly once', async () => {
    let feedCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('daily_summary_feed')) {
        feedCalls += 1;
        return new Response(JSON.stringify([]));
      }
      const date = new URL(url).searchParams.get('restrict_begin')!;
      return dataResponse(date, true);
    });

    await backfillRescuetime(rescuetimeEnv('rescue'), '2026-06-30');
    expect(feedCalls).toBe(1);
  });

  it('defaults the start cursor to yesterday (UTC)', async () => {
    const fetched: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('daily_summary_feed')) {
        return new Response(JSON.stringify([]));
      }
      const date = new URL(url).searchParams.get('restrict_begin')!;
      fetched.push(date);
      return dataResponse(date);
    });

    await backfillRescuetime(rescuetimeEnv('rescue'));

    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    expect(fetched[0]).toBe(yesterday.toISOString().slice(0, 10));
  });

  it('stops (nextCursor null) on an empty month', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('daily_summary_feed')) {
        return new Response(JSON.stringify([]));
      }
      const date = new URL(url).searchParams.get('restrict_begin')!;
      return dataResponse(date, true);
    });

    const result = await backfillRescuetime(
      rescuetimeEnv('rescue'),
      '2026-06-30'
    );
    expect(result.itemsSynced).toBe(0);
    expect(result.nextCursor).toBeNull();
  });

  it('rethrows a mid-chunk API error even after some data has synced (day syncs are idempotent; the operator retries the same cursor)', async () => {
    let dataCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('daily_summary_feed')) {
        return new Response(JSON.stringify([]));
      }
      dataCalls += 1;
      // First 5 days succeed, then a transient 500 mid-walk.
      if (dataCalls <= 5) {
        const date = new URL(url).searchParams.get('restrict_begin')!;
        return dataResponse(date);
      }
      return new Response('server error', { status: 500 });
    });

    await expect(
      backfillRescuetime(rescuetimeEnv('rescue'), '2026-06-30')
    ).rejects.toThrow();
  });

  it('rethrows when the very first chunk errors with no data synced', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('daily_summary_feed')) {
        return new Response(JSON.stringify([]));
      }
      return new Response('server error', { status: 500 });
    });

    // No cursor (first chunk) and the first day errors → rethrow.
    await expect(backfillRescuetime(rescuetimeEnv('rescue'))).rejects.toThrow();
  });
});
