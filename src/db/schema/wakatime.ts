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
 * contiguous stretch of activity in one file/project.
 *
 * Idempotency comes from the sync's per-day rebuild, NOT from the unique key:
 * syncWakatimeDay deletes the day's UTC window and reinserts, so re-running a
 * day never conflicts. The unique (start_time, project, entity) index is a
 * tripwire, not a dedup path — the sync never does onConflictDoNothing/Update
 * on this table, so a conflict here would throw. It exists to catch a bug
 * where two overlapping delete windows insert the same slice twice (e.g. a
 * mis-computed dayBounds), surfacing the corruption loudly instead of silently
 * double-counting time.
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

/**
 * Materialized per-day, per-language coding time, rebuilt from the WakaTime
 * Summaries API on every sync (delete + reinsert per day). Duration rows are
 * entity-sliced and never carry language, so this table is the sole source of
 * per-language time. Unique per (user, date, language).
 */
export const wakatimeDailyLanguages = sqliteTable(
  'wakatime_daily_languages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    /** YYYY-MM-DD */
    date: text('date').notNull(),
    language: text('language').notNull(),
    totalSeconds: real('total_seconds').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_wakatime_daily_lang_user_date_lang').on(
      table.userId,
      table.date,
      table.language
    ),
    index('idx_wakatime_daily_lang_date').on(table.date),
  ]
);
