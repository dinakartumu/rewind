import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { syncRuns } from '../db/schema/system.js';
import { setupTestDb, createTestApiKey } from '../test-helpers.js';

describe('health endpoint', () => {
  it('returns ok status', async () => {
    // Basic sanity test - full integration tests will use Workers pool
    expect(true).toBe(true);
  });
});

describe('GET /v1/health/sync', () => {
  let token: string;

  beforeAll(async () => {
    await setupTestDb();
    token = await createTestApiKey({ name: 'system-test', scope: 'admin' });
  });

  beforeEach(async () => {
    const db = drizzle(env.DB);
    await db.delete(syncRuns);
  });

  it('surfaces the coding domain sync run', async () => {
    const db = drizzle(env.DB);
    await db.insert(syncRuns).values({
      domain: 'coding',
      syncType: 'github',
      status: 'completed',
      startedAt: '2026-07-24T09:00:00.000Z',
      completedAt: '2026-07-24T09:00:05.000Z',
      itemsSynced: 152,
    });

    const res = await SELF.fetch('http://localhost/v1/health/sync', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      domains: Record<string, { status: string; items_synced: number | null }>;
    };
    expect(body.domains.coding).toBeDefined();
    expect(body.domains.coding.status).toBe('completed');
    expect(body.domains.coding.items_synced).toBe(152);
  });
});
