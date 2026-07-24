import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RewindClient } from '../client.js';
import {
  withRichResponse,
  text,
  resourceLink,
  imageBlock,
  fmt,
  hostOf,
  READ_ONLY_ANNOTATIONS,
  LIST_IMAGE_PX,
  type ContentBlock,
} from './helpers.js';
import {
  searchResultSchema,
  searchOutputSchema,
  semanticSearchOutputSchema,
} from './schemas/cross-domain.js';

const SEARCH_TOP_N = 5;

/** Ranking modes the API only implements over the reading domain. */
const READING_ONLY_MODES = new Set(['semantic', 'hybrid']);

// Types below are derived from the Zod output schemas (schemas/cross-domain.ts)
// so the declared schema and the TS type cannot drift. The search-result type
// matches the tool's structuredContent shape exactly.
type SearchResult = z.infer<typeof searchResultSchema>;

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
  server.registerTool(
    'search',
    {
      title: 'Search',
      description:
        'Search across all domains (listening, running, watching, collecting, reading). Ranking modes: keyword (default) uses FTS5 full-text search and is the ONLY mode that works outside the reading domain; semantic uses Voyage AI embeddings for paraphrased / meaning-based recall; hybrid fuses both. **semantic and hybrid are reading-domain only — they only ever match saved articles.** Never pair them with `domain: listening | running | watching | collecting`; that combination searches the wrong corpus and is downgraded to keyword automatically. For anything that is not an article (a film, an album, a run, a record), use the default keyword mode. Use semantic or hybrid when the user describes what an article was ABOUT rather than quoting its words. **Prefer `mode: hybrid` whenever the user mixes an article topic with a recalled keyword or a publisher hint** ("the ESPN piece about Ichiro", "the WSJ article on EVs") — semantic alone does not see source domains and can drop the publisher signal entirely. When a result is the article the user is asking about, follow up with `get_article(id)` to render the rich inline article card — do not stop at the search-result text response.',
      inputSchema: {
        query: z.string().describe('Search query text'),
        domain: z
          .enum(['listening', 'running', 'watching', 'collecting', 'reading'])
          .optional()
          .describe('Optional: filter results to a single domain'),
        mode: z
          .enum(['keyword', 'semantic', 'hybrid'])
          .optional()
          .describe(
            'Ranking mode. keyword = FTS (default), the only mode valid outside the reading domain. semantic = cosine-similarity over article embeddings (reading only). hybrid = FTS + semantic via reciprocal rank fusion (reading only). Leave unset unless you are searching saved articles.'
          ),
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(10)
          .describe('Number of results to return'),
        page: z
          .number()
          .min(1)
          .default(1)
          .describe('Page number for pagination'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: searchOutputSchema,
    },
    async ({ query, domain, mode, limit, page }) =>
      withRichResponse(async () => {
        // The API rejects semantic/hybrid outside the reading domain with a
        // 400. Honour the caller's explicit domain and downgrade the ranking
        // mode instead of failing: a film or album searched with `mode:
        // hybrid` still has a correct keyword answer, and forcing
        // domain=reading would answer from the wrong corpus entirely.
        const downgraded = Boolean(
          mode && READING_ONLY_MODES.has(mode) && domain && domain !== 'reading'
        );
        const effectiveMode = downgraded ? 'keyword' : mode;

        const params: Record<string, string | number> = {
          q: query,
          limit,
          page,
        };
        if (domain) params.domain = domain;
        if (effectiveMode) params.mode = effectiveMode;

        const data = await client.get<{
          data: SearchResult[];
          pagination: { total: number };
        }>('/search', params);

        // Tell the model what actually ran, so it does not read a keyword
        // result as a semantic one or retry the rejected combination.
        const downgradeNote = downgraded
          ? ` (mode=${mode} is reading-domain only; searched ${domain} with keyword ranking instead)`
          : '';

        if (!data.data.length) {
          return {
            content: [
              text(
                `No results found for "${query}"${domain ? ` in ${domain}` : ''}.${downgradeNote}`
              ),
            ],
            structuredContent: { items: [], pagination: data.pagination },
          };
        }

        const modeLabel =
          effectiveMode && effectiveMode !== 'keyword'
            ? ` [${effectiveMode}]`
            : '';
        const lines = [
          `Search results for "${query}"${modeLabel} (${fmt(data.pagination.total)} total):${downgradeNote}`,
        ];

        for (const [i, r] of data.data.entries()) {
          // Embed the click-through URL as a markdown link on the title so
          // Claude's natural echo of the tool text preserves clickability.
          // Resource_link blocks alone are hidden from the inline response
          // in Claude Desktop, and instructing the model to synthesize
          // `[title](url)` from structuredContent is unreliable.
          const titleUrl = r.url ?? r.instapaper_url ?? null;
          const titleMd = titleUrl ? `[${r.title}](${titleUrl})` : r.title;
          const authorPart = r.author ? ` by ${r.author}` : '';
          const dom = r.url ? ` (${hostOf(r.url)})` : '';
          const sub = r.subtitle && !r.url ? ` -- ${r.subtitle}` : '';
          const score =
            typeof r.score === 'number' ? ` (score=${r.score.toFixed(2)})` : '';
          lines.push(`${i + 1}. ${titleMd}${authorPart}${dom}${sub}${score}`);
        }

        // Emit resource_links: prefer the external URL when present (so the
        // user can click through to the actual article / Letterboxd review /
        // Strava activity / etc.), and additionally emit the rewind:// URI
        // so the model can @-mention / fetch full detail via the MCP resource.
        const links = data.data.flatMap((r) => {
          const out: ReturnType<typeof resourceLink>[] = [];
          if (r.url) {
            const host = hostOf(r.url);
            out.push(
              resourceLink(
                r.url,
                host ? `${r.title} — read on ${host}` : r.title,
                {
                  mimeType: 'text/html',
                  description: r.subtitle ?? undefined,
                }
              )
            );
          }
          if (r.instapaper_url) {
            out.push(
              resourceLink(
                r.instapaper_url,
                `${r.title} — read in Instapaper`,
                {
                  mimeType: 'text/html',
                  description: r.subtitle ?? undefined,
                }
              )
            );
          }
          if (r.instapaper_app_url) {
            out.push(
              resourceLink(
                r.instapaper_app_url,
                `${r.title} — open in Instapaper app`,
                { description: r.subtitle ?? undefined }
              )
            );
          }
          const uri = rewindUri(r.domain, r.entity_type, r.entity_id);
          if (uri) {
            out.push(
              resourceLink(uri, `${r.title} (details)`, {
                mimeType: 'application/json',
                description: r.subtitle ?? undefined,
              })
            );
          }
          return out.filter((b): b is NonNullable<typeof b> => b !== null);
        });

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
  server.registerTool(
    'semantic_search',
    {
      title: 'Semantic search',
      description:
        'Semantic search over the reading domain using Voyage AI embeddings. Use when the user describes the gist or topic of an article they remember rather than quoting exact words — e.g. "article about a former SNL writer" or "piece about tech layoffs". Returns articles ranked by cosine similarity with a score in [0,1]. Reading domain only. **Important: this tool does NOT see source domains** — embeddings only encode title + description + body. If the user mentions a publisher (ESPN, NYT, WSJ, Atlantic, etc.) or a recalled keyword, prefer `search(mode: "hybrid", ...)` so FTS picks up that signal. **If the top scores cluster within ~0.03 of each other, raise `limit` to 15+** — the right match may sit at position 6+ and approximate-nearest-neighbor noise can swap items at the boundary. When the top result is the article the user is asking about, follow up with `get_article(id)` to render the rich inline article card; if the top score is low (~0.4 and below) or you are unsure which match is right, list the top 2-3 candidates and ask the user to disambiguate before rendering.',
      inputSchema: {
        query: z
          .string()
          .describe('Natural-language description of the article'),
        limit: z
          .number()
          .min(1)
          .max(25)
          .default(10)
          .describe('Number of matches to return'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: semanticSearchOutputSchema,
    },
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
          url?: string | null;
          instapaper_url?: string | null;
          instapaper_app_url?: string | null;
          author?: string | null;
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
          const titleUrl = r.url ?? r.instapaper_url ?? null;
          const titleMd = titleUrl ? `[${r.title}](${titleUrl})` : r.title;
          const authorPart = r.author ? ` by ${r.author}` : '';
          const dom = r.url ? ` (${hostOf(r.url)})` : '';
          const sub = r.subtitle && !r.url ? ` -- ${r.subtitle}` : '';
          lines.push(
            `${i + 1}. ${titleMd}${authorPart}${dom}${sub} (score=${r.score.toFixed(2)})`
          );
        }

        const links = data.data.flatMap((r) => {
          const out: ReturnType<typeof resourceLink>[] = [];
          if (r.url) {
            const host = hostOf(r.url);
            out.push(
              resourceLink(
                r.url,
                host ? `${r.title} — read on ${host}` : r.title,
                {
                  mimeType: 'text/html',
                  description: r.subtitle ?? undefined,
                }
              )
            );
          }
          if (r.instapaper_url) {
            out.push(
              resourceLink(
                r.instapaper_url,
                `${r.title} — read in Instapaper`,
                {
                  mimeType: 'text/html',
                  description: r.subtitle ?? undefined,
                }
              )
            );
          }
          if (r.instapaper_app_url) {
            out.push(
              resourceLink(
                r.instapaper_app_url,
                `${r.title} — open in Instapaper app`,
                { description: r.subtitle ?? undefined }
              )
            );
          }
          const uri = rewindUri(r.domain, r.entity_type, r.entity_id);
          if (uri) {
            out.push(
              resourceLink(uri, `${r.title} (details)`, {
                mimeType: 'application/json',
                description: r.subtitle ?? undefined,
              })
            );
          }
          return out.filter((b): b is NonNullable<typeof b> => b !== null);
        });

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
}
