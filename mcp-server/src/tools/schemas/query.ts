/**
 * Output schemas for the SQL-first primitive tools (query_rewind, get_schema).
 *
 * `.passthrough()` keeps the advertised JSON Schema forward-compatible with
 * fields the API may add later. See schemas/shared.ts.
 */
import { z } from 'zod';

/** outputSchema for query_rewind: column names plus array-of-array row tuples. */
export const queryOutputSchema = z
  .object({
    columns: z.array(z.string()),
    rows: z.array(z.array(z.unknown())),
    row_count: z.number(),
    truncated: z.boolean(),
  })
  .passthrough();

/** outputSchema for get_schema: global conventions plus annotated tables. */
export const schemaOutputSchema = z
  .object({
    notes: z.array(z.string()),
    tables: z.array(
      z
        .object({
          name: z.string(),
          purpose: z.string(),
          columns: z.array(
            z
              .object({
                name: z.string(),
                type: z.string(),
                note: z.string().optional(),
              })
              .passthrough()
          ),
          joins: z.array(z.string()).optional(),
        })
        .passthrough()
    ),
  })
  .passthrough();
