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
import { syncWakatimeDay, syncWakatime } from './sync.js';
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
