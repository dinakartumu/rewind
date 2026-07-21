import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LastfmImageClient } from './lastfm.js';

/**
 * Live response shape captured 2026-07-21 for artist "M. M. Keeravaani",
 * album "Magadheera" -- an Indian film soundtrack that fails name-search
 * against Apple/Deezer/iTunes but resolves exactly on Last.fm because the
 * album name came from Last.fm scrobbles in the first place.
 */
const MAGADHEERA_RESPONSE = {
  album: {
    artist: 'M. M. Keeravaani',
    listeners: '4026',
    image: [
      {
        size: 'small',
        '#text':
          'https://lastfm.freetls.fastly.net/i/u/34s/87c80d4154ed8353bc89feb8404c21d8.jpg',
      },
      {
        size: 'medium',
        '#text':
          'https://lastfm.freetls.fastly.net/i/u/64s/87c80d4154ed8353bc89feb8404c21d8.jpg',
      },
      {
        size: 'large',
        '#text':
          'https://lastfm.freetls.fastly.net/i/u/174s/87c80d4154ed8353bc89feb8404c21d8.jpg',
      },
      {
        size: 'extralarge',
        '#text':
          'https://lastfm.freetls.fastly.net/i/u/300x300/87c80d4154ed8353bc89feb8404c21d8.jpg',
      },
      {
        size: 'mega',
        '#text':
          'https://lastfm.freetls.fastly.net/i/u/300x300/87c80d4154ed8353bc89feb8404c21d8.jpg',
      },
      {
        size: '',
        '#text':
          'https://lastfm.freetls.fastly.net/i/u/300x300/87c80d4154ed8353bc89feb8404c21d8.jpg',
      },
    ],
    mbid: '',
    tags: '',
    name: 'Magadheera',
    playcount: '44488',
    url: 'https://www.last.fm/music/M.+M.+Keeravaani/Magadheera',
  },
};

describe('LastfmImageClient', () => {
  let client: LastfmImageClient;

  beforeEach(() => {
    client = new LastfmImageClient('test-api-key');
    vi.restoreAllMocks();
  });

  it('has the correct name', () => {
    expect(client.name).toBe('lastfm');
  });

  it('returns the largest image from album.getInfo', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MAGADHEERA_RESPONSE),
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await client.search({
      domain: 'listening',
      entityType: 'albums',
      entityId: 'magadheera',
      artistName: 'M. M. Keeravaani',
      albumName: 'Magadheera',
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      source: 'lastfm',
      url: 'https://lastfm.freetls.fastly.net/i/u/300x300/87c80d4154ed8353bc89feb8404c21d8.jpg',
      width: null,
      height: null,
    });

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.origin + calledUrl.pathname).toBe(
      'https://ws.audioscrobbler.com/2.0/'
    );
    expect(calledUrl.searchParams.get('method')).toBe('album.getinfo');
    expect(calledUrl.searchParams.get('artist')).toBe('M. M. Keeravaani');
    expect(calledUrl.searchParams.get('album')).toBe('Magadheera');
    expect(calledUrl.searchParams.get('api_key')).toBe('test-api-key');
    expect(calledUrl.searchParams.get('format')).toBe('json');
  });

  it('prefers mbid lookup when the search params carry one', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MAGADHEERA_RESPONSE),
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await client.search({
      domain: 'listening',
      entityType: 'albums',
      entityId: 'magadheera',
      artistName: 'M. M. Keeravaani',
      albumName: 'Magadheera',
      mbid: 'abc-123-mbid',
    });

    expect(results).toHaveLength(1);
    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get('mbid')).toBe('abc-123-mbid');
    expect(calledUrl.searchParams.get('artist')).toBeNull();
    expect(calledUrl.searchParams.get('album')).toBeNull();
  });

  // Last.fm serves a known gray-star placeholder when an album has no real
  // art. Its URL always carries this hash; treat it as no-image.
  it('rejects the known placeholder star image', async () => {
    const response = {
      album: {
        ...MAGADHEERA_RESPONSE.album,
        image: MAGADHEERA_RESPONSE.album.image.map((img) => ({
          size: img.size,
          '#text': img['#text'].replace(
            '87c80d4154ed8353bc89feb8404c21d8',
            '2a96cbd8b46e442fc41c2b86b821562f'
          ),
        })),
      },
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(response),
      })
    );

    const results = await client.search({
      domain: 'listening',
      entityType: 'albums',
      entityId: 'magadheera',
      artistName: 'M. M. Keeravaani',
      albumName: 'Magadheera',
    });

    expect(results).toEqual([]);
  });

  it('returns empty for missing albums (error 6)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ message: 'Album not found', error: 6 }),
      })
    );

    const results = await client.search({
      domain: 'listening',
      entityType: 'albums',
      entityId: 'nope',
      artistName: 'Nonexistent Zz',
      albumName: 'Nonexistent Album Qq',
    });

    expect(results).toEqual([]);
  });

  it('returns empty when image entries are blank', async () => {
    const response = {
      album: {
        ...MAGADHEERA_RESPONSE.album,
        image: MAGADHEERA_RESPONSE.album.image.map((img) => ({
          size: img.size,
          '#text': '',
        })),
      },
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(response),
      })
    );

    const results = await client.search({
      domain: 'listening',
      entityType: 'albums',
      entityId: 'magadheera',
      artistName: 'M. M. Keeravaani',
      albumName: 'Magadheera',
    });

    expect(results).toEqual([]);
  });

  it('skips non-album entity types without fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const results = await client.search({
      domain: 'listening',
      entityType: 'artists',
      entityId: 'ar-rahman',
      artistName: 'A.R. Rahman',
    });

    expect(results).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns empty when artist or album name is missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const results = await client.search({
      domain: 'listening',
      entityType: 'albums',
      entityId: 'magadheera',
      artistName: 'M. M. Keeravaani',
    });

    expect(results).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns empty array on API error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500 })
    );

    const results = await client.search({
      domain: 'listening',
      entityType: 'albums',
      entityId: 'magadheera',
      artistName: 'M. M. Keeravaani',
      albumName: 'Magadheera',
    });

    expect(results).toEqual([]);
  });
});
