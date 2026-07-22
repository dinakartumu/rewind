import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RewindClient, QueryResult, SchemaDoc } from '../client.js';
import {
  withRichResponse,
  text,
  imageBlock,
  resizeCdnUrl,
  bytesToBase64,
  READ_ONLY_ANNOTATIONS,
  type ContentBlock,
} from './helpers.js';
import { queryOutputSchema, schemaOutputSchema } from './schemas/query.js';

/** ui:// resource the generic query-result renderer is registered under. */
const QUERY_RESULT_UI = 'ui://rewind/query-result.html';
/** Public Rewind image CDN origin. Cell values under this host are artwork. */
const CDN_ORIGIN = 'https://cdn.dinakartumu.com';
/** Max inline thumbnails per query result — keeps a 200-row result from fetching 200 images. */
const MAX_QUERY_IMAGES = 8;
/** Thumbnail size (px) for inline artwork rendered from SQL results. */
const QUERY_IMAGE_PX = 120;
/**
 * Max distinct CDN URLs embedded as base64 data URIs when `embed_art` is true.
 * Independent of MAX_QUERY_IMAGES (the native inline-image card cap).
 */
const MAX_EMBED_ART = 16;
/** Forced pixel size for embedded art thumbnails — hard-downsampled for artifacts. */
const EMBED_ART_PX = 64;
/** WebP quality for embedded art thumbnails. */
const EMBED_ART_QUALITY = 70;
/**
 * Cumulative base64 byte ceiling for the whole `art` map (~256KB). Once a
 * fetched thumbnail would push the total past this, we stop and flag
 * art_truncated so the payload stays bounded.
 */
const EMBED_ART_BYTE_CEILING = 256 * 1024;
/**
 * Domains that can prefix a bare r2_key (a value with no scheme). Mirrors the
 * `images.domain` enum so we don't treat an arbitrary "a/b/c" string as art.
 */
const R2_KEY_RE =
  /^(listening|watching|collecting|reading|places|attending|running)\/[\w./-]+$/;

/**
 * A matched image cell: the `original` string exactly as it appears in the
 * result row (used as the `art` map key), and the composed `cdnUrl` we fetch.
 * For a full CDN URL these are identical; for a bare r2_key they differ.
 */
type ImageMatch = { original: string; cdnUrl: string };

/**
 * Detect image URLs among the result cells, in row-major order, de-duplicated
 * (by original cell value), capped at `limit`. A cell qualifies if it is a full
 * CDN URL, or a bare r2_key (no scheme) that we can compose into one.
 */
function collectImageMatches(result: QueryResult, limit: number): ImageMatch[] {
  const matches: ImageMatch[] = [];
  const seen = new Set<string>();

  outer: for (const row of result.rows) {
    for (const cell of row) {
      if (typeof cell !== 'string') continue;
      let cdnUrl: string | null = null;
      if (cell.startsWith(`${CDN_ORIGIN}/`)) {
        cdnUrl = cell;
      } else if (!cell.includes('://') && R2_KEY_RE.test(cell)) {
        cdnUrl = `${CDN_ORIGIN}/${cell}`;
      }
      if (!cdnUrl || seen.has(cell)) continue;
      seen.add(cell);
      matches.push({ original: cell, cdnUrl });
      if (matches.length >= limit) break outer;
    }
  }
  return matches;
}

/** Composed CDN URLs for the inline image-block card (deduped, capped). */
function collectImageUrls(result: QueryResult): string[] {
  return collectImageMatches(result, MAX_QUERY_IMAGES).map((m) => m.cdnUrl);
}

/**
 * Fetch hard-downsampled base64 WebP thumbnails for the CDN URLs found in the
 * result and return them as a map keyed by the ORIGINAL cell value. Enforces a
 * cumulative base64 byte ceiling; once exceeded we stop and flag truncation.
 * Failed fetches are skipped (key omitted) — never throws.
 */
async function collectEmbedArt(
  client: RewindClient,
  result: QueryResult
): Promise<{ art: Record<string, string>; truncated: boolean }> {
  const matches = collectImageMatches(result, MAX_EMBED_ART);
  const art: Record<string, string> = {};
  let totalBytes = 0;
  let truncated = false;

  // Fetch all thumbnails concurrently, then fold in row order so the byte
  // ceiling cuts off deterministically from the front.
  const fetched = await Promise.all(
    matches.map(async (m) => {
      const url = resizeCdnUrl(m.cdnUrl, EMBED_ART_PX, {
        format: 'webp',
        quality: EMBED_ART_QUALITY,
      });
      try {
        const { bytes, mimeType } = await client.getBinaryFromUrl(url);
        // Use the CDN's actual Content-Type: it may fall back to JPEG/PNG when
        // it ignores the requested format=webp, and a data URI whose declared
        // MIME mismatches its bytes can be rejected by strict image decoders.
        const mime = mimeType || 'image/jpeg';
        return { original: m.original, base64: bytesToBase64(bytes), mime };
      } catch {
        return null;
      }
    })
  );

  for (const item of fetched) {
    if (!item) continue;
    if (totalBytes + item.base64.length > EMBED_ART_BYTE_CEILING) {
      truncated = true;
      break;
    }
    totalBytes += item.base64.length;
    art[item.original] = `data:${item.mime};base64,${item.base64}`;
  }

  return { art, truncated };
}

type QueryStructured = z.infer<typeof queryOutputSchema>;
type SchemaStructured = z.infer<typeof schemaOutputSchema>;

/** Cap on how many rows we render as a markdown table before switching to a preview. */
const TABLE_ROW_LIMIT = 30;
/** Cap on columns rendered in a markdown table before switching to a preview. */
const TABLE_COL_LIMIT = 8;
/** Max characters per rendered cell before truncation. */
const CELL_MAX = 60;

/** Render one cell value as a compact string for a markdown table. */
function renderCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s: string;
  if (typeof value === 'object') {
    s = JSON.stringify(value);
  } else {
    s = String(value);
  }
  // Escape pipes so the markdown table stays intact, collapse newlines.
  s = s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  if (s.length > CELL_MAX) s = s.slice(0, CELL_MAX - 1) + '…';
  return s;
}

/**
 * Render a query result as a compact text block: a markdown table for small
 * results, or a truncated preview plus a note for wide/long ones. The full,
 * untruncated data always lives in structuredContent.
 */
function renderResult(result: QueryResult): string {
  const { columns, rows, row_count, truncated } = result;

  if (row_count === 0) {
    return truncated
      ? 'Query ran but the result was truncated to fit the response ceiling and no rows fit. Add a tighter WHERE / LIMIT or select fewer columns.'
      : 'Query returned no rows.';
  }

  const wide = columns.length > TABLE_COL_LIMIT;
  const long = row_count > TABLE_ROW_LIMIT;

  const notes: string[] = [];
  if (truncated) {
    notes.push(
      'Note: results were truncated to fit the response ceiling. Add a tighter WHERE / LIMIT, or aggregate, to see everything.'
    );
  }

  // Wide or long: render a preview instead of a giant table. The full data is
  // in structuredContent for the model to read programmatically.
  if (wide || long) {
    const shownCols = wide ? columns.slice(0, TABLE_COL_LIMIT) : columns;
    const shownRows = rows.slice(0, TABLE_ROW_LIMIT);
    const lines: string[] = [
      `${row_count} row${row_count === 1 ? '' : 's'} × ${columns.length} column${columns.length === 1 ? '' : 's'}. Preview (structuredContent has the full result):`,
      '',
      `| ${shownCols.map(renderCell).join(' | ')}${wide ? ' | …' : ''} |`,
      `| ${shownCols.map(() => '---').join(' | ')}${wide ? ' | ---' : ''} |`,
    ];
    for (const row of shownRows) {
      const cells = (wide ? row.slice(0, TABLE_COL_LIMIT) : row).map(
        renderCell
      );
      lines.push(`| ${cells.join(' | ')}${wide ? ' | …' : ''} |`);
    }
    if (long) {
      lines.push('', `… and ${row_count - shownRows.length} more row(s).`);
    }
    if (wide) {
      lines.push(
        `Columns not shown: ${columns.slice(TABLE_COL_LIMIT).join(', ')}.`
      );
    }
    if (notes.length) lines.push('', ...notes);
    return lines.join('\n');
  }

  // Small result: full markdown table.
  const lines: string[] = [
    `| ${columns.map(renderCell).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
  ];
  for (const row of rows) {
    lines.push(`| ${row.map(renderCell).join(' | ')} |`);
  }
  if (notes.length) lines.push('', ...notes);
  return lines.join('\n');
}

/** Render the annotated schema doc as readable markdown. */
function renderSchema(schema: SchemaDoc): string {
  const lines: string[] = ['# Rewind database schema', ''];

  if (schema.notes.length) {
    lines.push('## Conventions', '');
    for (const note of schema.notes) lines.push(`- ${note}`);
    lines.push('');
  }

  lines.push('## Tables', '');
  for (const table of schema.tables) {
    lines.push(`### ${table.name}`, '', table.purpose, '');
    for (const col of table.columns) {
      const note = col.note ? ` — ${col.note}` : '';
      lines.push(`- \`${col.name}\` (${col.type})${note}`);
    }
    if (table.joins && table.joins.length) {
      lines.push('', `Joins: ${table.joins.join('; ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** Optional config threaded from createServer (Worker env / process.env). */
export interface QueryToolsConfig {
  /**
   * Public Mapbox access token. When present, map-eligible query results carry
   * a `map_config` pointing the map view at Mapbox raster tiles; otherwise the
   * bundle falls back to OpenStreetMap. See buildMapConfig for why the token in
   * the tile URL is acceptable here.
   */
  mapboxToken?: string;
}

/**
 * Build the Mapbox tile config embedded in structuredContent.map_config.
 *
 * SECURITY NOTE: the token ends up in `tileUrl`, which lives in
 * structuredContent and is therefore MODEL-VISIBLE. This is acceptable ONLY
 * because MAPBOX_TOKEN is a PUBLIC, rotatable Mapbox access token (a `pk.`
 * token) — it grants read access to public tile styles and can be rotated at
 * will. Never pass a secret/private (`sk.`) token here.
 */
function buildMapConfig(token: string): {
  provider: 'mapbox';
  tileUrl: string;
  attribution: string;
  maxZoom: number;
} {
  return {
    provider: 'mapbox',
    tileUrl: `https://api.mapbox.com/styles/v1/mapbox/outdoors-v12/tiles/256/{z}/{x}/{y}@2x?access_token=${token}`,
    attribution: '© Mapbox © OpenStreetMap',
    maxZoom: 22,
  };
}

export function registerQueryTools(
  server: McpServer,
  client: RewindClient,
  config: QueryToolsConfig = {}
): void {
  // query_rewind ───────────────────────────────────────────────────
  server.registerTool(
    'query_rewind',
    {
      title: 'Query Rewind (SQL)',
      description:
        'Run a read-only SQL SELECT against the Rewind SQLite database. FIRST call get_schema (or read the rewind://schema resource) to see the tables and columns. Single SELECT (or WITH … SELECT) only; a LIMIT is auto-applied (200 default, 500 max). Great for any cross-domain or ad-hoc question the specialized tools do not cover — e.g. joining watches to check-ins, or ranking sources by article count. It cannot write, run DDL, or read secret tables (API keys, OAuth tokens); those are rejected server-side. Returns column names and row tuples in structuredContent plus a compact table preview. In MCP Apps hosts it ALSO renders an interactive view auto-selected from the result shape (or forced via `view`): a calendar heatmap when the result is a daily-date (YYYY-MM-DD) column plus one numeric column, a polar clock (radial histogram) when it is an hour-of-day (0-23) or weekday column plus a count, big-number stat cards when a single row has numeric columns, a ranked list or card grid when a CDN image-URL column pairs with a name/label column and a metric, a chart when the result is one category-or-period column plus one numeric column, a tile-less point/route map plotted from lat/lng or polyline columns (no tiles, no external requests), and a styled table otherwise. To include album art or posters in the answer, SELECT the composed CDN image URL — see the images-table note in get_schema; query_rewind renders any https://cdn.dinakartumu.com image URLs in the results as inline thumbnails (first 8 distinct, in row order). Set embed_art:true to ALSO get those matched CDN image URLs back as small base64 WebP data URIs in structuredContent.art (a map keyed by the original URL exactly as it appears in the row) — inline them when authoring a sandboxed artifact whose iframe cannot fetch the CDN directly; look up each row art URL in art[url]. It is downsampled (64px) and opt-in because it adds payload; leave it false for normal data queries.',
      inputSchema: {
        sql: z
          .string()
          .min(1)
          .describe(
            'A single read-only SELECT (or WITH … SELECT) statement. Do not include a trailing semicolon. A LIMIT is applied automatically. Call get_schema first for table and column names.'
          ),
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
          .default('auto')
          .describe(
            "Preferred rendered view in MCP Apps hosts. 'auto' (default) auto-detects from the result shape: a calendar heatmap for a daily-date (YYYY-MM-DD) column + one numeric column, a polar clock for an hour-of-day (0-23) or weekday column + a count, stat cards for a single-row result with numeric columns, a ranked list (or card grid) for a CDN image URL + label + metric, a chart for one category/period column + one numeric column, a tile-less lat/lng or polyline map, else a table. Force one of 'table' | 'chart' | 'map' | 'grid' | 'calendar' | 'clock' | 'stat' | 'list' to override. Echoed back in structuredContent.view. Ignored by non-UI hosts."
          ),
        embed_art: z
          .boolean()
          .default(false)
          .describe(
            'Opt-in. When true, matched CDN image URLs in the result are returned as small base64 WebP data URIs (64px) in structuredContent.art, keyed by the original URL, so sandboxed artifact HTML that cannot fetch the CDN can inline the artwork. Capped at 16 distinct URLs and a ~256KB total; adds payload, so leave false for normal data queries.'
          ),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: queryOutputSchema,
      _meta: {
        ui: { resourceUri: QUERY_RESULT_UI },
        'ui/resourceUri': QUERY_RESULT_UI,
      },
    },
    async ({ sql, view, embed_art }) =>
      withRichResponse(async () => {
        const result = await client.query(sql);

        // Additive: render up to MAX_QUERY_IMAGES distinct Rewind CDN image
        // URLs found in the result as inline thumbnails. The markdown table and
        // structuredContent are unchanged. Failed fetches return null and are
        // filtered out — images are best-effort.
        const imageUrls = collectImageUrls(result);
        const images = (
          await Promise.all(
            imageUrls.map((url) =>
              imageBlock(client, { cdn_url: url }, QUERY_IMAGE_PX)
            )
          )
        ).filter((b): b is NonNullable<typeof b> => b !== null);

        const content: ContentBlock[] = [text(renderResult(result)), ...images];

        const structuredContent = { ...result, view } as QueryStructured & {
          view:
            | 'auto'
            | 'table'
            | 'chart'
            | 'map'
            | 'grid'
            | 'calendar'
            | 'clock'
            | 'stat'
            | 'list';
          art?: Record<string, string>;
          art_truncated?: boolean;
          map_config?: ReturnType<typeof buildMapConfig>;
        };

        // Tile-provider config for the map view: when a public Mapbox token is
        // configured, attach map_config so the bundle uses Mapbox raster tiles;
        // when absent we OMIT it and the bundle defaults to OpenStreetMap. The
        // bundle only reads map_config in the map view, so it's harmless on
        // non-map results — kept small.
        if (config.mapboxToken) {
          structuredContent.map_config = buildMapConfig(config.mapboxToken);
        }

        // Opt-in: additionally embed matched artwork as base64 WebP data URIs
        // in structuredContent.art for sandboxed-artifact authors. Purely
        // additive — the text table and inline image blocks are untouched.
        if (embed_art) {
          const { art, truncated } = await collectEmbedArt(client, result);
          if (Object.keys(art).length > 0) structuredContent.art = art;
          if (truncated) structuredContent.art_truncated = true;
        }

        return {
          content,
          structuredContent,
          // Attach on the RESULT too (not just the tool listing) so hosts that
          // read `_meta.ui.resourceUri` from the call result render the bundle.
          _meta: {
            ui: { resourceUri: QUERY_RESULT_UI },
            'ui/resourceUri': QUERY_RESULT_UI,
          },
        };
      })
  );

  // get_schema ──────────────────────────────────────────────────────
  server.registerTool(
    'get_schema',
    {
      title: 'Database schema',
      description:
        'Return the annotated Rewind database schema: every queryable table with its columns, types, semantic notes, join keys, and global conventions (single user_id, ISO timestamps, rating scales, image URL composition). Call this before query_rewind so your SELECT references real tables and columns. Also available as the rewind://schema resource.',
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: schemaOutputSchema,
    },
    async () =>
      withRichResponse(async () => {
        const schema = await client.getSchema();
        return {
          content: [text(renderSchema(schema))],
          structuredContent: schema as SchemaStructured,
        };
      })
  );
}
