import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RewindClient } from '../client.js';
import {
  withRichResponse,
  text,
  resourceLink,
  imageBlock,
  timeAgo,
  formatStars,
  READ_ONLY_ANNOTATIONS,
  dateFilterParams,
  includeImagesParam,
  LIST_IMAGE_PX,
  type ContentBlock,
} from './helpers.js';
import { recentWatchesOutputSchema } from './schemas/watching.js';

const POSTER_TOP_N = 5;

// Types below are derived from the Zod output schemas (schemas/watching.ts)
// so the declared schema and the TS type cannot drift.
type RecentWatch = z.infer<typeof recentWatchesOutputSchema>['items'][number];

export function registerWatchingTools(
  server: McpServer,
  client: RewindClient
): void {
  // get_recent_watches ─────────────────────────────────────────────
  // Registered via the modern server.registerTool so we can attach
  // `_meta.ui.resourceUri`. Hosts that support MCP Apps (Claude Desktop,
  // Claude web, VS Code Copilot) render the poster grid inline; others fall
  // back to the text + image + resource_link response.
  server.registerTool(
    'get_recent_watches',
    {
      title: 'Recent watches',
      description:
        'Get recently watched movies and TV shows from Plex and Letterboxd. Returns titles, ratings, watch dates, top-N posters, and Letterboxd review links where available. In MCP Apps hosts, renders an interactive poster grid inline.',
      inputSchema: {
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(10)
          .describe('Number of recent watches to return (max 50)'),
        page: z
          .number()
          .min(1)
          .default(1)
          .describe(
            'Page number for pagination (1-indexed). Combine with limit to page through longer windows like "last month".'
          ),
        ...dateFilterParams,
        ...includeImagesParam,
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: recentWatchesOutputSchema,
      _meta: {
        ui: { resourceUri: 'ui://rewind/recent-watches.html' },
        'ui/resourceUri': 'ui://rewind/recent-watches.html',
      },
    },
    async ({ limit, page, date, from, to, include_images }) =>
      withRichResponse(async () => {
        const { data: raw } = await client.get<{ data: RecentWatch[] }>(
          '/watching/recent',
          { limit, page, date, from, to }
        );

        // Dedup by movie id, keep the most recent watch event per movie.
        // `/v1/watching/recent` returns every watch event, which produces
        // duplicates when a film has both a Plex record and a Letterboxd
        // log (or a sync created multiple entries).
        const seen = new Map<number, RecentWatch>();
        for (const w of raw) {
          const existing = seen.get(w.movie.id);
          if (!existing) {
            seen.set(w.movie.id, w);
            continue;
          }
          const existingTs = Date.parse(existing.watched_at);
          const candidateTs = Date.parse(w.watched_at);
          // Prefer the record with a user_rating; otherwise the most recent.
          const prefer =
            (w.user_rating !== null && existing.user_rating === null) ||
            candidateTs > existingTs;
          if (prefer) seen.set(w.movie.id, w);
        }
        const data = Array.from(seen.values()).sort(
          (a, b) => Date.parse(b.watched_at) - Date.parse(a.watched_at)
        );

        if (!data.length) {
          return {
            content: [text('No recent watches found.')],
            structuredContent: { items: [] },
          };
        }

        const lines = ['Recent watches:'];
        for (const [i, w] of data.entries()) {
          const year = w.movie.year ? ` (${w.movie.year})` : '';
          const director = w.movie.director ? ` dir. ${w.movie.director}` : '';
          const rating =
            w.user_rating !== null ? ` -- ${formatStars(w.user_rating)}` : '';
          const rewatch = w.rewatch ? ' [rewatch]' : '';
          lines.push(
            `${i + 1}. ${w.movie.title}${year}${director}${rating}${rewatch} (${timeAgo(w.watched_at)})`
          );
        }

        const topN = data.slice(0, POSTER_TOP_N);

        const images = include_images
          ? await Promise.all(
              topN.map((w) => imageBlock(client, w.movie.image, LIST_IMAGE_PX))
            )
          : [];

        const links = topN
          .map((w) =>
            resourceLink(w.review_url, `Letterboxd -- ${w.movie.title}`, {
              mimeType: 'text/html',
            })
          )
          .filter((b): b is NonNullable<typeof b> => b !== null);

        const content: ContentBlock[] = [
          text(lines.join('\n')),
          ...images.filter((b): b is NonNullable<typeof b> => b !== null),
          ...links,
        ];

        return {
          content,
          structuredContent: { items: data },
        };
      })
  );
}
