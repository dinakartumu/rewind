const BASE_URL = 'https://api.trakt.tv';
const API_VERSION = '2';

export interface TraktMovieIds {
  trakt: number;
  slug: string;
  imdb: string;
  tmdb: number;
}

export interface TraktCollectionItem {
  collected_at: string;
  updated_at: string;
  movie: {
    title: string;
    year: number;
    ids: TraktMovieIds;
  };
  metadata: {
    media_type: string;
    resolution: string;
    hdr: string;
    audio: string;
    audio_channels: string;
    '3d': boolean;
  };
}

export interface TraktCollectionInput {
  ids: { tmdb?: number; imdb?: string; trakt?: number };
  media_type: string;
  resolution?: string;
  hdr?: string;
  audio?: string;
  audio_channels?: string;
  collected_at?: string;
}

export interface TraktSyncResult {
  added: { movies: number };
  updated: { movies: number };
  existing: { movies: number };
  not_found: { movies: { ids: Record<string, unknown> }[] };
}

export interface TraktSearchResult {
  type: string;
  score: number;
  movie: {
    title: string;
    year: number;
    ids: TraktMovieIds;
  };
}

export interface TraktHistoryMovieItem {
  id: number;
  watched_at: string;
  action: string;
  type: 'movie';
  movie: {
    title: string;
    year: number;
    ids: TraktMovieIds;
  };
}

export interface TraktHistoryEpisodeItem {
  id: number;
  watched_at: string;
  action: string;
  type: 'episode';
  episode: {
    season: number;
    number: number;
    title: string | null;
    ids: { trakt: number; tmdb: number | null };
  };
  show: {
    title: string;
    year: number | null;
    ids: TraktMovieIds;
  };
}

export interface TraktRatingItem {
  rated_at: string;
  rating: number;
  type: 'movie';
  movie: {
    title: string;
    year: number;
    ids: TraktMovieIds;
  };
}

export interface TraktHistoryPage<T> {
  items: T[];
  page: number;
  pageCount: number;
}

export interface TraktHistoryOptions {
  startAt?: string;
  endAt?: string;
  page?: number;
  limit?: number;
}

export class TraktClient {
  private accessToken: string;
  private clientId: string;

  constructor(accessToken: string, clientId: string) {
    this.accessToken = accessToken;
    this.clientId = clientId;
  }

  private async requestWithHeaders<T>(
    path: string,
    options?: RequestInit
  ): Promise<{ data: T; headers: Headers }> {
    const url = `${BASE_URL}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Rewind/1.0 (personal data aggregator)',
        'trakt-api-version': API_VERSION,
        'trakt-api-key': this.clientId,
        Authorization: `Bearer ${this.accessToken}`,
        ...options?.headers,
      },
    });

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 10000;
      console.log(
        `[INFO] Trakt rate limited, waiting ${waitMs}ms before retry`
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return this.requestWithHeaders<T>(path, options);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `[ERROR] Trakt API error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    const data = (await response.json()) as T;
    return { data, headers: response.headers };
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const { data } = await this.requestWithHeaders<T>(path, options);
    return data;
  }

  /**
   * Get the user's full movie collection with metadata (format, resolution, HDR, audio).
   */
  async getCollection(): Promise<TraktCollectionItem[]> {
    return this.request<TraktCollectionItem[]>(
      '/sync/collection/movies?extended=metadata'
    );
  }

  /**
   * Add movies to the user's collection with physical media metadata.
   */
  async addToCollection(
    items: TraktCollectionInput[]
  ): Promise<TraktSyncResult> {
    return this.request<TraktSyncResult>('/sync/collection', {
      method: 'POST',
      body: JSON.stringify({
        movies: items.map((item) => ({
          ids: item.ids,
          media_type: item.media_type,
          resolution: item.resolution,
          hdr: item.hdr,
          audio: item.audio,
          audio_channels: item.audio_channels,
          collected_at: item.collected_at || new Date().toISOString(),
        })),
      }),
    });
  }

  /**
   * Remove movies from the user's collection.
   */
  async removeFromCollection(
    items: TraktCollectionInput[]
  ): Promise<TraktSyncResult> {
    return this.request<TraktSyncResult>('/sync/collection/remove', {
      method: 'POST',
      body: JSON.stringify({
        movies: items.map((item) => ({
          ids: item.ids,
          media_type: item.media_type,
        })),
      }),
    });
  }

  /**
   * Search for a movie by title.
   */
  async searchMovie(query: string): Promise<TraktSearchResult[]> {
    const encoded = encodeURIComponent(query);
    return this.request<TraktSearchResult[]>(`/search/movie?query=${encoded}`);
  }

  private async getHistoryPage<T>(
    kind: 'movies' | 'episodes',
    options: TraktHistoryOptions
  ): Promise<TraktHistoryPage<T>> {
    const params = new URLSearchParams({
      page: String(options.page ?? 1),
      limit: String(options.limit ?? 100),
    });
    if (options.startAt) {
      params.set('start_at', options.startAt);
    }
    if (options.endAt) {
      params.set('end_at', options.endAt);
    }
    const { data, headers } = await this.requestWithHeaders<T[]>(
      `/sync/history/${kind}?${params.toString()}`
    );
    return {
      items: data,
      page: parseInt(headers.get('X-Pagination-Page') ?? '1', 10),
      pageCount: parseInt(headers.get('X-Pagination-Page-Count') ?? '1', 10),
    };
  }

  /**
   * Get a page of the user's movie watch history, newest first.
   */
  async getMovieHistory(
    options: TraktHistoryOptions = {}
  ): Promise<TraktHistoryPage<TraktHistoryMovieItem>> {
    return this.getHistoryPage<TraktHistoryMovieItem>('movies', options);
  }

  /**
   * Get a page of the user's episode watch history, newest first.
   */
  async getEpisodeHistory(
    options: TraktHistoryOptions = {}
  ): Promise<TraktHistoryPage<TraktHistoryEpisodeItem>> {
    return this.getHistoryPage<TraktHistoryEpisodeItem>('episodes', options);
  }

  /**
   * Get all of the user's movie ratings.
   */
  async getMovieRatings(): Promise<TraktRatingItem[]> {
    return this.request<TraktRatingItem[]>('/sync/ratings/movies');
  }
}
