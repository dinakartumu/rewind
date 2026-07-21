import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RewindClient } from '../client.js';
import {
  withRichResponse,
  text,
  timeAgo,
  fmt,
  READ_ONLY_ANNOTATIONS,
  dateFilterParams,
  type ContentBlock,
} from './helpers.js';
import {
  checkinSchema,
  recentCheckinsOutputSchema,
  placesStatsOutputSchema,
} from './schemas/places.js';

// Types below are derived from the Zod output schemas (schemas/places.ts)
// so the declared schema and the TS type cannot drift.
type Checkin = z.infer<typeof checkinSchema>;

type PlacesStats = z.infer<typeof placesStatsOutputSchema>;

type Pagination = {
  page: number;
  limit: number;
  total: number;
  total_pages: number;
};

/** "Seattle, WA" / "Bangalore, India" / "" -- best-effort location label. */
function locationOf(c: Checkin): string {
  const region = c.venue_state ?? c.venue_country;
  if (c.venue_city && region) return `${c.venue_city}, ${region}`;
  return c.venue_city ?? region ?? '';
}

export function registerPlacesTools(
  server: McpServer,
  client: RewindClient
): void {
  // get_recent_checkins ────────────────────────────────────────────
  server.registerTool(
    'get_recent_checkins',
    {
      title: 'Recent check-ins',
      description:
        'Get recent Foursquare/Swarm check-ins, newest first. Returns venue name, category and icon URL, city/state/country, check-in time, and any shout (attached note). Supports date filtering.',
      inputSchema: {
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(20)
          .describe('Number of recent check-ins to return (max 50)'),
        ...dateFilterParams,
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: recentCheckinsOutputSchema,
    },
    async ({ limit, date, from, to }) =>
      withRichResponse(async () => {
        const data = await client.get<{
          data: Checkin[];
          pagination: Pagination;
        }>('/places/recent', { limit, date, from, to });

        if (!data.data.length) {
          return {
            content: [text('No check-ins found.')],
            structuredContent: { items: [], pagination: data.pagination },
          };
        }

        const lines = [
          `Recent check-ins (${fmt(data.pagination.total)} total):`,
        ];
        for (const [i, c] of data.data.entries()) {
          const category = c.venue_category ? ` (${c.venue_category})` : '';
          const location = locationOf(c);
          const where = location ? ` -- ${location}` : '';
          lines.push(
            `${i + 1}. ${c.venue_name}${category}${where} (${timeAgo(c.checked_in_at)})`
          );
          if (c.shout) lines.push(`   "${c.shout}"`);
        }

        const content: ContentBlock[] = [text(lines.join('\n'))];

        return {
          content,
          structuredContent: { items: data.data, pagination: data.pagination },
        };
      })
  );

  // get_places_stats ───────────────────────────────────────────────
  server.registerTool(
    'get_places_stats',
    {
      title: 'Check-in stats',
      description:
        'Get aggregate Foursquare/Swarm check-in statistics: total check-ins, unique venues, this-year count, top categories (with icon URLs), top cities, and top venues. Date filters scope every aggregation to the range except this_year, which always counts the current year.',
      inputSchema: { ...dateFilterParams },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: placesStatsOutputSchema,
    },
    async ({ date, from, to }) =>
      withRichResponse(async () => {
        const data = await client.get<PlacesStats>('/places/stats', {
          date,
          from,
          to,
        });

        const lines = [
          'Check-in Stats:',
          `- Total check-ins: ${fmt(data.total)}`,
          `- Unique venues: ${fmt(data.unique_venues)}`,
          `- This year: ${fmt(data.this_year)}`,
        ];

        if (data.top_categories.length) {
          lines.push('- Top categories:');
          for (const c of data.top_categories) {
            lines.push(`    ${c.category}: ${fmt(c.count)}`);
          }
        }

        if (data.top_cities.length) {
          lines.push('- Top cities:');
          for (const c of data.top_cities) {
            lines.push(`    ${c.city}: ${fmt(c.count)}`);
          }
        }

        if (data.top_venues.length) {
          lines.push('- Top venues:');
          for (const v of data.top_venues) {
            const city = v.city ? ` (${v.city})` : '';
            lines.push(`    ${v.venue_name}${city}: ${fmt(v.count)}`);
          }
        }

        return { content: [text(lines.join('\n'))], structuredContent: data };
      })
  );
}
