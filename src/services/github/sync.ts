import { eq } from 'drizzle-orm';
import { createDb, type Database } from '../../db/client.js';
import {
  githubContributionDays,
  githubCommits,
  githubPullRequests,
  githubIssues,
} from '../../db/schema/github.js';
import { syncRuns } from '../../db/schema/system.js';
import { GithubClient } from './client.js';
import type { Env } from '../../types/env.js';

/**
 * Per-run cap on commit-detail (additions/deletions) fetches. Keeps hourly
 * runs cheap: only the first COMMIT_DETAIL_CAP truly-new commits get a stats
 * fetch; the rest keep null additions/deletions until a later run (or never —
 * old commits stay null once they scroll off the events feed).
 */
const COMMIT_DETAIL_CAP = 25;

/** KV key holding the last-seen ETag for the events feed. */
const EVENTS_ETAG_KEY = 'coding:github:events:etag';

/** Rolling contribution window (days) fetched each incremental run. */
const CONTRIBUTION_WINDOW_DAYS = 30;

/**
 * Minimal KV surface used by the sync: just conditional-request ETag get/put.
 * `env.REWIND_CACHE` (a KVNamespace) satisfies this. Typed narrowly so tests
 * can pass a plain in-memory Map wrapper.
 */
export interface EtagStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

/** What Task 9's feed rollup needs from a newly-inserted commit. */
export interface GithubNewCommit {
  sha: string;
  repo: string;
  committedAt: string;
}

export interface GithubIncrementalResult {
  synced: number;
  newCommits: GithubNewCommit[];
}

/** UTC YYYY-MM-DD for a Date. */
function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Incremental GitHub sync:
 *
 * 1. Contributions — the last CONTRIBUTION_WINDOW_DAYS days from the GraphQL
 *    calendar, upserted on (user, date) since recent counts keep changing.
 * 2. Commits — the first events-feed page, guarded by a conditional request
 *    (If-None-Match with the stored ETag). A 304 skips the whole commit phase
 *    (and does not touch the stored etag). Otherwise: non-distinct commits
 *    (rebase re-pushes) are dropped, the rest are inserted onConflictDoNothing
 *    on sha (meta.changes counts truly-new rows), additions/deletions are
 *    fetched for at most COMMIT_DETAIL_CAP NEW commits, and the fresh etag is
 *    stored (only when non-null).
 *    Note: other-author commits inside the user's own pushes are deliberately
 *    NOT filtered (author-email matching is unreliable; documented tradeoff).
 * 3. PRs + issues — the first search page each, upserted on (repo, number)
 *    since state / mergedAt / closedAt change over time.
 */
export async function syncGithubIncremental(
  db: Database,
  client: GithubClient,
  kv: EtagStore,
  username: string,
  userId = 1
): Promise<GithubIncrementalResult> {
  // The client already carries the username (baked in at construction); it is
  // also part of this signature per the domain contract so callers reason
  // about "whose activity" without inspecting the client. Referenced here to
  // keep that intent explicit.
  void username;
  let synced = 0;
  const newCommits: GithubNewCommit[] = [];

  // ── 1. Contributions ──────────────────────────────────────────────────
  const now = new Date();
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - CONTRIBUTION_WINDOW_DAYS);
  const contributionDays = await client.getContributionDays(
    utcDate(from),
    utcDate(now)
  );
  for (const day of contributionDays) {
    await db
      .insert(githubContributionDays)
      .values({
        userId,
        date: day.date,
        contributionCount: day.count,
      })
      .onConflictDoUpdate({
        target: [githubContributionDays.userId, githubContributionDays.date],
        set: { contributionCount: day.count },
      });
  }
  synced += contributionDays.length;

  // ── 2. Commits (conditional on the events-feed ETag) ──────────────────
  const storedEtag = (await kv.get(EVENTS_ETAG_KEY)) ?? undefined;
  const events = await client.getRecentCommits(1, storedEtag);

  if (events.notModified) {
    console.log('[SYNC] GitHub events unchanged (304), skipping commits');
  } else {
    // Rebase re-pushes re-surface old commits with distinct === false; drop
    // them so a rebase doesn't re-count history.
    const distinctCommits = events.commits.filter((c) => c.distinct);

    const freshlyInserted: GithubNewCommit[] = [];
    for (const c of distinctCommits) {
      const insertResult = await db
        .insert(githubCommits)
        .values({
          userId,
          sha: c.sha,
          repo: c.repo,
          message: c.message,
          committedAt: c.committedAt,
          isPrivate: c.isPrivate ? 1 : 0,
          url: `https://github.com/${c.repo}/commit/${c.sha}`,
        })
        .onConflictDoNothing();

      // Conflict on idx_github_commits_sha: an already-stored commit
      // re-delivered by an overlapping events fetch. Only count truly-new
      // rows (the foursquare lesson: meta.changes, not row presence).
      if (insertResult.meta.changes === 0) continue;

      freshlyInserted.push({
        sha: c.sha,
        repo: c.repo,
        committedAt: c.committedAt,
      });
    }

    synced += freshlyInserted.length;
    newCommits.push(...freshlyInserted);

    // Fetch additions/deletions for at most COMMIT_DETAIL_CAP NEW commits.
    for (const c of freshlyInserted.slice(0, COMMIT_DETAIL_CAP)) {
      const stats = await client.getCommitStats(c.repo, c.sha);
      if (stats) {
        await db
          .update(githubCommits)
          .set({ additions: stats.additions, deletions: stats.deletions })
          .where(eq(githubCommits.sha, c.sha));
      }
    }

    // Persist the fresh etag for the next conditional request. Only when
    // non-null — the client falls back to the passed-in etag, so a null here
    // means "no etag ever seen" and there is nothing to store.
    if (events.etag) {
      await kv.put(EVENTS_ETAG_KEY, events.etag);
    }
  }

  // ── 3. PRs + issues (first search page each) ──────────────────────────
  const prPage = await client.searchAuthored('pr', 1);
  for (const item of prPage.items) {
    await db
      .insert(githubPullRequests)
      .values({
        userId,
        repo: item.repo,
        number: item.number,
        title: item.title,
        state: item.state,
        createdAtGithub: item.createdAt,
        mergedAt: item.mergedAt,
        closedAt: item.closedAt,
        isPrivate: item.isPrivate ? 1 : 0,
        url: item.url,
      })
      .onConflictDoUpdate({
        target: [githubPullRequests.repo, githubPullRequests.number],
        set: {
          title: item.title,
          state: item.state,
          mergedAt: item.mergedAt,
          closedAt: item.closedAt,
        },
      });
  }
  synced += prPage.items.length;

  const issuePage = await client.searchAuthored('issue', 1);
  for (const item of issuePage.items) {
    await db
      .insert(githubIssues)
      .values({
        userId,
        repo: item.repo,
        number: item.number,
        title: item.title,
        state: item.state,
        createdAtGithub: item.createdAt,
        closedAt: item.closedAt,
        isPrivate: item.isPrivate ? 1 : 0,
        url: item.url,
      })
      .onConflictDoUpdate({
        target: [githubIssues.repo, githubIssues.number],
        set: {
          title: item.title,
          state: item.state,
          closedAt: item.closedAt,
        },
      });
  }
  synced += issuePage.items.length;

  return { synced, newCommits };
}

/**
 * Coding-domain GitHub sync entrypoint: sync_runs lifecycle (domain 'coding',
 * syncType 'github'). Constructs the client and passes env.REWIND_CACHE as the
 * ETag store. Throws inside the try (recording a failed run) when GITHUB_TOKEN
 * or GITHUB_USERNAME is unset.
 */
export async function syncGithub(
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
      syncType: 'github',
      status: 'running',
      startedAt,
      itemsSynced: 0,
    })
    .returning({ id: syncRuns.id });

  try {
    const token = env.GITHUB_TOKEN;
    if (!token) {
      throw new Error('GITHUB_TOKEN is not configured');
    }
    const username = env.GITHUB_USERNAME;
    if (!username) {
      throw new Error('GITHUB_USERNAME is not configured');
    }

    const client = new GithubClient(token, username);
    const { synced, newCommits } = await syncGithubIncremental(
      db,
      client,
      env.REWIND_CACHE,
      username,
      userId
    );

    await db
      .update(syncRuns)
      .set({
        status: 'completed',
        completedAt: new Date().toISOString(),
        itemsSynced: synced,
        metadata: JSON.stringify({ newCommits: newCommits.length }),
      })
      .where(eq(syncRuns.id, run.id));

    console.log(
      `[SYNC] GitHub sync complete: ${synced} items (${newCommits.length} new commits)`
    );
    return { synced };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.log(`[ERROR] GitHub sync failed: ${errorMsg}`);
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
