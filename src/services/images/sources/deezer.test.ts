import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeezerClient } from './deezer.js';

describe('DeezerClient', () => {
  let client: DeezerClient;

  beforeEach(() => {
    client = new DeezerClient();
    vi.restoreAllMocks();
  });

  it('has the correct name', () => {
    expect(client.name).toBe('deezer');
  });

  // Live regression: Deezer indexes the artist as "A.R.Rahman" (no spaces)
  // and "A. R. Rahman". Whatever punctuation/spacing variant is stored
  // locally, the candidates with real pictures must be accepted.
  it('accepts punctuation-variant artist names', async () => {
    const mockResponse = {
      data: [
        {
          id: 491,
          name: 'A.R.Rahman',
          picture_xl:
            'https://cdn-images.dzcdn.net/images/artist/abc123/1000x1000-000000-80-0-0.jpg',
        },
        {
          id: 253620,
          name: 'A. R. Rahman',
          picture_xl:
            'https://cdn-images.dzcdn.net/images/artist/def456/1000x1000-000000-80-0-0.jpg',
        },
      ],
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })
    );

    const results = await client.search({
      domain: 'listening',
      entityType: 'artists',
      entityId: 'ar-rahman',
      artistName: 'AR Rahman',
    });

    expect(results).toHaveLength(2);
  });

  // Deezer serves a generic gray placeholder for artists without photos:
  // the picture URL carries an empty image hash (`/artist//`). Those
  // candidates must be skipped so real photos further down the list win.
  it('skips blank placeholder picture URLs', async () => {
    const mockResponse = {
      data: [
        {
          id: 173750,
          name: 'A.R.Rahman',
          picture_xl:
            'https://cdn-images.dzcdn.net/images/artist//1000x1000-000000-80-0-0.jpg',
        },
        {
          id: 491,
          name: 'A.R. Rahman',
          picture_xl:
            'https://cdn-images.dzcdn.net/images/artist/bd34315ef977a62a9e28c1ab19bb8ac4/1000x1000-000000-80-0-0.jpg',
        },
      ],
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })
    );

    const results = await client.search({
      domain: 'listening',
      entityType: 'artists',
      entityId: 'ar-rahman',
      artistName: 'A.R. Rahman',
    });

    expect(results).toHaveLength(1);
    expect(results[0].url).toContain('bd34315ef977a62a9e28c1ab19bb8ac4');
  });

  it('rejects wrong artists on artist search', async () => {
    const mockResponse = {
      data: [
        {
          id: 1,
          name: 'Rahul Sipligunj',
          picture_xl:
            'https://cdn-images.dzcdn.net/images/artist/abc/1000x1000-000000-80-0-0.jpg',
        },
      ],
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })
    );

    const results = await client.search({
      domain: 'listening',
      entityType: 'artists',
      entityId: 'ar-rahman',
      artistName: 'A.R. Rahman',
    });

    expect(results).toEqual([]);
  });

  it('skips blank placeholder cover URLs on album search', async () => {
    const mockResponse = {
      data: [
        {
          title: 'Komuram Bheemudo (From "RRR") - Single',
          artist: { name: 'Kaala Bhairava' },
          cover_xl:
            'https://cdn-images.dzcdn.net/images/cover//1000x1000-000000-80-0-0.jpg',
        },
      ],
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })
    );

    const results = await client.search({
      domain: 'listening',
      entityType: 'albums',
      entityId: 'komuram-bheemudo',
      artistName: 'Kala Bhairava',
      albumName: 'Komuram Bheemudo (From "RRR")',
    });

    expect(results).toEqual([]);
  });

  it('accepts transliteration-variant album credits', async () => {
    const mockResponse = {
      data: [
        {
          title: 'Komuram Bheemudo (From "RRR") - Single',
          artist: { name: 'Kaala Bhairava' },
          cover_xl:
            'https://cdn-images.dzcdn.net/images/cover/abc123/1000x1000-000000-80-0-0.jpg',
        },
      ],
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })
    );

    const results = await client.search({
      domain: 'listening',
      entityType: 'albums',
      entityId: 'komuram-bheemudo',
      artistName: 'Kala Bhairava',
      albumName: 'Komuram Bheemudo (From "RRR")',
    });

    expect(results).toHaveLength(1);
    expect(results[0].url).toContain('1200x1200');
  });

  it('returns empty array on API error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500 })
    );

    const results = await client.search({
      domain: 'listening',
      entityType: 'artists',
      entityId: 'test',
      artistName: 'Test Artist',
    });

    expect(results).toEqual([]);
  });
});
