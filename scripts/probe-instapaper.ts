// One-off probe: count Instapaper bookmarks per folder + check whether a
// specific bookmark id is in the user's account. Reads creds from
// `.dev.vars` at the repo root. Uses the existing InstapaperClient so
// the OAuth signing path matches what production sync would do.
//
// Usage: tsx scripts/probe-instapaper.ts [target_bookmark_id]
//
// Run from repo root (where .dev.vars lives).

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { InstapaperClient } from '../src/services/instapaper/client.js';

function loadDevVars(path: string): Record<string, string> {
  if (!existsSync(path)) throw new Error(`.dev.vars not found at ${path}`);
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return out;
}

const env = loadDevVars(resolve(process.cwd(), '.dev.vars'));
const required = [
  'INSTAPAPER_CONSUMER_KEY',
  'INSTAPAPER_CONSUMER_SECRET',
  'INSTAPAPER_ACCESS_TOKEN',
  'INSTAPAPER_ACCESS_TOKEN_SECRET',
];
for (const k of required) {
  if (!env[k]) throw new Error(`Missing ${k} in .dev.vars`);
}

const client = new InstapaperClient(
  env.INSTAPAPER_CONSUMER_KEY,
  env.INSTAPAPER_CONSUMER_SECRET,
  env.INSTAPAPER_ACCESS_TOKEN,
  env.INSTAPAPER_ACCESS_TOKEN_SECRET
);

const targetId = process.argv[2] ? Number(process.argv[2]) : null;

async function countFolder(folder: string): Promise<{
  total: number;
  oldest: { id: number; time: number } | null;
  newest: { id: number; time: number } | null;
  hasTarget: boolean;
}> {
  // Pull the entire folder by repeatedly calling listBookmarks with the
  // running list of bookmark ids in `have=` so the server returns the
  // next batch of older bookmarks. We stop when the server returns 0
  // new bookmarks (everything we asked for is in `have`).
  const seen = new Map<number, { time: number; hash: string }>();
  let hasTarget = false;
  let pass = 0;
  while (true) {
    pass++;
    const haveParam = Array.from(seen.entries())
      .map(([id, { hash }]) => `${id}:${hash}`)
      .join(',');
    const result = await client.listBookmarks({
      folderId: folder,
      limit: 500,
      have: haveParam || undefined,
    });
    const fresh = result.bookmarks.filter((b) => !seen.has(b.bookmark_id));
    for (const b of fresh) {
      seen.set(b.bookmark_id, { time: b.time, hash: b.hash });
      if (targetId !== null && b.bookmark_id === targetId) hasTarget = true;
    }
    process.stderr.write(
      `  [${folder}] pass ${pass}: +${fresh.length} fresh, ${seen.size} total\n`
    );
    if (fresh.length === 0) break;
    if (pass > 50) {
      process.stderr.write(`  [${folder}] safety break at pass ${pass}\n`);
      break;
    }
  }
  let oldest: { id: number; time: number } | null = null;
  let newest: { id: number; time: number } | null = null;
  for (const [id, { time }] of seen) {
    if (!oldest || time < oldest.time) oldest = { id, time };
    if (!newest || time > newest.time) newest = { id, time };
  }
  return { total: seen.size, oldest, newest, hasTarget };
}

async function main() {
  const user = await client.verifyCredentials();
  console.log(`User: ${user.username} (id=${user.user_id})`);

  // Also enumerate user-created folders — Instapaper's `bookmarks/list`
  // is capped at 500 per folder, so a missing bookmark might just live
  // in a custom folder we never asked about.
  const customFolders = await client.listFolders();
  console.log(
    `\nCustom folders (${customFolders.length}): ${customFolders.map((f) => f.title).join(', ') || '(none)'}`
  );

  console.log(`\nCounting folders (deep paginate via have=)...`);
  const folders = [
    'unread',
    'starred',
    'archive',
    ...customFolders.map((f) => String(f.folder_id)),
  ];
  const totals: Record<string, Awaited<ReturnType<typeof countFolder>>> = {};
  for (const f of folders) {
    totals[f] = await countFolder(f);
  }

  console.log(`\n=== Instapaper folder totals ===`);
  let grandTotal = 0;
  for (const f of folders) {
    const t = totals[f];
    const fmtDate = (n: number) =>
      new Date(n * 1000).toISOString().slice(0, 10);
    const oldestStr = t.oldest
      ? `${t.oldest.id} (${fmtDate(t.oldest.time)})`
      : 'n/a';
    const newestStr = t.newest
      ? `${t.newest.id} (${fmtDate(t.newest.time)})`
      : 'n/a';
    console.log(
      `  ${f.padEnd(8)} ${String(t.total).padStart(5)}  oldest=${oldestStr}  newest=${newestStr}`
    );
    grandTotal += t.total;
  }
  console.log(`  ${'TOTAL'.padEnd(8)} ${String(grandTotal).padStart(5)}`);

  if (targetId !== null) {
    console.log(`\n=== Target bookmark ${targetId} ===`);
    for (const f of folders) {
      console.log(`  ${f}: ${totals[f].hasTarget ? 'FOUND' : 'not found'}`);
    }
    // Even if it's not in any folder list, getText may still return the
    // body if the bookmark belongs to this account (e.g. it's been
    // archived in a way that drops it from list results but the text
    // is retained).
    console.log(`\nTrying direct getText(${targetId})...`);
    try {
      const text = await client.getText(targetId);
      console.log(
        `  getText OK — ${text.length} chars. First 300 chars:\n  ${text.slice(0, 300).replace(/\n/g, ' ')}`
      );
    } catch (e) {
      console.log(`  getText FAILED: ${(e as Error).message}`);
    }
  }
}

main().catch((e) => {
  console.error('Probe failed:', e);
  process.exit(1);
});
