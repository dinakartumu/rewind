/**
 * Spotify Enrichment for the pre-Last.fm backfill
 *
 * Phase 2 of docs/plans/2026-07-25-spotify-prefill-design.md. Reads the same
 * Spotify export the importer used, resolves each play's `spotify_track_uri`
 * against the Spotify Web API, and fills in the metadata and artwork that
 * import-spotify.ts deliberately left empty.
 *
 * Enrichment is by ID, not by name search. That matters for this library:
 * the heaviest pre-2017 listening is Tamil and Telugu film music, where
 * transliteration variance makes name matching unreliable.
 *
 * What it writes:
 *   lastfm_tracks.duration_ms
 *   lastfm_albums.released_year, lastfm_albums.total_tracks
 *   album + artist artwork, via PUT /v1/admin/images (640px Spotify art)
 *
 * What it deliberately does not write:
 *   - Spotify ids. No column exists for them and apple_music_* must not be
 *     repurposed; the ids are re-derivable from the export on any re-run.
 *   - Genres. Spotify's vocabulary does not match the allowlist in
 *     src/services/lastfm/genres.ts and would read inconsistently against
 *     the post-2017 half of the library.
 *   - preview_url. Spotify withdrew preview access for apps created after
 *     November 2024; phase 4's iTunes backfill supplies those.
 *
 * Existing values are never clobbered -- every write is COALESCE-guarded, and
 * artwork is only pushed to entities that have none.
 *
 * Usage:
 *   npx tsx scripts/backfills/enrich-spotify.ts <export-dir> --dry-run
 *   npx tsx scripts/backfills/enrich-spotify.ts <export-dir> --metadata
 *   npx tsx scripts/backfills/enrich-spotify.ts <export-dir> --art
 *   npx tsx scripts/backfills/enrich-spotify.ts <export-dir>          # both
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const DEFAULT_CUTOFF = '2017-10-04T07:56:29.000Z';
const DEFAULT_MIN_MS = 30_000;

const TRACK_BATCH = 50; // Spotify /v1/tracks limit
const ARTIST_BATCH = 50; // Spotify /v1/artists limit
const UPDATE_CHUNK = 200; // rows per D1 CASE update
const ART_CONCURRENCY = 3; // parallel image pipeline requests

// The Rewind API enforces a 120-request sliding window per key
// (src/lib/rate-limit.ts). Pace under it rather than eating 429s.
const RATE_LIMIT_PER_MIN = 100;

const ART_PROGRESS_FILE = resolve(
  import.meta.dirname ?? '.',
  '.spotify-art-progress.json'
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

interface SpotifyTrack {
  id: string;
  name: string;
  duration_ms: number;
  album: {
    id: string;
    name: string;
    release_date: string | null;
    total_tracks: number | null;
    images: Array<{ url: string; width: number; height: number }>;
    artists: Array<{ id: string; name: string }>;
  };
  artists: Array<{ id: string; name: string }>;
}

interface SpotifyArtist {
  id: string;
  name: string;
  images: Array<{ url: string; width: number; height: number }>;
}

/** One export row reduced to the fields enrichment needs. */
interface Candidate {
  artistName: string;
  albumName: string;
  trackName: string;
  trackId: string;
}

// --- Env ---

function loadDevVars(): Record<string, string> {
  const path = resolve(import.meta.dirname ?? '.', '..', '..', '.dev.vars');
  if (!existsSync(path)) {
    console.error('[ERROR] .dev.vars not found');
    process.exit(1);
  }
  const vars: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return vars;
}

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
    console.error('[ERROR] Could not parse wrangler.toml');
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
  const match = existsSync(cfgPath)
    ? readFileSync(cfgPath, 'utf-8').match(/oauth_token\s*=\s*"([^"]+)"/)
    : null;
  if (!match) {
    console.error('[ERROR] Run `npx wrangler login` first.');
    process.exit(1);
  }
  return match[1];
}

let D1_URL = '';
let CF_TOKEN = '';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Global pacer shared by every art worker, spacing slots evenly so the
 * combined request rate stays under the API's per-key window.
 */
const MIN_GAP_MS = 60_000 / RATE_LIMIT_PER_MIN;
let nextSlot = 0;

async function takeSlot(): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + MIN_GAP_MS;
  if (slot > now) await sleep(slot - now);
}

function penalise(retryAfterSeconds: number): void {
  nextSlot = Math.max(nextSlot, Date.now() + (retryAfterSeconds + 1) * 1000);
}

function esc(v: string | null | undefined): string {
  if (v === null || v === undefined) return 'NULL';
  return `'${v.replace(/'/g, "''")}'`;
}

async function d1(sql: string): Promise<Array<Record<string, unknown>>> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(D1_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CF_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql }),
    });
    if (res.status === 429 || res.status >= 500) {
      await sleep(2_000 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`D1 ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      success: boolean;
      errors?: Array<{ message: string }>;
      result: Array<{ results: Array<Record<string, unknown>> }>;
    };
    if (!data.success) {
      throw new Error(
        data.errors?.map((e) => e.message).join(', ') ?? 'D1 failed'
      );
    }
    return data.result?.[0]?.results ?? [];
  }
  throw new Error('D1 failed after retries');
}

// --- Spotify client ---

let spotifyToken = '';
let spotifyTokenExpiry = 0;

async function getSpotifyToken(id: string, secret: string): Promise<string> {
  if (spotifyToken && Date.now() < spotifyTokenExpiry - 60_000)
    return spotifyToken;

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${id}&client_secret=${secret}`,
  });
  if (!res.ok) {
    console.error(
      `[ERROR] Spotify auth failed (${res.status}): ${await res.text()}`
    );
    process.exit(1);
  }
  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };
  spotifyToken = data.access_token;
  spotifyTokenExpiry = Date.now() + data.expires_in * 1000;
  return spotifyToken;
}

async function spotifyGet<T>(
  path: string,
  creds: { id: string; secret: string }
): Promise<T | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = await getSpotifyToken(creds.id, creds.secret);
    const res = await fetch(`https://api.spotify.com/v1${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') ?? '5', 10);
      console.log(`[WARN] Spotify rate limited, waiting ${retryAfter}s`);
      await sleep((retryAfter + 1) * 1000);
      continue;
    }
    if (res.status === 401) {
      spotifyToken = '';
      continue;
    }
    if (!res.ok) {
      console.log(`[WARN] Spotify ${res.status} on ${path.slice(0, 60)}`);
      return null;
    }
    return (await res.json()) as T;
  }
  return null;
}

// --- Export parsing ---

/**
 * Rebuild the same candidate set the importer used, reduced to one
 * representative Spotify track id per (artist, track) pair -- which is the
 * grain lastfm_tracks stores, since idx_lastfm_tracks_unique is
 * (name, artist_id).
 */
function readCandidates(
  dir: string,
  cutoff: string,
  minMs: number
): Candidate[] {
  const files = readdirSync(dir)
    .filter(
      (f) => f.startsWith('Streaming_History_Audio_') && f.endsWith('.json')
    )
    .sort();

  const cutoffMs = Date.parse(cutoff);
  const byKey = new Map<string, Candidate>();

  for (const file of files) {
    const rows = JSON.parse(
      readFileSync(join(dir, file), 'utf-8')
    ) as SpotifyPlay[];
    for (const row of rows) {
      if (Date.parse(row.ts) >= cutoffMs) continue;
      if (!row.master_metadata_track_name) continue;
      if ((row.ms_played ?? 0) < minMs) continue;
      if (!row.spotify_track_uri) continue;

      const artistName = row.master_metadata_album_artist_name?.trim();
      const trackName = row.master_metadata_track_name.trim();
      if (!artistName || !trackName) continue;

      const trackId = row.spotify_track_uri.replace('spotify:track:', '');
      if (!trackId || trackId.includes(':')) continue;

      const key = `${trackName.toLowerCase()}|${artistName.toLowerCase()}`;
      if (byKey.has(key)) continue;

      byKey.set(key, {
        artistName,
        albumName: row.master_metadata_album_album_name?.trim() ?? '',
        trackName,
        trackId,
      });
    }
  }

  return [...byKey.values()];
}

// --- DB caches ---

const artistCache = new Map<string, number>();
const albumCache = new Map<string, number>();
const trackCache = new Map<string, number>();

async function loadCaches(): Promise<void> {
  for (const r of await d1('SELECT id, name FROM lastfm_artists')) {
    artistCache.set((r.name as string).toLowerCase(), r.id as number);
  }
  for (const r of await d1('SELECT id, name, artist_id FROM lastfm_albums')) {
    albumCache.set(
      `${(r.name as string).toLowerCase()}|${r.artist_id}`,
      r.id as number
    );
  }
  for (const r of await d1('SELECT id, name, artist_id FROM lastfm_tracks')) {
    trackCache.set(
      `${(r.name as string).toLowerCase()}|${r.artist_id}`,
      r.id as number
    );
  }
  console.log(
    `[INFO] Cached ${artistCache.size} artists, ${albumCache.size} albums, ${trackCache.size} tracks`
  );
}

async function loadEntitiesWithArt(entityType: string): Promise<Set<number>> {
  const rows = await d1(
    `SELECT CAST(entity_id AS INTEGER) AS id FROM images
     WHERE domain = 'listening' AND entity_type = ${esc(entityType)}
       AND r2_key IS NOT NULL AND length(r2_key) > 0`
  );
  return new Set(rows.map((r) => Number(r.id)));
}

// --- Resolution ---

interface Resolved {
  trackUpdates: Map<number, number>; // track db id -> duration_ms
  albumUpdates: Map<number, { year: number | null; total: number | null }>;
  albumArt: Map<number, string>; // album db id -> image url
  artistArt: Map<number, string>; // artist db id -> image url
  stats: Record<string, number>;
}

async function resolve_(
  candidates: Candidate[],
  creds: { id: string; secret: string }
): Promise<Resolved> {
  const trackUpdates = new Map<number, number>();
  const albumUpdates = new Map<
    number,
    { year: number | null; total: number | null }
  >();
  const albumArt = new Map<number, string>();
  const artistArt = new Map<number, string>();
  const stats: Record<string, number> = {
    spotify_missing: 0,
    no_db_artist: 0,
    no_db_track: 0,
    no_db_album: 0,
  };

  // artist db id -> spotify artist id, collected from the track responses so
  // artist artwork needs no separate search.
  const artistSpotifyIds = new Map<number, string>();

  const batches: Candidate[][] = [];
  for (let i = 0; i < candidates.length; i += TRACK_BATCH) {
    batches.push(candidates.slice(i, i + TRACK_BATCH));
  }
  console.log(
    `[INFO] Resolving ${candidates.length} tracks in ${batches.length} batches`
  );

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const data = await spotifyGet<{ tracks: Array<SpotifyTrack | null> }>(
      `/tracks?ids=${batch.map((c) => c.trackId).join(',')}`,
      creds
    );
    if (!data) {
      stats.spotify_missing += batch.length;
      continue;
    }

    for (let i = 0; i < batch.length; i++) {
      const cand = batch[i];
      const sp = data.tracks[i];
      if (!sp) {
        stats.spotify_missing++;
        continue;
      }

      const artistDbId = artistCache.get(cand.artistName.toLowerCase());
      if (!artistDbId) {
        stats.no_db_artist++;
        continue;
      }

      const trackDbId = trackCache.get(
        `${cand.trackName.toLowerCase()}|${artistDbId}`
      );
      if (trackDbId) {
        trackUpdates.set(trackDbId, sp.duration_ms);
      } else {
        stats.no_db_track++;
      }

      // The export's album-artist string is what the importer used to build
      // the album row, so resolve the album against that same pair.
      if (cand.albumName) {
        const albumDbId = albumCache.get(
          `${cand.albumName.toLowerCase()}|${artistDbId}`
        );
        if (albumDbId) {
          if (!albumUpdates.has(albumDbId)) {
            const year = sp.album.release_date
              ? parseInt(sp.album.release_date.slice(0, 4), 10)
              : null;
            albumUpdates.set(albumDbId, {
              year: Number.isFinite(year) ? year : null,
              total: sp.album.total_tracks ?? null,
            });
          }
          const cover = sp.album.images?.[0]?.url;
          if (cover && !albumArt.has(albumDbId)) albumArt.set(albumDbId, cover);
        } else {
          stats.no_db_album++;
        }
      }

      const spArtistId = sp.album.artists?.[0]?.id ?? sp.artists?.[0]?.id;
      if (spArtistId && !artistSpotifyIds.has(artistDbId)) {
        artistSpotifyIds.set(artistDbId, spArtistId);
      }
    }

    if ((b + 1) % 20 === 0 || b === batches.length - 1) {
      console.log(`[INFO] Track batch ${b + 1}/${batches.length}`);
    }
  }

  // Artist artwork: one batched lookup over the ids gathered above.
  const artistPairs = [...artistSpotifyIds.entries()];
  console.log(`[INFO] Resolving artwork for ${artistPairs.length} artists`);

  for (let i = 0; i < artistPairs.length; i += ARTIST_BATCH) {
    const chunk = artistPairs.slice(i, i + ARTIST_BATCH);
    const data = await spotifyGet<{ artists: Array<SpotifyArtist | null> }>(
      `/artists?ids=${chunk.map(([, spId]) => spId).join(',')}`,
      creds
    );
    if (!data) continue;

    for (let j = 0; j < chunk.length; j++) {
      const [dbId] = chunk[j];
      const image = data.artists[j]?.images?.[0]?.url;
      if (image) artistArt.set(dbId, image);
    }
  }

  return { trackUpdates, albumUpdates, albumArt, artistArt, stats };
}

// --- Metadata writes ---

/**
 * Apply per-row values with a single CASE statement per chunk rather than one
 * UPDATE per row -- a few dozen round trips instead of several thousand.
 * COALESCE keeps any value an earlier enrichment already set.
 */
async function writeTrackDurations(
  updates: Map<number, number>
): Promise<number> {
  const entries = [...updates.entries()];
  let written = 0;

  for (let i = 0; i < entries.length; i += UPDATE_CHUNK) {
    const chunk = entries.slice(i, i + UPDATE_CHUNK);
    const cases = chunk.map(([id, ms]) => `WHEN ${id} THEN ${ms}`).join(' ');
    const ids = chunk.map(([id]) => id).join(',');
    await d1(
      `UPDATE lastfm_tracks
       SET duration_ms = COALESCE(duration_ms, CASE id ${cases} END)
       WHERE id IN (${ids});`
    );
    written += chunk.length;
  }
  console.log(`[INFO] Wrote duration_ms for ${written} tracks`);
  return written;
}

async function writeAlbumMetadata(
  updates: Map<number, { year: number | null; total: number | null }>
): Promise<number> {
  const entries = [...updates.entries()].filter(
    ([, v]) => v.year !== null || v.total !== null
  );
  let written = 0;

  for (let i = 0; i < entries.length; i += UPDATE_CHUNK) {
    const chunk = entries.slice(i, i + UPDATE_CHUNK);
    const yearCases = chunk
      .map(([id, v]) => `WHEN ${id} THEN ${v.year ?? 'NULL'}`)
      .join(' ');
    const totalCases = chunk
      .map(([id, v]) => `WHEN ${id} THEN ${v.total ?? 'NULL'}`)
      .join(' ');
    const ids = chunk.map(([id]) => id).join(',');
    await d1(
      `UPDATE lastfm_albums
       SET released_year = COALESCE(released_year, CASE id ${yearCases} END),
           total_tracks  = COALESCE(total_tracks,  CASE id ${totalCases} END)
       WHERE id IN (${ids});`
    );
    written += chunk.length;
  }
  console.log(`[INFO] Wrote released_year/total_tracks for ${written} albums`);
  return written;
}

// --- Artwork ---

interface ArtProgress {
  doneAlbums: number[];
  doneArtists: number[];
}

function loadArtProgress(): ArtProgress {
  if (!existsSync(ART_PROGRESS_FILE))
    return { doneAlbums: [], doneArtists: [] };
  try {
    return JSON.parse(readFileSync(ART_PROGRESS_FILE, 'utf-8')) as ArtProgress;
  } catch {
    return { doneAlbums: [], doneArtists: [] };
  }
}

function saveArtProgress(p: ArtProgress): void {
  writeFileSync(ART_PROGRESS_FILE, JSON.stringify(p));
}

/**
 * Push artwork through the existing image override endpoint. That runs the
 * full pipeline in the Worker -- fetch, R2 upload, thumbhash, colour
 * extraction -- so it is the slow part of enrichment and runs with modest
 * concurrency and a resumable progress file.
 */
async function pushArt(
  entityType: 'albums' | 'artists',
  art: Map<number, string>,
  skip: Set<number>,
  done: number[],
  apiBase: string,
  apiKey: string,
  progress: ArtProgress
): Promise<{ ok: number; failed: number; skipped: number }> {
  const doneSet = new Set(done);
  const work = [...art.entries()].filter(
    ([id]) => !skip.has(id) && !doneSet.has(id)
  );
  const skipped = art.size - work.length;

  console.log(
    `[INFO] ${entityType}: ${work.length} to push (${skipped} already have art or were done)`
  );

  let ok = 0;
  let failed = 0;
  let index = 0;

  async function worker(): Promise<void> {
    while (index < work.length) {
      const [id, url] = work[index++];

      let settled = false;
      for (let attempt = 0; attempt < 4 && !settled; attempt++) {
        await takeSlot();
        try {
          const res = await fetch(
            `${apiBase}/v1/admin/images/listening/${entityType}/${id}`,
            {
              method: 'PUT',
              headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ source_url: url }),
              signal: AbortSignal.timeout(45_000),
            }
          );

          if (res.status === 429) {
            penalise(parseInt(res.headers.get('retry-after') ?? '3', 10));
            continue;
          }

          if (res.ok) {
            ok++;
            done.push(id);
          } else {
            failed++;
            if (failed <= 5) {
              console.log(
                `[WARN] ${entityType}/${id} -> ${res.status}: ${(await res.text()).slice(0, 120)}`
              );
            }
          }
          settled = true;
        } catch (err) {
          if (attempt === 3) {
            failed++;
            settled = true;
            if (failed <= 5)
              console.log(`[WARN] ${entityType}/${id} threw: ${err}`);
          } else {
            await sleep(1_000 * (attempt + 1));
          }
        }
      }
      if (!settled) failed++;

      const processed = ok + failed;
      if (processed % 50 === 0) {
        saveArtProgress(progress);
        console.log(
          `[INFO] ${entityType}: ${processed}/${work.length} (${failed} failed)`
        );
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(ART_CONCURRENCY, work.length) }, () =>
      worker()
    )
  );
  saveArtProgress(progress);

  console.log(
    `[INFO] ${entityType} artwork: ${ok} ok, ${failed} failed, ${skipped} skipped`
  );
  return { ok, failed, skipped };
}

// --- CLI ---

function parseArgs() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const positional = argv.filter((a, i) => {
    if (a.startsWith('--')) return false;
    const prev = argv[i - 1];
    return prev !== '--cutoff' && prev !== '--min-ms';
  });

  if (positional.length === 0) {
    console.error(
      '[ERROR] Usage: npx tsx scripts/backfills/enrich-spotify.ts <export-dir> [--dry-run] [--metadata] [--art]'
    );
    process.exit(1);
  }

  const valueOf = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
  };

  const onlyMetadata = flags.has('--metadata');
  const onlyArt = flags.has('--art');

  // The metadata pass belongs to the pre-Last.fm backfill, but artwork gaps
  // span the whole library -- and the export reaches 2025, so dropping the
  // cutoff yields exact Spotify ids for anything ever played on Spotify.
  const allYears = flags.has('--all-years');

  return {
    dir: resolve(positional[0]),
    dryRun: flags.has('--dry-run'),
    // Neither flag means do both.
    doMetadata: onlyMetadata || !onlyArt,
    doArt: onlyArt || !onlyMetadata,
    cutoff: allYears
      ? '9999-12-31T23:59:59.999Z'
      : (valueOf('--cutoff') ?? DEFAULT_CUTOFF),
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

  const vars = loadDevVars();
  const clientId = vars.SPOTIFY_CLIENT_ID;
  const clientSecret = vars.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error(
      '[ERROR] SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET missing from .dev.vars'
    );
    process.exit(1);
  }
  const apiBase = vars.REWIND_API_BASE;
  const apiKey = vars.REWIND_API_KEY;
  if (args.doArt && (!apiBase || !apiKey)) {
    console.error(
      '[ERROR] REWIND_API_BASE / REWIND_API_KEY missing from .dev.vars'
    );
    process.exit(1);
  }

  const { accountId, databaseId } = readWranglerConfig();
  D1_URL = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  CF_TOKEN = loadCfToken();

  console.log('[INFO] Spotify enrichment starting');
  console.log(`[INFO] Mode: ${args.dryRun ? 'DRY RUN' : 'PRODUCTION'}`);
  console.log(
    `[INFO] Steps: ${[args.doMetadata && 'metadata', args.doArt && 'art'].filter(Boolean).join(' + ')}`
  );

  const candidates = readCandidates(args.dir, args.cutoff, args.minMs);
  console.log(
    `[INFO] ${candidates.length} unique (artist, track) pairs with a Spotify id`
  );

  await loadCaches();

  const creds = { id: clientId, secret: clientSecret };
  const resolved = await resolve_(candidates, creds);

  console.log('\nResolution:');
  console.log(`  track durations:  ${resolved.trackUpdates.size}`);
  console.log(`  album metadata:   ${resolved.albumUpdates.size}`);
  console.log(`  album artwork:    ${resolved.albumArt.size}`);
  console.log(`  artist artwork:   ${resolved.artistArt.size}`);
  for (const [k, v] of Object.entries(resolved.stats)) {
    if (v > 0) console.log(`  unmatched ${k}: ${v}`);
  }

  const albumsWithArt = await loadEntitiesWithArt('albums');
  const artistsWithArt = await loadEntitiesWithArt('artists');
  console.log(
    `\n[INFO] Already have artwork: ${albumsWithArt.size} albums, ${artistsWithArt.size} artists`
  );

  if (args.dryRun) {
    const newAlbumArt = [...resolved.albumArt.keys()].filter(
      (id) => !albumsWithArt.has(id)
    );
    const newArtistArt = [...resolved.artistArt.keys()].filter(
      (id) => !artistsWithArt.has(id)
    );
    console.log('\n--- DRY RUN ---');
    console.log(
      `Would set duration_ms on up to ${resolved.trackUpdates.size} tracks`
    );
    console.log(
      `Would set released_year/total_tracks on up to ${resolved.albumUpdates.size} albums`
    );
    console.log(
      `Would push artwork for ${newAlbumArt.length} albums, ${newArtistArt.length} artists`
    );
    console.log('--- END DRY RUN ---');
    return;
  }

  if (args.doMetadata) {
    await writeTrackDurations(resolved.trackUpdates);
    await writeAlbumMetadata(resolved.albumUpdates);
  }

  if (args.doArt) {
    const progress = loadArtProgress();
    await pushArt(
      'albums',
      resolved.albumArt,
      albumsWithArt,
      progress.doneAlbums,
      apiBase,
      apiKey,
      progress
    );
    await pushArt(
      'artists',
      resolved.artistArt,
      artistsWithArt,
      progress.doneArtists,
      apiBase,
      apiKey,
      progress
    );
  }

  console.log('\n[SUCCESS] Spotify enrichment complete');
  console.log('[INFO] Next: phase 3 (recompute stats and search index).');
}

main().catch((error) => {
  console.error(`[FATAL] ${error}`);
  process.exit(1);
});
