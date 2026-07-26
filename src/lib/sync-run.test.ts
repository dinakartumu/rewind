import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { syncRuns } from '../db/schema/system.js';
import { setupTestDb } from '../test-helpers.js';
import { markRunFailed } from './sync-run.js';

describe('markRunFailed', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  it('records the error on the run row', async () => {
    const db = createDb(env.DB);
    const [run] = await db
      .insert(syncRuns)
      .values({
        userId: 1,
        domain: 'running',
        syncType: 'incremental',
        status: 'running',
        startedAt: '2026-07-26T07:00:00.000Z',
      })
      .returning({ id: syncRuns.id });

    await markRunFailed(db, run.id, 'Strava API error 502');

    const [row] = await db
      .select({ status: syncRuns.status, error: syncRuns.error })
      .from(syncRuns)
      .where(eq(syncRuns.id, run.id));
    expect(row.status).toBe('failed');
    expect(row.error).toBe('Strava API error 502');
  });

  it('carries itemsSynced through for services that track partial progress', async () => {
    const db = createDb(env.DB);
    const [run] = await db
      .insert(syncRuns)
      .values({
        userId: 1,
        domain: 'running',
        syncType: 'incremental',
        status: 'running',
        startedAt: '2026-07-26T07:00:00.000Z',
      })
      .returning({ id: syncRuns.id });

    await markRunFailed(db, run.id, 'boom', { itemsSynced: 7 });

    const [row] = await db
      .select({ itemsSynced: syncRuns.itemsSynced })
      .from(syncRuns)
      .where(eq(syncRuns.id, run.id));
    expect(row.itemsSynced).toBe(7);
  });

  // The bookkeeping write is itself a D1 round trip, so whatever exhausted the
  // invocation mid-sync takes this write down too. When that happened the throw
  // escaped the catch block, the row stayed at 'running' forever, and the real
  // cause was replaced by the bookkeeping error.
  it('swallows its own write failure so the original error survives', async () => {
    const brokenD1 = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === 'prepare') {
          return () => {
            throw new Error('Too many subrequests');
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as D1Database;

    await expect(
      markRunFailed(createDb(brokenD1), 1, 'original failure')
    ).resolves.toBeUndefined();
  });
});

/**
 * Structural guard. Every sync service records its own failure, and each one
 * that hand-rolls the write reintroduces the bug: an unguarded D1 call inside a
 * catch block, which the very conditions that killed the sync are likely to
 * kill too. When it throws, the row is stranded at 'running' forever and
 * /v1/health/sync reports a dead cron as healthy-in-progress.
 *
 * Rather than trust review to catch the next one, assert it: no service may
 * write `status: 'failed'` itself. See issue #19.
 */
describe('no service hand-rolls failure bookkeeping', () => {
  const sources = import.meta.glob('../services/**/*.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;

  it('finds service sources to scan (guards against an empty glob passing vacuously)', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(20);
  });

  it('routes every failure write through markRunFailed', () => {
    const offenders = Object.entries(sources)
      .filter(([path]) => !path.endsWith('.test.ts'))
      .filter(([, src]) => /status:\s*'failed'/.test(src))
      .map(([path]) => path);

    expect(
      offenders,
      `these write status:'failed' directly instead of using markRunFailed:\n  ${offenders.join('\n  ')}`
    ).toEqual([]);
  });
});
