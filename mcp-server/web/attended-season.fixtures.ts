import type { SeasonPayload } from './components/SeasonGrid.js';
import realData from './fixtures/attended-season.json' with { type: 'json' };

const real = realData as unknown as SeasonPayload;

export const fixtures: Record<string, SeasonPayload> = {
  default: real,

  empty: {
    league: 'mlb',
    season: 2025,
    attended_count: 0,
    wins: 0,
    losses: 0,
    data: [],
  },
};
