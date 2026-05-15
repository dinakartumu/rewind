# MCP tool titles audit

Working doc to review and iterate on the user-facing `title` string for every
MCP tool before migrating the legacy `server.tool()` calls to
`server.registerTool()`.

## Background

Tools registered with the legacy `server.tool()` API have no `title` slot, so
clients (Claude Desktop / iOS) fall back to displaying the raw snake_case
`name` — `get_now_playing`, `get_recent_listens`, etc. Tools registered with
the modern `server.registerTool()` API carry a `title` and display a clean
label.

- `name` — protocol identifier, snake_case, stable. The model calls this. **Not changing.**
- `title` — human-readable label shown in client UI. This is what we're auditing.

`server.tool()` is `@deprecated` in `@modelcontextprotocol/sdk` v1.29.0;
`registerTool` is the SDK-blessed replacement. Migration is mechanical: the
three positional args (`description`, `inputSchema`, `annotations`) become a
config object, plus a new `title`. Handler is untouched.

## Title style guide

- **Sentence case** — "Recent listens", not "Recent Listens".
- **Noun phrase, no verb** — "Now playing", not "Get now playing".
- **No parentheticals** (per repo CLAUDE.md doc convention). Qualify with an
  em-dash instead: "Artist — detail", not "Artist (detail)".
- **Single-entity detail cards** use a bare singular noun — "Artist", "Movie".
  The list tools are all plural with a descriptive prefix ("Top artists",
  "Recent runs", "Attended events"), so a bare singular reads unambiguously as
  "the one" — no "— detail" qualifier needed.
- Keep it short — these render in narrow UI chips.

## Resolved decisions

1. **Athlete vs. Player → Player.** Standardized on "Player" across the
   attending domain (`get_attended_players` → "Attended players",
   `get_attended_player_stats` → "Player stats", `get_attended_player` →
   "Player"). Matches the tool names; the old "Athlete — detail" title is the
   only one that changes.
2. **`get_attended_season` → "Sports season".** Bare "Season" is too vague,
   so this one keeps a qualifier.
3. **`ui_hello_debug` → "UI hello — debug".** Parenthetical replaced with an
   em-dash per the repo doc convention.
4. **Detail tools use bare singular nouns**, so `get_article` becomes "Article"
   (was "Article — full body").

## Proposed titles

Legend: 🔧 needs migration (server.tool) · ✅ has a title, keeping as-is ·
✏️ has a title, but it's changing

### Listening — `listening.ts`

| Status | Tool name               | Current title   | Proposed title    |
| ------ | ----------------------- | --------------- | ----------------- |
| 🔧     | `get_now_playing`       | —               | Now playing       |
| 🔧     | `get_recent_listens`    | —               | Recent listens    |
| 🔧     | `get_listening_stats`   | —               | Listening stats   |
| 🔧     | `get_listening_streaks` | —               | Listening streaks |
| 🔧     | `get_album_details`     | —               | Album             |
| 🔧     | `get_listening_genres`  | —               | Listening genres  |
| ✅     | `get_top_artists`       | Top artists     | Top artists       |
| ✅     | `get_top_albums`        | Top albums      | Top albums        |
| ✅     | `get_top_tracks`        | Top tracks      | Top tracks        |
| ✏️     | `get_artist_details`    | Artist — detail | Artist            |

### Running — `running.ts`

| Status | Tool name              | Current title | Proposed title   |
| ------ | ---------------------- | ------------- | ---------------- |
| 🔧     | `get_running_stats`    | —             | Running stats    |
| 🔧     | `get_recent_runs`      | —             | Recent runs      |
| 🔧     | `get_personal_records` | —             | Personal records |
| 🔧     | `get_running_streaks`  | —             | Running streaks  |
| 🔧     | `get_activity_details` | —             | Run              |
| 🔧     | `get_activity_splits`  | —             | Run splits       |
| 🔧     | `get_running_years`    | —             | Running by year  |

### Watching — `watching.ts`

| Status | Tool name                | Current title  | Proposed title   |
| ------ | ------------------------ | -------------- | ---------------- |
| 🔧     | `get_movie_details`      | —              | Movie            |
| 🔧     | `get_watching_stats`     | —              | Watching stats   |
| 🔧     | `browse_movies`          | —              | Browse movies    |
| 🔧     | `get_watching_genres`    | —              | Watching genres  |
| 🔧     | `get_watching_decades`   | —              | Watching decades |
| 🔧     | `get_watching_directors` | —              | Top directors    |
| ✅     | `get_recent_watches`     | Recent watches | Recent watches   |

### Collecting — `collecting.ts`

| Status | Tool name                  | Current title | Proposed title       |
| ------ | -------------------------- | ------------- | -------------------- |
| 🔧     | `get_vinyl_collection`     | —             | Vinyl collection     |
| 🔧     | `get_collecting_stats`     | —             | Collection stats     |
| 🔧     | `get_physical_media`       | —             | Physical media       |
| 🔧     | `get_physical_media_stats` | —             | Physical media stats |

### Reading — `reading.ts`

| Status | Tool name                | Current title       | Proposed title     |
| ------ | ------------------------ | ------------------- | ------------------ |
| 🔧     | `get_reading_highlights` | —                   | Reading highlights |
| 🔧     | `get_random_highlight`   | —                   | Random highlight   |
| 🔧     | `get_reading_stats`      | —                   | Reading stats      |
| 🔧     | `find_similar_articles`  | —                   | Similar articles   |
| ✏️     | `get_article`            | Article — full body | Article            |
| ✅     | `get_recent_reads`       | Recent reads        | Recent reads       |

### Attending — `attending.ts`

| Status | Tool name                      | Current title          | Proposed title              |
| ------ | ------------------------------ | ---------------------- | --------------------------- |
| 🔧     | `get_attended_events`          | —                      | Attended events             |
| 🔧     | `get_attended_players`         | —                      | Attended players            |
| 🔧     | `get_attended_player_stats`    | —                      | Player stats                |
| 🔧     | `get_attending_stats`          | —                      | Attendance stats            |
| 🔧     | `get_attending_year_in_review` | —                      | Attendance — year in review |
| ✏️     | `get_attended_season`          | Attended sports season | Sports season               |
| ✏️     | `get_attended_player`          | Athlete — detail       | Player                      |
| ✏️     | `get_attended_event`           | Attended event         | Event                       |

### Cross-domain — `cross-domain.ts`

| Status | Tool name         | Current title | Proposed title  |
| ------ | ----------------- | ------------- | --------------- |
| 🔧     | `search`          | —             | Search          |
| 🔧     | `semantic_search` | —             | Semantic search |
| 🔧     | `get_feed`        | —             | Activity feed   |
| 🔧     | `get_on_this_day` | —             | On this day     |

### Debug — `debug.ts`

| Status | Tool name        | Current title    | Proposed title   |
| ------ | ---------------- | ---------------- | ---------------- |
| ✏️     | `ui_hello_debug` | UI Hello (debug) | UI hello — debug |

### System — `server.ts`

| Status | Tool name    | Current title | Proposed title |
| ------ | ------------ | ------------- | -------------- |
| 🔧     | `get_health` | —             | API health     |

## Resource titles — `resources.ts`

All 13 resources use the deprecated `server.resource()` API; none carry a
`title`. Migrating to `server.registerResource()` and adding titles.

| Status | Resource name    | URI                              | Proposed title             |
| ------ | ---------------- | -------------------------------- | -------------------------- |
| 🔧     | `sync-status`    | `rewind://sync/status`           | Sync status                |
| 🔧     | `listening-year` | `rewind://listening/year/{year}` | Listening — year in review |
| 🔧     | `running-year`   | `rewind://running/year/{year}`   | Running — year in review   |
| 🔧     | `watching-year`  | `rewind://watching/year/{year}`  | Watching — year in review  |
| 🔧     | `movie`          | `rewind://movie/{id}`            | Movie                      |
| 🔧     | `show`           | `rewind://show/{id}`             | TV show                    |
| 🔧     | `album`          | `rewind://album/{id}`            | Album                      |
| 🔧     | `artist`         | `rewind://artist/{id}`           | Artist                     |
| 🔧     | `vinyl`          | `rewind://vinyl/{id}`            | Vinyl record               |
| 🔧     | `physical-media` | `rewind://physical-media/{id}`   | Physical media             |
| 🔧     | `article`        | `rewind://article/{id}`          | Article                    |
| 🔧     | `activity`       | `rewind://activity/{id}`         | Run                        |
| 🔧     | `highlight`      | `rewind://highlight/{id}`        | Highlight                  |

## Prompt titles — `prompts.ts`

All 7 prompts use the deprecated `server.prompt()` API; none carry a `title`,
so clients show the raw name in the prompt picker. Migrating to
`server.registerPrompt()` and adding titles.

| Status | Prompt name               | Proposed title          |
| ------ | ------------------------- | ----------------------- |
| 🔧     | `weekly-summary`          | Weekly summary          |
| 🔧     | `year-in-review`          | Year in review          |
| 🔧     | `letterboxd-review-draft` | Letterboxd review draft |
| 🔧     | `training-report`         | Training report         |
| 🔧     | `film-diet`               | Film diet               |
| 🔧     | `compare-periods`         | Compare periods         |
| 🔧     | `find-article`            | Find an article         |

## Status

Migration executed: all 48 tools, 13 resources, and 7 prompts moved to the
`register*` APIs with the titles above. Verified with `tsc` (clean) and
`npm test` (99 passing). `outputSchema` on tools is tracked separately as
GitHub issue [#105](https://github.com/pdugan20/rewind/issues/105).
