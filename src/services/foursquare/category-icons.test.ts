import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { createDb } from '../../db/client.js';
import { checkins } from '../../db/schema/places.js';
import { setupTestDbWithFts5 } from '../../test-helpers.js';
import type { Env } from '../../types/env.js';
import {
  parseFoursquareIcon,
  mirrorCategoryIcon,
  reconcileCheckinIcons,
} from './category-icons.js';

const RAW = 'https://ss3.4sqi.net/img/categories_v2/food/default_64.png';
const CDN = 'https://cdn.dinakartumu.com/places/icons/food-default_64.png';

describe('parseFoursquareIcon', () => {
  it('maps a 4sqi glyph to its R2 key and CDN URL', () => {
    const parsed = parseFoursquareIcon(RAW);
    expect(parsed).toEqual({
      group: 'food',
      name: 'default',
      r2Key: 'places/icons/food-default_64.png',
      cdnUrl: CDN,
    });
  });

  it('handles multi-segment group names', () => {
    const parsed = parseFoursquareIcon(
      'https://ss3.4sqi.net/img/categories_v2/arts_entertainment/movietheater_64.png'
    );
    expect(parsed?.cdnUrl).toBe(
      'https://cdn.dinakartumu.com/places/icons/arts_entertainment-movietheater_64.png'
    );
  });

  it('returns null for already-CDN, null, or malformed URLs', () => {
    expect(parseFoursquareIcon(CDN)).toBeNull();
    expect(parseFoursquareIcon(null)).toBeNull();
    expect(parseFoursquareIcon('not a url')).toBeNull();
    expect(
      parseFoursquareIcon('https://ss3.4sqi.net/img/other/thing.png')
    ).toBeNull();
  });
});

describe('mirrorCategoryIcon', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('passes through non-4sqi URLs unchanged without touching R2', async () => {
    const head = vi.spyOn(env.IMAGES, 'head');
    expect(await mirrorCategoryIcon(env as unknown as Env, CDN)).toBe(CDN);
    expect(await mirrorCategoryIcon(env as unknown as Env, null)).toBeNull();
    expect(head).not.toHaveBeenCalled();
  });

  it('uploads to R2 on a miss and returns the CDN URL', async () => {
    vi.spyOn(env.IMAGES, 'head').mockResolvedValue(null);
    const put = vi.spyOn(env.IMAGES, 'put').mockResolvedValue({} as never);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(png, { headers: { 'content-type': 'image/png' } })
    );

    expect(await mirrorCategoryIcon(env as unknown as Env, RAW)).toBe(CDN);
    expect(put).toHaveBeenCalledWith(
      'places/icons/food-default_64.png',
      expect.anything(),
      expect.objectContaining({
        httpMetadata: expect.objectContaining({ contentType: 'image/png' }),
      })
    );
  });

  it('skips the upload when the object already exists', async () => {
    vi.spyOn(env.IMAGES, 'head').mockResolvedValue({} as never);
    const put = vi.spyOn(env.IMAGES, 'put');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await mirrorCategoryIcon(env as unknown as Env, RAW)).toBe(CDN);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it('returns the raw URL (never loses it) when the fetch fails', async () => {
    vi.spyOn(env.IMAGES, 'head').mockResolvedValue(null);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('nope', { status: 404 })
    );
    expect(await mirrorCategoryIcon(env as unknown as Env, RAW)).toBe(RAW);
  });
});

describe('reconcileCheckinIcons', () => {
  beforeEach(async () => {
    await setupTestDbWithFts5();
    vi.restoreAllMocks();
  });

  it('rewrites rows on the raw host and leaves CDN rows alone', async () => {
    const db = createDb(env.DB);
    await db.insert(checkins).values([
      {
        userId: 1,
        foursquareId: 'a',
        venueName: 'Klaa',
        venueIcon: RAW,
        checkedInAt: '2026-07-22T10:00:00Z',
      },
      {
        userId: 1,
        foursquareId: 'b',
        venueName: 'Pvr',
        venueIcon: CDN,
        checkedInAt: '2026-07-21T10:00:00Z',
      },
    ]);

    vi.spyOn(env.IMAGES, 'head').mockResolvedValue({} as never); // already mirrored

    const { mirrored } = await reconcileCheckinIcons(
      env as unknown as Env,
      db,
      1
    );
    expect(mirrored).toBe(1);

    const rows = await db
      .select()
      .from(checkins)
      .orderBy(checkins.foursquareId);
    expect(rows.find((r) => r.foursquareId === 'a')?.venueIcon).toBe(CDN);
    expect(rows.find((r) => r.foursquareId === 'b')?.venueIcon).toBe(CDN);
  });

  it('is a no-op when nothing points at the raw host', async () => {
    const db = createDb(env.DB);
    await db.insert(checkins).values({
      userId: 1,
      foursquareId: 'c',
      venueName: 'Pvr',
      venueIcon: CDN,
      checkedInAt: '2026-07-21T10:00:00Z',
    });
    const head = vi.spyOn(env.IMAGES, 'head');
    const { mirrored } = await reconcileCheckinIcons(
      env as unknown as Env,
      db,
      1
    );
    expect(mirrored).toBe(0);
    expect(head).not.toHaveBeenCalled();
  });
});
