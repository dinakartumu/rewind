import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { createDb } from '../../db/client.js';
import {
  wakatimeDailySummaries,
  wakatimeDurations,
  wakatimeDailyLanguages,
} from '../../db/schema/wakatime.js';
import { rescuetimeDailySummaries } from '../../db/schema/rescuetime.js';
import {
  githubCommits,
  githubContributionDays,
} from '../../db/schema/github.js';
import { activityFeed } from '../../db/schema/system.js';
import { setupTestDb } from '../../test-helpers.js';
import { syncCoding, buildDailyRollup, formatDuration } from './sync.js';
import type { Env } from '../../types/env.js';

const DAY = '2026-07-23';

async function clearAll() {
  const db = createDb(env.DB);
  await db.delete(wakatimeDailySummaries);
  await db.delete(wakatimeDurations);
  await db.delete(wakatimeDailyLanguages);
  await db.delete(rescuetimeDailySummaries);
  await db.delete(githubCommits);
  await db.delete(githubContributionDays);
  await db.delete(activityFeed);
}

async function seedWakatime(
  date: string,
  totalSeconds: number,
  topLanguage: string | null,
  topProject: string | null
) {
  await createDb(env.DB).insert(wakatimeDailySummaries).values({
    userId: 1,
    date,
    totalSeconds,
    topLanguage,
    topProject,
  });
}

async function seedCommit(
  sha: string,
  repo: string,
  committedAt: string,
  message = 'commit'
) {
  await createDb(env.DB)
    .insert(githubCommits)
    .values({
      userId: 1,
      sha,
      repo,
      message,
      committedAt,
      isPrivate: 0,
      url: `https://github.com/${repo}/commit/${sha}`,
    });
}

beforeAll(async () => {
  await setupTestDb();
});

beforeEach(async () => {
  await clearAll();
});

describe('formatDuration', () => {
  it('formats hours and minutes over an hour', () => {
    expect(formatDuration(4 * 3600 + 12 * 60)).toBe('4h 12m');
  });

  it('formats bare minutes under an hour', () => {
    expect(formatDuration(47 * 60)).toBe('47m');
  });

  it('formats an exact hour with zero minutes', () => {
    expect(formatDuration(3600)).toBe('1h 0m');
  });
});

describe('buildDailyRollup', () => {
  it('composes an all-sources title', async () => {
    const db = createDb(env.DB);
    await seedWakatime(DAY, 4 * 3600 + 12 * 60, 'TypeScript', 'rewind');
    // 9 commits across 2 repos.
    for (let i = 0; i < 7; i++) {
      await seedCommit(`a${i}`, 'me/rewind', `${DAY}T10:0${i}:00.000Z`);
    }
    await seedCommit('b1', 'me/other', `${DAY}T12:00:00.000Z`);
    await seedCommit('b2', 'me/other', `${DAY}T12:05:00.000Z`);

    const item = await buildDailyRollup(db, DAY, 1);
    expect(item).not.toBeNull();
    expect(item!.title).toBe(
      'Coded 4h 12m (TypeScript · rewind) · 9 commits across 2 repos'
    );
    expect(item!.domain).toBe('coding');
    expect(item!.eventType).toBe('daily_rollup');
    expect(item!.occurredAt).toBe(`${DAY}T23:59:59.000Z`);
    expect(item!.sourceId).toBe(`coding:day:${DAY}`);
  });

  it('composes a wakatime-only title (no commits)', async () => {
    const db = createDb(env.DB);
    await seedWakatime(DAY, 47 * 60, 'Go', 'infra');
    const item = await buildDailyRollup(db, DAY, 1);
    expect(item!.title).toBe('Coded 47m (Go · infra)');
  });

  it('drops the parenthetical when language/project are null', async () => {
    const db = createDb(env.DB);
    await seedWakatime(DAY, 3600, null, null);
    const item = await buildDailyRollup(db, DAY, 1);
    expect(item!.title).toBe('Coded 1h 0m');
  });

  it('composes a github-only title (no wakatime)', async () => {
    const db = createDb(env.DB);
    await seedCommit('c1', 'me/rewind', `${DAY}T10:00:00.000Z`);
    const item = await buildDailyRollup(db, DAY, 1);
    expect(item!.title).toBe('1 commit across 1 repo');
  });

  it('pluralizes commits and repos correctly', async () => {
    const db = createDb(env.DB);
    await seedCommit('d1', 'me/a', `${DAY}T10:00:00.000Z`);
    await seedCommit('d2', 'me/a', `${DAY}T11:00:00.000Z`);
    await seedCommit('d3', 'me/b', `${DAY}T12:00:00.000Z`);
    const item = await buildDailyRollup(db, DAY, 1);
    expect(item!.title).toBe('3 commits across 2 repos');
  });

  it('excludes commits outside the UTC day window', async () => {
    const db = createDb(env.DB);
    await seedWakatime(DAY, 3600, 'Rust', 'proj');
    await seedCommit('in', 'me/rewind', `${DAY}T23:59:59.000Z`);
    await seedCommit('before', 'me/rewind', `2026-07-22T23:59:59.000Z`);
    await seedCommit('after', 'me/rewind', `2026-07-24T00:00:00.000Z`);
    const item = await buildDailyRollup(db, DAY, 1);
    expect(item!.title).toBe(
      'Coded 1h 0m (Rust · proj) · 1 commit across 1 repo'
    );
  });

  it('returns null when all sources are empty for the day', async () => {
    const db = createDb(env.DB);
    const item = await buildDailyRollup(db, DAY, 1);
    expect(item).toBeNull();
  });
});

describe('syncCoding feed write', () => {
  it('writes the daily rollup feed row via afterSync', async () => {
    const db = createDb(env.DB);
    // Yesterday relative to a fixed "now".
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-24T08:00:00.000Z'));
    await seedWakatime('2026-07-23', 3600, 'TypeScript', 'rewind');
    await seedCommit('f1', 'me/rewind', '2026-07-23T10:00:00.000Z');

    await syncCoding({ DB: env.DB } as unknown as Env, 1, {
      syncWakatime: vi.fn(),
      syncRescuetime: vi.fn(),
      syncGithub: vi.fn(),
    });
    vi.useRealTimers();

    const rows = await db
      .select()
      .from(activityFeed)
      .where(eq(activityFeed.sourceId, 'coding:day:2026-07-23'));
    expect(rows).toHaveLength(1);
    expect(rows[0].domain).toBe('coding');
    expect(rows[0].eventType).toBe('daily_rollup');
  });

  it('does not duplicate the feed row on re-run', async () => {
    const db = createDb(env.DB);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-24T08:00:00.000Z'));
    await seedWakatime('2026-07-23', 3600, 'TypeScript', 'rewind');

    const deps = {
      syncWakatime: vi.fn(),
      syncRescuetime: vi.fn(),
      syncGithub: vi.fn(),
    };
    await syncCoding({ DB: env.DB } as unknown as Env, 1, deps);
    await syncCoding({ DB: env.DB } as unknown as Env, 1, deps);
    vi.useRealTimers();

    const rows = await db
      .select()
      .from(activityFeed)
      .where(eq(activityFeed.sourceId, 'coding:day:2026-07-23'));
    expect(rows).toHaveLength(1);
  });
});

describe('syncCoding source orchestration', () => {
  it('skips sources whose credentials are unset', async () => {
    const deps = {
      syncWakatime: vi.fn(),
      syncRescuetime: vi.fn(),
      syncGithub: vi.fn(),
    };
    // Only WakaTime configured.
    const env2 = { DB: env.DB, WAKATIME_API_KEY: 'k' } as unknown as Env;
    await syncCoding(env2, 1, deps);

    expect(deps.syncWakatime).toHaveBeenCalledTimes(1);
    expect(deps.syncRescuetime).not.toHaveBeenCalled();
    expect(deps.syncGithub).not.toHaveBeenCalled();
  });

  it('runs all sources when all creds are set', async () => {
    const deps = {
      syncWakatime: vi.fn(),
      syncRescuetime: vi.fn(),
      syncGithub: vi.fn(),
    };
    const env2 = {
      DB: env.DB,
      WAKATIME_API_KEY: 'k',
      RESCUETIME_API_KEY: 'k',
      GITHUB_TOKEN: 't',
      GITHUB_USERNAME: 'u',
    } as unknown as Env;
    await syncCoding(env2, 1, deps);

    expect(deps.syncWakatime).toHaveBeenCalledTimes(1);
    expect(deps.syncRescuetime).toHaveBeenCalledTimes(1);
    expect(deps.syncGithub).toHaveBeenCalledTimes(1);
  });

  it('continues to later sources when an earlier one throws', async () => {
    const deps = {
      syncWakatime: vi.fn().mockRejectedValue(new Error('waka boom')),
      syncRescuetime: vi.fn(),
      syncGithub: vi.fn(),
    };
    const env2 = {
      DB: env.DB,
      WAKATIME_API_KEY: 'k',
      RESCUETIME_API_KEY: 'k',
      GITHUB_TOKEN: 't',
      GITHUB_USERNAME: 'u',
    } as unknown as Env;

    await expect(syncCoding(env2, 1, deps)).resolves.toBeUndefined();
    expect(deps.syncRescuetime).toHaveBeenCalledTimes(1);
    expect(deps.syncGithub).toHaveBeenCalledTimes(1);
  });

  it('requires GITHUB_TOKEN and GITHUB_USERNAME both set to run github', async () => {
    const deps = {
      syncWakatime: vi.fn(),
      syncRescuetime: vi.fn(),
      syncGithub: vi.fn(),
    };
    // Token but no username: github must be skipped.
    const env2 = { DB: env.DB, GITHUB_TOKEN: 't' } as unknown as Env;
    await syncCoding(env2, 1, deps);
    expect(deps.syncGithub).not.toHaveBeenCalled();
  });
});
