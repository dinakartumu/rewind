import type { EventDetail } from './components/GameCard.js';
import realData from './fixtures/attended-event.json' with { type: 'json' };

const real = realData as unknown as EventDetail;

export const fixtures: Record<string, EventDetail> = {
  default: real,

  'no-show': {
    ...real,
    attended: false,
    tickets: [],
    players: [],
  },
};
