import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RewindClient, QueryResult, SchemaDoc } from '../client.js';
import { withRichResponse, text, READ_ONLY_ANNOTATIONS } from './helpers.js';
import { queryOutputSchema, schemaOutputSchema } from './schemas/query.js';

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

export function registerQueryTools(
  server: McpServer,
  client: RewindClient
): void {
  // query_rewind ───────────────────────────────────────────────────
  server.registerTool(
    'query_rewind',
    {
      title: 'Query Rewind (SQL)',
      description:
        'Run a read-only SQL SELECT against the Rewind SQLite database. FIRST call get_schema (or read the rewind://schema resource) to see the tables and columns. Single SELECT (or WITH … SELECT) only; a LIMIT is auto-applied (200 default, 500 max). Great for any cross-domain or ad-hoc question the specialized tools do not cover — e.g. joining watches to check-ins, or ranking sources by article count. It cannot write, run DDL, or read secret tables (API keys, OAuth tokens); those are rejected server-side. Returns column names and row tuples in structuredContent plus a compact table preview.',
      inputSchema: {
        sql: z
          .string()
          .min(1)
          .describe(
            'A single read-only SELECT (or WITH … SELECT) statement. Do not include a trailing semicolon. A LIMIT is applied automatically. Call get_schema first for table and column names.'
          ),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: queryOutputSchema,
    },
    async ({ sql }) =>
      withRichResponse(async () => {
        const result = await client.query(sql);
        return {
          content: [text(renderResult(result))],
          structuredContent: result as QueryStructured,
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
