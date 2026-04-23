import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RewindClient } from '../client.js';
import {
  withRichResponse,
  text,
  resourceLink,
  imageBlock,
  timeAgo,
  fmt,
  READ_ONLY_ANNOTATIONS,
  LIST_IMAGE_PX,
  type ContentBlock,
} from './helpers.js';

const SEARCH_TOP_N = 5;

/**
 * Map a cross-domain entity reference to a Rewind resource URI.
 * Returns null when the entity type has no registered resource template.
 */
function rewindUri(
  domain: string,
  entityType: string,
  entityId: string
): string | null {
  if (!entityId) return null;
  const map: Record<string, string> = {
    'listening:artist': 'artist',
    'listening:album': 'album',
    'watching:movie': 'movie',
    'watching:show': 'show',
    'collecting:vinyl': 'vinyl',
    'collecting:release': 'vinyl',
    'collecting:media': 'physical-media',
    'reading:article': 'article',
    'reading:highlight': 'highlight',
    'running:activity': 'activity',
  };
  const kind = map[`${domain}:${entityType}`];
  return kind ? `rewind://${kind}/${entityId}` : null;
}

export function registerCrossDomainTools(
  server: McpServer,
  client: RewindClient
): void {
  // search ─────────────────────────────────────────────────────────
  server.tool(
    'search',
    'Search across all domains (listening, running, watching, collecting, reading). Three ranking modes: keyword (default) uses FTS5 full-text search across all domains; semantic uses Voyage AI embeddings for paraphrased / meaning-based recall (reading domain only); hybrid fuses both (reading domain only). Use semantic or hybrid when the user describes what an article was ABOUT rather than quoting its words.',
    {
      query: z.string().describe('Search query text'),
      domain: z
        .enum(['listening', 'running', 'watching', 'collecting', 'reading'])
        .optional()
        .describe('Optional: filter results to a single domain'),
      mode: z
        .enum(['keyword', 'semantic', 'hybrid'])
        .optional()
        .describe(
          'Ranking mode. keyword = FTS (default). semantic = cosine-similarity over article embeddings (reading only). hybrid = FTS + semantic via reciprocal rank fusion (reading only).'
        ),
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe('Number of results to return'),
      page: z.number().min(1).default(1).describe('Page number for pagination'),
    },
    READ_ONLY_ANNOTATIONS,
    async ({ query, domain, mode, limit, page }) =>
      withRichResponse(async () => {
        const params: Record<string, string | number> = {
          q: query,
          limit,
          page,
        };
        if (domain) params.domain = domain;
        if (mode) params.mode = mode;

        type SearchResult = {
          domain: string;
          entity_type: string;
          entity_id: string;
          title: string;
          subtitle: string | null;
          image: {
            cdn_url: string;
            thumbhash: string | null;
            dominant_color: string | null;
          } | null;
          score?: number;
        };
        const data = await client.get<{
          data: SearchResult[];
          pagination: { total: number };
        }>('/search', params);

        if (!data.data.length) {
          return {
            content: [
              text(
                `No results found for "${query}"${domain ? ` in ${domain}` : ''}.`
              ),
            ],
            structuredContent: { items: [], pagination: data.pagination },
          };
        }

        const modeLabel = mode && mode !== 'keyword' ? ` [${mode}]` : '';
        const lines = [
          `Search results for "${query}"${modeLabel} (${fmt(data.pagination.total)} total):`,
        ];

        for (const [i, r] of data.data.entries()) {
          const sub = r.subtitle ? ` -- ${r.subtitle}` : '';
          const score =
            typeof r.score === 'number' ? ` (score=${r.score.toFixed(2)})` : '';
          lines.push(
            `${i + 1}. [${r.domain}/${r.entity_type}] ${r.title}${sub}${score}`
          );
        }

        // Emit one resource_link per result that maps to a known entity.
        const links = data.data
          .map((r) => {
            const uri = rewindUri(r.domain, r.entity_type, r.entity_id);
            if (!uri) return null;
            return resourceLink(uri, r.title, {
              mimeType: 'application/json',
              description: r.subtitle ?? undefined,
            });
          })
          .filter((b): b is NonNullable<typeof b> => b !== null);

        // Emit image blocks for the top-N results that carry an image.
        const topN = data.data.slice(0, SEARCH_TOP_N);
        const images = await Promise.all(
          topN.map((r) => imageBlock(client, r.image, LIST_IMAGE_PX))
        );
        const imageBlocks = images.filter(
          (b): b is NonNullable<typeof b> => b !== null
        );

        const content: ContentBlock[] = [
          text(lines.join('\n')),
          ...imageBlocks,
          ...links,
        ];

        return {
          content,
          structuredContent: { items: data.data, pagination: data.pagination },
        };
      })
  );

  // semantic_search ────────────────────────────────────────────────
  server.tool(
    'semantic_search',
    'Semantic search over the reading domain using Voyage AI embeddings. Use when the user describes the gist or topic of an article they remember rather than quoting exact words — e.g. "article about a former SNL writer" or "piece about tech layoffs". Returns articles ranked by cosine similarity with a score in [0,1]. Reading domain only.',
    {
      query: z.string().describe('Natural-language description of the article'),
      limit: z
        .number()
        .min(1)
        .max(25)
        .default(10)
        .describe('Number of matches to return'),
    },
    READ_ONLY_ANNOTATIONS,
    async ({ query, limit }) =>
      withRichResponse(async () => {
        type SemanticResult = {
          domain: string;
          entity_type: string;
          entity_id: string;
          title: string;
          subtitle: string | null;
          image: {
            cdn_url: string;
            thumbhash: string | null;
            dominant_color: string | null;
          } | null;
          score: number;
        };
        const data = await client.get<{
          data: SemanticResult[];
          pagination: { total: number };
        }>('/search', {
          q: query,
          domain: 'reading',
          mode: 'semantic',
          limit,
        });

        if (!data.data.length) {
          return {
            content: [text(`No semantic matches found for "${query}".`)],
            structuredContent: { items: [], pagination: data.pagination },
          };
        }

        const lines = [
          `Semantic matches for "${query}" (${fmt(data.data.length)} shown):`,
        ];
        for (const [i, r] of data.data.entries()) {
          const sub = r.subtitle ? ` -- ${r.subtitle}` : '';
          lines.push(
            `${i + 1}. ${r.title}${sub} (score=${r.score.toFixed(2)})`
          );
        }

        const links = data.data
          .map((r) => {
            const uri = rewindUri(r.domain, r.entity_type, r.entity_id);
            if (!uri) return null;
            return resourceLink(uri, r.title, {
              mimeType: 'application/json',
              description: r.subtitle ?? undefined,
            });
          })
          .filter((b): b is NonNullable<typeof b> => b !== null);

        const topN = data.data.slice(0, SEARCH_TOP_N);
        const images = await Promise.all(
          topN.map((r) => imageBlock(client, r.image, LIST_IMAGE_PX))
        );
        const imageBlocks = images.filter(
          (b): b is NonNullable<typeof b> => b !== null
        );

        const content: ContentBlock[] = [
          text(lines.join('\n')),
          ...imageBlocks,
          ...links,
        ];

        return {
          content,
          structuredContent: { items: data.data, pagination: data.pagination },
        };
      })
  );

  // get_feed ───────────────────────────────────────────────────────
  server.tool(
    'get_feed',
    'Get the unified activity feed across all domains. Returns a chronological list of recent activities (listens, runs, watches, reads, collection adds). Supports date filtering.',
    {
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe('Number of feed items to return'),
      domain: z
        .enum(['listening', 'running', 'watching', 'collecting', 'reading'])
        .optional()
        .describe('Optional: filter feed to a single domain'),
      date: z
        .string()
        .optional()
        .describe('Optional: filter to a specific date (YYYY-MM-DD)'),
      from: z
        .string()
        .optional()
        .describe('Optional: start of date range (ISO 8601)'),
      to: z
        .string()
        .optional()
        .describe('Optional: end of date range (ISO 8601)'),
    },
    READ_ONLY_ANNOTATIONS,
    async ({ limit, domain, date, from, to }) =>
      withRichResponse(async () => {
        const params: Record<string, string | number | undefined> = {
          limit,
          date,
          from,
          to,
        };

        const path = domain ? `/feed/domain/${domain}` : '/feed';
        type FeedItem = {
          domain: string;
          event_type: string;
          occurred_at: string;
          title: string;
          subtitle: string | null;
        };
        const data = await client.get<{
          data: FeedItem[];
          pagination: { has_more: boolean };
        }>(path, params);

        if (!data.data.length) {
          return {
            content: [text('No feed activity found for the given filters.')],
            structuredContent: { items: [], pagination: data.pagination },
          };
        }

        const lines = ['Activity Feed:'];
        for (const item of data.data) {
          const sub = item.subtitle ? ` -- ${item.subtitle}` : '';
          lines.push(
            `- [${item.domain}] ${item.title}${sub} (${timeAgo(item.occurred_at)})`
          );
        }

        if (data.pagination.has_more) {
          lines.push(
            '\nMore items available. Increase limit or narrow date range.'
          );
        }

        return {
          content: [text(lines.join('\n'))],
          structuredContent: { items: data.data, pagination: data.pagination },
        };
      })
  );

  // get_on_this_day ────────────────────────────────────────────────
  server.tool(
    'get_on_this_day',
    "Get historical 'on this day' items -- what happened on a given date in previous years across all domains. Defaults to today. Great for nostalgia and reflection.",
    {
      month: z
        .number()
        .min(1)
        .max(12)
        .optional()
        .describe('Optional: month (1-12). Defaults to current month.'),
      day: z
        .number()
        .min(1)
        .max(31)
        .optional()
        .describe('Optional: day (1-31). Defaults to current day.'),
    },
    READ_ONLY_ANNOTATIONS,
    async ({ month, day }) =>
      withRichResponse(async () => {
        const params: Record<string, number | undefined> = { month, day };
        type OnThisDay = {
          month: number;
          day: number;
          years: Array<{
            year: number;
            items: Array<{
              domain: string;
              event_type: string;
              title: string;
              subtitle: string | null;
            }>;
          }>;
        };
        const data = await client.get<OnThisDay>('/feed/on-this-day', params);

        if (!data.years.length) {
          return {
            content: [text("No 'on this day' history found.")],
            structuredContent: data,
          };
        }

        const lines = [`On This Day (${data.month}/${data.day}):`];
        for (const yearGroup of data.years) {
          lines.push('');
          lines.push(`${yearGroup.year}:`);
          for (const item of yearGroup.items) {
            const sub = item.subtitle ? ` -- ${item.subtitle}` : '';
            lines.push(`  - [${item.domain}] ${item.title}${sub}`);
          }
        }

        return {
          content: [text(lines.join('\n'))],
          structuredContent: data,
        };
      })
  );
}
