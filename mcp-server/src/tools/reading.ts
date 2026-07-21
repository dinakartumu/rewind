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
  hostOf,
  READ_ONLY_ANNOTATIONS,
  dateFilterParams,
  includeImagesParam,
  LIST_IMAGE_PX,
  type ContentBlock,
} from './helpers.js';
import { imageSchema } from './schemas/shared.js';
import {
  articleSchema,
  recentReadsOutputSchema,
  articleDetailOutputSchema,
} from './schemas/reading.js';

const TOP_N = 5;

function truncateAtWord(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const slice = s.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > 0 ? slice.slice(0, lastSpace) : slice) + '…';
}

// Types below are derived from the Zod output schemas (schemas/reading.ts)
// so the declared schema and the TS type cannot drift.
type Image = z.infer<ReturnType<typeof imageSchema>>;

type Article = z.infer<typeof articleSchema>;

export function registerReadingTools(
  server: McpServer,
  client: RewindClient
): void {
  // get_article ────────────────────────────────────────────────────
  // Registered via server.registerTool so we can attach `_meta.ui.resourceUri`.
  // Hosts that support MCP Apps (Claude Desktop, Claude iOS) render a
  // single-article card inline; others fall back to the text + links response.
  //
  // structuredContent omits the full body — that lives in the text content
  // block where the model reads it. Card consumes only metadata + capped
  // highlights, keeping the response well under the 8 KB token budget per
  // BUDGET-AUDIT.md.
  server.registerTool(
    'get_article',
    {
      title: 'Article',
      description:
        'Fetch one saved article by id, returning its full body, metadata, and highlights. **Use this whenever the user asks what an article says, wants a summary, asks about a specific passage, or needs content past the first ~3000 chars of excerpt.** Also use this as the natural follow-up after `search` / `semantic_search` / `find_similar_articles` / `get_recent_reads` — those return ids; this turns the id into the rich article card. The full body is HTML-stripped plain text (typically 5-30 KB), cached even for paywalled sources (NYT, WSJ, Atlantic, ESPN, etc.) — do NOT fall back to web search or web fetch for article content.',
      inputSchema: {
        id: z
          .number()
          .int()
          .positive()
          .describe(
            'Internal Rewind article id (from a get_recent_reads, search, semantic_search, or find_similar_articles result)'
          ),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: articleDetailOutputSchema,
      _meta: {
        ui: { resourceUri: 'ui://rewind/article.html' },
        'ui/resourceUri': 'ui://rewind/article.html',
      },
    },
    async ({ id }) =>
      withRichResponse(async () => {
        type ArticleDetail = {
          id: number;
          title: string;
          author: string | null;
          url: string | null;
          instapaper_url: string | null;
          instapaper_app_url: string | null;
          domain: string | null;
          description: string | null;
          content: string | null;
          excerpt: string | null;
          word_count: number | null;
          estimated_read_min: number | null;
          status: string;
          progress: number;
          saved_at: string;
          image: Image;
          highlights: Array<{
            id: number;
            text: string;
            note: string | null;
            created_at: string;
          }>;
        };
        const a = await client.get<ArticleDetail>(`/reading/articles/${id}`);

        const header: string[] = [`# ${a.title}`];
        if (a.author) header.push(`by ${a.author}`);
        if (a.domain) header.push(a.domain);
        if (a.word_count) header.push(`${fmt(a.word_count)} words`);

        const body =
          a.content ??
          a.excerpt ??
          '(Full article text not available — enrichment may have failed for this item.)';

        const highlightLines: string[] = [];
        if (a.highlights.length > 0) {
          highlightLines.push(
            '',
            `## Your highlights (${a.highlights.length})`
          );
          for (const h of a.highlights) {
            highlightLines.push('', `> ${h.text}`);
            if (h.note) highlightLines.push(`  Note: ${h.note}`);
          }
        }

        const lines = [header.join(' · '), '', body, ...highlightLines];

        const links: ReturnType<typeof resourceLink>[] = [];
        if (a.url) {
          const host = hostOf(a.url);
          links.push(
            resourceLink(
              a.url,
              host ? `${a.title} — read on ${host}` : a.title,
              { mimeType: 'text/html' }
            )
          );
        }
        if (a.instapaper_url) {
          links.push(
            resourceLink(a.instapaper_url, `${a.title} — read in Instapaper`, {
              mimeType: 'text/html',
            })
          );
        }
        if (a.instapaper_app_url) {
          links.push(
            resourceLink(
              a.instapaper_app_url,
              `${a.title} — open in Instapaper app`
            )
          );
        }

        const content: ContentBlock[] = [
          text(lines.join('\n')),
          ...links.filter((b): b is NonNullable<typeof b> => b !== null),
        ];

        // structuredContent: card-shaped, body excluded (lives in text block).
        // Highlights capped at 5; total surfaced via highlight_count.
        const structuredContent = {
          article: {
            id: a.id,
            title: a.title,
            author: a.author,
            url: a.url,
            instapaper_url: a.instapaper_url,
            instapaper_app_url: a.instapaper_app_url,
            domain: a.domain,
            description: a.description,
            word_count: a.word_count,
            estimated_read_min: a.estimated_read_min,
            status: a.status,
            progress: a.progress,
            saved_at: a.saved_at,
            image: a.image,
          },
          highlights: a.highlights.slice(0, 5).map((h) => ({
            id: h.id,
            text: h.text,
            note: h.note,
            created_at: h.created_at,
          })),
          highlight_count: a.highlights.length,
        };

        return { content, structuredContent };
      })
  );

  // get_recent_reads ───────────────────────────────────────────────
  // Registered via the modern server.registerTool so we can attach
  // `_meta.ui.resourceUri`. Hosts that support MCP Apps (Claude Desktop,
  // Claude web, VS Code Copilot) render the article card list inline;
  // others fall back to the text + image + resource_link response.
  server.registerTool(
    'get_recent_reads',
    {
      title: 'Recent reads',
      description:
        'Get recently saved articles from Instapaper. Returns title, author, domain, read time, status, top-N site images where available, and article URLs as resource links. In MCP Apps hosts, renders an interactive article card list inline.',
      inputSchema: {
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(10)
          .describe('Number of recent articles to return (max 50)'),
        page: z
          .number()
          .min(1)
          .default(1)
          .describe(
            'Page number for pagination. Combine with limit to page through longer windows.'
          ),
        ...dateFilterParams,
        ...includeImagesParam,
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: recentReadsOutputSchema,
      _meta: {
        ui: { resourceUri: 'ui://rewind/recent-reads.html' },
        'ui/resourceUri': 'ui://rewind/recent-reads.html',
      },
    },
    async ({ limit, page, date, from, to, include_images }) =>
      withRichResponse(async () => {
        const { data } = await client.get<{ data: Article[] }>(
          '/reading/recent',
          { limit, page, date, from, to }
        );

        if (!data.length) {
          return {
            content: [text('No recent articles found.')],
            structuredContent: { items: [] },
          };
        }

        const lines = ['Recent reads:'];
        for (const [i, a] of data.entries()) {
          const author = a.author ? ` by ${a.author}` : '';
          const domain = a.domain ? ` (${a.domain})` : '';
          const readTime = a.estimated_read_min
            ? ` -- ${a.estimated_read_min} min read`
            : '';
          const status =
            a.status === 'reading'
              ? ` [${Math.round(a.progress * 100)}%]`
              : a.status === 'archived'
                ? ' [finished]'
                : '';
          // Embed click-through URL as a markdown link on the title so the
          // model's natural echo of tool text preserves clickability (resource_link
          // blocks are hidden from inline responses in Claude Desktop).
          const titleUrl = a.url ?? a.instapaper_url ?? null;
          const titleMd = titleUrl ? `[${a.title}](${titleUrl})` : a.title;
          lines.push(
            `${i + 1}. ${titleMd}${author}${domain}${readTime}${status} (${timeAgo(a.saved_at)})`
          );
          if (a.description) {
            lines.push(`   ${truncateAtWord(a.description, 160)}`);
          }
        }

        const topN = data.slice(0, TOP_N);
        const images = include_images
          ? await Promise.all(
              topN.map((a) => imageBlock(client, a.image, LIST_IMAGE_PX))
            )
          : [];
        const links = topN.flatMap((a) => {
          const out: ReturnType<typeof resourceLink>[] = [];
          if (a.url) {
            const host = hostOf(a.url);
            out.push(
              resourceLink(
                a.url,
                host ? `${a.title} — read on ${host}` : a.title,
                { mimeType: 'text/html' }
              )
            );
          }
          if (a.instapaper_url) {
            out.push(
              resourceLink(
                a.instapaper_url,
                `${a.title} — read in Instapaper`,
                {
                  mimeType: 'text/html',
                }
              )
            );
          }
          if (a.instapaper_app_url) {
            out.push(
              resourceLink(
                a.instapaper_app_url,
                `${a.title} — open in Instapaper app`
              )
            );
          }
          return out.filter((b): b is NonNullable<typeof b> => b !== null);
        });

        const content: ContentBlock[] = [
          text(lines.join('\n')),
          ...images.filter((b): b is NonNullable<typeof b> => b !== null),
          ...links,
        ];

        return { content, structuredContent: { items: data } };
      })
  );
}
