/**
 * Listening image waterfall backfill
 *
 * Drives the on-demand image endpoint for every album and artist that has no
 * artwork. Each request runs the full pipeline in the Worker: source
 * resolution (Apple Music -> Deezer -> Cover Art Archive -> Last.fm), R2
 * upload, thumbhash, and colour extraction.
 *
 * This is the high-resolution pass -- Apple Music and Deezer return
 * 1000-1200px. Run it *before* any Spotify artwork push: Spotify caps at
 * 640px and the only URL-based endpoint is the override endpoint, which sets
 * is_override = 1 and permanently excludes the row from this waterfall.
 *
 * Entities that already have artwork are never touched.
 *
 * Misses are written to a CSV so the Spotify fallback can target exactly the
 * entities that name search could not resolve.
 *
 * Usage:
 *   npx tsx scripts/backfills/backfill-listening-images.ts --dry-run
 *   npx tsx scripts/backfills/backfill-listening-images.ts
 *   npx tsx scripts/backfills/backfill-listening-images.ts --albums
 *   npx tsx scripts/backfills/backfill-listening-images.ts --artists
 *   npx tsx scripts/backfills/backfill-listening-images.ts --limit 100
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  appendFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

const CONCURRENCY = 3;

// The API enforces a 120-request sliding window per key (src/lib/rate-limit.ts).
// Pace below it rather than eating 429s: the pipeline requests are slow enough
// that this, not concurrency, is the binding constraint.
const RATE_LIMIT_PER_MIN = 100;
const PROGRESS_FILE = resolve(
  import.meta.dirname ?? '.',
  '.listening-images-progress.json'
);
const MISSES_FILE = resolve(
  import.meta.dirname ?? '.',
  'listening-image-misses.csv'
);

interface AlbumRow {
  id: number;
  name: string;
  artist_name: string;
  mbid: string | null;
  playcount: number | null;
}

interface ArtistRow {
  id: number;
  name: string;
  mbid: string | null;
  playcount: number | null;
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
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq > 0) vars[t.slice(0, eq)] = t.slice(eq + 1);
  }
  return vars;
}

function readWranglerConfig(): { accountId: string; databaseId: string } {
  const p = resolve(import.meta.dirname ?? '.', '..', '..', 'wrangler.toml');
  const c = readFileSync(p, 'utf-8');
  const accountId = c.match(/^account_id\s*=\s*"([^"]+)"/m)?.[1];
  const databaseId = c.match(/^database_id\s*=\s*"([^"]+)"/m)?.[1];
  if (!accountId || !databaseId) {
    console.error('[ERROR] Could not parse wrangler.toml');
    process.exit(1);
  }
  return { accountId, databaseId };
}

function loadCfToken(): string {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const p = resolve(
    process.env.HOME ?? '~',
    'Library/Preferences/.wrangler/config/default.toml'
  );
  const m = existsSync(p)
    ? readFileSync(p, 'utf-8').match(/oauth_token\s*=\s*"([^"]+)"/)
    : null;
  if (!m) {
    console.error('[ERROR] Run `npx wrangler login` first.');
    process.exit(1);
  }
  return m[1];
}

let D1_URL = '';
let CF_TOKEN = '';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Global pacer shared by every worker. Keeps the combined request rate under
 * the API's per-key window by spacing slots evenly, so bursts never stack up.
 */
const MIN_GAP_MS = 60_000 / RATE_LIMIT_PER_MIN;
let nextSlot = 0;

async function takeSlot(): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + MIN_GAP_MS;
  if (slot > now) await sleep(slot - now);
}

/** Back off hard when the server says we are over the limit anyway. */
function penalise(retryAfterSeconds: number): void {
  nextSlot = Math.max(nextSlot, Date.now() + (retryAfterSeconds + 1) * 1000);
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
    // 401 shows up transiently under sustained load, and the wrangler OAuth
    // token also rotates -- so re-read it from disk and retry rather than die.
    if (res.status === 401) {
      await sleep(2_000 * (attempt + 1));
      CF_TOKEN = loadCfToken();
      continue;
    }
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
    if (!data.success)
      throw new Error(
        data.errors?.map((e) => e.message).join(', ') ?? 'D1 failed'
      );
    return data.result?.[0]?.results ?? [];
  }
  throw new Error('D1 failed after retries');
}

// --- Progress ---

interface Progress {
  doneAlbums: number[];
  doneArtists: number[];
}

function loadProgress(): Progress {
  if (!existsSync(PROGRESS_FILE)) return { doneAlbums: [], doneArtists: [] };
  try {
    return JSON.parse(readFileSync(PROGRESS_FILE, 'utf-8')) as Progress;
  } catch {
    return { doneAlbums: [], doneArtists: [] };
  }
}

function saveProgress(p: Progress): void {
  writeFileSync(PROGRESS_FILE, JSON.stringify(p));
}

// --- Work discovery ---

/**
 * Rows with an images record but an empty r2_key are failed pipeline runs, not
 * real artwork. Clearing them lets the entity be retried.
 */
async function cleanEmptyImageRows(): Promise<void> {
  await d1(
    `DELETE FROM images
     WHERE domain = 'listening'
       AND entity_type IN ('albums', 'artists')
       AND (r2_key IS NULL OR length(r2_key) = 0)`
  );
}

async function findAlbums(): Promise<AlbumRow[]> {
  const rows = await d1(
    `SELECT a.id, a.name, ar.name AS artist_name, a.mbid, a.playcount
     FROM lastfm_albums a
     JOIN lastfm_artists ar ON a.artist_id = ar.id
     WHERE a.is_filtered = 0
       AND a.id NOT IN (
         SELECT CAST(entity_id AS INTEGER) FROM images
         WHERE domain = 'listening' AND entity_type = 'albums'
           AND r2_key IS NOT NULL AND length(r2_key) > 0
       )
     ORDER BY a.playcount DESC, a.id`
  );
  return rows as unknown as AlbumRow[];
}

async function findArtists(): Promise<ArtistRow[]> {
  const rows = await d1(
    `SELECT a.id, a.name, a.mbid, a.playcount
     FROM lastfm_artists a
     WHERE a.is_filtered = 0
       AND a.id NOT IN (
         SELECT CAST(entity_id AS INTEGER) FROM images
         WHERE domain = 'listening' AND entity_type = 'artists'
           AND r2_key IS NOT NULL AND length(r2_key) > 0
       )
     ORDER BY a.playcount DESC, a.id`
  );
  return rows as unknown as ArtistRow[];
}

// --- Pipeline driver ---

interface Outcome {
  ok: number;
  miss: number;
  fail: number;
}

async function drive(
  label: 'albums' | 'artists',
  items: Array<{ id: number; query: string; describe: string }>,
  done: number[],
  progress: Progress,
  apiBase: string,
  apiKey: string
): Promise<Outcome> {
  const doneSet = new Set(done);
  const work = items.filter((i) => !doneSet.has(i.id));

  console.log(
    `[INFO] ${label}: ${work.length} to process (${items.length - work.length} already done)`
  );
  if (work.length === 0) return { ok: 0, miss: 0, fail: 0 };

  let ok = 0;
  let miss = 0;
  let fail = 0;
  let index = 0;

  async function worker(): Promise<void> {
    while (index < work.length) {
      const item = work[index++];

      // Up to 4 attempts, since a 429 costs nothing but time to retry.
      let settled = false;
      let counted = false;
      for (let attempt = 0; attempt < 4 && !settled; attempt++) {
        await takeSlot();
        try {
          const res = await fetch(
            `${apiBase}/v1/images/listening/${label}/${item.id}/medium?${item.query}`,
            {
              headers: { Authorization: `Bearer ${apiKey}` },
              redirect: 'manual',
              signal: AbortSignal.timeout(45_000),
            }
          );

          if (res.status === 429) {
            penalise(parseInt(res.headers.get('retry-after') ?? '3', 10));
            continue;
          }

          // A 302 to the CDN means the pipeline resolved and stored an image.
          if (res.status === 302 || res.status === 200) {
            ok++;
            done.push(item.id);
          } else if (res.status === 404) {
            // No source matched. Record it so the Spotify fallback targets it.
            miss++;
            done.push(item.id);
            appendFileSync(
              MISSES_FILE,
              `${label}|${item.id}|${item.describe}\n`
            );
          } else {
            fail++;
          }
          counted = true;
          settled = true;
        } catch {
          if (attempt === 3) {
            fail++;
            counted = true;
          } else {
            await sleep(1_000 * (attempt + 1));
          }
        }
      }
      // Exhausted every attempt on 429s without ever recording an outcome.
      if (!counted) fail++;

      const processed = ok + miss + fail;
      if (processed % 50 === 0) {
        saveProgress(progress);
        console.log(
          `[INFO] ${label}: ${processed}/${work.length} | ok=${ok} miss=${miss} fail=${fail}`
        );
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, work.length) }, () => worker())
  );
  saveProgress(progress);

  console.log(`[INFO] ${label} done: ok=${ok} miss=${miss} fail=${fail}`);
  return { ok, miss, fail };
}

// --- CLI ---

function parseArgs() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const limitIdx = argv.indexOf('--limit');
  const onlyAlbums = flags.has('--albums');
  const onlyArtists = flags.has('--artists');
  return {
    dryRun: flags.has('--dry-run'),
    doAlbums: onlyAlbums || !onlyArtists,
    doArtists: onlyArtists || !onlyAlbums,
    limit:
      limitIdx !== -1 && argv[limitIdx + 1]
        ? parseInt(argv[limitIdx + 1], 10)
        : null,
  };
}

async function main() {
  const args = parseArgs();
  const vars = loadDevVars();
  const apiBase = vars.REWIND_API_BASE;
  const apiKey = vars.REWIND_API_KEY;
  if (!apiBase || !apiKey) {
    console.error(
      '[ERROR] REWIND_API_BASE / REWIND_API_KEY missing from .dev.vars'
    );
    process.exit(1);
  }

  const { accountId, databaseId } = readWranglerConfig();
  D1_URL = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  CF_TOKEN = loadCfToken();

  console.log('[INFO] Listening image waterfall backfill');
  console.log(`[INFO] Mode: ${args.dryRun ? 'DRY RUN' : 'PRODUCTION'}`);

  if (!args.dryRun) await cleanEmptyImageRows();

  const progress = loadProgress();
  if (!existsSync(MISSES_FILE)) {
    writeFileSync(MISSES_FILE, 'entity_type|id|describe\n');
  }

  const enc = encodeURIComponent;

  if (args.doAlbums) {
    let albums = await findAlbums();
    if (args.limit) albums = albums.slice(0, args.limit);
    console.log(`[INFO] ${albums.length} albums missing artwork`);

    if (!args.dryRun) {
      const items = albums.map((a) => ({
        id: a.id,
        query:
          `artist_name=${enc(a.artist_name)}&album_name=${enc(a.name)}` +
          (a.mbid ? `&mbid=${enc(a.mbid)}` : ''),
        describe: `${a.artist_name} - ${a.name}`,
      }));
      await drive(
        'albums',
        items,
        progress.doneAlbums,
        progress,
        apiBase,
        apiKey
      );
    }
  }

  if (args.doArtists) {
    let artists = await findArtists();
    if (args.limit) artists = artists.slice(0, args.limit);
    console.log(`[INFO] ${artists.length} artists missing artwork`);

    if (!args.dryRun) {
      const items = artists.map((a) => ({
        id: a.id,
        query:
          `artist_name=${enc(a.name)}` + (a.mbid ? `&mbid=${enc(a.mbid)}` : ''),
        describe: a.name,
      }));
      await drive(
        'artists',
        items,
        progress.doneArtists,
        progress,
        apiBase,
        apiKey
      );
    }
  }

  if (args.dryRun) {
    console.log('[INFO] Dry run: nothing written.');
    return;
  }

  console.log('\n[SUCCESS] Waterfall backfill complete');
  console.log(`[INFO] Misses recorded in ${MISSES_FILE}`);
  console.log(
    '[INFO] Next: run enrich-spotify.ts --art to fill the remaining gaps at 640px.'
  );
}

main().catch((e) => {
  console.error(`[FATAL] ${e}`);
  process.exit(1);
});
