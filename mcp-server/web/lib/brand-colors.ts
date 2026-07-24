/**
 * Per-integration colour for the query-result views.
 *
 * TWO colours per service, because they do different jobs and are held to
 * different standards:
 *
 *   `brand` — the service's real colour, used ONLY for a chip: a small dot
 *     beside its name. One at a time, always next to a text label, so nothing
 *     depends on telling two of them apart.
 *
 *   `series` — the colour a CHART is drawn in, taken from the documented
 *     categorical palette rather than from the brand. Real brand colours cannot
 *     do this job: Strava orange (#fc4c02) and Apple Music pink (#fc3c44) sit
 *     ΔE 5.0 apart in OKLab for NORMAL vision (the floor is 15) and collapse to
 *     ΔE 3.3 under deuteranopia, and Swarm orange, Last.fm red and Plex gold
 *     pile into the same warm band. Each `series` value is the palette step
 *     nearest the brand hue, so the association survives while the mark stays
 *     legible.
 *
 * A chart therefore only ever wears ONE series colour — it is tinted when the
 * whole result belongs to one integration, and left on the neutral accent when
 * it spans several. That is what keeps this safe: with a single series there is
 * no adjacent pair to confuse, and identity is carried by the header chip, not
 * by the colour alone.
 *
 * Slots below `3:1` against the light surface (yellow 2.11, magenta 2.62, aqua
 * 2.74) are used deliberately: the contrast rule allows relief where the values
 * are readable another way, and every one of these views ships axis labels plus
 * a Table tab that is always one click away. Dark mode uses the palette's own
 * dark steps, which clear 3:1 outright — it is a selected set, not a flip.
 */

/** Keys match `integration` from /v1/query and the `source` column values. */
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

export type IntegrationStyle = {
  /** Display name for the chip. */
  label: string;
  /** The service's own colour — chips only. */
  brand: string;
  /** Categorical-palette step for marks, light mode. */
  series: string;
  /** Categorical-palette step for marks, dark mode. */
  seriesDark: string;
};

/**
 * Brand values: Strava, Swarm, Apple Music, Last.fm and Trakt are lifted from
 * the Nostaliga app's `BrandColors` so both surfaces tint the same service the
 * same way. Plex, Letterboxd, TMDB, GitHub and Instapaper are the services'
 * published brand colours. Discogs, WakaTime and RescueTime publish no colour
 * this author could confirm, so they take a hue that fits their neighbours --
 * flagged here rather than presented as official.
 */
export const INTEGRATIONS: Record<IntegrationKey, IntegrationStyle> = {
  // Listening — Last.fm red, Apple Music pink-red; both land on palette red.
  lastfm: {
    label: 'Last.fm',
    brand: '#d31010',
    series: '#e34948',
    seriesDark: '#e66767',
  },
  applemusic: {
    label: 'Apple Music',
    brand: '#fc3c44',
    series: '#e34948',
    seriesDark: '#e66767',
  },
  // Running
  strava: {
    label: 'Strava',
    brand: '#fc4c02',
    series: '#eb6834',
    seriesDark: '#d95926',
  },
  // Watching
  plex: {
    label: 'Plex',
    brand: '#e5a00d',
    series: '#eda100',
    seriesDark: '#c98500',
  },
  letterboxd: {
    label: 'Letterboxd',
    brand: '#00e054',
    series: '#008300',
    seriesDark: '#008300',
  },
  trakt: {
    label: 'Trakt',
    brand: '#9f42c6',
    series: '#4a3aa7',
    seriesDark: '#9085e9',
  },
  tmdb: {
    label: 'TMDB',
    brand: '#01b4e4',
    series: '#1baf7a',
    seriesDark: '#199e70',
  },
  // Collecting — Discogs publishes no brand colour; violet keeps it distinct
  // from Trakt's slot within the same domain.
  discogs: {
    label: 'Discogs',
    brand: '#7b5ea7',
    series: '#4a3aa7',
    seriesDark: '#9085e9',
  },
  // Reading — Instapaper's brand is black, which cannot be a mark; its chip
  // takes near-black and its charts take palette blue.
  instapaper: {
    label: 'Instapaper',
    brand: '#1f1f1f',
    series: '#2a78d6',
    seriesDark: '#3987e5',
  },
  // Places
  foursquare: {
    label: 'Swarm',
    brand: '#f97316',
    series: '#e87ba4',
    seriesDark: '#d55181',
  },
  // Coding — GitHub's brand is black, same treatment as Instapaper. WakaTime
  // and RescueTime colours are chosen, not official.
  github: {
    label: 'GitHub',
    brand: '#181717',
    series: '#4a3aa7',
    seriesDark: '#9085e9',
  },
  wakatime: {
    label: 'WakaTime',
    brand: '#1baf7a',
    series: '#1baf7a',
    seriesDark: '#199e70',
  },
  rescuetime: {
    label: 'RescueTime',
    brand: '#2a78d6',
    series: '#2a78d6',
    seriesDark: '#3987e5',
  },
};

/**
 * Spellings a `source` column actually holds, mapped to a key. watch_history
 * writes 'plex' | 'letterboxd' | 'manual' | 'trakt'; the rest cover the way a
 * person or a model might alias a service in a projected literal.
 */
const SOURCE_ALIASES: Record<string, IntegrationKey> = {
  lastfm: 'lastfm',
  'last.fm': 'lastfm',
  last_fm: 'lastfm',
  scrobble: 'lastfm',
  applemusic: 'applemusic',
  apple_music: 'applemusic',
  'apple music': 'applemusic',
  strava: 'strava',
  plex: 'plex',
  letterboxd: 'letterboxd',
  trakt: 'trakt',
  tmdb: 'tmdb',
  discogs: 'discogs',
  instapaper: 'instapaper',
  foursquare: 'foursquare',
  swarm: 'foursquare',
  github: 'github',
  wakatime: 'wakatime',
  rescuetime: 'rescuetime',
};

/** The integration a `source`-style cell names, or null if it names none. */
export function integrationFromValue(v: unknown): IntegrationKey | null {
  if (typeof v !== 'string') return null;
  return SOURCE_ALIASES[v.trim().toLowerCase()] ?? null;
}

/** Column names that plausibly hold a service name. */
const SOURCE_COL_RE = /(^|_)(source|provider|service|integration)s?$/i;

/**
 * The integration a whole result belongs to, or null when it isn't singular.
 *
 * Two independent signals, most specific first: a `source` column whose every
 * non-empty row names the SAME service wins, because it describes these rows;
 * otherwise the server's table-derived key (which knows `lastfm_scrobbles` is
 * Last.fm without a column being projected). A source column that mixes
 * services returns null even when the server offered a key — a chart of Plex
 * vs Trakt watches must not be painted as if it were all one.
 */
export function resolveResultIntegration(
  columns: string[],
  rows: unknown[][],
  serverKey?: string | null
): IntegrationKey | null {
  const sourceIdx = columns.findIndex((c) => SOURCE_COL_RE.test(c));
  if (sourceIdx >= 0 && rows.length > 0) {
    const seen = new Set<IntegrationKey | 'unknown'>();
    for (const row of rows) {
      const cell = row[sourceIdx];
      if (cell === null || cell === undefined || cell === '') continue;
      seen.add(integrationFromValue(cell) ?? 'unknown');
    }
    if (seen.size === 1) {
      const only = [...seen][0];
      if (only !== 'unknown') return only;
    }
    // A populated source column that disagrees with itself settles it: this
    // result is not one integration, whatever the tables say.
    if (seen.size > 1) return null;
  }
  const key = serverKey?.toLowerCase();
  return key && key in INTEGRATIONS ? (key as IntegrationKey) : null;
}

/** The mark colour for a resolved integration in the given mode. */
export function seriesColor(
  key: IntegrationKey | null,
  dark: boolean
): string | null {
  if (!key) return null;
  const style = INTEGRATIONS[key];
  return dark ? style.seriesDark : style.series;
}
