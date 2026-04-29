/**
 * Phase 3 of reading-search-recall: re-derive body_excerpt, reindex
 * FTS, reembed Vectorize for the entire reading archive.
 *
 * Sequence matters — each step depends on the prior one's data shape:
 *   1. Re-derive body_excerpt (htmlToText with new 12K cap) for every
 *      row that has content. Walks via offset/limit pagination.
 *   2. Reindex FTS (search_index) for the reading domain so the longer
 *      body_excerpts land in the search index. Chunked.
 *   3. Reembed Vectorize using the longer body_excerpts. Chunked.
 *
 * All three loops drive admin endpoints on api.rewind.rest using the
 * REWIND_ADMIN_KEY from .dev.vars. Each call emits a one-line progress
 * report so the run is auditable from the terminal.
 *
 * Run: npx tsx scripts/run-phase3-backfill.ts [--skip-derive] [--skip-fts] [--skip-embed]
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Agent, setGlobalDispatcher } from 'undici';

const API = 'https://api.rewind.rest';

// Default undici headersTimeout is 300s; chunks late in the FTS reindex
// have run ~290s already, leaving no margin. Bump to 10 min so we don't
// false-positive on a slow but healthy admin call.
setGlobalDispatcher(
  new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 })
);

function loadAdminKey(): string {
  const env = readFileSync(resolve(process.cwd(), '.dev.vars'), 'utf-8');
  const m = env.match(/^REWIND_ADMIN_KEY=(.+)$/m);
  if (!m) throw new Error('REWIND_ADMIN_KEY missing from .dev.vars');
  return m[1].trim().replace(/^"(.*)"$/, '$1');
}

const KEY = loadAdminKey();

async function post<T>(path: string, body: unknown): Promise<T> {
  const t0 = Date.now();
  const r = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`${path} failed: ${r.status} ${text.slice(0, 500)}`);
  }
  const data = (await r.json()) as T;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  [${elapsed}s] ${path} ${JSON.stringify(body)} -> OK`);
  return data;
}

interface BackfillResp {
  scanned: number;
  updated: number;
  took_ms: number;
}

interface ReindexResp {
  domains: Record<
    string,
    {
      indexed: number;
      took_ms: number;
      total?: number;
      has_more?: boolean;
      next_offset?: number;
      error?: string;
    }
  >;
}

interface ReembedResp {
  scanned: number;
  embedded: number;
  skipped: number;
  tokens: number;
  took_ms: number;
}

async function step1Derive() {
  console.log('\n=== Phase 3.1: re-derive body_excerpt (force=true) ===');
  const limit = 2000;
  let offset = 0;
  let totalUpdated = 0;
  let calls = 0;
  while (true) {
    calls++;
    const r = await post<BackfillResp>('/v1/admin/backfill-body-excerpt', {
      force: true,
      limit,
      offset,
    });
    totalUpdated += r.updated;
    console.log(
      `  scanned=${r.scanned} updated=${r.updated} cumulative_updated=${totalUpdated}`
    );
    if (r.scanned < limit) break;
    offset += r.scanned;
  }
  console.log(`  done (${calls} calls, ${totalUpdated} rows re-derived).`);
}

async function step2FTS(startOffset = 0) {
  console.log('\n=== Phase 3.2: reindex FTS (reading) ===');
  // chunk_size 1000 keeps each call under ~250s even at high offsets,
  // well inside the 600s headers timeout we set above.
  const chunk = 1000;
  let chunkOffset = startOffset;
  let calls = 0;
  let totalIndexed = 0;
  while (true) {
    calls++;
    const r = await post<ReindexResp>('/v1/admin/reindex-search', {
      domains: ['reading'],
      chunk_size: chunk,
      chunk_offset: chunkOffset,
    });
    const reading = r.domains.reading;
    if (reading.error) throw new Error(`reindex error: ${reading.error}`);
    totalIndexed += reading.indexed;
    console.log(
      `  indexed=${reading.indexed} cumulative=${totalIndexed} total=${reading.total} has_more=${reading.has_more}`
    );
    if (!reading.has_more) break;
    chunkOffset = reading.next_offset ?? chunkOffset + reading.indexed;
  }
  console.log(`  done (${calls} calls, ${totalIndexed} FTS rows).`);
}

async function step3Embed() {
  console.log('\n=== Phase 3.3: reembed Vectorize ===');
  // 1000 articles × ~1s/article (Voyage call dominates) ≈ 1000s — still
  // well over 600s timeout. Drop to 500 articles per call to be safe.
  const limit = 500;
  const batchSize = 10;
  let offset = 0;
  let totalEmbedded = 0;
  let totalTokens = 0;
  let calls = 0;
  while (true) {
    calls++;
    const r = await post<ReembedResp>('/v1/admin/reembed-reading', {
      limit,
      batchSize,
      offset,
    });
    totalEmbedded += r.embedded;
    totalTokens += r.tokens;
    console.log(
      `  scanned=${r.scanned} embedded=${r.embedded} skipped=${r.skipped} tokens=${r.tokens} cumulative_embed=${totalEmbedded} cumulative_tokens=${totalTokens}`
    );
    if (r.scanned < limit) break;
    offset += r.scanned;
  }
  console.log(
    `  done (${calls} calls, ${totalEmbedded} vectors, ${totalTokens} tokens, ~$${(totalTokens / 1_000_000) * 0.02}).`
  );
}

async function main() {
  const args = process.argv.slice(2);
  const has = (k: string) => args.includes(k);
  const skipDerive = has('--skip-derive');
  const skipFts = has('--skip-fts');
  const skipEmbed = has('--skip-embed');
  const ftsFromArg = args.find((a) => a.startsWith('--fts-from='));
  const ftsFrom = ftsFromArg
    ? parseInt(ftsFromArg.split('=')[1] ?? '0', 10)
    : 0;

  const t0 = Date.now();
  if (!skipDerive) await step1Derive();
  else console.log('skipping Phase 3.1');
  if (!skipFts) await step2FTS(ftsFrom);
  else console.log('skipping Phase 3.2');
  if (!skipEmbed) await step3Embed();
  else console.log('skipping Phase 3.3');
  const minutes = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\nALL DONE in ${minutes} min.`);
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
