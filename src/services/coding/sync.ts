import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { createDb, type Database } from '../../db/client.js';
import { wakatimeDailySummaries } from '../../db/schema/wakatime.js';
import { githubCommits } from '../../db/schema/github.js';
import { activityFeed } from '../../db/schema/system.js';
import { afterSync, type FeedItem } from '../../lib/after-sync.js';
import { syncWakatime as realSyncWakatime } from '../wakatime/sync.js';
import { syncRescuetime as realSyncRescuetime } from '../rescuetime/sync.js';
import { syncGithub as realSyncGithub } from '../github/sync.js';
import type { Env } from '../../types/env.js';

/**
 * Injectable source entrypoints. syncCoding runs each configured source
 * through these; production uses the real imports, tests pass stubs to
 * assert orchestration (skip / isolation / ordering) without touching the
 * network. Each entrypoint owns its own sync_runs lifecycle.
 */
export interface CodingSyncDeps {
  syncWakatime: (env: Env, userId?: number) => Promise<unknown>;
  syncRescuetime: (env: Env, userId?: number) => Promise<unknown>;
  syncGithub: (env: Env, userId?: number) => Promise<unknown>;
}

const defaultDeps: CodingSyncDeps = {
  syncWakatime: realSyncWakatime,
  syncRescuetime: realSyncRescuetime,
  syncGithub: realSyncGithub,
};

/** Format seconds as `Xh Ym` over an hour, bare `Ym` under an hour. */
export function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

/** Half-open UTC bounds [dateT00:00:00.000Z, nextDayT00:00:00.000Z). */
function dayBounds(date: string): { start: string; end: string } {
  const start = `${date}T00:00:00.000Z`;
  const next = new Date(start);
  next.setUTCDate(next.getUTCDate() + 1);
  return { start, end: next.toISOString() };
}

/** UTC YYYY-MM-DD for a Date. */
function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Build the daily feed rollup for one day from that day's summary tables and
 * commit activity. Title format:
 *
 *   "Coded 4h 12m (TypeScript · rewind) · 9 commits across 2 repos"
 *
 * The coding-time segment comes from wakatime_daily_summaries (with a
 * `(top language · top project)` parenthetical when either is present); the
 * commits segment counts github_commits authored within the UTC day window
 * and the distinct repos touched. Segments drop out when their source has no
 * data; returns null when BOTH are empty (no feed row for empty days).
 *
 * RescueTime screen time is deliberately excluded — the rollup answers "what
 * did I build", not "how long was I at the screen".
 */
export async function buildDailyRollup(
  db: Database,
  date: string,
  userId: number
): Promise<FeedItem | null> {
  const { start, end } = dayBounds(date);

  const [wakaRow] = await db
    .select({
      totalSeconds: wakatimeDailySummaries.totalSeconds,
      topLanguage: wakatimeDailySummaries.topLanguage,
      topProject: wakatimeDailySummaries.topProject,
    })
    .from(wakatimeDailySummaries)
    .where(
      and(
        eq(wakatimeDailySummaries.userId, userId),
        eq(wakatimeDailySummaries.date, date)
      )
    );

  const [commitAgg] = await db
    .select({
      commits: sql<number>`count(*)`,
      repos: sql<number>`count(distinct ${githubCommits.repo})`,
    })
    .from(githubCommits)
    .where(
      and(
        eq(githubCommits.userId, userId),
        gte(githubCommits.committedAt, start),
        lt(githubCommits.committedAt, end)
      )
    );

  const commitCount = commitAgg?.commits ?? 0;
  const repoCount = commitAgg?.repos ?? 0;

  const segments: string[] = [];

  // Require at least a full minute of coding time; formatDuration floors to
  // whole minutes, so anything under 60s would render a misleading "Coded 0m".
  if (wakaRow && wakaRow.totalSeconds >= 60) {
    const context = [wakaRow.topLanguage, wakaRow.topProject]
      .filter((v): v is string => Boolean(v))
      .join(' · ');
    const parenthetical = context ? ` (${context})` : '';
    segments.push(
      `Coded ${formatDuration(wakaRow.totalSeconds)}${parenthetical}`
    );
  }

  if (commitCount > 0) {
    const commitLabel = `${commitCount} commit${commitCount === 1 ? '' : 's'}`;
    const repoLabel = `${repoCount} repo${repoCount === 1 ? '' : 's'}`;
    segments.push(`${commitLabel} across ${repoLabel}`);
  }

  if (segments.length === 0) return null;

  return {
    domain: 'coding',
    eventType: 'daily_rollup',
    occurredAt: `${date}T23:59:59.000Z`,
    title: segments.join(' · '),
    sourceId: `coding:day:${date}`,
  };
}

/**
 * Coding-domain orchestrator. Runs every configured source (skipping any whose
 * credentials are unset) sequentially, each in its own try/catch so one
 * failure logs `[ERROR]` and does not block the others — the source entrypoint
 * has already recorded its own failed sync_runs row. After the sources, emits
 * the daily feed rollup for YESTERDAY (UTC), inserting the row on first run and
 * updating it in place on later runs so the title corrects as late data lands.
 *
 * `deps` is injectable for tests; production uses the real source entrypoints.
 */
export async function syncCoding(
  env: Env,
  userId = 1,
  deps: CodingSyncDeps = defaultDeps
): Promise<void> {
  const sources: {
    name: string;
    configured: boolean;
    run: () => Promise<unknown>;
  }[] = [
    {
      name: 'wakatime',
      configured: Boolean(env.WAKATIME_API_KEY),
      run: () => deps.syncWakatime(env, userId),
    },
    {
      name: 'rescuetime',
      configured: Boolean(env.RESCUETIME_API_KEY),
      run: () => deps.syncRescuetime(env, userId),
    },
    {
      name: 'github',
      configured: Boolean(env.GITHUB_TOKEN && env.GITHUB_USERNAME),
      run: () => deps.syncGithub(env, userId),
    },
  ];

  for (const source of sources) {
    if (!source.configured) {
      console.log(`[SYNC] Skipping ${source.name}: not configured`);
      continue;
    }
    try {
      await source.run();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[ERROR] Coding source ${source.name} failed: ${msg}`);
    }
  }

  // Roll up YESTERDAY (UTC). Commit counts are final once the day is over, but
  // WakaTime keeps correcting yesterday's totals for a while after midnight —
  // so we update the feed row in place rather than freezing the first insert.
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const date = utcDate(yesterday);

  const db = createDb(env.DB);
  const item = await buildDailyRollup(db, date, userId);
  if (!item) return;

  // afterSync's insertFeedItems dedups by sourceId, so it can only create the
  // row, never refresh it. If the row already exists, update its title in place
  // (leaving occurred_at untouched) so late-landing WakaTime data is reflected.
  const [existing] = await db
    .select({ id: activityFeed.id })
    .from(activityFeed)
    .where(
      and(
        eq(activityFeed.domain, 'coding'),
        eq(activityFeed.sourceId, item.sourceId)
      )
    );

  if (existing) {
    await db
      .update(activityFeed)
      .set({ title: item.title })
      .where(eq(activityFeed.id, existing.id));
    console.log(`[SYNC] Coding rollup updated for ${date}: ${item.title}`);
  } else {
    await afterSync(db, { domain: 'coding', feedItems: [item] });
    console.log(`[SYNC] Coding rollup written for ${date}: ${item.title}`);
  }
}
