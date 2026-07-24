/**
 * Curated, annotated schema for the read-only SQL endpoint (`GET /v1/schema`).
 *
 * This is hand-maintained (NOT live introspection) so a model gets the
 * semantic context it needs — source enums, rating scales, join keys, image
 * URL composition — rather than raw column types. Every ALLOWED table (see
 * `sql-guard.ts` for the denylist) must appear here; a test in
 * `schema-doc.test.ts` fails if a new table is added to the schema without a
 * corresponding entry, and if any denied table leaks in.
 *
 * Denied tables (`api_keys`, `*_tokens`, `revalidation_hooks`,
 * `webhook_events`, `sqlite_master`/`sqlite_schema`) are intentionally absent —
 * they are unreachable from the query endpoint, so documenting them would be
 * misleading.
 */

export interface SchemaColumn {
  name: string;
  type: string;
  note?: string;
}

export interface SchemaTable {
  name: string;
  purpose: string;
  columns: SchemaColumn[];
  joins?: string[];
}

export interface SchemaDoc {
  notes: string[];
  tables: SchemaTable[];
}

const c = (name: string, type: string, note?: string): SchemaColumn =>
  note ? { name, type, note } : { name, type };

export const SCHEMA_DOC: SchemaDoc = {
  notes: [
    'Single-user database: every table has `user_id` and it is always 1. You may omit `WHERE user_id = 1` — there is only one user.',
    'All timestamps are ISO 8601 strings stored in text columns (e.g. "2026-03-18T14:30:00.000Z"), UTC. Date-only fields (event_date, birth_date, date) are "YYYY-MM-DD". Compare/sort them as strings; use SQLite date()/strftime() for bucketing.',
    'Booleans are stored as integers 0/1 (e.g. is_filtered, starred, is_race, attended, notable, rewatch, is_home).',
    'is_filtered = 1 marks Last.fm rows the owner has hidden (junk scrobbles, misattributions). Analytical listening queries should filter `is_filtered = 0` unless you specifically want the raw data. lastfm_scrobbles has no is_filtered column — join through lastfm_tracks to filter.',
    'Rating scales differ by domain: watch_history.user_rating and movies.tmdb_rating / shows.tmdb_rating are 0-10 (real). discogs_collection.rating and discogs_wantlist.rating are 0-5 integers (0 = unrated). reading_items.rating is a small integer (may be null). There is no single global scale.',
    'Images: the shared `images` table is the ONLY source of artwork -- it keys on (domain, entity_type, entity_id) and every image lives there. The public CDN URL is composed as https://cdn.dinakartumu.com/cdn-cgi/image/<transforms>/<r2_key>, and image_version is appended as a cache-busting query param (?v=<image_version>). Domain tables do NOT carry a usable artwork column: movies.poster_path / shows.poster_path are raw TMDB paths against a different host, not R2 keys, and are null for many rows. Always join `images`. dominant_color/accent_color are hex strings; thumbhash is a compact placeholder blob.',
    "Rendering artwork in query_rewind: SELECT a composed CDN image URL and query_rewind renders it as an inline thumbnail (first 8 distinct URLs, in row order). Copy-paste expression joining the images table: `'https://cdn.dinakartumu.com/cdn-cgi/image/width=120,height=120,fit=cover,format=auto/' || i.r2_key || '?v=' || i.image_version AS art`. Join path per entity: album art = JOIN images i ON i.domain='listening' AND i.entity_type='albums' AND i.entity_id = CAST(al.id AS TEXT); artist image = entity_type='artists' (entity_id = artist.id); movie poster = i.domain='watching' AND i.entity_type='movies' AND i.entity_id = CAST(m.id AS TEXT); show poster = entity_type='shows'. entity_id is TEXT, so cast the numeric row id. There is no shortcut column — artwork ALWAYS comes from a join against `images`; do not compose a URL from any column on the domain table itself. Note that `'prefix' || NULL` is NULL in SQLite, so a wrong column yields a silently empty art column rather than an error — if art comes back blank, the join is wrong. A place/venue icon lives directly on checkins.venue_icon (already a full URL — SELECT it as-is). For a sandboxed Claude artifact whose iframe cannot fetch the CDN, call query_rewind with embed_art:true to also get those matched image URLs back as small base64 WebP data URIs in structuredContent.art (keyed by the original URL) to inline directly in the artifact HTML.",
    "Year-in-review (wrapped) view in query_rewind: call query_rewind with view:'wrapped' and a UNION-ALL that returns labeled highlight rows with columns `section, label, value, image` (image optional, a composed CDN URL or NULL) grouped by `section`. The wrapped card groups rows by section and renders each as a mini panel — a ranked list with covers when the section has images, else a labeled stat. Add a leading `SELECT 'Year' AS section, '2024 in review' AS label, NULL AS value, NULL AS image` to title the card. Example: `SELECT 'Year' AS section, '2024 in review' AS label, NULL AS value, NULL AS image UNION ALL SELECT 'Top Artists', ar.name, ar.playcount, 'https://cdn.dinakartumu.com/cdn-cgi/image/width=120,height=120,fit=cover,format=auto/' || i.r2_key || '?v=' || i.image_version FROM lastfm_artists ar LEFT JOIN images i ON i.domain = 'listening' AND i.entity_type = 'artists' AND i.entity_id = CAST(ar.id AS TEXT) WHERE ar.is_filtered = 0 ORDER BY ar.playcount DESC LIMIT 3` then further UNION ALL blocks for 'Top Films' (watch_history JOIN movies, image = movie poster), 'Miles Run' (`SELECT 'Miles Run', CAST(ROUND(SUM(distance)/1609.34) AS TEXT) || ' miles', SUM(distance), NULL FROM strava_activities WHERE started_at LIKE '2024%'`), 'Places', etc. Each SELECT must project the SAME four columns in the same order; use column aliases only on the first SELECT. Section names are free-form — unknown sections render generically; single-row image-less sections read as a big stat.",
    'Cross-domain join keys: performers.lastfm_artist_id → lastfm_artists.id (concerts ↔ listening); collection_listening_xref links discogs_collection ↔ Last.fm play counts by matched name; trakt_collection.movie_id and watch_history.movie_id → movies.id (physical media ↔ watched films).',
    'Enums are stored as plain text. Notable ones: watch_history.source (plex|letterboxd|manual|trakt), trakt_collection.media_type (bluray|uhd_bluray|hddvd|dvd|digital), reading_items.status (unread|reading|finished), attended_events.category (sports|music|arts).',
    'Coding domain: wakatime_durations/wakatime_daily_summaries (editor time), rescuetime_activities/rescuetime_daily_summaries (screen time; productivity -2..+2), github_commits/github_pull_requests/github_issues/github_contribution_days (authored activity incl. private repos). Cross-source join: wakatime project names often equal github repo short names (m.repo LIKE "%/" || project).',
  ],
  tables: [
    // ─── Listening (Last.fm + Apple Music) ───────────────────────────
    {
      name: 'lastfm_artists',
      purpose:
        'One row per artist scrobbled by the user, with playcount and enrichment (bio, genre, similar artists, Apple Music links).',
      columns: [
        c('id', 'integer', 'PK'),
        c('name', 'text'),
        c('mbid', 'text', 'MusicBrainz id, nullable'),
        c('playcount', 'integer', 'lifetime scrobble count'),
        c('is_filtered', 'integer', '0/1; 1 = hidden from analytics'),
        c('genre', 'text', 'primary genre (top allowlisted tag)'),
        c('tags', 'text', 'JSON array of {name,count}'),
        c('bio_summary', 'text'),
        c(
          'similar_artists',
          'text',
          'JSON array of similar artists the user also plays'
        ),
        c('apple_music_url', 'text'),
        c('created_at', 'text'),
        c('updated_at', 'text'),
      ],
    },
    {
      name: 'lastfm_albums',
      purpose: 'Albums scrobbled by the user.',
      columns: [
        c('id', 'integer', 'PK'),
        c('name', 'text'),
        c('artist_id', 'integer', '→ lastfm_artists.id'),
        c('playcount', 'integer'),
        c('is_filtered', 'integer', '0/1'),
        c('released_year', 'integer', 'nullable, from Apple Music'),
        c('total_tracks', 'integer', 'nullable'),
        c('apple_music_url', 'text'),
      ],
      joins: ['artist_id → lastfm_artists.id'],
    },
    {
      name: 'lastfm_tracks',
      purpose:
        'Tracks scrobbled by the user (the grain that scrobbles reference).',
      columns: [
        c('id', 'integer', 'PK'),
        c('name', 'text'),
        c('artist_id', 'integer', '→ lastfm_artists.id'),
        c('album_id', 'integer', '→ lastfm_albums.id, nullable'),
        c('duration_ms', 'integer', 'nullable'),
        c('is_filtered', 'integer', '0/1'),
        c('apple_music_url', 'text'),
        c('preview_url', 'text'),
      ],
      joins: ['artist_id → lastfm_artists.id', 'album_id → lastfm_albums.id'],
    },
    {
      name: 'lastfm_scrobbles',
      purpose:
        'Individual play events — one row per listen. The base fact table for listening.',
      columns: [
        c('id', 'integer', 'PK'),
        c('track_id', 'integer', '→ lastfm_tracks.id'),
        c('scrobbled_at', 'text', 'ISO 8601 timestamp of the play'),
      ],
      joins: [
        'track_id → lastfm_tracks.id (then → lastfm_artists / lastfm_albums). Filter is_filtered via the track join.',
      ],
    },
    {
      name: 'lastfm_top_artists',
      purpose:
        'Precomputed top-artist rankings per Last.fm period (7day, 1month, 3month, 6month, 12month, overall).',
      columns: [
        c('id', 'integer', 'PK'),
        c('period', 'text', 'Last.fm period key'),
        c('rank', 'integer'),
        c('artist_id', 'integer', '→ lastfm_artists.id'),
        c('playcount', 'integer', 'plays within the period'),
      ],
      joins: ['artist_id → lastfm_artists.id'],
    },
    {
      name: 'lastfm_top_albums',
      purpose: 'Precomputed top-album rankings per period.',
      columns: [
        c('id', 'integer', 'PK'),
        c('period', 'text'),
        c('rank', 'integer'),
        c('album_id', 'integer', '→ lastfm_albums.id'),
        c('playcount', 'integer'),
      ],
      joins: ['album_id → lastfm_albums.id'],
    },
    {
      name: 'lastfm_top_tracks',
      purpose: 'Precomputed top-track rankings per period.',
      columns: [
        c('id', 'integer', 'PK'),
        c('period', 'text'),
        c('rank', 'integer'),
        c('track_id', 'integer', '→ lastfm_tracks.id'),
        c('playcount', 'integer'),
      ],
      joins: ['track_id → lastfm_tracks.id'],
    },
    {
      name: 'lastfm_filters',
      purpose:
        'User-defined filter rules that drive the is_filtered flags (which artists/tracks to hide).',
      columns: [
        c('id', 'integer', 'PK'),
        c('filter_type', 'text'),
        c('pattern', 'text'),
        c('scope', 'text', 'nullable'),
        c('reason', 'text', 'nullable'),
      ],
    },
    {
      name: 'lastfm_user_stats',
      purpose:
        'Single-row lifetime listening totals (scrobbles, unique artists/albums/tracks).',
      columns: [
        c('id', 'integer', 'PK'),
        c('total_scrobbles', 'integer'),
        c('unique_artists', 'integer'),
        c('unique_albums', 'integer'),
        c('unique_tracks', 'integer'),
        c('registered_date', 'text', 'nullable'),
        c('updated_at', 'text'),
      ],
    },
    {
      name: 'lastfm_monthly_stats',
      purpose: 'Precomputed per-month listening totals (is_filtered=0 scope).',
      columns: [
        c('id', 'integer', 'PK'),
        c('year_month', 'text', '"YYYY-MM"'),
        c('scrobbles', 'integer'),
        c('unique_artists', 'integer'),
        c('unique_albums', 'integer'),
      ],
    },
    {
      name: 'lastfm_yearly_stats',
      purpose:
        'Precomputed per-year listening totals plus top artist of the year.',
      columns: [
        c('id', 'integer', 'PK'),
        c('year', 'integer'),
        c('scrobbles', 'integer'),
        c('unique_artists', 'integer'),
        c('unique_albums', 'integer'),
        c('unique_tracks', 'integer'),
        c('top_artist_id', 'integer', '→ lastfm_artists.id, nullable'),
      ],
      joins: ['top_artist_id → lastfm_artists.id'],
    },
    {
      name: 'lastfm_album_attribution_audit',
      purpose:
        'Audit log for the one-time album-attribution repair migration. Rarely useful for user questions.',
      columns: [
        c('id', 'integer', 'PK'),
        c('original_album_id', 'integer'),
        c('original_album_name', 'text'),
        c(
          'action',
          'text',
          'KEEP_AS_VA | COLLAPSE_TO_PRIMARY | SPLIT_PER_ARTIST'
        ),
        c('tracks_moved', 'integer'),
        c('created_at', 'text'),
      ],
    },
    // ─── Running (Strava) ────────────────────────────────────────────
    {
      name: 'strava_activities',
      purpose:
        'One row per Strava activity (mostly runs). Base fact table for running. Filter is_deleted = 0.',
      columns: [
        c('id', 'integer', 'PK'),
        c('strava_id', 'integer', 'upstream Strava activity id'),
        c('name', 'text'),
        c('sport_type', 'text', 'e.g. Run, TrailRun, Walk'),
        c('distance_miles', 'real'),
        c('distance_meters', 'real'),
        c('moving_time_seconds', 'integer'),
        c('total_elevation_gain_feet', 'real'),
        c('start_date', 'text', 'ISO 8601, UTC'),
        c('start_date_local', 'text', 'ISO 8601, venue-local'),
        c('city', 'text', 'nullable'),
        c('state', 'text', 'nullable'),
        c('pace_min_per_mile', 'real', 'nullable'),
        c('pace_formatted', 'text', 'e.g. "8:32"'),
        c('average_heartrate', 'real', 'nullable'),
        c('calories', 'integer', 'nullable'),
        c('is_race', 'integer', '0/1'),
        c('is_deleted', 'integer', '0/1; filter = 0'),
        c('gear_id', 'text', '→ strava_gear.strava_gear_id, nullable'),
        c('strava_url', 'text'),
      ],
      joins: [
        'gear_id → strava_gear.strava_gear_id',
        'strava_id → strava_splits.activity_strava_id',
      ],
    },
    {
      name: 'strava_splits',
      purpose: 'Per-mile splits for an activity.',
      columns: [
        c('id', 'integer', 'PK'),
        c('activity_strava_id', 'integer', '→ strava_activities.strava_id'),
        c('split_number', 'integer'),
        c('distance_miles', 'real'),
        c('moving_time_seconds', 'integer'),
        c('pace_formatted', 'text'),
        c('average_heartrate', 'real', 'nullable'),
      ],
      joins: ['activity_strava_id → strava_activities.strava_id'],
    },
    {
      name: 'strava_gear',
      purpose: 'Shoes / gear with accumulated mileage.',
      columns: [
        c('id', 'integer', 'PK'),
        c(
          'strava_gear_id',
          'text',
          'upstream id, matches strava_activities.gear_id'
        ),
        c('name', 'text'),
        c('brand', 'text', 'nullable'),
        c('model', 'text', 'nullable'),
        c('distance_miles', 'real'),
        c('is_retired', 'integer', '0/1'),
      ],
    },
    {
      name: 'strava_personal_records',
      purpose: 'Best times per distance (e.g. fastest 5K).',
      columns: [
        c('id', 'integer', 'PK'),
        c('distance', 'text', 'machine key, e.g. "5k"'),
        c('distance_label', 'text', 'display label'),
        c('time_seconds', 'integer'),
        c('time_formatted', 'text'),
        c('pace_formatted', 'text'),
        c('date', 'text', 'YYYY-MM-DD'),
        c('activity_strava_id', 'integer', '→ strava_activities.strava_id'),
        c('activity_name', 'text'),
      ],
    },
    {
      name: 'strava_year_summaries',
      purpose: 'Precomputed per-year running totals.',
      columns: [
        c('id', 'integer', 'PK'),
        c('year', 'integer'),
        c('total_runs', 'integer'),
        c('total_distance_miles', 'real'),
        c('total_elevation_feet', 'real'),
        c('total_duration_seconds', 'integer'),
        c('avg_pace_formatted', 'text'),
        c('longest_run_miles', 'real'),
        c('race_count', 'integer'),
      ],
    },
    {
      name: 'strava_lifetime_stats',
      purpose:
        'Single-row lifetime running totals, streaks, and Eddington number.',
      columns: [
        c('id', 'integer', 'PK'),
        c('total_runs', 'integer'),
        c('total_distance_miles', 'real'),
        c('total_elevation_feet', 'real'),
        c('total_duration_seconds', 'integer'),
        c('avg_pace_formatted', 'text'),
        c('years_active', 'integer'),
        c('first_run', 'text', 'ISO 8601, nullable'),
        c('eddington_number', 'integer'),
        c('current_streak_days', 'integer'),
        c('longest_streak_days', 'integer'),
      ],
    },
    // ─── Watching (Plex + Letterboxd + Trakt) ────────────────────────
    {
      name: 'movies',
      purpose:
        'One row per unique film. watch_history references this; a movie can be watched many times.',
      columns: [
        c('id', 'integer', 'PK'),
        c('title', 'text'),
        c('year', 'integer', 'nullable'),
        c('tmdb_id', 'integer', 'nullable, unique'),
        c('imdb_id', 'text', 'nullable, unique'),
        c('runtime', 'integer', 'minutes, nullable'),
        c('tmdb_rating', 'real', '0-10, nullable'),
        c('summary', 'text', 'nullable'),
        c('content_rating', 'text', 'nullable'),
        c('poster_path', 'text', 'TMDB path, nullable'),
      ],
      joins: [
        'id ← watch_history.movie_id',
        'id ← movie_genres.movie_id ← genres',
        'id ← movie_directors.movie_id ← directors',
        'id ← trakt_collection.movie_id',
      ],
    },
    {
      name: 'genres',
      purpose: 'Movie genre lookup (shared name → id).',
      columns: [c('id', 'integer', 'PK'), c('name', 'text', 'unique')],
      joins: ['id ← movie_genres.genre_id'],
    },
    {
      name: 'movie_genres',
      purpose: 'Many-to-many join between movies and genres.',
      columns: [
        c('movie_id', 'integer', '→ movies.id'),
        c('genre_id', 'integer', '→ genres.id'),
      ],
      joins: ['movie_id → movies.id', 'genre_id → genres.id'],
    },
    {
      name: 'directors',
      purpose: 'Director lookup (shared name → id).',
      columns: [c('id', 'integer', 'PK'), c('name', 'text', 'unique')],
      joins: ['id ← movie_directors.director_id'],
    },
    {
      name: 'movie_directors',
      purpose: 'Many-to-many join between movies and directors.',
      columns: [
        c('movie_id', 'integer', '→ movies.id'),
        c('director_id', 'integer', '→ directors.id'),
      ],
      joins: ['movie_id → movies.id', 'director_id → directors.id'],
    },
    {
      name: 'watch_history',
      purpose:
        'One row per movie viewing event (rewatches produce multiple rows). Base fact table for watching films.',
      columns: [
        c('id', 'integer', 'PK'),
        c('movie_id', 'integer', '→ movies.id'),
        c('watched_at', 'text', 'ISO 8601'),
        c('source', 'text', 'plex | letterboxd | manual | trakt'),
        c('user_rating', 'real', '0-10, nullable'),
        c('rewatch', 'integer', '0/1'),
        c('review', 'text', 'nullable'),
        c('review_url', 'text', 'nullable Letterboxd review link'),
        c('percent_complete', 'real', 'nullable'),
      ],
      joins: ['movie_id → movies.id'],
    },
    {
      name: 'watch_stats',
      purpose:
        'Single-row denormalized watching totals (movies, shows, episodes, watch time).',
      columns: [
        c('id', 'integer', 'PK'),
        c('total_movies', 'integer'),
        c('total_watch_time_s', 'integer'),
        c('movies_this_year', 'integer'),
        c('total_shows', 'integer'),
        c('total_episodes_watched', 'integer'),
        c('episodes_this_year', 'integer'),
      ],
    },
    {
      name: 'shows',
      purpose: 'One row per TV show. episodes_watched references this.',
      columns: [
        c('id', 'integer', 'PK'),
        c('title', 'text'),
        c('year', 'integer', 'nullable'),
        c('tmdb_id', 'integer', 'nullable'),
        c('trakt_id', 'integer', 'nullable'),
        c('tmdb_rating', 'real', '0-10, nullable'),
        c('total_seasons', 'integer', 'nullable'),
        c('total_episodes', 'integer', 'nullable'),
        c('poster_path', 'text', 'nullable'),
      ],
      joins: ['id ← episodes_watched.show_id'],
    },
    {
      name: 'episodes_watched',
      purpose: 'One row per episode viewing event.',
      columns: [
        c('id', 'integer', 'PK'),
        c('show_id', 'integer', '→ shows.id'),
        c('season_number', 'integer'),
        c('episode_number', 'integer'),
        c('title', 'text', 'nullable'),
        c('watched_at', 'text', 'ISO 8601'),
        c('source', 'text', 'plex | trakt'),
      ],
      joins: ['show_id → shows.id'],
    },
    // ─── Collecting (Discogs + Trakt physical media) ─────────────────
    {
      name: 'discogs_releases',
      purpose:
        'Catalog metadata for a Discogs release (album pressing). discogs_collection references these.',
      columns: [
        c('id', 'integer', 'PK'),
        c('discogs_id', 'integer', 'upstream release id'),
        c('title', 'text'),
        c('year', 'integer', 'nullable'),
        c('genres', 'text', 'JSON array'),
        c('styles', 'text', 'JSON array'),
        c('formats', 'text', 'JSON array (e.g. Vinyl, CD)'),
        c('labels', 'text', 'JSON array of {name,catno}'),
        c('country', 'text', 'nullable'),
        c('cover_url', 'text', 'nullable'),
        c('lowest_price', 'real', 'nullable, market price'),
      ],
      joins: [
        'id ← discogs_collection.release_id',
        'id ← discogs_release_artists.release_id ← discogs_artists',
      ],
    },
    {
      name: 'discogs_artists',
      purpose: 'Artist metadata for releases in the collection.',
      columns: [
        c('id', 'integer', 'PK'),
        c('discogs_id', 'integer'),
        c('name', 'text'),
        c('profile_url', 'text', 'nullable'),
        c('image_url', 'text', 'nullable'),
      ],
      joins: ['id ← discogs_release_artists.artist_id'],
    },
    {
      name: 'discogs_collection',
      purpose:
        'The owned records — one row per physical copy in the collection. Base fact table for the vinyl/CD collection.',
      columns: [
        c('id', 'integer', 'PK'),
        c('release_id', 'integer', '→ discogs_releases.id'),
        c('instance_id', 'integer', 'unique per-copy id'),
        c('folder_id', 'integer'),
        c('rating', 'integer', '0-5, 0 = unrated'),
        c('notes', 'text', 'nullable'),
        c('date_added', 'text', 'ISO 8601'),
      ],
      joins: [
        'release_id → discogs_releases.id',
        'id ← collection_listening_xref.collection_id',
      ],
    },
    {
      name: 'discogs_release_artists',
      purpose: 'Many-to-many join between releases and artists.',
      columns: [
        c('id', 'integer', 'PK'),
        c('release_id', 'integer', '→ discogs_releases.id'),
        c('artist_id', 'integer', '→ discogs_artists.id'),
      ],
      joins: [
        'release_id → discogs_releases.id',
        'artist_id → discogs_artists.id',
      ],
    },
    {
      name: 'discogs_wantlist',
      purpose: 'Records the user wants but does not own yet.',
      columns: [
        c('id', 'integer', 'PK'),
        c('discogs_id', 'integer'),
        c('title', 'text'),
        c('artists', 'text', 'JSON array of names'),
        c('year', 'integer', 'nullable'),
        c('formats', 'text', 'JSON array'),
        c('genres', 'text', 'JSON array'),
        c('rating', 'integer', '0-5'),
        c('date_added', 'text', 'ISO 8601'),
      ],
    },
    {
      name: 'discogs_collection_stats',
      purpose:
        'Single-row denormalized collection summary (counts, top genre, estimated value, breakdowns).',
      columns: [
        c('id', 'integer', 'PK'),
        c('total_items', 'integer'),
        c('by_format', 'text', 'JSON {vinyl,cd,cassette,other}'),
        c('wantlist_count', 'integer'),
        c('unique_artists', 'integer'),
        c('estimated_value', 'real', 'nullable'),
        c('top_genre', 'text', 'nullable'),
        c('added_this_year', 'integer'),
        c('by_genre', 'text', 'JSON {genre:count}'),
        c('by_decade', 'text', 'JSON {decade:count}'),
      ],
    },
    {
      name: 'collection_listening_xref',
      purpose:
        'Cross-references owned records (discogs_collection) with Last.fm play counts by matched name — how often the owner streams what they own.',
      columns: [
        c('id', 'integer', 'PK'),
        c('collection_id', 'integer', '→ discogs_collection.id'),
        c('release_id', 'integer', '→ discogs_releases.id'),
        c('lastfm_album_name', 'text', 'nullable matched name'),
        c('lastfm_artist_name', 'text', 'nullable'),
        c('play_count', 'integer'),
        c('last_played', 'text', 'ISO 8601, nullable'),
        c('match_type', 'text', 'exact | fuzzy | artist_only | none'),
        c('match_confidence', 'real'),
      ],
      joins: [
        'collection_id → discogs_collection.id',
        'release_id → discogs_releases.id',
      ],
    },
    {
      name: 'trakt_collection',
      purpose:
        'Physical/digital movie media owned (Blu-ray, 4K UHD, DVD, digital) with A/V specs. Joins to movies.',
      columns: [
        c('id', 'integer', 'PK'),
        c('movie_id', 'integer', '→ movies.id'),
        c('trakt_id', 'integer'),
        c('media_type', 'text', 'bluray | uhd_bluray | hddvd | dvd | digital'),
        c(
          'resolution',
          'text',
          'uhd_4k | hd_1080p | hd_720p | sd_480p, nullable'
        ),
        c('hdr', 'text', 'dolby_vision | hdr10 | hdr10_plus | hlg, nullable'),
        c('audio', 'text', 'e.g. dolby_atmos, dts_x, nullable'),
        c('audio_channels', 'text', '7_1 | 5_1 | 2_0, nullable'),
        c('collected_at', 'text', 'ISO 8601'),
      ],
      joins: ['movie_id → movies.id'],
    },
    {
      name: 'trakt_collection_stats',
      purpose:
        'Single-row summary of the physical media collection (counts by format/resolution/HDR).',
      columns: [
        c('id', 'integer', 'PK'),
        c('total_items', 'integer'),
        c('by_format', 'text', 'JSON'),
        c('by_resolution', 'text', 'JSON'),
        c('by_hdr', 'text', 'JSON'),
        c('by_genre', 'text', 'JSON'),
        c('by_decade', 'text', 'JSON'),
        c('added_this_year', 'integer'),
      ],
    },
    // ─── Reading (Instapaper) ────────────────────────────────────────
    {
      name: 'reading_items',
      purpose:
        'One row per saved article (or future book). Base fact table for reading.',
      columns: [
        c('id', 'integer', 'PK'),
        c('item_type', 'text', 'article (default)'),
        c('source', 'text', 'instapaper'),
        c('source_id', 'text', 'upstream bookmark id'),
        c('url', 'text', 'nullable original article URL'),
        c('title', 'text'),
        c('author', 'text', 'nullable'),
        c('domain', 'text', 'nullable, e.g. theatlantic.com'),
        c('site_name', 'text', 'nullable'),
        c('word_count', 'integer', 'nullable'),
        c('estimated_read_min', 'integer', 'nullable'),
        c('status', 'text', 'unread | reading | finished'),
        c('progress', 'real', '0.0-1.0'),
        c('starred', 'integer', '0/1'),
        c('rating', 'integer', 'small int, nullable'),
        c('tags', 'text', 'JSON array'),
        c(
          'enrichment_status',
          'text',
          'pending | ok | no_body (no_body = body unavailable)'
        ),
        c('saved_at', 'text', 'ISO 8601'),
        c('started_at', 'text', 'ISO 8601, nullable'),
        c('finished_at', 'text', 'ISO 8601, nullable'),
      ],
      joins: ['id ← reading_highlights.item_id'],
    },
    {
      name: 'reading_highlights',
      purpose: 'Highlights/annotations the user saved within an article.',
      columns: [
        c('id', 'integer', 'PK'),
        c('item_id', 'integer', '→ reading_items.id'),
        c('text', 'text', 'the highlighted passage'),
        c('note', 'text', 'nullable user note'),
        c('position', 'integer', 'order within the article'),
        c('chapter', 'text', 'nullable'),
        c('page', 'integer', 'nullable'),
        c('created_at', 'text', 'ISO 8601'),
      ],
      joins: ['item_id → reading_items.id'],
    },
    // ─── Places (Foursquare/Swarm) ───────────────────────────────────
    {
      name: 'checkins',
      purpose:
        'One row per Foursquare/Swarm check-in. Base fact table for places.',
      columns: [
        c('id', 'integer', 'PK'),
        c('foursquare_id', 'text', 'upstream id'),
        c('venue_id', 'text', 'nullable'),
        c('venue_name', 'text'),
        c('venue_category', 'text', 'nullable'),
        c(
          'venue_icon',
          'text',
          'nullable, already a full image URL — SELECT as-is to render'
        ),
        c('venue_city', 'text', 'nullable'),
        c('venue_state', 'text', 'nullable'),
        c('venue_country', 'text', 'nullable'),
        c('lat', 'real', 'nullable'),
        c('lng', 'real', 'nullable'),
        c('checked_in_at', 'text', 'ISO 8601'),
        c('shout', 'text', 'nullable note posted with the check-in'),
      ],
    },
    // ─── Coding (WakaTime + RescueTime + GitHub) ─────────────────────
    {
      name: 'wakatime_durations',
      purpose:
        'One row per contiguous stretch of coding activity in one file (WakaTime Durations API), sliced by entity.',
      columns: [
        c('id', 'integer', 'PK'),
        c('start_time', 'text', 'ISO 8601'),
        c('duration_seconds', 'real', 'length of the slice in seconds'),
        c('project', 'text', 'nullable'),
        c('language', 'text', 'nullable'),
        c('entity', 'text', 'file path when sliced by entity, nullable'),
      ],
    },
    {
      name: 'wakatime_daily_summaries',
      purpose:
        'Materialized per-day coding-time rollup; rebuilt each sync from wakatime_durations. One row per (user, date).',
      columns: [
        c('id', 'integer', 'PK'),
        c('date', 'text', 'YYYY-MM-DD'),
        c('total_seconds', 'real', "that day's total coding time in seconds"),
        c('top_language', 'text', 'nullable'),
        c('top_project', 'text', 'nullable'),
      ],
    },
    {
      name: 'wakatime_daily_languages',
      purpose:
        'Materialized per-day, per-language coding time; rebuilt each sync from the WakaTime Summaries API (duration rows are entity-sliced and carry no language). One row per (user, date, language).',
      columns: [
        c('id', 'integer', 'PK'),
        c('date', 'text', 'YYYY-MM-DD'),
        c('language', 'text', 'e.g. "TypeScript"'),
        c(
          'total_seconds',
          'real',
          "that day's time in the language in seconds"
        ),
      ],
    },
    {
      name: 'rescuetime_activities',
      purpose:
        'One row per (timestamp, activity) 5-minute screen-time bucket from the RescueTime Analytic Data API.',
      columns: [
        c('id', 'integer', 'PK'),
        c(
          'timestamp',
          'text',
          'ISO 8601 (RescueTime-local time stored as ISO)'
        ),
        c('duration_seconds', 'integer'),
        c('activity', 'text', 'app or site name, e.g. "VS Code", "github.com"'),
        c('category', 'text', 'nullable'),
        c(
          'productivity',
          'integer',
          '-2 (very distracting) .. +2 (very productive)'
        ),
      ],
    },
    {
      name: 'rescuetime_daily_summaries',
      purpose:
        'Materialized per-day screen-time rollup; rebuilt each sync from rescuetime_activities. One row per (user, date).',
      columns: [
        c('id', 'integer', 'PK'),
        c('date', 'text', 'YYYY-MM-DD'),
        c(
          'total_seconds',
          'integer',
          "that day's total tracked time in seconds"
        ),
        c(
          'productivity_pulse',
          'integer',
          '0-100 RescueTime pulse; null for days outside the recent API feed window'
        ),
        c('very_productive_seconds', 'integer'),
        c('productive_seconds', 'integer'),
        c('neutral_seconds', 'integer'),
        c('distracting_seconds', 'integer'),
        c('very_distracting_seconds', 'integer'),
      ],
    },
    {
      name: 'github_contribution_days',
      purpose:
        'GitHub contribution calendar; one row per day, includes private contributions. Upserted on (user, date).',
      columns: [
        c('id', 'integer', 'PK'),
        c('date', 'text', 'YYYY-MM-DD'),
        c('contribution_count', 'integer'),
      ],
    },
    {
      name: 'github_commits',
      purpose:
        'One row per commit authored by the user, from the authenticated events feed.',
      columns: [
        c('id', 'integer', 'PK'),
        c('sha', 'text'),
        c('repo', 'text', 'owner/name'),
        c('message', 'text'),
        c('additions', 'integer', 'null when detail fetch was skipped'),
        c('deletions', 'integer', 'null when detail fetch was skipped'),
        c('committed_at', 'text', 'ISO 8601'),
        c('is_private', 'integer', '0/1'),
        c('url', 'text'),
      ],
    },
    {
      name: 'github_pull_requests',
      purpose:
        'One row per PR authored by the user, from the Search API (full history).',
      columns: [
        c('id', 'integer', 'PK'),
        c('repo', 'text', 'owner/name'),
        c('number', 'integer'),
        c('title', 'text'),
        c('state', 'text', 'open | closed | merged'),
        c('created_at_github', 'text', 'ISO 8601'),
        c('merged_at', 'text', 'ISO 8601, nullable'),
        c('closed_at', 'text', 'ISO 8601, nullable'),
        c('is_private', 'integer', '0/1'),
        c('url', 'text'),
      ],
    },
    {
      name: 'github_issues',
      purpose:
        'One row per issue authored by the user, from the Search API (full history).',
      columns: [
        c('id', 'integer', 'PK'),
        c('repo', 'text', 'owner/name'),
        c('number', 'integer'),
        c('title', 'text'),
        c('state', 'text', 'open | closed'),
        c('created_at_github', 'text', 'ISO 8601'),
        c('closed_at', 'text', 'ISO 8601, nullable'),
        c('is_private', 'integer', '0/1'),
        c('url', 'text'),
      ],
    },
    // ─── Geo reference ───────────────────────────────────────────────
    {
      name: 'geo_cities',
      purpose:
        'Offline reverse-geocoding reference (GeoNames cities >= 15k population). Static lookup data, not user activity.',
      columns: [
        c('id', 'integer', 'PK (GeoNames geonameid)'),
        c('name', 'text'),
        c('admin1', 'text', 'state/region, nullable'),
        c('country_code', 'text', 'ISO 3166-1 alpha-2'),
        c('lat', 'real'),
        c('lng', 'real'),
      ],
    },
    // ─── Attending (Google Calendar + Gmail) ─────────────────────────
    {
      name: 'attended_events',
      purpose:
        'One row per live event the user has tickets for (sports/music/arts). Base fact table for attending. Type-specific data lives in event_data JSON.',
      columns: [
        c('id', 'integer', 'PK'),
        c('category', 'text', 'sports | music | arts'),
        c('event_type', 'text', 'e.g. mlb_game, concert, theater'),
        c('event_date', 'text', 'YYYY-MM-DD (venue-local)'),
        c('event_datetime', 'text', 'ISO 8601, nullable'),
        c('venue_id', 'integer', '→ venues.id, nullable'),
        c('title', 'text'),
        c('subtitle', 'text', 'nullable'),
        c(
          'event_data',
          'text',
          'JSON, type-specific (teams, scores, tour, etc.)'
        ),
        c('attended', 'integer', '0/1 (0 = ticket bought, skipped)'),
        c('notes', 'text', 'nullable'),
      ],
      joins: [
        'venue_id → venues.id',
        'id ← attended_event_performers.event_id ← performers',
        'id ← attended_event_players.event_id ← players',
        'id ← attended_event_tickets.event_id',
      ],
    },
    {
      name: 'venues',
      purpose:
        'Normalized venues where events happen (stadiums, arenas, theaters).',
      columns: [
        c('id', 'integer', 'PK'),
        c('name', 'text'),
        c('aliases', 'text', 'JSON array of historical names'),
        c('city', 'text', 'nullable'),
        c('state', 'text', 'nullable'),
        c('country', 'text', 'nullable'),
        c('latitude', 'real', 'nullable'),
        c('longitude', 'real', 'nullable'),
        c('capacity', 'integer', 'nullable'),
      ],
      joins: ['id ← attended_events.venue_id'],
    },
    {
      name: 'teams',
      purpose:
        'Shared sports-team reference data (no user_id). Join via (league, league_team_id), not teams.id — attended_events.event_data stores the league-native team id.',
      columns: [
        c('id', 'integer', 'PK'),
        c('league', 'text', 'mlb | nfl | nba | mls | ...'),
        c('league_team_id', 'integer', 'league-native id (join key)'),
        c('abbreviation', 'text'),
        c('location', 'text', 'nullable'),
        c('name', 'text'),
        c('full_name', 'text', 'nullable'),
        c('primary_color', 'text', 'nullable hex'),
        c('logo_url', 'text', 'nullable'),
        c('conference', 'text', 'nullable'),
        c('division', 'text', 'nullable'),
        c('home_venue_id', 'integer', '→ venues.id, nullable'),
      ],
      joins: [
        'home_venue_id → venues.id',
        '(league, league_team_id) ↔ players.primary_team_id / attended_events.event_data team ids',
      ],
    },
    {
      name: 'performers',
      purpose:
        'Musical artists, comedians, theater companies, speakers. lastfm_artist_id bridges concerts to listening.',
      columns: [
        c('id', 'integer', 'PK'),
        c('name', 'text'),
        c(
          'performer_type',
          'text',
          'musical_artist | comedian | theater_company | speaker | other'
        ),
        c('mbid', 'text', 'nullable'),
        c(
          'lastfm_artist_id',
          'integer',
          '→ lastfm_artists.id, nullable (cross-domain link)'
        ),
      ],
      joins: [
        'lastfm_artist_id → lastfm_artists.id',
        'id ← attended_event_performers.performer_id',
      ],
    },
    {
      name: 'attended_event_performers',
      purpose:
        'Many-to-many join between events and performers with role/billing.',
      columns: [
        c('event_id', 'integer', '→ attended_events.id'),
        c('performer_id', 'integer', '→ performers.id'),
        c('role', 'text', 'headliner | opener | support | guest | mc'),
        c('billing_order', 'integer'),
      ],
      joins: ['event_id → attended_events.id', 'performer_id → performers.id'],
    },
    {
      name: 'attended_event_tickets',
      purpose: 'One row per ticket order for an event (vendor, seat, price).',
      columns: [
        c('id', 'integer', 'PK'),
        c('event_id', 'integer', '→ attended_events.id'),
        c('vendor', 'text', 'ticketmaster | seatgeek | axs | box_office | ...'),
        c('order_id', 'text', 'nullable'),
        c('section', 'text', 'nullable'),
        c('row', 'text', 'nullable'),
        c('seat', 'text', 'nullable'),
        c('quantity', 'integer'),
        c('total_price_cents', 'integer', 'nullable'),
        c('currency', 'text', 'default USD'),
        c('purchased_at', 'text', 'ISO 8601, nullable'),
      ],
      joins: ['event_id → attended_events.id'],
    },
    {
      name: 'attended_event_sources',
      purpose:
        'Provenance/debug trail for how each event was discovered (calendar, email, API). Mostly internal.',
      columns: [
        c('id', 'integer', 'PK'),
        c('event_id', 'integer', '→ attended_events.id, nullable'),
        c(
          'source_type',
          'text',
          'gcal | gmail | manual | mlb_stats_api | espn | setlist_fm'
        ),
        c('source_ref', 'text'),
        c('match_confidence', 'real', 'nullable'),
      ],
      joins: ['event_id → attended_events.id'],
    },
    {
      name: 'players',
      purpose:
        'Athletes seen at attended sports events, with bios and cross-source ids (MLB Stats, ESPN).',
      columns: [
        c('id', 'integer', 'PK'),
        c('league', 'text', 'mlb | nfl | nba | ...'),
        c('mlb_stats_id', 'integer', 'nullable'),
        c('espn_id', 'text', 'nullable'),
        c('full_name', 'text'),
        c('primary_position', 'text', 'nullable'),
        c('primary_number', 'text', 'jersey, kept as string, nullable'),
        c('birth_date', 'text', 'YYYY-MM-DD, nullable'),
        c('primary_team_id', 'integer', 'league-native team id, nullable'),
        c('debut_date', 'text', 'nullable'),
        c('awards', 'text', 'JSON array of {season,name,id}'),
      ],
      joins: [
        'id ← attended_event_players.player_id',
        'primary_team_id ↔ teams.league_team_id',
      ],
    },
    {
      name: 'attended_event_players',
      purpose:
        'Per-game appearance line for a player at an attended event (batting/pitching/fielding stats as JSON).',
      columns: [
        c('id', 'integer', 'PK'),
        c('event_id', 'integer', '→ attended_events.id'),
        c('player_id', 'integer', '→ players.id'),
        c('team_id', 'integer', 'league-native team id, nullable'),
        c('is_home', 'integer', '0/1'),
        c('batting_line', 'text', 'JSON AB/R/H/RBI/... nullable'),
        c('pitching_line', 'text', 'JSON IP/H/R/ER/... nullable'),
        c(
          'decision',
          'text',
          'W | L | SV | HLD | BS, nullable (pitcher of record)'
        ),
        c('notable', 'integer', '0/1 standout performance flag'),
      ],
      joins: ['event_id → attended_events.id', 'player_id → players.id'],
    },
    // ─── System (safe subset) ────────────────────────────────────────
    {
      name: 'activity_feed',
      purpose:
        'Denormalized cross-domain feed — one row per notable event across all domains, for the unified timeline.',
      columns: [
        c('id', 'integer', 'PK'),
        c(
          'domain',
          'text',
          'listening | running | watching | collecting | reading | attending | places'
        ),
        c('event_type', 'text'),
        c('occurred_at', 'text', 'ISO 8601'),
        c('title', 'text'),
        c('subtitle', 'text', 'nullable'),
        c(
          'image_key',
          'text',
          'legacy, always NULL -- join `images` for artwork'
        ),
        c('source_id', 'text', 'id of the underlying domain row'),
        c('metadata', 'text', 'JSON, nullable'),
      ],
    },
    {
      name: 'images',
      purpose:
        'Shared image store keyed by (domain, entity_type, entity_id). Compose the CDN URL from r2_key + image_version (see global notes).',
      columns: [
        c('id', 'integer', 'PK'),
        c('domain', 'text'),
        c('entity_type', 'text', 'e.g. artist, movie, articles'),
        c('entity_id', 'text', 'the domain row id as a string'),
        c('r2_key', 'text', 'object key in R2 (path component of the CDN URL)'),
        c('source', 'text', 'origin of the image'),
        c('width', 'integer', 'nullable'),
        c('height', 'integer', 'nullable'),
        c('thumbhash', 'text', 'nullable placeholder blob'),
        c('dominant_color', 'text', 'nullable hex'),
        c('accent_color', 'text', 'nullable hex'),
        c('is_override', 'integer', '0/1'),
        c('image_version', 'integer', 'cache-busting version, append as ?v='),
      ],
    },
    {
      name: 'sync_runs',
      purpose:
        'History of background sync jobs per domain — useful for "when did data last update".',
      columns: [
        c('id', 'integer', 'PK'),
        c('domain', 'text'),
        c('sync_type', 'text'),
        c('status', 'text', 'running | completed | failed'),
        c('started_at', 'text', 'ISO 8601'),
        c('completed_at', 'text', 'ISO 8601, nullable'),
        c('items_synced', 'integer', 'nullable'),
        c('error', 'text', 'nullable'),
        c('retry_count', 'integer'),
      ],
    },
  ],
};

/** The physical table names documented in SCHEMA_DOC. */
export function schemaDocTableNames(): string[] {
  return SCHEMA_DOC.tables.map((t) => t.name);
}

/**
 * The allow-list of table names the read-only query endpoint may target.
 *
 * SCHEMA_DOC is the single, curated source of truth for what is safe to read:
 * every table documented here is intentionally exposed, and secret/system
 * tables (api_keys, *_tokens, revalidation_hooks, webhook_events, sqlite_*)
 * are deliberately absent. The SQL guard derives its FROM/JOIN allow-list from
 * this set, so adding a table to the query surface means documenting it here —
 * there is no separate list to keep in sync. Names are lower-cased so the
 * guard can match case-insensitively.
 */
export function allowedTableNames(): Set<string> {
  return new Set(SCHEMA_DOC.tables.map((t) => t.name.toLowerCase()));
}
