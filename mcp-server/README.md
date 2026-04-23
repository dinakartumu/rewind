# rewind-mcp-server

[![CI](https://github.com/pdugan20/rewind/actions/workflows/mcp-server.yml/badge.svg)](https://github.com/pdugan20/rewind/actions/workflows/mcp-server.yml)
[![npm version](https://img.shields.io/npm/v/rewind-mcp-server?logo=npm)](https://www.npmjs.com/package/rewind-mcp-server)
[![docs](https://img.shields.io/badge/docs-docs.rewind.rest-blue)](https://docs.rewind.rest/mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?logo=opensourceinitiative&logoColor=white)](https://opensource.org/licenses/MIT)

MCP server for the [Rewind](https://rewind.rest) personal data API. Gives AI assistants access to your listening, running, watching, collecting, and reading data.

## Setup

### Desktop Apps

Add to your MCP client config (Claude Desktop, ChatGPT, Gemini, etc.):

```json
{
  "mcpServers": {
    "rewind": {
      "command": "npx",
      "args": ["-y", "rewind-mcp-server"],
      "env": {
        "REWIND_API_KEY": "rw_live_your_key_here"
      }
    }
  }
}
```

### Mobile & Web

Add as a remote integration in your client's settings:

- **URL**: `https://mcp.rewind.rest/mcp`
- **Authorization**: `Bearer rw_live_your_key_here`

<details>
<summary>Claude Code</summary>

```bash
claude mcp add rewind -- npx -y rewind-mcp-server
```

</details>

Requires a [Rewind API key](https://docs.rewind.rest/authentication). `REWIND_API_URL` defaults to `https://api.rewind.rest`.

## Tools

| Domain           | Source           | Tools                                                                                                                         |
| ---------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Listening**    | Last.fm          | Now playing, recent scrobbles, stats, top artists/albums/tracks, streaks, artist and album details, genre breakdown over time |
| **Running**      | Strava           | Stats, recent runs, personal records, streaks, activity details, per-mile splits, per-year summaries                          |
| **Watching**     | Plex, Letterboxd | Recent watches, movie details, browse by genre/decade/director, stats, genre/decade/director breakdowns                       |
| **Collecting**   | Discogs, Trakt   | Vinyl collection, physical media (Blu-ray/4K UHD/HD DVD), collection and media stats                                          |
| **Reading**      | Instapaper       | Recent articles, highlights, random highlight, stats, semantic similar-article recall (`find_similar_articles`)               |
| **Cross-domain** | All              | Full-text search (keyword / semantic / hybrid modes), semantic_search, unified feed, on-this-day, health check                |

## Rich responses

Tool responses follow the MCP 2025-06-18 content model and include more than plain text:

- **Images.** Detail tools (`get_movie_details`, `get_album_details`, `get_artist_details`) and list tools (`get_recent_watches`, `get_recent_listens`, `get_top_albums`, `get_vinyl_collection`, etc.) return cover art / posters / artist imagery as `image` content blocks (top-N on lists, default N=5). Pass `include_images: false` to skip them when keeping responses compact matters.
- **Resource links.** External platform URLs come back as `resource_link` content blocks rather than being baked into prose -- Letterboxd reviews, Strava activities, Discogs releases, Apple Music pages, original article URLs, Last.fm pages.
- **Structured content.** Every tool also returns `structuredContent` with a JSON shape that mirrors the underlying API response, so the model can reason over exact numbers without re-parsing prose.

## Entity resources

The server exposes `@`-mentionable resources for fetching full detail on any entity:

| Entity         | URI                             | Source endpoint                                           |
| -------------- | ------------------------------- | --------------------------------------------------------- |
| Movie          | `rewind://movie/{id}`           | `/v1/watching/movies/{id}`                                |
| Show           | `rewind://show/{id}`            | `/v1/watching/shows/{id}`                                 |
| Album          | `rewind://album/{id}`           | `/v1/listening/albums/{id}`                               |
| Artist         | `rewind://artist/{id}`          | `/v1/listening/artists/{id}`                              |
| Vinyl          | `rewind://vinyl/{id}`           | `/v1/collecting/vinyl/{id}`                               |
| Physical media | `rewind://physical-media/{id}`  | `/v1/collecting/media/{id}`                               |
| Article        | `rewind://article/{id}`         | `/v1/reading/articles/{id}`                               |
| Highlight      | `rewind://highlight/{id}`       | `/v1/reading/highlights/{id}`                             |
| Activity       | `rewind://activity/{id}`        | `/v1/running/activities/{id}`                             |
| Sync status    | `rewind://sync/status`          | `/v1/health/sync`                                         |
| Year in review | `rewind://{domain}/year/{year}` | `/v1/{domain}/year/{year}` (listening, running, watching) |

`search` returns `resource_link`s pointing at these URIs so clients can drill from a match straight into the full record.

## Semantic search (reading)

Reading articles are embedded into a [Cloudflare Vectorize](https://developers.cloudflare.com/vectorize/) index at sync time using [Voyage AI](https://docs.voyageai.com/) (voyage-3-lite, 512-dim, cosine). Three query paths are available for natural-language recall:

- **`search` with `mode="semantic"` or `mode="hybrid"`** — keyword-only by default; opt in to vector-backed ranking when the user describes what an article was about rather than quoting it. Hybrid combines FTS + semantic via reciprocal rank fusion (k=60).
- **`semantic_search`** — dedicated tool for pure semantic recall over the reading domain. Returns cosine scores alongside `rewind://article/{id}` resource links.
- **`find_similar_articles(article_id)`** — "what else did I read like this?" — uses the article's own stored vector, no Voyage call at query time.

Semantic and hybrid modes are reading-only; other domains remain keyword-FTS.

## Interactive UI (MCP Apps)

`get_recent_watches` advertises a [MCP Apps](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/) UI resource. On clients that render MCP Apps (Claude Desktop, Claude web, VS Code GitHub Copilot, Goose) the tool returns an interactive poster grid inline in the conversation: thumbhash placeholders, theme-aware cards, clickable Letterboxd reviews, hover states. On clients that do not render MCP Apps the existing text + image + resource_link + structuredContent response is unchanged, so no caller regresses.

## Example Queries

- "What albums have I been listening to the most recently?"
- "Compare my mile splits from this month vs last month"
- "When was the last time I watched a film by Wes Anderson?"
- "What Beastie Boys records are missing from my vinyl collection?"
- "How many articles did I read last year and stack-rank the top 10 sources"
- "Can you give me a quick summary of everything I did last week?"

## Prompts

The server exposes slash-command prompts that orchestrate multiple tools for common asks:

- `weekly-summary` -- rolls up activity across all domains for the past 7 days
- `year-in-review` -- comprehensive yearly recap
- `compare-periods` -- parametric comparison between two time windows in a single domain
- `letterboxd-review-draft` -- drafts a Letterboxd-style review for your most recent unrated film
- `training-report` -- coach-style running report for the last 7-14 days
- `film-diet` -- portrait of your film-watching taste (genre mix, decades, directors)
- `find-article` -- recover a half-remembered article via hybrid+semantic search, then pull 3-5 related pieces

## Authentication

**Desktop apps** use the `REWIND_API_KEY` environment variable passed directly to the server process. The server authenticates with the Rewind API using this key as a Bearer token.

**Mobile and web clients** connect to the remote server at `mcp.rewind.rest`, which uses OAuth 2.1 with GitHub as the identity provider. The flow:

1. Client discovers endpoints via `/.well-known/oauth-authorization-server`
2. Client dynamically registers via `/register`
3. User authenticates with GitHub and approves access
4. Client receives scoped tokens (1h access, 90d refresh, PKCE S256)

The server has **read-only access** to your data. No write or admin operations are exposed.

## Privacy & Support

- [Privacy Policy](https://rewind.rest/privacy)
- [Documentation](https://docs.rewind.rest/mcp-server)
- [Report an issue](https://github.com/pdugan20/rewind/issues)
