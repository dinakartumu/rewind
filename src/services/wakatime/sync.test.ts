import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { eq, sql, asc } from 'drizzle-orm';
import { createDb } from '../../db/client.js';
import {
  wakatimeDurations,
  wakatimeDailySummaries,
  wakatimeDailyLanguages,
} from '../../db/schema/wakatime.js';
import { syncRuns } from '../../db/schema/system.js';
import { setupTestDb } from '../../test-helpers.js';
import { syncWakatimeDay, syncWakatime, backfillWakatime } from './sync.js';
import { WakatimeHistoryLimitError } from './client.js';
import type {
  WakatimeClient,
  WakatimeDurationRow,
  WakatimeSummary,
} from './client.js';
import type { Env } from '../../types/env.js';

/**
 * Stub client: canned durations + summary keyed by date. Records calls so
 * tests can assert the day was fetched. Durations/summary are supplied by
 * the test per date.
 */
function makeClient(
  durationsByDate: Record<string, WakatimeDurationRow[]>,
  summaryByDate: Record<string, Partial<WakatimeSummary>>
): {
  client: WakatimeClient;
  calls: { durations: string[]; summary: string[] };
} {
  const calls = { durations: [] as string[], summary: [] as string[] };
  const client = {
    getDurations: async (date: string) => {
      calls.durations.push(date);
      return durationsByDate[date] ?? [];
    },
    getSummary: async (date: string): Promise<WakatimeSummary> => {
      calls.summary.push(date);
      const s = summaryByDate[date] ?? {};
      return {
        date,
        totalSeconds: s.totalSeconds ?? 0,
        topLanguage: s.topLanguage ?? null,
        topProject: s.topProject ?? null,
        languages: s.languages ?? [],
      };
    },
  } as unknown as WakatimeClient;
  return { client, calls };
}

function duration(
  startTime: string,
  durationSeconds: number,
  overrides: Partial<WakatimeDurationRow> = {}
): WakatimeDurationRow {
  return {
    startTime,
    durationSeconds,
    project: 'rewind',
    language: null,
    entity: '/src/index.ts',
    ...overrides,
  };
}

beforeAll(async () => {
  await setupTestDb();
});

describe('syncWakatimeDay', () => {
  it('inserts duration rows, language rows, and one summary row', async () => {
    const db = createDb(env.DB);
    const date = '2026-07-23';
    const { client } = makeClient(
      {
        [date]: [
          duration('2026-07-23T09:00:00.000Z', 300, {
            entity: '/src/a.ts',
          }),
          duration('2026-07-23T10:00:00.000Z', 120, {
            entity: '/src/b.ts',
            project: 'other',
          }),
        ],
      },
      {
        [date]: {
          totalSeconds: 420,
          topLanguage: 'TypeScript',
          topProject: 'rewind',
          languages: [
            { name: 'TypeScript', totalSeconds: 360 },
            { name: 'CSS', totalSeconds: 60 },
          ],
        },
      }
    );

    const result = await syncWakatimeDay(db, client, date);

    expect(result).toEqual({
      synced: 2,
      totalSeconds: 420,
      topLanguage: 'TypeScript',
      topProject: 'rewind',
    });

    const rows = await db
      .select()
      .from(wakatimeDurations)
      .orderBy(asc(wakatimeDurations.startTime));
    expect(rows).toHaveLength(2);
    expect(rows[0].startTime).toBe('2026-07-23T09:00:00.000Z');
    expect(rows[0].durationSeconds).toBe(300);
    expect(rows[0].project).toBe('rewind');
    expect(rows[0].userId).toBe(1);

    const summaries = await db.select().from(wakatimeDailySummaries);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].date).toBe(date);
    expect(summaries[0].totalSeconds).toBe(420);
    expect(summaries[0].topLanguage).toBe('TypeScript');
    expect(summaries[0].topProject).toBe('rewind');

    const langs = await db
      .select()
      .from(wakatimeDailyLanguages)
      .orderBy(asc(wakatimeDailyLanguages.language));
    expect(langs).toHaveLength(2);
    expect(langs.map((l) => [l.language, l.totalSeconds])).toEqual([
      ['CSS', 60],
      ['TypeScript', 360],
    ]);
    expect(langs[0].date).toBe(date);
    expect(langs[0].userId).toBe(1);
  });

  it('is idempotent: running the same day twice yields the same row counts', async () => {
    const db = createDb(env.DB);
    const date = '2026-07-24';
    const durations = {
      [date]: [
        duration('2026-07-24T09:00:00.000Z', 300, { entity: '/src/a.ts' }),
        duration('2026-07-24T10:00:00.000Z', 120, { entity: '/src/b.ts' }),
      ],
    };
    const summary = {
      [date]: {
        totalSeconds: 420,
        topLanguage: 'TypeScript',
        topProject: 'rewind',
        languages: [{ name: 'TypeScript', totalSeconds: 420 }],
      },
    };

    await syncWakatimeDay(db, makeClient(durations, summary).client, date);
    await syncWakatimeDay(db, makeClient(durations, summary).client, date);

    const [durCount] = await db
      .select({ n: sql<number>`count(*)` })
      .from(wakatimeDurations)
      .where(eq(wakatimeDurations.startTime, '2026-07-24T09:00:00.000Z'));
    const [totalDur] = await db
      .select({ n: sql<number>`count(*)` })
      .from(wakatimeDurations);
    expect(totalDur.n).toBe(2);
    expect(durCount.n).toBe(1);

    const [summCount] = await db
      .select({ n: sql<number>`count(*)` })
      .from(wakatimeDailySummaries)
      .where(eq(wakatimeDailySummaries.date, date));
    expect(summCount.n).toBe(1);

    const [langCount] = await db
      .select({ n: sql<number>`count(*)` })
      .from(wakatimeDailyLanguages)
      .where(eq(wakatimeDailyLanguages.date, date));
    expect(langCount.n).toBe(1);
  });

  it('reflects a grown slice (same startTime, bigger duration) without adding rows', async () => {
    const db = createDb(env.DB);
    const date = '2026-07-25';

    await syncWakatimeDay(
      db,
      makeClient(
        {
          [date]: [duration('2026-07-25T09:00:00.000Z', 300, { entity: '/x' })],
        },
        { [date]: { totalSeconds: 300, languages: [] } }
      ).client,
      date
    );

    // Same slice re-fetched later has grown.
    await syncWakatimeDay(
      db,
      makeClient(
        {
          [date]: [duration('2026-07-25T09:00:00.000Z', 900, { entity: '/x' })],
        },
        { [date]: { totalSeconds: 900, languages: [] } }
      ).client,
      date
    );

    const rows = await db
      .select()
      .from(wakatimeDurations)
      .where(eq(wakatimeDurations.startTime, '2026-07-25T09:00:00.000Z'));
    expect(rows).toHaveLength(1);
    expect(rows[0].durationSeconds).toBe(900);

    const [summ] = await db
      .select()
      .from(wakatimeDailySummaries)
      .where(eq(wakatimeDailySummaries.date, date));
    expect(summ.totalSeconds).toBe(900);
  });

  it('leaves zero language rows for a day with no languages', async () => {
    const db = createDb(env.DB);
    const date = '2026-07-26';
    await syncWakatimeDay(
      db,
      makeClient({ [date]: [] }, { [date]: { totalSeconds: 0, languages: [] } })
        .client,
      date
    );

    const [langCount] = await db
      .select({ n: sql<number>`count(*)` })
      .from(wakatimeDailyLanguages)
      .where(eq(wakatimeDailyLanguages.date, date));
    expect(langCount.n).toBe(0);
  });

  it('reinserts language rows on re-sync (delete + reinsert, no dupes)', async () => {
    const db = createDb(env.DB);
    const date = '2026-07-27';

    await syncWakatimeDay(
      db,
      makeClient(
        { [date]: [] },
        {
          [date]: {
            totalSeconds: 100,
            languages: [
              { name: 'Go', totalSeconds: 60 },
              { name: 'Rust', totalSeconds: 40 },
            ],
          },
        }
      ).client,
      date
    );

    // Second run: the language mix changed.
    await syncWakatimeDay(
      db,
      makeClient(
        { [date]: [] },
        {
          [date]: {
            totalSeconds: 120,
            languages: [{ name: 'Go', totalSeconds: 120 }],
          },
        }
      ).client,
      date
    );

    const langs = await db
      .select()
      .from(wakatimeDailyLanguages)
      .where(eq(wakatimeDailyLanguages.date, date));
    expect(langs).toHaveLength(1);
    expect(langs[0].language).toBe('Go');
    expect(langs[0].totalSeconds).toBe(120);
  });

  it('dedups duration slices that share (start_time, project, entity), keeping the last', async () => {
    // The WakaTime Durations API can return multiple slices whose rounded
    // start_time collides on the same (project, entity) — this must not blow
    // up the batch insert on the unique index. Last occurrence wins.
    const db = createDb(env.DB);
    const date = '2026-07-28';
    const { client } = makeClient(
      {
        [date]: [
          duration('2026-07-28T09:00:00.000Z', 100, { entity: '/src/a.ts' }),
          duration('2026-07-28T09:00:00.000Z', 250, { entity: '/src/a.ts' }),
          duration('2026-07-28T10:00:00.000Z', 60, { entity: '/src/b.ts' }),
        ],
      },
      { [date]: { totalSeconds: 310 } }
    );

    const result = await syncWakatimeDay(db, client, date);

    const rows = await db
      .select()
      .from(wakatimeDurations)
      .where(eq(wakatimeDurations.startTime, '2026-07-28T09:00:00.000Z'))
      .orderBy(asc(wakatimeDurations.startTime));
    // Only one row for the colliding key, carrying the last slice's duration.
    expect(rows).toHaveLength(1);
    expect(rows[0].durationSeconds).toBe(250);

    const all = await db.select().from(wakatimeDurations);
    expect(all).toHaveLength(2);
    // synced reflects the de-duplicated count actually persisted.
    expect(result.synced).toBe(2);
  });
});

describe('backfillWakatime', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function wakatimeEnv(apiKey?: string): Env {
    return { ...env, WAKATIME_API_KEY: apiKey } as unknown as Env;
  }

  it('walks 14 days backward from a cursor and returns the next cursor 14 days earlier', async () => {
    // Every day returns one duration slice (timestamped to that day so the
    // per-day delete windows don't collide) so no empty-streak stop triggers.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/durations')) {
        const date = new URL(url).searchParams.get('date')!;
        const epoch = new Date(`${date}T12:00:00.000Z`).getTime() / 1000;
        return new Response(
          JSON.stringify({
            data: [
              { time: epoch, duration: 60, project: 'rewind', entity: '/x' },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({ data: [{ grand_total: { total_seconds: 60 } }] })
      );
    });

    const result = await backfillWakatime(wakatimeEnv('waka'), '2026-06-14');

    expect(result.itemsSynced).toBeGreaterThan(0);
    // Chunk = 14 days: 2026-06-14 .. 2026-06-01 inclusive; next cursor is the
    // day before the last fetched day: 2026-05-31.
    expect(result.nextCursor).toBe('2026-05-31');
  });

  it('defaults the start cursor to yesterday (UTC) when none is provided', async () => {
    const fetched: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/durations')) {
        const date = new URL(url).searchParams.get('date');
        if (date) fetched.push(date);
        return new Response(JSON.stringify({ data: [] }));
      }
      return new Response(JSON.stringify({ data: [] }));
    });

    await backfillWakatime(wakatimeEnv('waka'));

    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    expect(fetched[0]).toBe(yesterday.toISOString().slice(0, 10));
  });

  it('stops (nextCursor null) on a WakatimeHistoryLimitError', async () => {
    // First durations call 402s → history limit reached immediately.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/durations')) {
        return new Response('Payment Required', { status: 402 });
      }
      return new Response(JSON.stringify({ data: [] }));
    });

    const result = await backfillWakatime(wakatimeEnv('waka'), '2026-06-14');
    expect(result.nextCursor).toBeNull();
  });

  it('stops (nextCursor null) on an empty chunk when there is NO floor (all_time start_date absent)', async () => {
    // No floor available (all_time_since_today returns no start_date) → the
    // empty-chunk fallback terminates the walk.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/all_time_since_today')) {
        return new Response(JSON.stringify({ data: { range: {} } }));
      }
      if (url.includes('/durations')) {
        return new Response(JSON.stringify({ data: [] }));
      }
      return new Response(JSON.stringify({ data: [] }));
    });

    const result = await backfillWakatime(wakatimeEnv('waka'), '2026-06-14');
    expect(result.itemsSynced).toBe(0);
    expect(result.nextCursor).toBeNull();
  });

  it('continues past an empty chunk when the floor is still below the cursor (vacation gap does not truncate)', async () => {
    // Floor is 2019 (far below the cursor). An entirely-empty 14-day chunk
    // must NOT terminate: the next cursor advances 14 days earlier.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/all_time_since_today')) {
        return new Response(
          JSON.stringify({ data: { range: { start_date: '2019-01-01' } } })
        );
      }
      if (url.includes('/durations')) {
        return new Response(JSON.stringify({ data: [] }));
      }
      return new Response(JSON.stringify({ data: [] }));
    });

    const result = await backfillWakatime(wakatimeEnv('waka'), '2026-06-14');
    // Chunk = 14 days: 2026-06-14 .. 2026-06-01; next cursor = 2026-05-31.
    expect(result.nextCursor).toBe('2026-05-31');
  });

  it('terminates (nextCursor null) once the cursor walks below the floor', async () => {
    // Floor is 2026-06-10; the cursor 2026-06-14 walks below it within the
    // chunk, so the walk terminates rather than fetching pre-history days.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/all_time_since_today')) {
        return new Response(
          JSON.stringify({ data: { range: { start_date: '2026-06-10' } } })
        );
      }
      if (url.includes('/durations')) {
        const date = new URL(url).searchParams.get('date')!;
        const epoch = new Date(`${date}T12:00:00.000Z`).getTime() / 1000;
        return new Response(
          JSON.stringify({
            data: [{ time: epoch, duration: 60, project: 'p', entity: '/x' }],
          })
        );
      }
      return new Response(
        JSON.stringify({ data: [{ grand_total: { total_seconds: 60 } }] })
      );
    });

    const result = await backfillWakatime(wakatimeEnv('waka'), '2026-06-14');
    expect(result.itemsSynced).toBeGreaterThan(0);
    expect(result.nextCursor).toBeNull();
  });

  it('surfaces a WakatimeHistoryLimitError as terminal (nextCursor null), not a throw', async () => {
    let durationCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/durations')) {
        durationCalls += 1;
        // First 3 days have data, then 402.
        if (durationCalls <= 3) {
          const date = new URL(url).searchParams.get('date')!;
          const epoch = new Date(`${date}T12:00:00.000Z`).getTime() / 1000;
          return new Response(
            JSON.stringify({
              data: [{ time: epoch, duration: 60, project: 'p', entity: '/x' }],
            })
          );
        }
        return new Response('Payment Required', { status: 402 });
      }
      return new Response(
        JSON.stringify({ data: [{ grand_total: { total_seconds: 60 } }] })
      );
    });

    const result = await backfillWakatime(wakatimeEnv('waka'), '2026-06-14');
    // Some items synced before the 402, then terminal.
    expect(result.itemsSynced).toBeGreaterThan(0);
    expect(result.nextCursor).toBeNull();
    // Sanity: the thrown-limit path is not surfaced to the caller.
    void WakatimeHistoryLimitError;
  });
});

describe('syncWakatime', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function wakatimeEnv(apiKey?: string): Env {
    return { ...env, WAKATIME_API_KEY: apiKey } as unknown as Env;
  }

  it('records a completed sync run syncing yesterday + today', async () => {
    // Two days of empty responses; assert lifecycle + shape, not real data.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/durations')) {
        return new Response(JSON.stringify({ data: [] }));
      }
      return new Response(JSON.stringify({ data: [] }));
    });

    const result = await syncWakatime(wakatimeEnv('waka_test'));
    // Both days return empty durations, so nothing is synced.
    expect(result.synced).toBe(0);

    const [run] = await createDb(env.DB)
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.domain, 'coding'));
    expect(run.syncType).toBe('wakatime');
    expect(run.status).toBe('completed');

    // Day selection is pinned to yesterday + today in UTC. Assert the
    // metadata's per-day keys are exactly those two dates.
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

    await expect(syncWakatime(wakatimeEnv('waka_test'))).rejects.toThrow(
      'boom'
    );

    const runs = await createDb(env.DB)
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.syncType, 'wakatime'));
    const failed = runs.find((r) => r.status === 'failed');
    expect(failed).toBeDefined();
    expect(failed?.error).toContain('boom');
  });

  it('throws a clear error when WAKATIME_API_KEY is unset', async () => {
    await expect(syncWakatime(wakatimeEnv(undefined))).rejects.toThrow(
      'WAKATIME_API_KEY'
    );

    const runs = await createDb(env.DB)
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.syncType, 'wakatime'));
    const failed = runs.find((r) => r.error?.includes('WAKATIME_API_KEY'));
    expect(failed).toBeDefined();
    expect(failed?.status).toBe('failed');
  });
});
