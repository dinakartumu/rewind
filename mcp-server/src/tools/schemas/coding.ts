/**
 * Output schemas for the coding-domain tools.
 *
 * These schemas are the source of truth for the coding tools' return
 * shapes: `coding.ts` derives its payload types from them via `z.infer`,
 * so the declared schema and the TypeScript type cannot drift.
 *
 * Every object schema uses `.passthrough()` so the JSON Schema advertised
 * to clients stays `additionalProperties`-open -- a field the Rewind API
 * adds later does not break client-side validation. See schemas/shared.ts.
 */
import { z } from 'zod';

// --- Element schemas ------------------------------------------------------

/** A single item in the merged recent-activity timeline (commit / PR / issue). */
export const codingActivitySchema = z
  .object({
    type: z.enum(['commit', 'pr', 'issue']),
    repo: z.string(),
    title: z.string(),
    occurred_at: z.string(),
    state: z.string().nullable(),
    url: z.string(),
  })
  .passthrough();

/** RescueTime screen-time breakdown embedded in the coding stats. */
const screenTimeSchema = z
  .object({
    total_seconds: z.number(),
    very_productive_seconds: z.number(),
    productive_seconds: z.number(),
    neutral_seconds: z.number(),
    distracting_seconds: z.number(),
    very_distracting_seconds: z.number(),
  })
  .passthrough();

/** A single per-language row from get_coding_languages. */
export const codingLanguageSchema = z
  .object({
    language: z.string(),
    total_seconds: z.number(),
    percent: z.number(),
  })
  .passthrough();

// --- Tool output schemas --------------------------------------------------

/**
 * outputSchema for get_coding_stats (flat stats object with a nested
 * screen-time breakdown). Mirrors GET /v1/coding/stats.
 */
export const codingStatsOutputSchema = z
  .object({
    coding_seconds: z.number(),
    coding_days: z.number(),
    commits: z.number(),
    prs: z.number(),
    issues: z.number(),
    screen_time: screenTimeSchema,
  })
  .passthrough();

/**
 * outputSchema for get_recent_coding_activity. Both the populated and the
 * empty-state branch return `{ items, today }` -- the empty branch just has
 * `items: []`, so one schema covers both.
 */
export const recentCodingActivityOutputSchema = z
  .object({
    items: z.array(codingActivitySchema),
    today: z
      .object({
        coding_seconds: z.number(),
        productivity_pulse: z.number().nullable(),
      })
      .passthrough(),
  })
  .passthrough();

/**
 * outputSchema for get_coding_languages. The empty-state branch returns
 * `{ items: [] }`, which satisfies the same schema -- no union needed.
 */
export const codingLanguagesOutputSchema = z
  .object({ items: z.array(codingLanguageSchema) })
  .passthrough();
