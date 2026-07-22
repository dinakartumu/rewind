# Reading Domain

Instapaper articles, reading progress, highlights, and enrichment metadata.

## Data Sources

- **Instapaper** — bookmarks, reading progress, folders, tags, highlights, article text

## Tables

- `reading_items` — articles (future: books), with status, progress, OG metadata, word count, content
- `reading_highlights` — highlighted passages linked to articles

## Sync

- Cron: every 6 hours (alongside Letterboxd). Gated by the `ENABLE_INSTAPAPER` var — both the 6-hourly bookmarks sync and the weekly deletion reconciliation are skipped when it is `"false"`. Currently disabled (access token returns 401); re-enable by refreshing the token and setting the var to `"true"` or removing it.
- **Delta sync** via Instapaper `have` parameter: sends known bookmark ID:hash pairs so the API only returns new or changed bookmarks
- **Inline highlights** via `highlights` parameter: sends known highlight IDs so the API returns only new highlights alongside bookmarks, reducing per-bookmark API calls
- Handles `delete_ids` from the API to remove bookmarks deleted in Instapaper
- Enriches new articles with OG metadata (author, site_name, published_at, og_image_url) and word count via get_text
- Processes article thumbnail images via image pipeline

## Status Derivation

| Instapaper state                        | Rewind status |
| --------------------------------------- | ------------- |
| progress == 0, folder unread            | `unread`      |
| progress > 0 and < 0.75, folder unread  | `reading`     |
| progress >= 0.75, any folder            | `finished`    |
| progress == 0, folder archive           | `skipped`     |
| progress > 0 and < 0.75, folder archive | `abandoned`   |

## Endpoints

### Public (13)

- `GET /reading/recent` — recently saved or finished
- `GET /reading/currently-reading` — articles in progress
- `GET /reading/articles` — browse with filters (status, domain, tag, starred)
- `GET /reading/articles/{id}` — detail with embedded highlights
- `GET /reading/archive` — finished articles
- `GET /reading/highlights` — all highlights with article context
- `GET /reading/highlights/random` — random highlight
- `GET /reading/stats` — aggregate statistics
- `GET /reading/calendar` — daily reading activity
- `GET /reading/streaks` — current and longest reading streaks
- `GET /reading/tags` — tag breakdown
- `GET /reading/domains` — top source domains
- `GET /reading/year/{year}` — year in review

### Admin (hidden)

- `POST /admin/sync/reading` — trigger Instapaper sync
- `POST /reading/admin/backfill-images` — process missing article thumbnails

## Enrichment

Each article is enriched with metadata from two sources:

**OG metadata** (from article URL HTML head):

- `og:image` → `og_image_url` (used by image pipeline for thumbnails)
- `og:site_name` → `site_name` ("Wired", "The New York Times")
- `article:author` → `author`
- `article:published_time` → `published_at`
- `og:description` → `og_description` (fallback for empty descriptions)
- `article:section` + `article:tag` → `article_tags`

**Instapaper get_text** (processed article HTML):

- Full HTML → `content` (for future full-text search)
- Word count → `word_count`
- Estimated read time → `estimated_read_min` (238 WPM)

Enrichment status tracked per article: `pending`, `completed`, `failed` with error reason.

## API Client

The `InstapaperClient` (`src/services/instapaper/client.ts`) wraps the Instapaper Full API v1 with OAuth 1.0a signing.

Key methods:

- `listBookmarks(options)` — delta-aware bookmark listing with `have`, `highlights`, and `tag` params; returns `{ bookmarks, highlights, deleteIds, user }`
- `listBookmarksSimple(folderId, limit)` — backward-compatible wrapper returning only bookmarks array
- `getText(bookmarkId)` — fetch processed article HTML (restricted to personal use as of Sept 2026)
- `listHighlights(bookmarkId)` — fetch highlights for a single bookmark (fallback when not using inline highlights)
- `verifyCredentials()` — validate OAuth credentials, returns authenticated user
- `listFolders()` — list user-created folders

## Known Limitations

- Paywalled sites (NYT, WSJ, Bloomberg) block OG metadata scraping (~490 of 1047 articles)
- Instapaper API returns max 500 bookmarks per folder per call
- Article thumbnails depend on `og:image` being present on the source page
- `get_text` endpoint restricted to personal use after Sept 30, 2026 (our usage is personal, so no impact)
- Instapaper API v2 with OAuth 2.0 is planned; current OAuth 1.0a will need migration when v1 is deprecated
