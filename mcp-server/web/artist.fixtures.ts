import type { ArtistPayload } from './components/ArtistDetail.js';
import realData from './fixtures/artist.json' with { type: 'json' };

const real = realData as unknown as ArtistPayload;

const noBio: ArtistPayload = {
  ...real,
  artist: {
    ...real.artist,
    name: 'A Long-Tail Indie Artist',
    bio_summary: null,
    bio_content: null,
  },
  listening_stats: {
    total_scrobbles: 47,
    first_scrobble_at: '2024-08-12T22:14:00Z',
    last_played_at: '2026-03-02T08:32:00Z',
    all_time_rank: null,
    distinct_tracks: 9,
    distinct_albums: 1,
  },
  sparkline: {
    granularity: 'year',
    points: [
      { at: '2024-01-01T00:00:00.000Z', count: 12 },
      { at: '2025-01-01T00:00:00.000Z', count: 28 },
      { at: '2026-01-01T00:00:00.000Z', count: 7 },
    ],
  },
  similar_artists: [],
};

const noImage: ArtistPayload = {
  ...real,
  artist: {
    ...real.artist,
    image: null,
  },
};

export const fixtures: Record<string, ArtistPayload> = {
  default: real,
  'no-bio-no-similar': noBio,
  'no-image': noImage,
};
