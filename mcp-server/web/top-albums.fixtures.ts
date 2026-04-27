import type { TopItem } from './components/AlbumCard.js';
import realData from './fixtures/top-albums.json' with { type: 'json' };

export type TopAlbumsPayload = {
  period: string;
  data: TopItem[];
};

const real = realData as unknown as TopAlbumsPayload;

export const fixtures: Record<string, TopAlbumsPayload> = {
  default: real,
  empty: { period: '7day', data: [] },
};
