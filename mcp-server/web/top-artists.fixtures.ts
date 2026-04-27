import type { TopItem } from './components/AlbumCard.js';
import realData from './fixtures/top-artists.json' with { type: 'json' };

export type TopArtistsPayload = {
  period: string;
  data: TopItem[];
};

const real = realData as unknown as TopArtistsPayload;

export const fixtures: Record<string, TopArtistsPayload> = {
  default: real,

  'no-sparklines': {
    period: real.period,
    data: real.data.map((a) => ({ ...a, sparkline: undefined })),
  },

  empty: { period: '7day', data: [] },
};
