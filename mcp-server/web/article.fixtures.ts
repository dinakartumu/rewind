import type { ArticlePayload } from './components/ArticleDetail.js';

const defaultFixture: ArticlePayload = {
  article: {
    id: 4821,
    title: 'The Simpsons predicted everything: a brief and incomplete history',
    author: 'Mira Singh',
    url: 'https://example.com/simpsons-predictions-essay',
    instapaper_url: 'https://www.instapaper.com/read/4821',
    instapaper_app_url: 'instapaper://read/4821',
    domain: 'theringer.com',
    description:
      'For more than three decades the show has been credited — sometimes deservedly, sometimes ridiculously — with predicting future events. The truth is more interesting than the meme.',
    word_count: 4280,
    estimated_read_min: 18,
    status: 'archived',
    progress: 1,
    saved_at: '2026-02-14T14:23:00Z',
    image: {
      cdn_url: 'https://cdn.rewind.rest/reading/articles/4821',
      url: 'https://cdn.theringer.com/2026/02/simpsons-hero.jpg',
      thumbhash: 'KBgKDYJ4eHmXhoeEd4eIeIB4d3iIA4eHd4iIeIeIA4eHeId4iH',
      dominant_color: '#0e2b4a',
      accent_color: '#f5c518',
    },
  },
  highlights: [
    {
      id: 12001,
      text: 'The show works less because it predicts the future and more because it understands the eternal: family resentment, civic incompetence, and the way an American living room organizes the day.',
      note: 'good for the closing of the essay i want to write',
      created_at: '2026-02-15T09:11:00Z',
    },
    {
      id: 12002,
      text: "Most of the 'predictions' people circulate are jokes about American consumer life that aged into reality because American consumer life kept doing the same thing.",
      note: null,
      created_at: '2026-02-14T20:44:00Z',
    },
    {
      id: 12003,
      text: 'When the writers room thinned out in the late 90s, the show stopped predicting the world; it started lagging it.',
      note: null,
      created_at: '2026-02-14T20:46:00Z',
    },
    {
      id: 12004,
      text: 'The Tracey Ullman shorts are not a curiosity — they are a different show entirely, with the same family.',
      note: null,
      created_at: '2026-02-14T20:51:00Z',
    },
  ],
  highlight_count: 6,
};

const noImageFixture: ArticlePayload = {
  article: {
    id: 5099,
    title: 'A short note from a personal blog',
    author: null,
    url: 'https://small-blog.example.com/post/2',
    instapaper_url: 'https://www.instapaper.com/read/5099',
    instapaper_app_url: null,
    domain: 'small-blog.example.com',
    description:
      'Some sources never extract an OG image — the article still saves cleanly, the card just renders without a hero.',
    word_count: 620,
    estimated_read_min: 3,
    status: 'unread',
    progress: 0,
    saved_at: '2026-04-22T08:12:00Z',
    image: null,
  },
  highlights: [],
  highlight_count: 0,
};

const inProgressFixture: ArticlePayload = {
  article: {
    id: 4990,
    title:
      'On long-form attention: why the brain does not actually want to read 12,000 words on a phone',
    author: 'D. Hasan',
    url: 'https://example.com/long-form-attention',
    instapaper_url: 'https://www.instapaper.com/read/4990',
    instapaper_app_url: 'instapaper://read/4990',
    domain: 'aeon.co',
    description:
      'The "deep reading" debate is older than the smartphone. What changed is not your brain — it is the situational architecture around the act of reading.',
    word_count: 11820,
    estimated_read_min: 49,
    status: 'reading',
    progress: 0.42,
    saved_at: '2026-04-10T18:00:00Z',
    image: {
      cdn_url: 'https://cdn.rewind.rest/reading/articles/4990',
      url: 'https://cdn.aeon.co/2026/04/long-form-hero.jpg',
      thumbhash: 'KBgKDYJ4eHmXhoeEd4eIeIB4d3iIA4eHd4iIeIeIA4eHeId4iH',
      dominant_color: '#1a1a2e',
      accent_color: '#e94560',
    },
  },
  highlights: [
    {
      id: 13001,
      text: 'The phone is not a reading device pretending to be a phone — it is a phone pretending to be a reading device.',
      note: null,
      created_at: '2026-04-11T11:02:00Z',
    },
  ],
  highlight_count: 1,
};

const archivedNoHighlightsFixture: ArticlePayload = {
  article: {
    id: 5111,
    title: 'A quick read I finished but never highlighted',
    author: 'Casey Wong',
    url: 'https://example.com/quick-read',
    instapaper_url: 'https://www.instapaper.com/read/5111',
    instapaper_app_url: 'instapaper://read/5111',
    domain: 'medium.com',
    description:
      'Sometimes you read a thing all the way through and there is nothing to highlight — the card should still feel complete.',
    word_count: 1240,
    estimated_read_min: 5,
    status: 'archived',
    progress: 1,
    saved_at: '2026-03-30T22:18:00Z',
    image: {
      cdn_url: 'https://cdn.rewind.rest/reading/articles/5111',
      url: null,
      thumbhash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      dominant_color: '#3a3a3a',
      accent_color: '#9a9a9a',
    },
  },
  highlights: [],
  highlight_count: 0,
};

export const fixtures: Record<string, ArticlePayload> = {
  default: defaultFixture,
  'no-image': noImageFixture,
  'in-progress': inProgressFixture,
  'archived-no-highlights': archivedNoHighlightsFixture,
};
