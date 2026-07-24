import {
  integer,
  sqliteTable,
  text,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * RescueTime 5-minute activity buckets (Analytic Data API, perspective=
 * interval, interval=minute). One row per (timestamp, activity). The
 * unique key makes today+yesterday re-syncs idempotent; late-arriving
 * buckets for a still-open 5-minute window are handled by delete+reinsert
 * of the synced day in sync.ts.
 */
export const rescuetimeActivities = sqliteTable(
  'rescuetime_activities',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    timestamp: text('timestamp').notNull(),
    durationSeconds: integer('duration_seconds').notNull(),
    /** App or site name, e.g. "VS Code", "github.com". */
    activity: text('activity').notNull(),
    category: text('category'),
    /** RescueTime productivity score: -2..+2. */
    productivity: integer('productivity').notNull().default(0),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_rescuetime_activities_slot').on(
      table.timestamp,
      table.activity
    ),
    index('idx_rescuetime_activities_user_id').on(table.userId),
    index('idx_rescuetime_activities_timeline').on(
      table.userId,
      table.timestamp
    ),
  ]
);

/**
 * Materialized per-day rollup rebuilt from rescuetime_activities each sync.
 * productivity_pulse comes from the daily_summary_feed API when available
 * (feed only covers ~2 recent weeks) and stays null for older days.
 */
export const rescuetimeDailySummaries = sqliteTable(
  'rescuetime_daily_summaries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    /** YYYY-MM-DD */
    date: text('date').notNull(),
    totalSeconds: integer('total_seconds').notNull(),
    productivityPulse: integer('productivity_pulse'),
    veryProductiveSeconds: integer('very_productive_seconds')
      .notNull()
      .default(0),
    productiveSeconds: integer('productive_seconds').notNull().default(0),
    neutralSeconds: integer('neutral_seconds').notNull().default(0),
    distractingSeconds: integer('distracting_seconds').notNull().default(0),
    veryDistractingSeconds: integer('very_distracting_seconds')
      .notNull()
      .default(0),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_rescuetime_daily_user_date').on(table.userId, table.date),
    index('idx_rescuetime_daily_date').on(table.date),
  ]
);
