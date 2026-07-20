import { describe, it, expect } from 'vitest';
import {
  syncTraktHistory,
  buildMovieFeedItem,
  shouldMarkRewatch,
} from './history-sync.js';

describe('syncTraktHistory', () => {
  it('exports the sync entrypoint', () => {
    expect(typeof syncTraktHistory).toBe('function');
  });
});

describe('buildMovieFeedItem', () => {
  it('builds a movie_watched feed item with trakt source id', () => {
    const item = buildMovieFeedItem({
      movieId: 42,
      title: 'Heat',
      year: 1995,
      watchedAt: '2026-06-01T20:00:00.000Z',
    });
    expect(item.domain).toBe('watching');
    expect(item.eventType).toBe('movie_watched');
    expect(item.title).toBe('Watched Heat (1995)');
    expect(item.sourceId).toBe('trakt:movie:42:2026-06-01');
    expect(item.occurredAt).toBe('2026-06-01T20:00:00.000Z');
  });

  it('omits year when null', () => {
    const item = buildMovieFeedItem({
      movieId: 7,
      title: 'Unknown Film',
      year: null,
      watchedAt: '2026-06-02T10:00:00.000Z',
    });
    expect(item.title).toBe('Watched Unknown Film');
  });
});

describe('shouldMarkRewatch', () => {
  it('is a rewatch when an earlier watch exists', () => {
    expect(shouldMarkRewatch(1)).toBe(true);
    expect(shouldMarkRewatch(3)).toBe(true);
  });

  it('is not a rewatch for the first watch', () => {
    expect(shouldMarkRewatch(0)).toBe(false);
  });
});
