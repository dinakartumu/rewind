import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import {
  githubCommits,
  githubPullRequests,
  githubIssues,
} from '../db/schema/github.js';
import {
  wakatimeDurations,
  wakatimeDailySummaries,
  wakatimeDailyLanguages,
} from '../db/schema/wakatime.js';
import { rescuetimeDailySummaries } from '../db/schema/rescuetime.js';
import { setupTestDb, createTestApiKey } from '../test-helpers.js';

const testEnv = env as any;

async function dbRun(sql: string, ...params: unknown[]) {
  return testEnv.DB.prepare(sql)
    .bind(...params)
    .run();
}

describe('coding routes', () => {
  let token: string;

  beforeAll(async () => {
    await setupTestDb();
    token = await createTestApiKey({ name: 'coding-test', scope: 'admin' });
  });

  beforeEach(async () => {
    const db = drizzle(env.DB);
    await db.delete(githubCommits);
    await db.delete(githubPullRequests);
    await db.delete(githubIssues);
    await db.delete(wakatimeDurations);
    await db.delete(wakatimeDailySummaries);
    await db.delete(wakatimeDailyLanguages);
    await db.delete(rescuetimeDailySummaries);
  });

  // ─── Seed helpers ───────────────────────────────────────────────────

  async function seedCommit(overrides: Record<string, unknown> = {}) {
    const defaults = {
      user_id: 1,
      sha: `sha-${Date.now()}-${Math.random()}`,
      repo: 'octocat/hello',
      message: 'Fix bug in parser\n\nLonger body here',
      additions: 10,
      deletions: 2,
      committed_at: '2026-03-10T12:00:00.000Z',
      is_private: 0,
      url: 'https://github.com/octocat/hello/commit/abc',
      created_at: '2026-03-10T12:00:00.000Z',
    };
    const row = { ...defaults, ...overrides };
    const cols = Object.keys(row);
    const placeholders = cols.map(() => '?').join(', ');
    const sql = `INSERT INTO github_commits (${cols.join(', ')}) VALUES (${placeholders})`;
    const result = await dbRun(sql, ...Object.values(row));
    return result.meta.last_row_id;
  }

  async function seedPr(overrides: Record<string, unknown> = {}) {
    const defaults = {
      user_id: 1,
      repo: 'octocat/hello',
      number: Math.floor(Math.random() * 100000),
      title: 'Add feature',
      state: 'merged',
      created_at_github: '2026-03-11T12:00:00.000Z',
      merged_at: '2026-03-12T12:00:00.000Z',
      closed_at: null,
      is_private: 0,
      url: 'https://github.com/octocat/hello/pull/1',
      created_at: '2026-03-11T12:00:00.000Z',
    };
    const row = { ...defaults, ...overrides };
    const cols = Object.keys(row);
    const placeholders = cols.map(() => '?').join(', ');
    const sql = `INSERT INTO github_pull_requests (${cols.join(', ')}) VALUES (${placeholders})`;
    const result = await dbRun(sql, ...Object.values(row));
    return result.meta.last_row_id;
  }

  async function seedIssue(overrides: Record<string, unknown> = {}) {
    const defaults = {
      user_id: 1,
      repo: 'octocat/hello',
      number: Math.floor(Math.random() * 100000),
      title: 'Something broke',
      state: 'open',
      created_at_github: '2026-03-13T12:00:00.000Z',
      closed_at: null,
      is_private: 0,
      url: 'https://github.com/octocat/hello/issues/1',
      created_at: '2026-03-13T12:00:00.000Z',
    };
    const row = { ...defaults, ...overrides };
    const cols = Object.keys(row);
    const placeholders = cols.map(() => '?').join(', ');
    const sql = `INSERT INTO github_issues (${cols.join(', ')}) VALUES (${placeholders})`;
    const result = await dbRun(sql, ...Object.values(row));
    return result.meta.last_row_id;
  }

  async function seedWakatimeDuration(overrides: Record<string, unknown> = {}) {
    const defaults = {
      user_id: 1,
      start_time: '2026-03-10T12:00:00.000Z',
      duration_seconds: 3600,
      project: 'rewind',
      language: 'TypeScript',
      entity: '/src/index.ts',
      created_at: '2026-03-10T12:00:00.000Z',
    };
    const row = { ...defaults, ...overrides };
    const cols = Object.keys(row);
    const placeholders = cols.map(() => '?').join(', ');
    const sql = `INSERT INTO wakatime_durations (${cols.join(', ')}) VALUES (${placeholders})`;
    const result = await dbRun(sql, ...Object.values(row));
    return result.meta.last_row_id;
  }

  async function seedWakatimeSummary(overrides: Record<string, unknown> = {}) {
    const defaults = {
      user_id: 1,
      date: '2026-03-10',
      total_seconds: 3600,
      top_language: 'TypeScript',
      top_project: 'rewind',
      created_at: '2026-03-10T12:00:00.000Z',
    };
    const row = { ...defaults, ...overrides };
    const cols = Object.keys(row);
    const placeholders = cols.map(() => '?').join(', ');
    const sql = `INSERT INTO wakatime_daily_summaries (${cols.join(', ')}) VALUES (${placeholders})`;
    const result = await dbRun(sql, ...Object.values(row));
    return result.meta.last_row_id;
  }

  async function seedWakatimeLanguage(overrides: Record<string, unknown> = {}) {
    const defaults = {
      user_id: 1,
      date: '2026-03-10',
      language: 'TypeScript',
      total_seconds: 3600,
      created_at: '2026-03-10T12:00:00.000Z',
    };
    const row = { ...defaults, ...overrides };
    const cols = Object.keys(row);
    const placeholders = cols.map(() => '?').join(', ');
    const sql = `INSERT INTO wakatime_daily_languages (${cols.join(', ')}) VALUES (${placeholders})`;
    const result = await dbRun(sql, ...Object.values(row));
    return result.meta.last_row_id;
  }

  async function seedRescuetimeSummary(
    overrides: Record<string, unknown> = {}
  ) {
    const defaults = {
      user_id: 1,
      date: '2026-03-10',
      total_seconds: 7200,
      productivity_pulse: 65,
      very_productive_seconds: 3600,
      productive_seconds: 1800,
      neutral_seconds: 900,
      distracting_seconds: 600,
      very_distracting_seconds: 300,
      created_at: '2026-03-10T12:00:00.000Z',
    };
    const row = { ...defaults, ...overrides };
    const cols = Object.keys(row);
    const placeholders = cols.map(() => '?').join(', ');
    const sql = `INSERT INTO rescuetime_daily_summaries (${cols.join(', ')}) VALUES (${placeholders})`;
    const result = await dbRun(sql, ...Object.values(row));
    return result.meta.last_row_id;
  }

  function authFetch(path: string) {
    return SELF.fetch(`http://localhost${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  // ─── GET /v1/coding/recent ──────────────────────────────────────────

  describe('GET /v1/coding/recent', () => {
    it('returns empty timeline and zero/null today when empty', async () => {
      const res = await authFetch('/v1/coding/recent');
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toEqual([]);
      expect(body.pagination.total).toBe(0);
      expect(body.today).toEqual({
        coding_seconds: 0,
        productivity_pulse: null,
      });
    });

    it('requires auth', async () => {
      const res = await SELF.fetch('http://localhost/v1/coding/recent');
      expect(res.status).toBe(401);
    });

    it('merges commits, prs and issues sorted desc with correct shape', async () => {
      await seedCommit({
        committed_at: '2026-03-10T12:00:00.000Z',
        message: 'First line of commit\nSecond line ignored',
        url: 'https://github.com/octocat/hello/commit/c1',
      });
      await seedPr({
        created_at_github: '2026-03-11T12:00:00.000Z',
        title: 'A PR',
        state: 'merged',
        url: 'https://github.com/octocat/hello/pull/2',
      });
      await seedIssue({
        created_at_github: '2026-03-13T12:00:00.000Z',
        title: 'An issue',
        state: 'open',
        url: 'https://github.com/octocat/hello/issues/3',
      });

      const res = await authFetch('/v1/coding/recent');
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(3);
      // newest first: issue (13th), pr (11th), commit (10th)
      expect(body.data[0].type).toBe('issue');
      expect(body.data[0].state).toBe('open');
      expect(body.data[0].occurred_at).toBe('2026-03-13T12:00:00.000Z');
      expect(body.data[1].type).toBe('pr');
      expect(body.data[1].state).toBe('merged');
      expect(body.data[2].type).toBe('commit');
      expect(body.data[2].state).toBe(null);
      // commit title is the first line of the message
      expect(body.data[2].title).toBe('First line of commit');
      expect(body.data[2].repo).toBe('octocat/hello');
      expect(body.data[2].url).toBe(
        'https://github.com/octocat/hello/commit/c1'
      );
    });

    it('includes today totals from summary tables for current UTC date', async () => {
      const today = new Date().toISOString().slice(0, 10);
      await seedWakatimeSummary({ date: today, total_seconds: 5400 });
      await seedRescuetimeSummary({ date: today, productivity_pulse: 72 });

      const res = await authFetch('/v1/coding/recent');
      const body = (await res.json()) as any;
      expect(body.today.coding_seconds).toBe(5400);
      expect(body.today.productivity_pulse).toBe(72);
    });

    it('paginates the merged timeline', async () => {
      for (let i = 0; i < 5; i++) {
        await seedCommit({
          sha: `page-sha-${i}`,
          committed_at: `2026-03-${10 + i}T12:00:00.000Z`,
        });
      }
      // page 3 fetches enough per source (page*limit = 6) to reach the tail
      const res = await authFetch('/v1/coding/recent?page=3&limit=2');
      const body = (await res.json()) as any;
      expect(body.pagination.total).toBe(5);
      expect(body.pagination.total_pages).toBe(3);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].occurred_at).toBe('2026-03-10T12:00:00.000Z');

      // page 1 returns the two newest
      const res1 = await authFetch('/v1/coding/recent?page=1&limit=2');
      const body1 = (await res1.json()) as any;
      expect(body1.data).toHaveLength(2);
      expect(body1.data[0].occurred_at).toBe('2026-03-14T12:00:00.000Z');
      expect(body1.data[1].occurred_at).toBe('2026-03-13T12:00:00.000Z');
    });

    it('filters by date range', async () => {
      await seedCommit({
        sha: 'old',
        committed_at: '2026-01-01T00:00:00.000Z',
      });
      await seedCommit({
        sha: 'new',
        committed_at: '2026-06-01T00:00:00.000Z',
      });
      const res = await authFetch(
        '/v1/coding/recent?from=2026-05-01T00:00:00Z&to=2026-07-01T00:00:00Z'
      );
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(1);
      expect(body.data[0].occurred_at).toBe('2026-06-01T00:00:00.000Z');
    });

    it('reports the true total when more commits than fetch depth exist', async () => {
      // Seed 25 commits, page 1 limit 5. The old fetch-depth cap (page*limit=5)
      // would report total=5; the real total is 25 with 5 pages.
      for (let i = 0; i < 25; i++) {
        const day = String(1 + i).padStart(2, '0');
        await seedCommit({
          sha: `total-sha-${i}`,
          committed_at: `2026-03-${day}T12:00:00.000Z`,
        });
      }
      const res = await authFetch('/v1/coding/recent?page=1&limit=5');
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(5);
      expect(body.pagination.total).toBe(25);
      expect(body.pagination.total_pages).toBe(5);
    });

    it('reports a total spanning all three sources', async () => {
      for (let i = 0; i < 8; i++) {
        const day = String(1 + i).padStart(2, '0');
        await seedCommit({
          sha: `mix-c-${i}`,
          committed_at: `2026-04-${day}T12:00:00.000Z`,
        });
        await seedPr({ created_at_github: `2026-04-${day}T13:00:00.000Z` });
        await seedIssue({ created_at_github: `2026-04-${day}T14:00:00.000Z` });
      }
      // 24 items total, limit 5 -> 5 pages
      const res = await authFetch('/v1/coding/recent?page=1&limit=5');
      const body = (await res.json()) as any;
      expect(body.pagination.total).toBe(24);
      expect(body.pagination.total_pages).toBe(5);
    });

    it('breaks equal-timestamp ties in commit, pr, issue insertion order', async () => {
      const ts = '2026-05-01T00:00:00.000Z';
      await seedCommit({ sha: 'tie-commit', committed_at: ts });
      await seedPr({ created_at_github: ts, title: 'Tie PR' });
      await seedIssue({ created_at_github: ts, title: 'Tie issue' });

      const res = await authFetch('/v1/coding/recent');
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(3);
      // stable order: commit sources first, then pr, then issue
      expect(body.data.map((d: any) => d.type)).toEqual([
        'commit',
        'pr',
        'issue',
      ]);
    });
  });

  // ─── GET /v1/coding/stats ───────────────────────────────────────────

  describe('GET /v1/coding/stats', () => {
    it('returns zeroed stats when empty', async () => {
      const res = await authFetch('/v1/coding/stats');
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body).toEqual({
        coding_seconds: 0,
        coding_days: 0,
        commits: 0,
        prs: 0,
        issues: 0,
        screen_time: {
          total_seconds: 0,
          very_productive_seconds: 0,
          productive_seconds: 0,
          neutral_seconds: 0,
          distracting_seconds: 0,
          very_distracting_seconds: 0,
        },
      });
    });

    it('requires auth', async () => {
      const res = await SELF.fetch('http://localhost/v1/coding/stats');
      expect(res.status).toBe(401);
    });

    it('aggregates coding, github and screen time', async () => {
      await seedWakatimeSummary({ date: '2026-03-10', total_seconds: 3600 });
      await seedWakatimeSummary({ date: '2026-03-11', total_seconds: 1800 });
      await seedCommit({ sha: 's1', committed_at: '2026-03-10T12:00:00.000Z' });
      await seedCommit({ sha: 's2', committed_at: '2026-03-11T12:00:00.000Z' });
      await seedPr({ created_at_github: '2026-03-10T12:00:00.000Z' });
      await seedIssue({ created_at_github: '2026-03-11T12:00:00.000Z' });
      await seedRescuetimeSummary({ date: '2026-03-10' });

      const res = await authFetch('/v1/coding/stats');
      const body = (await res.json()) as any;
      expect(body.coding_seconds).toBe(5400);
      expect(body.coding_days).toBe(2);
      expect(body.commits).toBe(2);
      expect(body.prs).toBe(1);
      expect(body.issues).toBe(1);
      expect(body.screen_time.total_seconds).toBe(7200);
      expect(body.screen_time.very_productive_seconds).toBe(3600);
    });

    it('scopes aggregations by date range', async () => {
      await seedWakatimeSummary({ date: '2026-01-01', total_seconds: 1000 });
      await seedWakatimeSummary({ date: '2026-06-01', total_seconds: 2000 });
      await seedCommit({
        sha: 'c-old',
        committed_at: '2026-01-01T00:00:00.000Z',
      });
      await seedCommit({
        sha: 'c-new',
        committed_at: '2026-06-01T00:00:00.000Z',
      });

      const res = await authFetch(
        '/v1/coding/stats?from=2026-05-01T00:00:00Z&to=2026-07-01T00:00:00Z'
      );
      const body = (await res.json()) as any;
      expect(body.coding_seconds).toBe(2000);
      expect(body.coding_days).toBe(1);
      expect(body.commits).toBe(1);
    });
  });

  // ─── GET /v1/coding/languages ───────────────────────────────────────

  describe('GET /v1/coding/languages', () => {
    it('returns empty data when empty', async () => {
      const res = await authFetch('/v1/coding/languages');
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toEqual([]);
    });

    it('requires auth', async () => {
      const res = await SELF.fetch('http://localhost/v1/coding/languages');
      expect(res.status).toBe(401);
    });

    it('groups by language with percent of range total', async () => {
      await seedWakatimeLanguage({
        date: '2026-03-10',
        language: 'TypeScript',
        total_seconds: 7500,
      });
      await seedWakatimeLanguage({
        date: '2026-03-11',
        language: 'TypeScript',
        total_seconds: 0,
      });
      await seedWakatimeLanguage({
        date: '2026-03-10',
        language: 'Python',
        total_seconds: 2500,
      });

      const res = await authFetch('/v1/coding/languages');
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(2);
      expect(body.data[0].language).toBe('TypeScript');
      expect(body.data[0].total_seconds).toBe(7500);
      expect(body.data[0].percent).toBe(75.0);
      expect(body.data[1].language).toBe('Python');
      expect(body.data[1].percent).toBe(25.0);
    });

    it('scopes by from/to on the YYYY-MM-DD date column', async () => {
      await seedWakatimeLanguage({
        date: '2026-01-05',
        language: 'Go',
        total_seconds: 1000,
      });
      await seedWakatimeLanguage({
        date: '2026-06-05',
        language: 'Rust',
        total_seconds: 2000,
      });

      const res = await authFetch(
        '/v1/coding/languages?from=2026-05-01T00:00:00Z&to=2026-07-01T00:00:00Z'
      );
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(1);
      expect(body.data[0].language).toBe('Rust');
      expect(body.data[0].percent).toBe(100.0);
    });

    it('clamps limit', async () => {
      for (let i = 0; i < 5; i++) {
        await seedWakatimeLanguage({
          date: '2026-03-10',
          language: `Lang${i}`,
          total_seconds: 100 * (i + 1),
        });
      }
      const res = await authFetch('/v1/coding/languages?limit=2');
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(2);
      // limit > max clamps to 50 (no error)
      const res2 = await authFetch('/v1/coding/languages?limit=999');
      expect(res2.status).toBe(200);
    });

    it('computes percent over the full range total, not just shown rows', async () => {
      // Seed four languages summing to 10000s, but only show 2. The denominator
      // must be the un-limited range total (10000), so shown percents sum < 100.
      await seedWakatimeLanguage({
        date: '2026-03-10',
        language: 'TypeScript',
        total_seconds: 5000,
      });
      await seedWakatimeLanguage({
        date: '2026-03-10',
        language: 'Python',
        total_seconds: 3000,
      });
      await seedWakatimeLanguage({
        date: '2026-03-10',
        language: 'Go',
        total_seconds: 1500,
      });
      await seedWakatimeLanguage({
        date: '2026-03-10',
        language: 'Rust',
        total_seconds: 500,
      });

      const res = await authFetch('/v1/coding/languages?limit=2');
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(2);
      expect(body.data[0].language).toBe('TypeScript');
      expect(body.data[0].percent).toBe(50.0); // 5000 / 10000
      expect(body.data[1].language).toBe('Python');
      expect(body.data[1].percent).toBe(30.0); // 3000 / 10000
      const shownSum = body.data.reduce(
        (s: number, r: any) => s + r.percent,
        0
      );
      expect(shownSum).toBeCloseTo(80.0, 5);
      expect(shownSum).toBeLessThan(100);
    });
  });

  // ─── GET /v1/coding/projects ────────────────────────────────────────

  describe('GET /v1/coding/projects', () => {
    it('returns empty data when empty', async () => {
      const res = await authFetch('/v1/coding/projects');
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toEqual([]);
    });

    it('requires auth', async () => {
      const res = await SELF.fetch('http://localhost/v1/coding/projects');
      expect(res.status).toBe(401);
    });

    it('groups durations by project with commit counts', async () => {
      await seedWakatimeDuration({
        project: 'rewind',
        duration_seconds: 3600,
        start_time: '2026-03-10T12:00:00.000Z',
        entity: '/a.ts',
      });
      await seedWakatimeDuration({
        project: 'rewind',
        duration_seconds: 1800,
        start_time: '2026-03-10T13:00:00.000Z',
        entity: '/b.ts',
      });
      await seedWakatimeDuration({
        project: 'other',
        duration_seconds: 900,
        start_time: '2026-03-10T14:00:00.000Z',
        entity: '/c.ts',
      });
      // commit repo ends with /rewind
      await seedCommit({ sha: 'r1', repo: 'octocat/rewind' });
      await seedCommit({ sha: 'r2', repo: 'octocat/rewind' });
      await seedCommit({ sha: 'o1', repo: 'octocat/other' });

      const res = await authFetch('/v1/coding/projects');
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(2);
      expect(body.data[0].project).toBe('rewind');
      expect(body.data[0].total_seconds).toBe(5400);
      expect(body.data[0].commits).toBe(2);
      expect(body.data[1].project).toBe('other');
      expect(body.data[1].total_seconds).toBe(900);
      expect(body.data[1].commits).toBe(1);
    });

    it('scopes durations by date and clamps limit', async () => {
      await seedWakatimeDuration({
        project: 'old',
        start_time: '2026-01-01T00:00:00.000Z',
        entity: '/old.ts',
      });
      await seedWakatimeDuration({
        project: 'new',
        start_time: '2026-06-01T00:00:00.000Z',
        entity: '/new.ts',
      });
      const res = await authFetch(
        '/v1/coding/projects?from=2026-05-01T00:00:00Z&to=2026-07-01T00:00:00Z'
      );
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(1);
      expect(body.data[0].project).toBe('new');

      const res2 = await authFetch('/v1/coding/projects?limit=999');
      expect(res2.status).toBe(200);
    });

    it('escapes LIKE wildcards in the project name when matching repos', async () => {
      // Project name literally contains an underscore. Without ESCAPE, the '_'
      // is a single-char wildcard and would match 'octocat/myXapp' etc.
      await seedWakatimeDuration({
        project: 'my_app',
        duration_seconds: 3600,
        start_time: '2026-03-10T12:00:00.000Z',
        entity: '/x.ts',
      });
      // Exact literal match — should count.
      await seedCommit({ sha: 'w1', repo: 'octocat/my_app' });
      // Would be matched by an unescaped '_' wildcard, must NOT count.
      await seedCommit({ sha: 'w2', repo: 'octocat/myXapp' });

      const res = await authFetch('/v1/coding/projects');
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(1);
      expect(body.data[0].project).toBe('my_app');
      expect(body.data[0].commits).toBe(1);
    });
  });
});
