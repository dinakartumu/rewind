import type { Article } from './components/ArticleCard.js';
import realData from './fixtures/recent-reads.json' with { type: 'json' };

export type RecentReadsPayload = {
  items: Article[];
};

const real = realData as unknown as RecentReadsPayload;

export const fixtures: Record<string, RecentReadsPayload> = {
  default: real,

  'no-images': {
    items: [
      {
        id: 9001,
        title: 'A short article with no OG image',
        author: null,
        url: 'https://example.com/no-image',
        instapaper_url: 'https://www.instapaper.com/read/9001',
        instapaper_app_url: null,
        domain: 'example.com',
        description: 'Some sources never extract an image.',
        estimated_read_min: 2,
        status: 'unread',
        progress: 0,
        image: null,
        saved_at: '2026-04-18T11:45:00Z',
      },
    ],
  },

  empty: { items: [] },
};
