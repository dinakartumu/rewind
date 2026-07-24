import {
  integer,
  sqliteTable,
  text,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * Daily contribution counts from the GraphQL contributions calendar
 * (includes private contributions). Upserted on (user, date) — counts for
 * recent days keep changing until the day is over.
 */
export const githubContributionDays = sqliteTable(
  'github_contribution_days',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    /** YYYY-MM-DD */
    date: text('date').notNull(),
    contributionCount: integer('contribution_count').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_github_contrib_user_date').on(table.userId, table.date),
    index('idx_github_contrib_date').on(table.date),
  ]
);

/**
 * Individual commits authored by the user. Incremental source: the
 * authenticated events feed (PushEvents). additions/deletions come from a
 * capped per-commit detail fetch and stay null when skipped.
 */
export const githubCommits = sqliteTable(
  'github_commits',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    sha: text('sha').notNull(),
    /** owner/name */
    repo: text('repo').notNull(),
    message: text('message').notNull(),
    additions: integer('additions'),
    deletions: integer('deletions'),
    committedAt: text('committed_at').notNull(),
    isPrivate: integer('is_private').notNull().default(0),
    url: text('url').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_github_commits_sha').on(table.sha),
    index('idx_github_commits_user_id').on(table.userId),
    index('idx_github_commits_timeline').on(table.userId, table.committedAt),
    index('idx_github_commits_repo').on(table.repo),
  ]
);

/** PRs authored by the user, from the Search API (full history). */
export const githubPullRequests = sqliteTable(
  'github_pull_requests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    repo: text('repo').notNull(),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    /** open | closed | merged */
    state: text('state').notNull(),
    createdAtGithub: text('created_at_github').notNull(),
    mergedAt: text('merged_at'),
    closedAt: text('closed_at'),
    isPrivate: integer('is_private').notNull().default(0),
    url: text('url').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_github_prs_repo_number').on(table.repo, table.number),
    index('idx_github_prs_user_id').on(table.userId),
    index('idx_github_prs_timeline').on(table.userId, table.createdAtGithub),
  ]
);

/** Issues authored by the user, from the Search API (full history). */
export const githubIssues = sqliteTable(
  'github_issues',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    repo: text('repo').notNull(),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    /** open | closed */
    state: text('state').notNull(),
    createdAtGithub: text('created_at_github').notNull(),
    closedAt: text('closed_at'),
    isPrivate: integer('is_private').notNull().default(0),
    url: text('url').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_github_issues_repo_number').on(table.repo, table.number),
    index('idx_github_issues_user_id').on(table.userId),
    index('idx_github_issues_timeline').on(table.userId, table.createdAtGithub),
  ]
);
