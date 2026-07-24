import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { eq, sql, asc } from 'drizzle-orm';
import { createDb } from '../../db/client.js';
import {
  githubContributionDays,
  githubCommits,
  githubPullRequests,
  githubIssues,
} from '../../db/schema/github.js';
import { syncRuns } from '../../db/schema/system.js';
import { setupTestDb } from '../../test-helpers.js';
import { syncGithubIncremental, syncGithub, backfillGithub } from './sync.js';
import { GithubRateLimitError } from './client.js';
import type {
  GithubClient,
  GithubCommitRow,
  GithubItem,
  GithubRecentCommitsResult,
} from './client.js';
import type { Env } from '../../types/env.js';

/** In-memory KV fake implementing the minimal { get, put } interface. */
function makeKv(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const kv = {
    get: async (key: string): Promise<string | null> => store.get(key) ?? null,
    put: async (key: string, value: string): Promise<void> => {
      store.set(key, value);
    },
  };
  return { kv, store };
}

interface StubOptions {
  contributionDays?: Array<{ date: string; count: number }>;
  recentCommits?: GithubRecentCommitsResult;
  /**
   * Per-sha commit-stats behavior. A value throws when it is an Error instance
   * (models a transient 500 / network blip or an exhausted rate limit); null
   * models the 404/409 path; an object supplies additions/deletions.
   */
  commitStats?: Record<
    string,
    { additions: number; deletions: number } | null | Error
  >;
  prs?: GithubItem[];
  issues?: GithubItem[];
}

interface StubCalls {
  getContributionDays: Array<{ from: string; to: string }>;
  getRecentCommits: Array<{ page: number; etag?: string }>;
  getCommitStats: string[];
  searchAuthored: Array<{ type: 'pr' | 'issue'; page: number }>;
}

function makeClient(opts: StubOptions = {}): {
  client: GithubClient;
  calls: StubCalls;
} {
  const calls: StubCalls = {
    getContributionDays: [],
    getRecentCommits: [],
    getCommitStats: [],
    searchAuthored: [],
  };
  const client = {
    getContributionDays: async (from: string, to: string) => {
      calls.getContributionDays.push({ from, to });
      return opts.contributionDays ?? [];
    },
    getRecentCommits: async (page = 1, etag?: string) => {
      calls.getRecentCommits.push({ page, etag });
      return (
        opts.recentCommits ?? {
          commits: [],
          etag: null,
          notModified: false,
        }
      );
    },
    getCommitStats: async (_repo: string, sha: string) => {
      calls.getCommitStats.push(sha);
      // Distinguish "configured as null" (404 path) from "not configured".
      if (opts.commitStats && sha in opts.commitStats) {
        const configured = opts.commitStats[sha];
        if (configured instanceof Error) throw configured;
        return configured;
      }
      return { additions: 1, deletions: 1 };
    },
    searchAuthored: async (type: 'pr' | 'issue', page = 1) => {
      calls.searchAuthored.push({ type, page });
      return {
        items: type === 'pr' ? (opts.prs ?? []) : (opts.issues ?? []),
        totalCount:
          type === 'pr' ? (opts.prs ?? []).length : (opts.issues ?? []).length,
      };
    },
  } as unknown as GithubClient;
  return { client, calls };
}

function commit(
  sha: string,
  overrides: Partial<GithubCommitRow> = {}
): GithubCommitRow {
  return {
    sha,
    repo: 'me/rewind',
    message: `commit ${sha}`,
    committedAt: '2026-07-23T10:00:00Z',
    isPrivate: false,
    distinct: true,
    authorEmail: 'me@example.com',
    ...overrides,
  };
}

function pr(number: number, overrides: Partial<GithubItem> = {}): GithubItem {
  return {
    repo: 'me/rewind',
    number,
    title: `pr ${number}`,
    state: 'open',
    createdAt: '2026-07-20T10:00:00Z',
    closedAt: null,
    mergedAt: null,
    isPrivate: false,
    url: `https://github.com/me/rewind/pull/${number}`,
    ...overrides,
  };
}

beforeAll(async () => {
  await setupTestDb();
});

describe('syncGithubIncremental', () => {
  const USERNAME = 'me';

  it('upserts contribution days on (user, date) — second run with a changed count updates, not duplicates', async () => {
    const db = createDb(env.DB);
    const { kv } = makeKv();

    await syncGithubIncremental(
      db,
      makeClient({ contributionDays: [{ date: '2026-07-23', count: 3 }] })
        .client,
      kv,
      USERNAME
    );
    await syncGithubIncremental(
      db,
      makeClient({ contributionDays: [{ date: '2026-07-23', count: 7 }] })
        .client,
      kv,
      USERNAME
    );

    const rows = await db
      .select()
      .from(githubContributionDays)
      .where(eq(githubContributionDays.date, '2026-07-23'));
    expect(rows).toHaveLength(1);
    expect(rows[0].contributionCount).toBe(7);
  });

  it('passes a 30-day window to getContributionDays', async () => {
    const db = createDb(env.DB);
    const { kv } = makeKv();
    const { client, calls } = makeClient();

    await syncGithubIncremental(db, client, kv, USERNAME);

    expect(calls.getContributionDays).toHaveLength(1);
    const { from, to } = calls.getContributionDays[0];
    const spanMs = new Date(to).getTime() - new Date(from).getTime();
    const spanDays = spanMs / (1000 * 60 * 60 * 24);
    expect(spanDays).toBeGreaterThanOrEqual(29);
    expect(spanDays).toBeLessThanOrEqual(31);
  });

  it('inserts commits and dedups on sha across runs', async () => {
    const db = createDb(env.DB);
    const { kv } = makeKv();

    const first = await syncGithubIncremental(
      db,
      makeClient({
        recentCommits: {
          commits: [commit('sha-a'), commit('sha-b')],
          etag: 'etag-1',
          notModified: false,
        },
      }).client,
      kv,
      USERNAME
    );
    expect(first.newCommits.map((c) => c.sha).sort()).toEqual([
      'sha-a',
      'sha-b',
    ]);

    // Second run re-delivers sha-b plus a new sha-c.
    const second = await syncGithubIncremental(
      db,
      makeClient({
        recentCommits: {
          commits: [commit('sha-b'), commit('sha-c')],
          etag: 'etag-2',
          notModified: false,
        },
      }).client,
      kv,
      USERNAME
    );

    // Only the truly-new sha-c is reported.
    expect(second.newCommits.map((c) => c.sha)).toEqual(['sha-c']);

    const [total] = await db
      .select({ n: sql<number>`count(*)` })
      .from(githubCommits);
    expect(total.n).toBe(3);
    const rows = await db
      .select()
      .from(githubCommits)
      .orderBy(asc(githubCommits.sha));
    expect(rows.map((r) => r.sha)).toEqual(['sha-a', 'sha-b', 'sha-c']);
  });

  it('skips non-distinct commits (rebase re-pushes)', async () => {
    const db = createDb(env.DB);
    const { kv } = makeKv();

    const result = await syncGithubIncremental(
      db,
      makeClient({
        recentCommits: {
          commits: [
            commit('keep-1', { distinct: true }),
            commit('drop-1', { distinct: false }),
          ],
          etag: 'e',
          notModified: false,
        },
      }).client,
      kv,
      USERNAME
    );

    expect(result.newCommits.map((c) => c.sha)).toEqual(['keep-1']);
    const rows = await db.select().from(githubCommits);
    expect(rows.map((r) => r.sha)).toEqual(['keep-1']);
  });

  it('honors the commit-detail cap: >25 new commits → only 25 stats fetches, others keep null additions', async () => {
    const db = createDb(env.DB);
    const { kv } = makeKv();

    const commits = Array.from({ length: 30 }, (_, i) =>
      commit(`bulk-${String(i).padStart(2, '0')}`)
    );
    const { client, calls } = makeClient({
      recentCommits: { commits, etag: 'e', notModified: false },
    });

    await syncGithubIncremental(db, client, kv, USERNAME);

    expect(calls.getCommitStats).toHaveLength(25);

    const withStats = await db
      .select({ n: sql<number>`count(*)` })
      .from(githubCommits)
      .where(sql`additions is not null`);
    const nullStats = await db
      .select({ n: sql<number>`count(*)` })
      .from(githubCommits)
      .where(sql`additions is null`);
    expect(withStats[0].n).toBe(25);
    expect(nullStats[0].n).toBe(5);
  });

  it('does NOT re-fetch stats for already-stored commits (only counts NEW ones toward the cap)', async () => {
    const db = createDb(env.DB);
    const { kv } = makeKv();

    // Prime with one commit.
    await syncGithubIncremental(
      db,
      makeClient({
        recentCommits: {
          commits: [commit('old-1')],
          etag: 'e',
          notModified: false,
        },
      }).client,
      kv,
      USERNAME
    );

    // Re-deliver old-1 plus new-1; only new-1 should get a stats fetch.
    const { client, calls } = makeClient({
      recentCommits: {
        commits: [commit('old-1'), commit('new-1')],
        etag: 'e',
        notModified: false,
      },
    });
    await syncGithubIncremental(db, client, kv, USERNAME);

    expect(calls.getCommitStats).toEqual(['new-1']);
  });

  it('tolerates a transient commit-stats failure: other commits still get stats and the PR/issue phase still runs', async () => {
    const db = createDb(env.DB);
    const { kv } = makeKv();

    const { client, calls } = makeClient({
      recentCommits: {
        commits: [commit('ok-1'), commit('boom'), commit('ok-2')],
        etag: 'e',
        notModified: false,
      },
      commitStats: {
        'ok-1': { additions: 5, deletions: 2 },
        boom: new Error('502 Bad Gateway'),
        'ok-2': { additions: 3, deletions: 1 },
      },
      prs: [pr(1)],
      issues: [pr(2, { url: 'https://github.com/me/rewind/issues/2' })],
    });

    // Should NOT throw despite the transient failure on 'boom'.
    const result = await syncGithubIncremental(db, client, kv, USERNAME);

    // All three shas were attempted (loop continued past the throw).
    expect(calls.getCommitStats).toEqual(['ok-1', 'boom', 'ok-2']);

    // The two healthy commits got their stats; 'boom' stays null.
    const rows = await db
      .select()
      .from(githubCommits)
      .orderBy(asc(githubCommits.sha));
    const bySha = Object.fromEntries(rows.map((r) => [r.sha, r]));
    expect(bySha['ok-1'].additions).toBe(5);
    expect(bySha['ok-2'].additions).toBe(3);
    expect(bySha['boom'].additions).toBeNull();

    // The PR + issue phase still ran.
    expect(calls.searchAuthored).toEqual([
      { type: 'pr', page: 1 },
      { type: 'issue', page: 1 },
    ]);
    const prs = await db.select().from(githubPullRequests);
    const issues = await db.select().from(githubIssues);
    expect(prs.length).toBe(1);
    expect(issues.length).toBe(1);
    expect(result.newCommits.map((c) => c.sha).sort()).toEqual([
      'boom',
      'ok-1',
      'ok-2',
    ]);
  });

  it('rethrows a GithubRateLimitError from commit stats — an exhausted budget fails the whole sync', async () => {
    const db = createDb(env.DB);
    const { kv } = makeKv();

    const { client } = makeClient({
      recentCommits: {
        commits: [commit('rl-1')],
        etag: 'e',
        notModified: false,
      },
      commitStats: {
        'rl-1': new GithubRateLimitError('GitHub rate limit exceeded'),
      },
    });

    await expect(
      syncGithubIncremental(db, client, kv, USERNAME)
    ).rejects.toBeInstanceOf(GithubRateLimitError);
  });

  it('commit stats returning null (404 path) leaves additions null without incident', async () => {
    const db = createDb(env.DB);
    const { kv } = makeKv();

    const { client } = makeClient({
      recentCommits: {
        commits: [commit('gone')],
        etag: 'e',
        notModified: false,
      },
      commitStats: { gone: null },
    });

    await syncGithubIncremental(db, client, kv, USERNAME);

    const [row] = await db
      .select()
      .from(githubCommits)
      .where(eq(githubCommits.sha, 'gone'));
    expect(row.additions).toBeNull();
    expect(row.deletions).toBeNull();
  });

  it('304 path: passes the stored etag, skips commit processing entirely, and does not clobber the stored etag', async () => {
    const db = createDb(env.DB);
    const { kv, store } = makeKv({
      'coding:github:events:etag': 'stored-etag',
    });

    const { client, calls } = makeClient({
      recentCommits: {
        commits: [],
        etag: 'stored-etag',
        notModified: true,
      },
    });

    await syncGithubIncremental(db, client, kv, USERNAME);

    // Called with the stored etag.
    expect(calls.getRecentCommits).toEqual([{ page: 1, etag: 'stored-etag' }]);
    // No commit-detail fetches, no rows inserted.
    expect(calls.getCommitStats).toHaveLength(0);
    const [total] = await db
      .select({ n: sql<number>`count(*)` })
      .from(githubCommits);
    expect(total.n).toBe(0);
    // Stored etag preserved.
    expect(store.get('coding:github:events:etag')).toBe('stored-etag');
  });

  it('200 path: stores the new etag', async () => {
    const db = createDb(env.DB);
    const { kv, store } = makeKv();

    await syncGithubIncremental(
      db,
      makeClient({
        recentCommits: {
          commits: [commit('x')],
          etag: 'fresh-etag',
          notModified: false,
        },
      }).client,
      kv,
      USERNAME
    );

    expect(store.get('coding:github:events:etag')).toBe('fresh-etag');
  });

  it('does not put a null etag', async () => {
    const db = createDb(env.DB);
    const { kv, store } = makeKv();

    await syncGithubIncremental(
      db,
      makeClient({
        recentCommits: {
          commits: [commit('x')],
          etag: null,
          notModified: false,
        },
      }).client,
      kv,
      USERNAME
    );

    expect(store.has('coding:github:events:etag')).toBe(false);
  });

  it('upserts PRs on (repo, number): state open→merged updates in place', async () => {
    const db = createDb(env.DB);
    const { kv } = makeKv();

    await syncGithubIncremental(
      db,
      makeClient({ prs: [pr(42, { state: 'open' })] }).client,
      kv,
      USERNAME
    );
    await syncGithubIncremental(
      db,
      makeClient({
        prs: [
          pr(42, {
            state: 'merged',
            mergedAt: '2026-07-24T10:00:00Z',
            closedAt: '2026-07-24T10:00:00Z',
          }),
        ],
      }).client,
      kv,
      USERNAME
    );

    const rows = await db
      .select()
      .from(githubPullRequests)
      .where(eq(githubPullRequests.number, 42));
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('merged');
    expect(rows[0].mergedAt).toBe('2026-07-24T10:00:00Z');
  });

  it('upserts issues on (repo, number)', async () => {
    const db = createDb(env.DB);
    const { kv } = makeKv();

    await syncGithubIncremental(
      db,
      makeClient({
        issues: [
          pr(7, {
            state: 'open',
            url: 'https://github.com/me/rewind/issues/7',
          }),
        ],
      }).client,
      kv,
      USERNAME
    );
    await syncGithubIncremental(
      db,
      makeClient({
        issues: [
          pr(7, {
            state: 'closed',
            closedAt: '2026-07-25T10:00:00Z',
            url: 'https://github.com/me/rewind/issues/7',
          }),
        ],
      }).client,
      kv,
      USERNAME
    );

    const rows = await db
      .select()
      .from(githubIssues)
      .where(eq(githubIssues.number, 7));
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('closed');
    expect(rows[0].closedAt).toBe('2026-07-25T10:00:00Z');
  });

  it('skips commit processing on 304 but still runs contributions + search', async () => {
    const db = createDb(env.DB);
    const { kv } = makeKv({ 'coding:github:events:etag': 'stored' });

    const { client } = makeClient({
      contributionDays: [{ date: '2026-07-23', count: 2 }],
      recentCommits: { commits: [], etag: 'stored', notModified: true },
      prs: [pr(1)],
      issues: [pr(2, { url: 'https://github.com/me/rewind/issues/2' })],
    });

    await syncGithubIncremental(db, client, kv, USERNAME);

    const contrib = await db.select().from(githubContributionDays);
    const prs = await db.select().from(githubPullRequests);
    const issues = await db.select().from(githubIssues);
    expect(contrib.length).toBeGreaterThan(0);
    expect(prs.length).toBe(1);
    expect(issues.length).toBe(1);
  });
});

describe('syncGithub', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function githubEnv(token?: string, username?: string): Env {
    return {
      ...env,
      GITHUB_TOKEN: token,
      GITHUB_USERNAME: username,
    } as unknown as Env;
  }

  it('records a completed sync run', async () => {
    // Stub every github fetch to empty-ish responses.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('graphql')) {
        return new Response(
          JSON.stringify({
            data: {
              user: {
                contributionsCollection: {
                  contributionCalendar: { weeks: [] },
                },
              },
            },
          })
        );
      }
      if (url.includes('/events')) {
        return new Response(JSON.stringify([]), {
          headers: { ETag: 'etag-x' },
        });
      }
      if (url.includes('/search/issues')) {
        return new Response(JSON.stringify({ total_count: 0, items: [] }));
      }
      return new Response(JSON.stringify([]));
    });

    const result = await syncGithub(githubEnv('tok', 'me'));
    expect(result.synced).toBeGreaterThanOrEqual(0);

    const [run] = await createDb(env.DB)
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.syncType, 'github'));
    expect(run.domain).toBe('coding');
    expect(run.status).toBe('completed');
  });

  it('records a failed run and rethrows when GITHUB_TOKEN is unset', async () => {
    await expect(syncGithub(githubEnv(undefined, 'me'))).rejects.toThrow(
      'GITHUB_TOKEN'
    );
    const runs = await createDb(env.DB)
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.syncType, 'github'));
    const failed = runs.find((r) => r.error?.includes('GITHUB_TOKEN'));
    expect(failed).toBeDefined();
    expect(failed?.status).toBe('failed');
  });

  it('records a failed run and rethrows when GITHUB_USERNAME is unset', async () => {
    await expect(syncGithub(githubEnv('tok', undefined))).rejects.toThrow(
      'GITHUB_USERNAME'
    );
    const runs = await createDb(env.DB)
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.syncType, 'github'));
    const failed = runs.find((r) => r.error?.includes('GITHUB_USERNAME'));
    expect(failed).toBeDefined();
    expect(failed?.status).toBe('failed');
  });
});

describe('backfillGithub', () => {
  const USERNAME = 'me';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function githubEnv(token = 'tok', username = USERNAME): Env {
    return {
      ...env,
      GITHUB_TOKEN: token,
      GITHUB_USERNAME: username,
    } as unknown as Env;
  }

  /** A GraphQL calendar Response with the given per-day counts. */
  function calendarResponse(days: Array<{ date: string; count: number }>) {
    return new Response(
      JSON.stringify({
        data: {
          user: {
            contributionsCollection: {
              contributionCalendar: {
                weeks: [
                  {
                    contributionDays: days.map((d) => ({
                      date: d.date,
                      contributionCount: d.count,
                    })),
                  },
                ],
              },
            },
          },
        },
      })
    );
  }

  /** A Search-issues Response with `count` synthetic items and a total. */
  function searchResponse(
    count: number,
    totalCount: number,
    kind: 'pr' | 'issue'
  ) {
    const items = Array.from({ length: count }, (_, i) => ({
      repository_url: 'https://api.github.com/repos/me/rewind',
      number: 1000 + i,
      title: `${kind} ${i}`,
      state: 'open',
      created_at: '2026-07-20T10:00:00Z',
      closed_at: null,
      html_url: `https://github.com/me/rewind/${kind === 'pr' ? 'pull' : 'issues'}/${1000 + i}`,
      ...(kind === 'pr' ? { pull_request: { merged_at: null } } : {}),
    }));
    return new Response(JSON.stringify({ total_count: totalCount, items }));
  }

  it('contributions phase: a non-empty year advances to the previous year', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('graphql')) {
        return calendarResponse([{ date: '2026-03-01', count: 5 }]);
      }
      return new Response(JSON.stringify({ total_count: 0, items: [] }));
    });

    const result = await backfillGithub(
      githubEnv(),
      JSON.stringify({ phase: 'contributions', year: 2026 })
    );

    expect(result.itemsSynced).toBeGreaterThan(0);
    expect(result.nextCursor).toBe(
      JSON.stringify({ phase: 'contributions', year: 2025 })
    );
    const rows = await createDb(env.DB).select().from(githubContributionDays);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('contributions phase: an all-zero year advances to the prs phase', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('graphql')) {
        return calendarResponse([{ date: '2015-01-01', count: 0 }]);
      }
      return new Response(JSON.stringify({ total_count: 0, items: [] }));
    });

    const result = await backfillGithub(
      githubEnv(),
      JSON.stringify({ phase: 'contributions', year: 2015 })
    );

    expect(result.nextCursor).toBe(JSON.stringify({ phase: 'prs', page: 1 }));
  });

  it('defaults the start cursor to the contributions phase for the current UTC year', async () => {
    let graphqlBody: string | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('graphql')) {
        graphqlBody = String(init?.body ?? '');
        return calendarResponse([{ date: '2026-01-01', count: 1 }]);
      }
      return new Response(JSON.stringify({ total_count: 0, items: [] }));
    });

    await backfillGithub(githubEnv());

    const year = new Date().getUTCFullYear();
    expect(graphqlBody).toContain(`${year}-01-01`);
  });

  it('prs phase: a partial page (fewer than the cap) advances to the issues phase', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/search/issues')) {
        // 40 items, total 40 → page 1 exhausts the results.
        return searchResponse(40, 40, 'pr');
      }
      return new Response(JSON.stringify({ total_count: 0, items: [] }));
    });

    const result = await backfillGithub(
      githubEnv(),
      JSON.stringify({ phase: 'prs', page: 1 })
    );

    expect(result.itemsSynced).toBe(40);
    expect(result.nextCursor).toBe(
      JSON.stringify({ phase: 'issues', page: 1 })
    );
    const prs = await createDb(env.DB).select().from(githubPullRequests);
    expect(prs.length).toBeGreaterThan(0);
  });

  it('prs phase: a full page advances to the next page', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/search/issues')) {
        // 100 items, total 250 → page 1 has more to fetch.
        return searchResponse(100, 250, 'pr');
      }
      return new Response(JSON.stringify({ total_count: 0, items: [] }));
    });

    const result = await backfillGithub(
      githubEnv(),
      JSON.stringify({ phase: 'prs', page: 1 })
    );

    expect(result.nextCursor).toBe(JSON.stringify({ phase: 'prs', page: 2 }));
  });

  it('caps pagination at 1000 (Search API limit) and logs truncation', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logs.push(String(msg));
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/search/issues')) {
        // total 4000 but page 10 hits the 1000 cap → phase done.
        return searchResponse(100, 4000, 'pr');
      }
      return new Response(JSON.stringify({ total_count: 0, items: [] }));
    });

    const result = await backfillGithub(
      githubEnv(),
      JSON.stringify({ phase: 'prs', page: 10 })
    );

    expect(result.nextCursor).toBe(
      JSON.stringify({ phase: 'issues', page: 1 })
    );
    expect(logs.some((l) => l.includes('[INFO]') && l.includes('1000'))).toBe(
      true
    );
  });

  it('issues phase: an exhausted page completes the walk (null cursor)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/search/issues')) {
        return searchResponse(10, 10, 'issue');
      }
      return new Response(JSON.stringify({ total_count: 0, items: [] }));
    });

    const result = await backfillGithub(
      githubEnv(),
      JSON.stringify({ phase: 'issues', page: 1 })
    );

    expect(result.nextCursor).toBeNull();
    const issues = await createDb(env.DB).select().from(githubIssues);
    expect(issues.length).toBeGreaterThan(0);
  });
});
