/**
 * Diff Instapaper API ↔ Rewind D1: report what's missing in either direction.
 *
 * Lists every bookmark visible across the user's Instapaper folders
 * (default: unread/starred/archive, plus every custom folder), lists every
 * `reading_items` row where `source='instapaper'`, and prints the symmetric
 * difference plus a one-line "in_api / in_db / both / api_only / db_only"
 * summary.
 *
 * Notes:
 * - Instapaper's `bookmarks/list` is hard-capped at 500 per folder; the
 *   `have=` parameter is for delta-skip, not pagination, so this script
 *   surfaces the live-API view, not the user's full historical archive.
 *   The full archive (incl. orphaned bookmarks like the Ichiro case) is
 *   only enumerable via the CSV export at instapaper.com/user.
 * - This script is read-only — no writes to D1, no Instapaper writes.
 *
 * Usage:
 *   npx tsx scripts/backfills/diff-instapaper.ts
 *   npx tsx scripts/backfills/diff-instapaper.ts --json    # machine-readable
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as crypto from 'node:crypto';

const REWIND_API = 'https://api.rewind.rest';
const RATE_LIMIT_MS = 250;

// ─── env + cloudflare token ────────────────────────────────────────

function loadEnv(): Record<string, string> {
  const envFile = resolve(import.meta.dirname ?? '.', '../../.dev.vars');
  const content = readFileSync(envFile, 'utf-8');
  const env: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.+)$/);
    if (match) env[match[1].trim()] = match[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return env;
}
const ENV = loadEnv();

// ─── rewind api (read-only via REWIND_ADMIN_KEY) ────────────────────

async function fetchAllInstapaperArticles(): Promise<
  { id: number; sourceId: number; url: string; title: string | null }[]
> {
  const out: {
    id: number;
    sourceId: number;
    url: string;
    title: string | null;
  }[] = [];
  let page = 1;
  while (true) {
    const url = `${REWIND_API}/v1/reading/articles?limit=50&page=${page}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${ENV.REWIND_ADMIN_KEY}` },
    });
    if (!res.ok) throw new Error(`Rewind API failed: ${res.status}`);
    const data = (await res.json()) as {
      data: Array<{
        id: number;
        url: string;
        instapaper_url: string | null;
        title: string | null;
        source: string;
      }>;
      pagination: { total_pages: number };
    };
    for (const a of data.data) {
      if (a.source !== 'instapaper') continue;
      // Derive bookmark id from `instapaper_url` (.../read/{id}); fall back
      // to parsing the path when the host strips the prefix.
      const m = (a.instapaper_url || '').match(/\/read\/(\d+)/);
      if (!m) continue;
      out.push({
        id: a.id,
        sourceId: Number(m[1]),
        url: a.url,
        title: a.title,
      });
    }
    if (page >= data.pagination.total_pages) break;
    page++;
  }
  return out;
}

// ─── instapaper oauth + list ───────────────────────────────────────

function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function generateSignature(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret: string
): string {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join('&');
  const base = `${method}&${percentEncode(url)}&${percentEncode(sorted)}`;
  const key = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return crypto.createHmac('sha1', key).update(base).digest('base64');
}

async function instapaperRequest(
  path: string,
  body: Record<string, string> = {}
): Promise<string> {
  const url = `https://www.instapaper.com/api${path}`;
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: ENV.INSTAPAPER_CONSUMER_KEY,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: ENV.INSTAPAPER_ACCESS_TOKEN,
    oauth_version: '1.0',
  };
  oauthParams.oauth_signature = generateSignature(
    'POST',
    url,
    { ...oauthParams, ...body },
    ENV.INSTAPAPER_CONSUMER_SECRET,
    ENV.INSTAPAPER_ACCESS_TOKEN_SECRET
  );

  const auth =
    'OAuth ' +
    Object.keys(oauthParams)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
      .join(', ');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    throw new Error(
      `Instapaper ${path} failed: ${res.status} ${(await res.text()).slice(0, 200)}`
    );
  }
  return res.text();
}

interface ApiBookmark {
  bookmark_id: number;
  url: string;
  title: string;
  hash: string;
  time: number;
  folder: string;
}

async function listFolderDeep(folderId: string): Promise<ApiBookmark[]> {
  // The Instapaper API caps `bookmarks/list` at 500; `have=` is for delta-
  // skip. We still loop with `have=` to be sure we've drained — typically
  // pass 2 returns 0 because the API isn't actually paginating.
  const seen = new Map<number, ApiBookmark>();
  let pass = 0;
  while (true) {
    pass++;
    const have = Array.from(seen.values())
      .map((b) => `${b.bookmark_id}:${b.hash}`)
      .join(',');
    const params: Record<string, string> = {
      folder_id: folderId,
      limit: '500',
    };
    if (have) params.have = have;
    const res = await instapaperRequest('/1/bookmarks/list', params);
    const items = JSON.parse(res) as Array<Record<string, unknown>>;
    let fresh = 0;
    for (const item of items) {
      if (item.type !== 'bookmark') continue;
      const b = item as unknown as ApiBookmark;
      if (seen.has(b.bookmark_id)) continue;
      seen.set(b.bookmark_id, { ...b, folder: folderId });
      fresh++;
    }
    process.stderr.write(
      `  [${folderId}] pass ${pass}: +${fresh} fresh, ${seen.size} total\n`
    );
    if (fresh === 0) break;
    if (pass > 50) break;
    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
  }
  return Array.from(seen.values());
}

// ─── main ───────────────────────────────────────────────────────────

async function main() {
  const jsonMode = process.argv.includes('--json');

  const log = (msg: string) => {
    if (!jsonMode) console.log(msg);
    else process.stderr.write(msg + '\n');
  };

  log('Listing folders...');
  const foldersRes = await instapaperRequest('/1/folders/list');
  const customFolders = JSON.parse(foldersRes) as Array<{
    folder_id: number;
    title: string;
  }>;
  const folderIds = [
    'unread',
    'starred',
    'archive',
    ...customFolders.map((f) => String(f.folder_id)),
  ];
  log(
    `  ${folderIds.length} folders (3 default + ${customFolders.length} custom)`
  );

  log('\nListing bookmarks per folder...');
  const apiBookmarks = new Map<number, ApiBookmark>();
  for (const folderId of folderIds) {
    const bms = await listFolderDeep(folderId);
    for (const b of bms) {
      if (!apiBookmarks.has(b.bookmark_id)) apiBookmarks.set(b.bookmark_id, b);
    }
  }
  log(`  ${apiBookmarks.size} unique bookmarks visible via API`);

  log('\nFetching instapaper-sourced articles from Rewind API...');
  const dbRows = await fetchAllInstapaperArticles();
  const dbIds = new Set(dbRows.map((r) => r.sourceId));
  log(`  ${dbIds.size} reading_items rows`);

  // Symmetric diff
  const apiOnly: ApiBookmark[] = [];
  const dbOnly: typeof dbRows = [];
  const both: number[] = [];
  for (const [id, b] of apiBookmarks) {
    if (dbIds.has(id)) both.push(id);
    else apiOnly.push(b);
  }
  for (const r of dbRows) {
    if (!apiBookmarks.has(r.sourceId)) dbOnly.push(r);
  }

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          summary: {
            api: apiBookmarks.size,
            db: dbIds.size,
            both: both.length,
            api_only: apiOnly.length,
            db_only: dbOnly.length,
          },
          api_only: apiOnly.map((b) => ({
            bookmark_id: b.bookmark_id,
            title: b.title,
            url: b.url,
            folder: b.folder,
            time: b.time,
          })),
          db_only: dbOnly.slice(0, 200), // cap
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`\n=== Summary ===`);
  console.log(`  API bookmarks: ${apiBookmarks.size}`);
  console.log(`  DB rows:       ${dbIds.size}`);
  console.log(`  In both:       ${both.length}`);
  console.log(`  API only:      ${apiOnly.length}  (need to ingest)`);
  console.log(
    `  DB only:       ${dbOnly.length}  (deleted from Instapaper or in custom folder we missed)`
  );

  if (apiOnly.length) {
    console.log(`\n=== API-only (in Instapaper, not in Rewind) — first 20 ===`);
    for (const b of apiOnly.slice(0, 20)) {
      console.log(
        `  ${b.bookmark_id}  [${b.folder.padEnd(8)}]  ${(b.title || '(untitled)').slice(0, 70)}`
      );
    }
    if (apiOnly.length > 20) console.log(`  ... + ${apiOnly.length - 20} more`);
  }
  if (dbOnly.length && dbOnly.length <= 30) {
    console.log(`\n=== DB-only (in Rewind, not in any API folder) ===`);
    for (const r of dbOnly) {
      console.log(`  ${r.sourceId}  ${r.url}`);
    }
  } else if (dbOnly.length > 30) {
    console.log(
      `\n=== DB-only ${dbOnly.length} (too many to list — check via /v1/reading/articles)`
    );
  }
}

main().catch((e) => {
  console.error('diff-instapaper failed:', e);
  process.exit(1);
});
