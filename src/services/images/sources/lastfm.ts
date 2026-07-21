/**
 * Last.fm album-art source client.
 * Tail sweeper for the listening/albums waterfall: album names in the
 * database came from Last.fm scrobbles, so album.getInfo(artist, album)
 * matches catalog titles (mostly Indian film soundtracks) that fail
 * name-search against Apple/Deezer/iTunes. Art tops out at 300x300, so
 * this source runs last -- higher-quality sources stay preferred.
 */

import type { ImageResult, SourceClient, SourceSearchParams } from './types.js';

const BASE_URL = 'https://ws.audioscrobbler.com/2.0/';

/**
 * Last.fm serves a generic gray-star placeholder when an album has no real
 * art. The placeholder URL always carries this hash; treat it as no-image.
 */
const PLACEHOLDER_HASH = '2a96cbd8b46e442fc41c2b86b821562f';

export class LastfmImageClient implements SourceClient {
  name = 'lastfm';

  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async search(params: SourceSearchParams): Promise<ImageResult[]> {
    if (params.entityType !== 'albums') {
      return [];
    }

    const url = new URL(BASE_URL);
    url.searchParams.set('method', 'album.getinfo');
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('format', 'json');

    if (params.mbid) {
      url.searchParams.set('mbid', params.mbid);
    } else if (params.artistName && params.albumName) {
      url.searchParams.set('artist', params.artistName);
      url.searchParams.set('album', params.albumName);
    } else {
      return [];
    }

    try {
      const response = await fetch(url.toString());

      if (!response.ok) {
        return [];
      }

      const data = (await response.json()) as LastfmAlbumInfoResponse;

      // error 6 = album not found; any error means no art
      if (data.error !== undefined || !data.album?.image) {
        return [];
      }

      // Take the largest image: "mega", or the last entry in the array
      const images = data.album.image;
      const largest =
        images.find((img) => img.size === 'mega') ?? images[images.length - 1];
      const imageUrl = largest?.['#text']?.trim();

      if (!imageUrl || imageUrl.includes(PLACEHOLDER_HASH)) {
        return [];
      }

      // Last.fm does not report dimensions
      return [
        {
          source: this.name,
          url: imageUrl,
          width: null,
          height: null,
        },
      ];
    } catch (error) {
      console.log(
        `[ERROR] Last.fm album art search failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return [];
    }
  }
}

interface LastfmAlbumInfoResponse {
  error?: number;
  message?: string;
  album?: {
    name?: string;
    artist?: string;
    image?: Array<{ size: string; '#text': string }>;
  };
}
