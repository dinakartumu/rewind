import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RewindClient } from '../client.js';
import {
  withRichResponse,
  text,
  resourceLink,
  timeAgo,
  fmt,
  READ_ONLY_ANNOTATIONS,
  dateFilterParams,
  type ContentBlock,
} from './helpers.js';
import {
  codingActivitySchema,
  codingLanguageSchema,
  codingStatsOutputSchema,
  recentCodingActivityOutputSchema,
  codingLanguagesOutputSchema,
} from './schemas/coding.js';

// Types below are derived from the Zod output schemas (schemas/coding.ts)
// so the declared schema and the TS type cannot drift.
type CodingActivity = z.infer<typeof codingActivitySchema>;
type CodingLanguage = z.infer<typeof codingLanguageSchema>;

/** Format a duration in seconds as "4h 12m" (or "47m" under an hour). */
function formatDuration(seconds: number): string {
  const total = Math.round(seconds / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Human label for a timeline item type. */
function activityLabel(type: CodingActivity['type']): string {
  if (type === 'pr') return 'PR';
  if (type === 'issue') return 'issue';
  return 'commit';
}

export function registerCodingTools(
  server: McpServer,
  client: RewindClient
): void {
  // get_coding_stats ───────────────────────────────────────────────
  server.registerTool(
    'get_coding_stats',
    {
      title: 'Coding stats',
      description:
        'Aggregate coding statistics over an optional date range: total coding time and active days (WakaTime), commit / PR / issue counts (GitHub), and a screen-time breakdown by productivity level (RescueTime). Use for "how much did I code", "how many commits this month", or "where does my screen time go".',
      inputSchema: {
        ...dateFilterParams,
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: codingStatsOutputSchema,
    },
    async ({ date, from, to }) =>
      withRichResponse(async () => {
        const stats = await client.get<{
          coding_seconds: number;
          coding_days: number;
          commits: number;
          prs: number;
          issues: number;
          screen_time: {
            total_seconds: number;
            very_productive_seconds: number;
            productive_seconds: number;
            neutral_seconds: number;
            distracting_seconds: number;
            very_distracting_seconds: number;
          };
        }>('/coding/stats', { date, from, to });

        const st = stats.screen_time;
        const lines = [
          'Coding stats:',
          `- Coded ${formatDuration(stats.coding_seconds)} across ${fmt(stats.coding_days)} active ${stats.coding_days === 1 ? 'day' : 'days'}`,
          `- ${fmt(stats.commits)} commits, ${fmt(stats.prs)} PRs, ${fmt(stats.issues)} issues`,
          `- Screen time ${formatDuration(st.total_seconds)}: ${formatDuration(st.very_productive_seconds)} very productive, ${formatDuration(st.productive_seconds)} productive, ${formatDuration(st.neutral_seconds)} neutral, ${formatDuration(st.distracting_seconds)} distracting, ${formatDuration(st.very_distracting_seconds)} very distracting`,
        ];

        return { content: [text(lines.join('\n'))], structuredContent: stats };
      })
  );

  // get_recent_coding_activity ─────────────────────────────────────
  server.registerTool(
    'get_recent_coding_activity',
    {
      title: 'Recent coding activity',
      description:
        'Get a merged timeline of recent GitHub commits, pull requests, and issues (newest first), plus a today object with coding seconds (WakaTime) and productivity pulse (RescueTime) for the current UTC date. Each item renders as a markdown link to its GitHub URL. Use for "what have I been working on", "recent commits", or "my open PRs".',
      inputSchema: {
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(20)
          .describe('Number of activity items to return (max 50)'),
        page: z
          .number()
          .min(1)
          .default(1)
          .describe('Page number for pagination'),
        ...dateFilterParams,
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: recentCodingActivityOutputSchema,
    },
    async ({ limit, page, date, from, to }) =>
      withRichResponse(async () => {
        const res = await client.get<{
          data: CodingActivity[];
          today: { coding_seconds: number; productivity_pulse: number | null };
        }>('/coding/recent', { limit, page, date, from, to });

        const today = res.today;
        const todayLine = `Today: coded ${formatDuration(today.coding_seconds)}${
          today.productivity_pulse !== null
            ? `, productivity pulse ${today.productivity_pulse}`
            : ''
        }.`;

        if (!res.data.length) {
          return {
            content: [text(`No recent coding activity found.\n${todayLine}`)],
            structuredContent: { items: [], today },
          };
        }

        const lines = ['Recent coding activity:'];
        for (const [i, a] of res.data.entries()) {
          // Embed the GitHub URL as a markdown link on the title so the model's
          // natural echo of the tool text preserves clickability (resource_link
          // blocks are hidden from inline responses in Claude Desktop).
          const titleMd = `[${a.title}](${a.url})`;
          const kind = activityLabel(a.type);
          const state = a.state ? ` [${a.state}]` : '';
          lines.push(
            `${i + 1}. ${titleMd} — ${kind} in ${a.repo}${state} (${timeAgo(a.occurred_at)})`
          );
        }
        lines.push('', todayLine);

        // resource_link blocks for hosts that surface them; the inline markdown
        // links above cover the accordion-hidden case.
        const links = res.data
          .map((a) =>
            resourceLink(
              a.url,
              `${a.title} — ${activityLabel(a.type)} in ${a.repo}`,
              {
                mimeType: 'text/html',
              }
            )
          )
          .filter((b): b is NonNullable<typeof b> => b !== null);

        const content: ContentBlock[] = [text(lines.join('\n')), ...links];

        return { content, structuredContent: { items: res.data, today } };
      })
  );

  // get_coding_languages ───────────────────────────────────────────
  server.registerTool(
    'get_coding_languages',
    {
      title: 'Top coding languages',
      description:
        'Get per-language coding time over an optional date range (from WakaTime), each with its percent of the range total. Use for "what languages do I code in most", "language breakdown this year".',
      inputSchema: {
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(10)
          .describe('Number of languages to return (max 50)'),
        ...dateFilterParams,
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: codingLanguagesOutputSchema,
    },
    async ({ limit, date, from, to }) =>
      withRichResponse(async () => {
        const { data } = await client.get<{ data: CodingLanguage[] }>(
          '/coding/languages',
          { limit, date, from, to }
        );

        if (!data.length) {
          return {
            content: [text('No coding-language data found.')],
            structuredContent: { items: [] },
          };
        }

        const lines = ['Top coding languages:'];
        for (const [i, l] of data.entries()) {
          lines.push(
            `${i + 1}. ${l.language} — ${formatDuration(l.total_seconds)} (${l.percent}%)`
          );
        }

        return {
          content: [text(lines.join('\n'))],
          structuredContent: { items: data },
        };
      })
  );
}
