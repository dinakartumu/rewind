/**
 * Spotify Extended Streaming History Import
 *
 * One-time script to prefill the listening domain with the years that
 * predate Last.fm. Scrobbling started 2017-10-04; the Spotify export
 * reaches back to 2013.
 *
 * Because the export and the database do not overlap, this importer needs
 * no deduplication against existing scrobbles -- unlike import-apple-music.ts,
 * which probes a +/-30-minute window per play. Entities are resolved once
 * up front rather than per batch, so the whole run is a handful of D1 round
 * trips plus the scrobble inserts.
 *
 * Writes into the existing lastfm_* tables. Enrichment (Apple Music IDs,
 * artwork, durations) is deliberately left to phase 2 --
 * see docs/plans/2026-07-25-spotify-prefill-design.md.
 *
 * Prerequisites:
 *   1. Ensure wrangler is authenticated (`npx wrangler login`)
 *   2. Spotify Extended Streaming History export, unzipped
 *
 * Usage:
 *   npx tsx scripts/imports/import-spotify.ts <export-dir> --dry-run
 *   npx tsx scripts/imports/import-spotify.ts <export-dir>
 *   npx tsx scripts/imports/import-spotify.ts <export-dir> --resume
 *   npx tsx scripts/imports/import-spotify.ts <export-dir> --reset
 *   npx tsx scripts/imports/import-spotify.ts <export-dir> --cutoff 2017-10-04T07:56:29Z
 *   npx tsx scripts/imports/import-spotify.ts <export-dir> --min-ms 30000
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  seedFilterCache,
  isFiltered,
} from '../../src/services/lastfm/filters.js';

// Earliest existing Last.fm scrobble. Everything strictly before this is a
// clean prefill with no overlap, so no dedup against existing rows is
// required.
//
// Millisecond precision matters: scrobbled_at is TEXT and D1 compares it
// lexicographically, so the shorter form '...:29Z' sorts *after*
// '...:29.000Z' ('Z' > '.') and would sweep the boundary row into every
// "before the cutoff" query.
const DEFAULT_CUTOFF = '2017-10-04T07:56:29.000Z';

// Last.fm's own scrobbling rule. Matching it keeps the imported years
// counted the same way as the Last.fm years.
const DEFAULT_MIN_MS = 30_000;

const SCROBBLE_CHUNK_SIZE = 200;
const ENTITY_CHUNK_SIZE = 200;
const CHECKPOINT_FILE = resolve(
  import.meta.dirname ?? '.',
  '.spotify-checkpoint.json'
);

// --- Types ---

interface SpotifyPlay {
  ts: string;
  ms_played: number;
  master_metadata_track_name: string | null;
  master_metadata_album_artist_name: string | null;
  master_metadata_album_album_name: string | null;
  spotify_track_uri: string | null;
}

interface ParsedPlay {
  artistName: string;
  albumName: string;
  trackName: string;
  scrobbledAt: string;
  trackUri: string | null;
  filtered: boolean;
}

interface Checkpoint {
  totalScrobbles: number;
  insertedIndex: number;
  cutoff: string;
  minMs: number;
}

// In-memory caches, lowercase-keyed so the import never creates a
// case-variant duplicate of an entity it just inserted.
const artistCache = new Map<string, number>(); // name -> id
const albumCache = new Map<string, number>(); // "name|artistId" -> id
const trackCache = new Map<string, number>(); // "name|artistId" -> id

// --- Cloudflare wiring ---

function readWranglerConfig(): { accountId: string; databaseId: string } {
  const tomlPath = resolve(
    import.meta.dirname ?? '.',
    '..',
    '..',
    'wrangler.toml'
  );
  const content = readFileSync(tomlPath, 'utf-8');

  const accountId = content.match(/^account_id\s*=\s*"([^"]+)"/m)?.[1];
  const databaseId = content.match(/^database_id\s*=\s*"([^"]+)"/m)?.[1];

  if (!accountId || !databaseId) {
    console.error(
      '[ERROR] Could not parse account_id/database_id from wrangler.toml'
    );
    process.exit(1);
  }
  return { accountId, databaseId };
}

function loadCfToken(): string {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;

  const cfgPath = resolve(
    process.env.HOME ?? '~',
    'Library/Preferences/.wrangler/config/default.toml'
  );
  if (!existsSync(cfgPath)) {
    console.error(
      '[ERROR] Wrangler config not found. Run `npx wrangler login` first.'
    );
    process.exit(1);
  }
  const match = readFileSync(cfgPath, 'utf-8').match(
    /oauth_token\s*=\s*"([^"]+)"/
  );
  if (!match) {
    console.error('[ERROR] Could not parse oauth_token from wrangler config');
    process.exit(1);
  }
  return match[1];
}

let D1_URL = '';
let CF_TOKEN = '';

async function d1(sql: string): Promise<Array<Record<string, unknown>>> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(D1_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CF_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql }),
    });

    if (response.status === 429 || response.status >= 500) {
      const wait = 2_000 * (attempt + 1);
      console.log(
        `[WARN] D1 returned ${response.status}, retrying in ${wait / 1000}s`
      );
      await sleep(wait);
      continue;
    }

    if (!response.ok) {
      throw new Error(
        `D1 API error (${response.status}): ${await response.text()}`
      );
    }

    const data = (await response.json()) as {
      success: boolean;
      errors?: Array<{ message: string }>;
      result: Array<{ results: Array<Record<string, unknown>> }>;
    };

    if (!data.success) {
      throw new Error(
        `D1 query failed: ${data.errors?.map((e) => e.message).join(', ') ?? 'unknown'}`
      );
    }
    return data.result?.[0]?.results ?? [];
  }
  throw new Error('D1 request failed after retries');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function esc(value: string | null | undefined): string {
  if (value === null || value === undefined) return 'NULL';
  return `'${value.replace(/'/g, "''")}'`;
}

// --- Export parsing ---

function readExport(dir: string): SpotifyPlay[] {
  const files = readdirSync(dir)
    .filter(
      (f) => f.startsWith('Streaming_History_Audio_') && f.endsWith('.json')
    )
    .sort();

  if (files.length === 0) {
    console.error(`[ERROR] No Streaming_History_Audio_*.json files in ${dir}`);
    process.exit(1);
  }

  const all: SpotifyPlay[] = [];
  for (const file of files) {
    const rows = JSON.parse(
      readFileSync(join(dir, file), 'utf-8')
    ) as SpotifyPlay[];
    all.push(...rows);
    console.log(`[INFO] Read ${rows.length} plays from ${file}`);
  }
  return all;
}

/**
 * Normalise the export into scrobble candidates.
 *
 * Artist identity comes from the *album* artist rather than the track's
 * featured-artist list, matching the schema's artist -> album -> track
 * hierarchy. Rows without a track name are podcasts, audiobooks, or video.
 */
function buildPlays(
  raw: SpotifyPlay[],
  cutoff: string,
  minMs: number
): { plays: ParsedPlay[]; stats: Record<string, number> } {
  const stats: Record<string, number> = {
    after_cutoff: 0,
    not_music: 0,
    below_threshold: 0,
    missing_artist_or_album: 0,
  };
  const plays: ParsedPlay[] = [];

  // Compare as epoch millis, not strings: export timestamps are
  // second-precision ('...:45Z') while the cutoff carries milliseconds, and
  // lexicographic comparison across the two formats is wrong at the boundary.
  const cutoffMs = Date.parse(cutoff);

  for (const row of raw) {
    if (Date.parse(row.ts) >= cutoffMs) {
      stats.after_cutoff++;
      continue;
    }
    if (!row.master_metadata_track_name) {
      stats.not_music++;
      continue;
    }
    if ((row.ms_played ?? 0) < minMs) {
      stats.below_threshold++;
      continue;
    }

    const artistName = row.master_metadata_album_artist_name?.trim();
    const trackName = row.master_metadata_track_name.trim();
    if (!artistName || !trackName) {
      stats.missing_artist_or_album++;
      continue;
    }

    const albumName = row.master_metadata_album_album_name?.trim() ?? '';

    plays.push({
      artistName,
      albumName,
      trackName,
      // Export timestamps are second-precision Zulu; store the ISO form the
      // rest of the codebase uses.
      scrobbledAt: new Date(row.ts).toISOString(),
      trackUri: row.spotify_track_uri,
      filtered: isFiltered({ artistName, albumName, trackName }),
    });
  }

  plays.sort((a, b) => a.scrobbledAt.localeCompare(b.scrobbledAt));
  return { plays, stats };
}

// --- Cache loading ---

async function loadCaches(): Promise<void> {
  artistCache.clear();
  albumCache.clear();
  trackCache.clear();

  for (const row of await d1('SELECT id, name FROM lastfm_artists')) {
    artistCache.set((row.name as string).toLowerCase(), row.id as number);
  }
  for (const row of await d1('SELECT id, name, artist_id FROM lastfm_albums')) {
    albumCache.set(
      `${(row.name as string).toLowerCase()}|${row.artist_id}`,
      row.id as number
    );
  }
  for (const row of await d1('SELECT id, name, artist_id FROM lastfm_tracks')) {
    trackCache.set(
      `${(row.name as string).toLowerCase()}|${row.artist_id}`,
      row.id as number
    );
  }

  console.log(
    `[INFO] Cached ${artistCache.size} artists, ${albumCache.size} albums, ${trackCache.size} tracks`
  );
}

async function insertInChunks(
  label: string,
  columns: string,
  table: string,
  values: string[]
): Promise<void> {
  if (values.length === 0) {
    console.log(`[INFO] No new ${label} to insert`);
    return;
  }
  for (let i = 0; i < values.length; i += ENTITY_CHUNK_SIZE) {
    const chunk = values.slice(i, i + ENTITY_CHUNK_SIZE);
    await d1(
      `INSERT OR IGNORE INTO ${table} (${columns}) VALUES\n${chunk.join(',\n')};`
    );
  }
  console.log(`[INFO] Inserted ${values.length} new ${label}`);
}

// --- Entity resolution ---

/**
 * Insert every artist, album, and track the import needs, in foreign-key
 * order, reloading the cache after each level so the next level can resolve
 * its parent ids.
 */
async function resolveEntities(plays: ParsedPlay[]): Promise<void> {
  const now = new Date().toISOString();

  // Artists. An artist is filtered only if every one of its plays is.
  const artistFiltered = new Map<string, boolean>();
  const artistNames = new Map<string, string>(); // lower -> display
  for (const p of plays) {
    const key = p.artistName.toLowerCase();
    if (!artistNames.has(key)) artistNames.set(key, p.artistName);
    artistFiltered.set(key, (artistFiltered.get(key) ?? true) && p.filtered);
  }

  const newArtists: string[] = [];
  for (const [key, display] of artistNames) {
    if (artistCache.has(key)) continue;
    newArtists.push(
      `(1, ${esc(display)}, NULL, '', 0, ${artistFiltered.get(key) ? 1 : 0}, ${esc(now)}, ${esc(now)})`
    );
  }
  await insertInChunks(
    'artists',
    'user_id, name, mbid, url, playcount, is_filtered, created_at, updated_at',
    'lastfm_artists',
    newArtists
  );
  await loadCaches();

  // Albums, keyed on (name, artist_id) to match idx_lastfm_albums_unique.
  const albums = new Map<
    string,
    { name: string; artistId: number; filtered: boolean }
  >();
  for (const p of plays) {
    if (!p.albumName) continue;
    const artistId = artistCache.get(p.artistName.toLowerCase());
    if (!artistId) continue;
    const key = `${p.albumName.toLowerCase()}|${artistId}`;
    const prev = albums.get(key);
    albums.set(key, {
      name: p.albumName,
      artistId,
      filtered: (prev?.filtered ?? true) && p.filtered,
    });
  }

  const newAlbums: string[] = [];
  for (const [key, a] of albums) {
    if (albumCache.has(key)) continue;
    newAlbums.push(
      `(1, ${esc(a.name)}, NULL, ${a.artistId}, '', 0, ${a.filtered ? 1 : 0}, ${esc(now)}, ${esc(now)})`
    );
  }
  await insertInChunks(
    'albums',
    'user_id, name, mbid, artist_id, url, playcount, is_filtered, created_at, updated_at',
    'lastfm_albums',
    newAlbums
  );
  await loadCaches();

  // Tracks. idx_lastfm_tracks_unique is (name, artist_id), so a song that
  // appears on several albums collapses into one row -- existing behaviour,
  // inherited deliberately. The first album seen wins as album_id.
  const tracks = new Map<
    string,
    {
      name: string;
      artistId: number;
      albumId: number | null;
      filtered: boolean;
    }
  >();
  for (const p of plays) {
    const artistId = artistCache.get(p.artistName.toLowerCase());
    if (!artistId) continue;
    const key = `${p.trackName.toLowerCase()}|${artistId}`;
    const albumId = p.albumName
      ? (albumCache.get(`${p.albumName.toLowerCase()}|${artistId}`) ?? null)
      : null;
    const prev = tracks.get(key);
    tracks.set(key, {
      name: p.trackName,
      artistId,
      albumId: prev?.albumId ?? albumId,
      filtered: (prev?.filtered ?? true) && p.filtered,
    });
  }

  const newTracks: string[] = [];
  for (const [key, t] of tracks) {
    if (trackCache.has(key)) continue;
    newTracks.push(
      `(1, ${esc(t.name)}, NULL, ${t.artistId}, ${t.albumId ?? 'NULL'}, '', ${t.filtered ? 1 : 0}, ${esc(now)}, ${esc(now)})`
    );
  }
  await insertInChunks(
    'tracks',
    'user_id, name, mbid, artist_id, album_id, url, is_filtered, created_at, updated_at',
    'lastfm_tracks',
    newTracks
  );
  await loadCaches();
}

// --- Scrobble insertion ---

async function insertScrobbles(
  plays: ParsedPlay[],
  startIndex: number,
  cutoff: string,
  minMs: number
): Promise<number> {
  const now = new Date().toISOString();
  let inserted = 0;
  let unresolved = 0;

  for (let i = startIndex; i < plays.length; i += SCROBBLE_CHUNK_SIZE) {
    const chunk = plays.slice(i, i + SCROBBLE_CHUNK_SIZE);
    const values: string[] = [];

    for (const p of chunk) {
      const artistId = artistCache.get(p.artistName.toLowerCase());
      if (!artistId) {
        unresolved++;
        continue;
      }
      const trackId = trackCache.get(
        `${p.trackName.toLowerCase()}|${artistId}`
      );
      if (!trackId) {
        unresolved++;
        continue;
      }
      values.push(`(1, ${trackId}, ${esc(p.scrobbledAt)}, ${esc(now)})`);
    }

    if (values.length > 0) {
      await d1(
        `INSERT INTO lastfm_scrobbles (user_id, track_id, scrobbled_at, created_at) VALUES\n${values.join(',\n')};`
      );
      inserted += values.length;
    }

    const done = Math.min(i + SCROBBLE_CHUNK_SIZE, plays.length);
    saveCheckpoint({
      totalScrobbles: plays.length,
      insertedIndex: done,
      cutoff,
      minMs,
    });

    if (done % 2000 === 0 || done === plays.length) {
      console.log(
        `[INFO] Scrobbles ${done}/${plays.length} (inserted ${inserted})`
      );
    }
  }

  if (unresolved > 0) {
    console.log(`[WARN] ${unresolved} plays could not resolve to a track id`);
  }
  return inserted;
}

// --- Checkpoint ---

function loadCheckpoint(): Checkpoint | null {
  if (!existsSync(CHECKPOINT_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CHECKPOINT_FILE, 'utf-8')) as Checkpoint;
  } catch {
    return null;
  }
}

function saveCheckpoint(cp: Checkpoint): void {
  writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp, null, 2));
}

// --- Dry-run reporting ---

/**
 * Flag artists the import would create whose names are near-matches of
 * artists already in the database. These are potential case or punctuation
 * splits ("A.R. Rahman" vs "A. R. Rahman") that the unique index will not
 * catch, so they want a human eye before the live run.
 */
function findNearMatches(
  newNames: string[],
  existing: string[]
): Array<[string, string]> {
  const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const existingByNorm = new Map<string, string>();
  for (const name of existing) existingByNorm.set(normalise(name), name);

  const matches: Array<[string, string]> = [];
  for (const name of newNames) {
    const hit = existingByNorm.get(normalise(name));
    if (hit && hit.toLowerCase() !== name.toLowerCase())
      matches.push([name, hit]);
  }
  return matches;
}

function reportDryRun(
  plays: ParsedPlay[],
  stats: Record<string, number>
): void {
  const artists = new Map<string, number>();
  const albums = new Set<string>();
  const tracks = new Set<string>();
  const byYear = new Map<string, number>();

  for (const p of plays) {
    const a = p.artistName.toLowerCase();
    artists.set(p.artistName, (artists.get(p.artistName) ?? 0) + 1);
    if (p.albumName) albums.add(`${p.albumName.toLowerCase()}|${a}`);
    tracks.add(`${p.trackName.toLowerCase()}|${a}`);
    const year = p.scrobbledAt.slice(0, 4);
    byYear.set(year, (byYear.get(year) ?? 0) + 1);
  }

  const newArtists = [...artists.keys()].filter(
    (n) => !artistCache.has(n.toLowerCase())
  );

  console.log('\n--- DRY RUN ---');
  console.log('Excluded from the export:');
  for (const [reason, n] of Object.entries(stats)) {
    console.log(`  ${reason}: ${n}`);
  }
  console.log(`\nScrobbles to import: ${plays.length}`);
  console.log(
    `  range: ${plays[0]?.scrobbledAt} -> ${plays[plays.length - 1]?.scrobbledAt}`
  );
  console.log(
    `  filtered (holiday/audiobook): ${plays.filter((p) => p.filtered).length}`
  );

  console.log('\nBy year:');
  for (const [year, n] of [...byYear.entries()].sort()) {
    console.log(`  ${year}: ${n}`);
  }

  console.log(
    `\nEntities: ${artists.size} artists (${newArtists.length} new), ${albums.size} albums, ${tracks.size} tracks`
  );

  const nearMatches = findNearMatches(newArtists, [...artistCache.keys()]);
  if (nearMatches.length > 0) {
    console.log(
      `\n[WARN] ${nearMatches.length} new artists look like near-duplicates of existing rows:`
    );
    for (const [incoming, existing] of nearMatches.slice(0, 30)) {
      console.log(`  "${incoming}"  ~  "${existing}"`);
    }
  }

  console.log('\nTop 20 artists:');
  for (const [name, n] of [...artists.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)) {
    console.log(`  ${String(n).padStart(5)}  ${name}`);
  }
  console.log('\n--- END DRY RUN ---');
}

// --- CLI ---

function parseArgs() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const positional = argv.filter((a, i) => {
    if (a.startsWith('--')) return false;
    const prev = argv[i - 1];
    return prev !== '--limit' && prev !== '--cutoff' && prev !== '--min-ms';
  });

  if (positional.length === 0) {
    console.error(
      '[ERROR] Usage: npx tsx scripts/imports/import-spotify.ts <export-dir> [--dry-run] [--resume] [--reset] [--limit N] [--cutoff ISO] [--min-ms N]'
    );
    process.exit(1);
  }

  const valueOf = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
  };

  return {
    dir: resolve(positional[0]),
    dryRun: flags.has('--dry-run'),
    resume: flags.has('--resume'),
    reset: flags.has('--reset'),
    limit: valueOf('--limit') ? parseInt(valueOf('--limit')!, 10) : null,
    cutoff: valueOf('--cutoff') ?? DEFAULT_CUTOFF,
    minMs: valueOf('--min-ms')
      ? parseInt(valueOf('--min-ms')!, 10)
      : DEFAULT_MIN_MS,
  };
}

async function main() {
  const args = parseArgs();

  if (!existsSync(args.dir)) {
    console.error(`[ERROR] Export directory not found: ${args.dir}`);
    process.exit(1);
  }

  const { accountId, databaseId } = readWranglerConfig();
  D1_URL = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  CF_TOKEN = loadCfToken();

  console.log('[INFO] Spotify history import starting');
  console.log(`[INFO] Export: ${args.dir}`);
  console.log(`[INFO] Mode: ${args.dryRun ? 'DRY RUN' : 'PRODUCTION'}`);
  console.log(`[INFO] Cutoff: ts < ${args.cutoff}`);
  console.log(`[INFO] Threshold: ms_played >= ${args.minMs}`);

  // Filter rules live in D1; the matcher itself is pure once seeded.
  const filterRows = await d1(
    'SELECT filter_type, pattern, scope FROM lastfm_filters WHERE user_id = 1'
  );
  seedFilterCache(
    filterRows.map((r) => ({
      filterType: r.filter_type as string,
      pattern: r.pattern as string,
      scope: (r.scope as string | null) ?? null,
    }))
  );
  console.log(`[INFO] Loaded ${filterRows.length} filter rules`);

  const raw = readExport(args.dir);
  console.log(`[INFO] Total plays in export: ${raw.length}`);

  const { plays, stats } = buildPlays(raw, args.cutoff, args.minMs);
  let toImport = plays;
  if (args.limit && args.limit < toImport.length) {
    toImport = toImport.slice(0, args.limit);
    console.log(`[INFO] Limited to ${args.limit} plays`);
  }

  if (toImport.length === 0) {
    console.log('[INFO] Nothing to import.');
    return;
  }

  await loadCaches();

  if (args.dryRun) {
    reportDryRun(toImport, stats);
    return;
  }

  // Safety rail: refuse to run if pre-cutoff scrobbles already exist, unless
  // explicitly resuming or resetting. Scrobbles have no unique constraint,
  // so a careless second run would silently double every play.
  const existing = await d1(
    `SELECT COUNT(*) AS n FROM lastfm_scrobbles WHERE scrobbled_at < ${esc(args.cutoff)}`
  );
  const existingCount = Number(existing[0]?.n ?? 0);

  if (existingCount > 0 && !args.resume && !args.reset) {
    console.error(
      `[ERROR] ${existingCount} scrobbles already exist before ${args.cutoff}.\n` +
        '        Re-running would double-count them. Use --resume to continue an\n' +
        '        interrupted run, or --reset to delete them and start over.'
    );
    process.exit(1);
  }

  if (args.reset && existingCount > 0) {
    console.log(
      `[INFO] --reset: deleting ${existingCount} pre-cutoff scrobbles`
    );
    await d1(
      `DELETE FROM lastfm_scrobbles WHERE scrobbled_at < ${esc(args.cutoff)}`
    );
  }

  let startIndex = 0;
  if (args.resume) {
    const cp = loadCheckpoint();
    if (cp && cp.cutoff === args.cutoff && cp.minMs === args.minMs) {
      startIndex = cp.insertedIndex;
      console.log(`[INFO] Resuming from scrobble index ${startIndex}`);
    } else if (cp) {
      console.log(
        '[WARN] Checkpoint parameters differ; starting from the beginning'
      );
    }
  }

  console.log('[INFO] Resolving entities...');
  await resolveEntities(toImport);

  console.log('[INFO] Inserting scrobbles...');
  const inserted = await insertScrobbles(
    toImport,
    startIndex,
    args.cutoff,
    args.minMs
  );

  console.log(`[SUCCESS] Imported ${inserted} scrobbles`);
  console.log('');
  console.log(
    '[INFO] Next: phase 2 (Spotify enrichment) then phase 3 (recompute stats).'
  );
  console.log('       See docs/plans/2026-07-25-spotify-prefill-design.md');
}

main().catch((error) => {
  console.error(`[FATAL] ${error}`);
  process.exit(1);
});
