import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { createDb } from '../../db/client.js';
import { syncRuns } from '../../db/schema/system.js';
import { setupTestDb } from '../../test-helpers.js';
import type { Env } from '../../types/env.js';
import { isSunday, isDiscogsConfigured, syncCollecting } from './sync.js';

describe('sync utilities', () => {
  describe('isSunday', () => {
    it('should return a boolean', () => {
      const result = isSunday();
      expect(typeof result).toBe('boolean');
    });

    it('should return true when day is Sunday (0)', () => {
      // We can't easily mock Date in Workers env, so we just verify it returns boolean
      const result = isSunday();
      const today = new Date().getUTCDay();
      expect(result).toBe(today === 0);
    });
  });
});

// Discogs is optional: an instance without a Discogs account never sets the
// token, and the stale one left behind failed every Sunday with a 401.
describe('syncCollecting without Discogs configured', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  it('reports unconfigured when either var is missing', () => {
    expect(isDiscogsConfigured({})).toBe(false);
    expect(
      isDiscogsConfigured({
        DISCOGS_PERSONAL_TOKEN: 'tok',
        DISCOGS_USERNAME: '',
      })
    ).toBe(false);
    expect(
      isDiscogsConfigured({
        DISCOGS_PERSONAL_TOKEN: 'tok',
        DISCOGS_USERNAME: 'me',
      })
    ).toBe(true);
  });

  it('skips without recording a sync run', async () => {
    await syncCollecting({
      ...env,
      DISCOGS_PERSONAL_TOKEN: undefined as unknown as string,
      DISCOGS_USERNAME: undefined as unknown as string,
    } as unknown as Env);

    const db = createDb(env.DB);
    const runs = await db
      .select({ id: syncRuns.id })
      .from(syncRuns)
      .where(eq(syncRuns.domain, 'collecting'));
    expect(runs).toHaveLength(0);
  });
});
