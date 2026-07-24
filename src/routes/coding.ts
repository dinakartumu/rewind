import { createRoute, z } from '@hono/zod-openapi';
import { eq, and, desc, gte, lte, sql, count, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { createDb } from '../db/client.js';
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
import { setCache } from '../lib/cache.js';
import { DateFilterQuery, buildDateCondition } from '../lib/date-filters.js';
import { createOpenAPIApp } from '../lib/openapi.js';
import {
  errorResponses,
  PaginationMeta,
  PaginationQuery,
} from '../lib/schemas/common.js';

const coding = createOpenAPIApp();

// ─── Helper functions ────────────────────────────────────────────────

function paginate(page: number, limit: number, total: number) {
  return {
    page,
    limit,
    total,
    total_pages: Math.ceil(total / limit),
  };
}

/** Scope a YYYY-MM-DD date column using plain string compares on the first
 *  10 chars of from/to (the column is a date, not a full ISO timestamp).
 *  `date` takes precedence over `from`/`to`, mirroring buildDateCondition. */
function buildDateStringCondition(
  column: SQLiteColumn,
  params: { date?: string; from?: string; to?: string }
): SQL | undefined {
  if (params.date) {
    return eq(column, params.date.slice(0, 10));
  }
  const conditions: SQL[] = [];
  if (params.from) conditions.push(gte(column, params.from.slice(0, 10)));
  if (params.to) conditions.push(lte(column, params.to.slice(0, 10)));
  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return and(...conditions);
}

// ─── Schemas ─────────────────────────────────────────────────────────

const TimelineItemSchema = z.object({
  type: z.enum(['commit', 'pr', 'issue']),
  repo: z.string(),
  title: z.string(),
  occurred_at: z.string(),
  state: z.string().nullable(),
  url: z.string(),
});

const TodaySchema = z.object({
  coding_seconds: z.number(),
  productivity_pulse: z.number().nullable(),
});

const ScreenTimeSchema = z.object({
  total_seconds: z.number(),
  very_productive_seconds: z.number(),
  productive_seconds: z.number(),
  neutral_seconds: z.number(),
  distracting_seconds: z.number(),
  very_distracting_seconds: z.number(),
});

const CodingStatsSchema = z.object({
  coding_seconds: z.number(),
  coding_days: z.number(),
  commits: z.number(),
  prs: z.number(),
  issues: z.number(),
  screen_time: ScreenTimeSchema,
});

const LanguageSchema = z.object({
  language: z.string(),
  total_seconds: z.number(),
  percent: z.number(),
});

const ProjectSchema = z.object({
  project: z.string(),
  total_seconds: z.number(),
  commits: z.number(),
});

// ─── Routes ──────────────────────────────────────────────────────────

// 1. GET /recent
const recentRoute = createRoute({
  method: 'get',
  path: '/recent',
  operationId: 'getCodingRecent',
  tags: ['Coding'],
  summary: 'Recent coding activity',
  description:
    'Merged timeline of GitHub commits, pull requests, and issues, newest first, plus a today object with coding seconds (WakaTime) and productivity pulse (RescueTime) for the current UTC date.',
  request: {
    query: PaginationQuery.merge(DateFilterQuery),
  },
  responses: {
    200: {
      description: 'Recent coding activity',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(TimelineItemSchema),
            pagination: PaginationMeta,
            today: TodaySchema,
          }),
          example: {
            data: [
              {
                type: 'pr',
                repo: 'pdugan20/rewind',
                title: 'Add coding domain routes',
                occurred_at: '2026-07-24T15:02:00.000Z',
                state: 'merged',
                url: 'https://github.com/pdugan20/rewind/pull/42',
              },
              {
                type: 'commit',
                repo: 'pdugan20/rewind',
                title: 'feat(coding): routes',
                occurred_at: '2026-07-24T14:40:00.000Z',
                state: null,
                url: 'https://github.com/pdugan20/rewind/commit/abc123',
              },
            ],
            pagination: { page: 1, limit: 20, total: 128, total_pages: 7 },
            today: { coding_seconds: 5400, productivity_pulse: 72 },
          },
        },
      },
    },
    ...errorResponses(400, 401),
  },
});

// 2. GET /stats
const statsRoute = createRoute({
  method: 'get',
  path: '/stats',
  operationId: 'getCodingStats',
  tags: ['Coding'],
  summary: 'Coding stats',
  description:
    'Aggregate coding statistics: coding seconds and active days (WakaTime), commit/PR/issue counts (GitHub), and a screen-time breakdown (RescueTime). Optional date/from/to params scope every aggregation to the range.',
  request: {
    query: DateFilterQuery,
  },
  responses: {
    200: {
      description: 'Coding statistics',
      content: {
        'application/json': {
          schema: CodingStatsSchema,
          example: {
            coding_seconds: 486000,
            coding_days: 142,
            commits: 1203,
            prs: 87,
            issues: 41,
            screen_time: {
              total_seconds: 720000,
              very_productive_seconds: 410000,
              productive_seconds: 150000,
              neutral_seconds: 80000,
              distracting_seconds: 60000,
              very_distracting_seconds: 20000,
            },
          },
        },
      },
    },
    ...errorResponses(400, 401),
  },
});

// 3. GET /languages
const languagesRoute = createRoute({
  method: 'get',
  path: '/languages',
  operationId: 'getCodingLanguages',
  tags: ['Coding'],
  summary: 'Top languages',
  description:
    'Per-language coding time over the range (from wakatime_daily_languages), with percent of the range total. Supports date filtering and limit (default 10, max 50).',
  request: {
    query: z
      .object({
        limit: z.coerce.number().int().min(1).optional().default(10),
      })
      .merge(DateFilterQuery),
  },
  responses: {
    200: {
      description: 'Top languages',
      content: {
        'application/json': {
          schema: z.object({ data: z.array(LanguageSchema) }),
          example: {
            data: [
              { language: 'TypeScript', total_seconds: 360000, percent: 74.1 },
              { language: 'Python', total_seconds: 90000, percent: 18.5 },
            ],
          },
        },
      },
    },
    ...errorResponses(400, 401),
  },
});

// 4. GET /projects
const projectsRoute = createRoute({
  method: 'get',
  path: '/projects',
  operationId: 'getCodingProjects',
  tags: ['Coding'],
  summary: 'Top projects',
  description:
    'Per-project coding time (WakaTime durations) with a matching GitHub commit count (commits whose repo ends with /{project}). Supports date filtering and limit (default 10, max 50).',
  request: {
    query: z
      .object({
        limit: z.coerce.number().int().min(1).optional().default(10),
      })
      .merge(DateFilterQuery),
  },
  responses: {
    200: {
      description: 'Top projects',
      content: {
        'application/json': {
          schema: z.object({ data: z.array(ProjectSchema) }),
          example: {
            data: [
              { project: 'rewind', total_seconds: 180000, commits: 412 },
              { project: 'dotfiles', total_seconds: 24000, commits: 33 },
            ],
          },
        },
      },
    },
    ...errorResponses(400, 401),
  },
});

// ─── Handlers ────────────────────────────────────────────────────────

// 1. GET /recent
coding.openapi(recentRoute, async (c) => {
  setCache(c, 'short');
  const db = createDb(c.env.DB);
  const { page, limit, date, from, to } = c.req.valid('query');

  const commitDate = buildDateCondition(githubCommits.committedAt, {
    date,
    from,
    to,
  });
  const prDate = buildDateCondition(githubPullRequests.createdAtGithub, {
    date,
    from,
    to,
  });
  const issueDate = buildDateCondition(githubIssues.createdAtGithub, {
    date,
    from,
    to,
  });

  // Per-source limited fetch (page * limit is the deepest row we could need),
  // then merge + sort + paginate in JS.
  const fetchLimit = page * limit;

  const commitConds = [eq(githubCommits.userId, 1)];
  if (commitDate) commitConds.push(commitDate);
  const commitRows = await db
    .select({
      repo: githubCommits.repo,
      message: githubCommits.message,
      occurredAt: githubCommits.committedAt,
      url: githubCommits.url,
    })
    .from(githubCommits)
    .where(and(...commitConds))
    .orderBy(desc(githubCommits.committedAt))
    .limit(fetchLimit);

  const prConds = [eq(githubPullRequests.userId, 1)];
  if (prDate) prConds.push(prDate);
  const prRows = await db
    .select({
      repo: githubPullRequests.repo,
      title: githubPullRequests.title,
      occurredAt: githubPullRequests.createdAtGithub,
      state: githubPullRequests.state,
      url: githubPullRequests.url,
    })
    .from(githubPullRequests)
    .where(and(...prConds))
    .orderBy(desc(githubPullRequests.createdAtGithub))
    .limit(fetchLimit);

  const issueConds = [eq(githubIssues.userId, 1)];
  if (issueDate) issueConds.push(issueDate);
  const issueRows = await db
    .select({
      repo: githubIssues.repo,
      title: githubIssues.title,
      occurredAt: githubIssues.createdAtGithub,
      state: githubIssues.state,
      url: githubIssues.url,
    })
    .from(githubIssues)
    .where(and(...issueConds))
    .orderBy(desc(githubIssues.createdAtGithub))
    .limit(fetchLimit);

  const merged = [
    ...commitRows.map((r) => ({
      type: 'commit' as const,
      repo: r.repo,
      title: r.message.split('\n')[0],
      occurred_at: r.occurredAt,
      state: null as string | null,
      url: r.url,
    })),
    ...prRows.map((r) => ({
      type: 'pr' as const,
      repo: r.repo,
      title: r.title,
      occurred_at: r.occurredAt,
      state: r.state as string | null,
      url: r.url,
    })),
    ...issueRows.map((r) => ({
      type: 'issue' as const,
      repo: r.repo,
      title: r.title,
      occurred_at: r.occurredAt,
      state: r.state as string | null,
      url: r.url,
    })),
  ];

  // Newest first; equal timestamps keep insertion order (commit → pr → issue),
  // which Array.prototype.sort preserves for a comparator returning 0.
  merged.sort((a, b) => {
    if (a.occurred_at === b.occurred_at) return 0;
    return a.occurred_at < b.occurred_at ? 1 : -1;
  });

  // True total across all three sources (independent of the per-source fetch
  // depth used above). Three scoped count() queries, summed.
  const [commitCountRow] = await db
    .select({ c: count() })
    .from(githubCommits)
    .where(and(...commitConds));
  const [prCountRow] = await db
    .select({ c: count() })
    .from(githubPullRequests)
    .where(and(...prConds));
  const [issueCountRow] = await db
    .select({ c: count() })
    .from(githubIssues)
    .where(and(...issueConds));
  const total =
    (commitCountRow?.c ?? 0) + (prCountRow?.c ?? 0) + (issueCountRow?.c ?? 0);
  const pageItems = merged.slice((page - 1) * limit, page * limit);

  // today object from the daily-summary tables for the current UTC date.
  const today = new Date().toISOString().slice(0, 10);
  const [wakaToday] = await db
    .select({ totalSeconds: wakatimeDailySummaries.totalSeconds })
    .from(wakatimeDailySummaries)
    .where(
      and(
        eq(wakatimeDailySummaries.userId, 1),
        eq(wakatimeDailySummaries.date, today)
      )
    );
  const [rescueToday] = await db
    .select({ productivityPulse: rescuetimeDailySummaries.productivityPulse })
    .from(rescuetimeDailySummaries)
    .where(
      and(
        eq(rescuetimeDailySummaries.userId, 1),
        eq(rescuetimeDailySummaries.date, today)
      )
    );

  return c.json({
    data: pageItems,
    pagination: paginate(page, limit, total),
    today: {
      coding_seconds: wakaToday?.totalSeconds ?? 0,
      productivity_pulse: rescueToday?.productivityPulse ?? null,
    },
  });
});

// 2. GET /stats
coding.openapi(statsRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);
  const { date, from, to } = c.req.valid('query');

  const summaryDate = buildDateStringCondition(wakatimeDailySummaries.date, {
    date,
    from,
    to,
  });
  const wakaConds = [eq(wakatimeDailySummaries.userId, 1)];
  if (summaryDate) wakaConds.push(summaryDate);
  const [waka] = await db
    .select({
      seconds: sql<number>`coalesce(sum(${wakatimeDailySummaries.totalSeconds}), 0)`,
      days: count(),
    })
    .from(wakatimeDailySummaries)
    .where(and(...wakaConds));

  const rescueDate = buildDateStringCondition(rescuetimeDailySummaries.date, {
    date,
    from,
    to,
  });
  const rescueConds = [eq(rescuetimeDailySummaries.userId, 1)];
  if (rescueDate) rescueConds.push(rescueDate);
  const [rescue] = await db
    .select({
      total: sql<number>`coalesce(sum(${rescuetimeDailySummaries.totalSeconds}), 0)`,
      veryProductive: sql<number>`coalesce(sum(${rescuetimeDailySummaries.veryProductiveSeconds}), 0)`,
      productive: sql<number>`coalesce(sum(${rescuetimeDailySummaries.productiveSeconds}), 0)`,
      neutral: sql<number>`coalesce(sum(${rescuetimeDailySummaries.neutralSeconds}), 0)`,
      distracting: sql<number>`coalesce(sum(${rescuetimeDailySummaries.distractingSeconds}), 0)`,
      veryDistracting: sql<number>`coalesce(sum(${rescuetimeDailySummaries.veryDistractingSeconds}), 0)`,
    })
    .from(rescuetimeDailySummaries)
    .where(and(...rescueConds));

  const commitDate = buildDateCondition(githubCommits.committedAt, {
    date,
    from,
    to,
  });
  const commitConds = [eq(githubCommits.userId, 1)];
  if (commitDate) commitConds.push(commitDate);
  const [commitRow] = await db
    .select({ c: count() })
    .from(githubCommits)
    .where(and(...commitConds));

  const prDate = buildDateCondition(githubPullRequests.createdAtGithub, {
    date,
    from,
    to,
  });
  const prConds = [eq(githubPullRequests.userId, 1)];
  if (prDate) prConds.push(prDate);
  const [prRow] = await db
    .select({ c: count() })
    .from(githubPullRequests)
    .where(and(...prConds));

  const issueDate = buildDateCondition(githubIssues.createdAtGithub, {
    date,
    from,
    to,
  });
  const issueConds = [eq(githubIssues.userId, 1)];
  if (issueDate) issueConds.push(issueDate);
  const [issueRow] = await db
    .select({ c: count() })
    .from(githubIssues)
    .where(and(...issueConds));

  return c.json({
    coding_seconds: waka?.seconds ?? 0,
    coding_days: waka?.days ?? 0,
    commits: commitRow?.c ?? 0,
    prs: prRow?.c ?? 0,
    issues: issueRow?.c ?? 0,
    screen_time: {
      total_seconds: rescue?.total ?? 0,
      very_productive_seconds: rescue?.veryProductive ?? 0,
      productive_seconds: rescue?.productive ?? 0,
      neutral_seconds: rescue?.neutral ?? 0,
      distracting_seconds: rescue?.distracting ?? 0,
      very_distracting_seconds: rescue?.veryDistracting ?? 0,
    },
  });
});

// 3. GET /languages
coding.openapi(languagesRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);
  const { limit: rawLimit, date, from, to } = c.req.valid('query');
  const limit = Math.min(rawLimit, 50);

  const conds = [eq(wakatimeDailyLanguages.userId, 1)];
  const dateCond = buildDateStringCondition(wakatimeDailyLanguages.date, {
    date,
    from,
    to,
  });
  if (dateCond) conds.push(dateCond);

  const rows = await db
    .select({
      language: wakatimeDailyLanguages.language,
      totalSeconds: sql<number>`sum(${wakatimeDailyLanguages.totalSeconds})`,
    })
    .from(wakatimeDailyLanguages)
    .where(and(...conds))
    .groupBy(wakatimeDailyLanguages.language)
    .orderBy(desc(sql`sum(${wakatimeDailyLanguages.totalSeconds})`))
    .limit(limit);

  // Denominator is the un-limited sum over the same conditions, so percents are
  // a share of the whole range (not just the shown rows) and can sum to < 100.
  const [totalRow] = await db
    .select({
      total: sql<number>`coalesce(sum(${wakatimeDailyLanguages.totalSeconds}), 0)`,
    })
    .from(wakatimeDailyLanguages)
    .where(and(...conds));
  const rangeTotal = totalRow?.total ?? 0;

  return c.json({
    data: rows.map((r) => ({
      language: r.language,
      total_seconds: r.totalSeconds,
      percent:
        rangeTotal > 0
          ? Math.round((r.totalSeconds / rangeTotal) * 1000) / 10
          : 0,
    })),
  });
});

// 4. GET /projects
coding.openapi(projectsRoute, async (c) => {
  setCache(c, 'medium');
  const db = createDb(c.env.DB);
  const { limit: rawLimit, date, from, to } = c.req.valid('query');
  const limit = Math.min(rawLimit, 50);

  const conds = [
    eq(wakatimeDurations.userId, 1),
    sql`${wakatimeDurations.project} IS NOT NULL`,
  ];
  const dateCond = buildDateCondition(wakatimeDurations.startTime, {
    date,
    from,
    to,
  });
  if (dateCond) conds.push(dateCond);

  // Commit count comes from a correlated subquery inside the grouped select, so
  // the whole thing is a single D1 query (no per-project N+1 subrequests, which
  // blow the free-plan subrequest cap). The repo match is `%/<project>` with the
  // project's own LIKE wildcards (\ % _) escaped via ESCAPE '\'.
  const escapedProject = sql`replace(replace(replace(${wakatimeDurations.project}, '\\', '\\\\'), '%', '\\%'), '_', '\\_')`;

  const projectRows = await db
    .select({
      project: wakatimeDurations.project,
      totalSeconds: sql<number>`sum(${wakatimeDurations.durationSeconds})`,
      commits: sql<number>`(select count(*) from github_commits gc where gc.user_id = 1 and gc.repo like '%/' || ${escapedProject} escape '\\')`,
    })
    .from(wakatimeDurations)
    .where(and(...conds))
    .groupBy(wakatimeDurations.project)
    .orderBy(desc(sql`sum(${wakatimeDurations.durationSeconds})`))
    .limit(limit);

  const data = projectRows.map((row) => ({
    project: row.project!,
    total_seconds: row.totalSeconds,
    commits: row.commits ?? 0,
  }));

  return c.json({ data });
});

export default coding;
