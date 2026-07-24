import {
  integer,
  real,
  sqliteTable,
  text,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * WakaTime duration slices (Durations API, sliced by entity). One row per
 * contiguous stretch of activity in one file/project. The unique
 * (start_time, project, entity) key makes the today+yesterday re-sync
 * idempotent: overlapping fetches deduplicate on conflict.
 */
export const wakatimeDurations = sqliteTable(
  'wakatime_durations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    startTime: text('start_time').notNull(),
    durationSeconds: real('duration_seconds').notNull(),
    project: text('project'),
    language: text('language'),
    /** File path when sliced by entity; null for non-file slices. */
    entity: text('entity'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_wakatime_durations_slice').on(
      table.startTime,
      table.project,
      table.entity
    ),
    index('idx_wakatime_durations_user_id').on(table.userId),
    index('idx_wakatime_durations_timeline').on(table.userId, table.startTime),
  ]
);

/**
 * Materialized per-day rollup, rebuilt from wakatime_durations on every
 * sync (delete + reinsert per day). Unique per (user, date).
 */
export const wakatimeDailySummaries = sqliteTable(
  'wakatime_daily_summaries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    /** YYYY-MM-DD */
    date: text('date').notNull(),
    totalSeconds: real('total_seconds').notNull(),
    topLanguage: text('top_language'),
    topProject: text('top_project'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_wakatime_daily_user_date').on(table.userId, table.date),
    index('idx_wakatime_daily_date').on(table.date),
  ]
);
