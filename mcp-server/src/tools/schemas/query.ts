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
    /**
     * Echo of the requested render view for the generic query-result UI
     * bundle: 'auto' (auto-detect) or a forced 'table' | 'chart' | 'map' |
     * 'grid' | 'calendar' | 'clock' | 'stat' | 'list'. Present on every
     * result; ignored by non-UI hosts.
     */
    view: z
      .enum([
        'auto',
        'table',
        'chart',
        'map',
        'grid',
        'calendar',
        'clock',
        'stat',
        'list',
      ])
      .optional(),
    /**
     * Present only when `embed_art: true`. Maps each matched CDN image URL —
     * exactly as it appears in a result cell — to a small base64 WebP data URI
     * (64px) so sandboxed artifact HTML can inline the artwork without fetching
     * the CDN directly. The base64 lives here, never in the text table.
     */
    art: z.record(z.string(), z.string()).optional(),
    /** True when the cumulative base64 byte ceiling cut off some `art` entries. */
    art_truncated: z.boolean().optional(),
    /**
     * Optional map tile-provider config for the query-result map view. Present
     * only when a MAPBOX_TOKEN is configured on the server; the bundle defaults
     * to OpenStreetMap tiles when it is absent. The token is baked into
     * `tileUrl` (a public, rotatable Mapbox access token — safe to expose).
     */
    map_config: z
      .object({
        provider: z.enum(['mapbox', 'osm']),
        tileUrl: z.string(),
        attribution: z.string(),
        maxZoom: z.number(),
      })
      .passthrough()
      .optional(),
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
