/**
 * Which integration does a query result come from?
 *
 * Every domain table in Rewind was filled by exactly one upstream service, so
 * the tables a SELECT reads identify the source without the caller having to
 * project a `source` column. `/v1/query` resolves this once per request and
 * returns the key, which the MCP renderer turns into that service's colour.
 *
 * The key is deliberately SEMANTIC, not presentational — no hex lives here.
 * Colours are a rendering concern and belong with the views (see the MCP
 * server's `web/lib/brand-colors.ts`), so a palette change never touches the
 * API and a new table never needs a design review.
 *
 * Resolution is all-or-nothing: a query that joins two integrations (watches
 * against check-ins, say) resolves to `null` rather than picking a winner. A
 * chart tinted with one source's colour while showing another's data would be
 * worse than an untinted one.
 */

/** Every integration the renderer knows how to tint. */
export type IntegrationKey =
  | 'lastfm'
  | 'applemusic'
  | 'strava'
  | 'plex'
  | 'letterboxd'
  | 'trakt'
  | 'tmdb'
  | 'discogs'
  | 'instapaper'
  | 'foursquare'
  | 'github'
  | 'wakatime'
  | 'rescuetime';

/**
 * Table → the service that populates it. Tables absent from this map are
 * shared or cross-domain (`images`, `activity_feed`, `sync_runs`, the
 * attending tables) and are deliberately NEUTRAL: they carry no single
 * integration, and reading one alongside a domain table must not change the
 * answer. `resolveIntegration` therefore ignores unmapped tables entirely —
 * that is what lets `movies JOIN images` still resolve to its watch source.
 */
const TABLE_INTEGRATIONS: Record<string, IntegrationKey> = {
  // Listening
  lastfm_artists: 'lastfm',
  lastfm_albums: 'lastfm',
  lastfm_tracks: 'lastfm',
  lastfm_scrobbles: 'lastfm',
  apple_music_plays: 'applemusic',
  // Running
  strava_activities: 'strava',
  strava_splits: 'strava',
  // Watching is deliberately absent. `movies`/`shows` are TMDB-enriched
  // CATALOGUES rather than a record of the user's activity, and the viewing
  // events (watch_history, episodes_watched) carry a per-row `source` column
  // naming the app that logged them. Tinting a watch chart teal for TMDB would
  // credit the metadata provider instead of Trakt/Plex/Letterboxd, so watching
  // resolves neutral here and the renderer tints it from `source` when every
  // row agrees.
  // Collecting
  discogs_collection: 'discogs',
  discogs_wantlist: 'discogs',
  trakt_collection: 'trakt',
  // Reading
  reading_items: 'instapaper',
  reading_highlights: 'instapaper',
  // Places
  checkins: 'foursquare',
  // Coding
  github_commits: 'github',
  github_pull_requests: 'github',
  github_issues: 'github',
  github_contribution_days: 'github',
  wakatime_durations: 'wakatime',
  wakatime_daily_summaries: 'wakatime',
  rescuetime_activities: 'rescuetime',
  rescuetime_daily_summaries: 'rescuetime',
};

/**
 * The integration a set of query tables belongs to, or null when the answer
 * isn't singular: no mapped table (a purely cross-domain query), or more than
 * one (a join across services).
 */
export function resolveIntegration(tables: string[]): IntegrationKey | null {
  const found = new Set<IntegrationKey>();
  for (const table of tables) {
    const key = TABLE_INTEGRATIONS[table.toLowerCase()];
    if (key) found.add(key);
  }
  return found.size === 1 ? [...found][0]! : null;
}
