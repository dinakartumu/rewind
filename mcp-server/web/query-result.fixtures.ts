import type { QueryResultShape } from './lib/query-view.js';

const CDN = 'https://cdn.dinakartumu.com';

/** Scalar / mixed table — falls through to the styled table view. */
const scalarTable: QueryResultShape = {
  columns: ['title', 'watched_at', 'rating', 'accent_color'],
  rows: [
    ['Dune: Part Two', '2025-03-14T20:30:00Z', 4.5, '#c8763a'],
    ['Poor Things', '2025-02-02T00:00:00Z', 5, '#7a5cff'],
    ['The Zone of Interest', '2025-01-19T00:00:00Z', 4, '#3a3a3a'],
  ],
};

/** One period column + one numeric column → time-series line/area chart. */
const periodChart: QueryResultShape = {
  columns: ['month', 'plays'],
  rows: [
    ['2025-01', 1820],
    ['2025-02', 1640],
    ['2025-03', 2110],
    ['2025-04', 1990],
    ['2025-05', 2450],
    ['2025-06', 2180],
    ['2025-07', 2620],
  ],
};

/** One category column + one numeric column → bar chart. */
const categoryChart: QueryResultShape = {
  columns: ['domain', 'articles'],
  rows: [
    ['nytimes.com', 142],
    ['theatlantic.com', 98],
    ['wsj.com', 71],
    ['newyorker.com', 63],
    ['stratechery.com', 40],
  ],
};

/** lat/lng columns → tile-less point map (San Francisco check-ins). */
const latLngMap: QueryResultShape = {
  columns: ['venue', 'lat', 'lng'],
  rows: [
    ['Blue Bottle', 37.7765, -122.3948],
    ['Ferry Building', 37.7955, -122.3937],
    ['Dolores Park', 37.7596, -122.4269],
    ['Golden Gate Park', 37.7694, -122.4862],
    ['Coit Tower', 37.8024, -122.4058],
    ['Mission Dolores', 37.7643, -122.4266],
  ],
};

/** Encoded polyline column → tile-less route map (a short Strava run). */
const polylineMap: QueryResultShape = {
  columns: ['name', 'map_polyline'],
  rows: [
    [
      'Embarcadero loop',
      'aowkFtqjaVv@sBd@qBHm@AeAKm@Um@a@e@e@Wm@Ei@Fe@Vc@d@Wl@Kt@?t@Nn@Zh@d@Zh@Nl@?l@Ml@Wd@e@Xk@Jm@Ai@Kg@Yc@_@',
    ],
    [
      'Bay run',
      'g}wkFrpjaV_@}BQ}@O_ASo@_@k@e@Yk@Ki@?g@Le@\\W`@Kd@?d@L`@X\\d@Rf@Dh@?',
    ],
  ],
};

/** CDN image column + label column → card grid. */
const imageGrid: QueryResultShape = {
  columns: ['album', 'cover', 'plays'],
  rows: [
    ['GUTS', `${CDN}/listening/albums/1/original.jpg?v=1`, 412],
    ['SOUR', `${CDN}/listening/albums/2/original.jpg?v=1`, 388],
    ['Short n’ Sweet', `${CDN}/listening/albums/3/original.jpg?v=1`, 301],
    ['emails i can’t send', `${CDN}/listening/albums/4/original.jpg?v=1`, 254],
  ],
};

/**
 * Daily date + count spanning ~a year → calendar heatmap. Sparse: only the
 * days actually run are present; the heatmap fills the rest as empty cells.
 */
const calendarHeatmap: QueryResultShape = (() => {
  const rows: (string | number)[][] = [];
  const start = new Date('2025-01-06T00:00:00Z');
  // ~110 scattered active days across the year, deterministic pseudo-random.
  let seed = 7;
  for (let i = 0; i < 360; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    if (seed % 3 === 0) continue; // ~1/3 of days are rest days
    const d = new Date(start.getTime() + i * 86400000);
    const iso = d.toISOString().slice(0, 10);
    const count = 1 + (seed % 5); // 1..5 km-ish
    rows.push([iso, count]);
  }
  return { columns: ['day', 'runs'], rows };
})();

/** Single row + several numeric columns → big-number stat cards. */
const statCards: QueryResultShape = {
  columns: ['films', 'hours', 'directors'],
  rows: [[1946, 2440, 312]],
};

/** rank/name/cover/plays → ranked list with art (and grid). */
const rankedList: QueryResultShape = {
  columns: ['artist', 'cover', 'plays'],
  rows: [
    ['Olivia Rodrigo', `${CDN}/listening/artists/1/original.jpg?v=1`, 4120],
    ['Taylor Swift', `${CDN}/listening/artists/2/original.jpg?v=1`, 3880],
    ['Sabrina Carpenter', `${CDN}/listening/artists/3/original.jpg?v=1`, 3010],
    ['Clairo', `${CDN}/listening/artists/4/original.jpg?v=1`, 2540],
    ['Phoebe Bridgers', `${CDN}/listening/artists/5/original.jpg?v=1`, 2110],
  ],
};

/** Hour-of-day (0-23) + count → polar clock (24 spokes). */
const hourClock: QueryResultShape = {
  columns: ['hour', 'plays'],
  rows: [
    [0, 120],
    [1, 60],
    [2, 30],
    [3, 12],
    [4, 8],
    [5, 15],
    [6, 40],
    [7, 90],
    [8, 160],
    [9, 210],
    [10, 240],
    [11, 220],
    [12, 260],
    [13, 250],
    [14, 230],
    [15, 240],
    [16, 280],
    [17, 320],
    [18, 300],
    [19, 340],
    [20, 380],
    [21, 360],
    [22, 260],
    [23, 180],
  ],
};

/** Same image-grid data but forced to the table view via `view`. */
const forcedTable: QueryResultShape = { ...imageGrid, view: 'table' };

export const fixtures: Record<string, QueryResultShape> = {
  'scalar-table': scalarTable,
  'period-chart': periodChart,
  'category-chart': categoryChart,
  'latlng-map': latLngMap,
  'polyline-map': polylineMap,
  'image-grid': imageGrid,
  'calendar-heatmap': calendarHeatmap,
  'stat-cards': statCards,
  'ranked-list': rankedList,
  'hour-clock': hourClock,
  'forced-table': forcedTable,
};
