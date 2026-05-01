import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { env } from 'cloudflare:test';
import { readingItems } from '../../db/schema/reading.js';
import { images } from '../../db/schema/system.js';
import { setupTestDb } from '../../test-helpers.js';
import { reconcileReadingDeletions } from './reconcile-deletions.js';

const ENV = {
  INSTAPAPER_CONSUMER_KEY: 'k',
  INSTAPAPER_CONSUMER_SECRET: 's',
  INSTAPAPER_ACCESS_TOKEN: 'at',
  INSTAPAPER_ACCESS_TOKEN_SECRET: 'ats',
};

function bookmark(id: number, hash = 'h') {
  return {
    type: 'bookmark',
    bookmark_id: id,
    url: `https://example.com/${id}`,
    title: `Bookmark ${id}`,
    description: '',
    time: 1704067200,
    starred: '0',
    private_source: '',
    hash,
    progress: 0,
    progress_timestamp: 0,
    tags: [],
  };
}

async function seedDb(sourceIds: number[]) {
  const db = drizzle(env.DB);
  await db.delete(images);
  await db.delete(readingItems);
  for (const sid of sourceIds) {
    await db.insert(readingItems).values({
      userId: 1,
      itemType: 'article',
      source: 'instapaper',
      sourceId: String(sid),
      url: `https://example.com/${sid}`,
      title: `Item ${sid}`,
      savedAt: new Date().toISOString(),
    });
  }
}

describe('reconcileReadingDeletions', () => {
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    await setupTestDb();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('purges items missing from every folder; keeps items present in any folder', async () => {
    // Seed 30 items; archive holds 100-127, item 400 is the deleted ghost.
    // 1/30 ≈ 3.3% deletion rate stays under the 10% safety guard.
    const seedIds = [
      ...Array.from({ length: 28 }, (_, i) => 100 + i),
      300,
      400,
    ];
    await seedDb(seedIds);

    // - folders/list returns one custom folder (id=99)
    // - unread returns [300] (one item)
    // - archive returns the 28 sequential items
    // - folder 99 returns []
    // → 400 is in DB but missing everywhere → must be purged.
    const archiveBookmarks = Array.from({ length: 28 }, (_, i) =>
      bookmark(100 + i)
    );
    const responseFor = (url: string, body: string) => {
      if (url.endsWith('/folders/list')) {
        return JSON.stringify([{ folder_id: 99, title: 'Custom' }]);
      }
      if (url.endsWith('/bookmarks/list')) {
        const params = new URLSearchParams(body);
        const folder = params.get('folder_id');
        switch (folder) {
          case 'unread':
            return JSON.stringify([bookmark(300)]);
          case 'starred':
            return JSON.stringify([]);
          case 'archive':
            return JSON.stringify(archiveBookmarks);
          case '99':
            return JSON.stringify([]);
          default:
            return JSON.stringify([]);
        }
      }
      return '[]';
    };

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const body = (init?.body as string) ?? '';
      return new Response(responseFor(url, body), { status: 200 });
    }) as typeof globalThis.fetch;

    const db = drizzle(env.DB);
    const result = await reconcileReadingDeletions(db, ENV);

    expect(result.foldersScanned).toBe(4);
    expect(result.bookmarksSeen).toBe(29);
    expect(result.candidates).toBe(1);
    expect(result.deleted).toBe(1);
    expect(result.abortedReason).toBeUndefined();

    const remaining = await db
      .select({ sourceId: readingItems.sourceId })
      .from(readingItems);
    expect(remaining.find((r) => r.sourceId === '400')).toBeUndefined();
    expect(remaining).toHaveLength(29);
  });

  it('keeps items that appear in any folder during pagination but not in the verify pass', async () => {
    // Edge case: pagination misses item 500 (e.g., race during scan), but
    // verifyChunk finds it in unread → must NOT be purged.
    await seedDb([500]);

    let bookmarksListCalls = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const body = (init?.body as string) ?? '';
      if (url.endsWith('/folders/list')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith('/bookmarks/list')) {
        bookmarksListCalls++;
        const params = new URLSearchParams(body);
        const folder = params.get('folder_id');
        const have = params.get('have');
        // Pass 1 (paginate): no have= → return empty so 500 is a candidate
        if (!have && folder === 'unread')
          return new Response(JSON.stringify([]), { status: 200 });
        if (!have) return new Response(JSON.stringify([]), { status: 200 });
        // Pass 2 (verify): have=500 sent to unread → return bookmark(500)
        if (have === '500' && folder === 'unread') {
          return new Response(JSON.stringify([bookmark(500)]), { status: 200 });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response('[]', { status: 200 });
    }) as typeof globalThis.fetch;

    const db = drizzle(env.DB);
    const result = await reconcileReadingDeletions(db, ENV);

    expect(result.candidates).toBe(1);
    expect(result.deleted).toBe(0);
    expect(bookmarksListCalls).toBeGreaterThan(0);

    const remaining = await db
      .select({ sourceId: readingItems.sourceId })
      .from(readingItems);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].sourceId).toBe('500');
  });

  it('aborts with safety_abort if more than 10% of items are flagged for deletion', async () => {
    // Seed 20 items; pretend Instapaper API returns nothing → all 20
    // would be candidates. Safety guard must abort before any DELETE.
    await seedDb(Array.from({ length: 20 }, (_, i) => i + 1));

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/folders/list'))
        return new Response('[]', { status: 200 });
      // Every bookmarks/list returns empty → everything looks deleted
      return new Response('[]', { status: 200 });
    }) as typeof globalThis.fetch;

    const db = drizzle(env.DB);
    const result = await reconcileReadingDeletions(db, ENV);

    expect(result.candidates).toBe(20);
    expect(result.deleted).toBe(0);
    expect(result.abortedReason).toMatch(/safety_abort/);

    const remaining = await db
      .select({ sourceId: readingItems.sourceId })
      .from(readingItems);
    expect(remaining).toHaveLength(20);
  });

  it('no-ops cleanly when DB is empty', async () => {
    await seedDb([]);

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/folders/list'))
        return new Response('[]', { status: 200 });
      if (url.endsWith('/bookmarks/list'))
        return new Response('[]', { status: 200 });
      return new Response('[]', { status: 200 });
    }) as typeof globalThis.fetch;

    const db = drizzle(env.DB);
    const result = await reconcileReadingDeletions(db, ENV);

    expect(result.candidates).toBe(0);
    expect(result.deleted).toBe(0);
  });
});
