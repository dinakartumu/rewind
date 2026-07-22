/**
 * DOM render harness for the generic query-result MCP-UI views.
 *
 * The detector has unit coverage in web/lib/query-view.test.ts, but nothing
 * previously MOUNTED the React components. This suite mounts the top-level
 * <QueryResult> for every view with a representative fixture and asserts the
 * component actually produces meaningful DOM — closing the end-to-end
 * detect → render gap. Runs in the `web` vitest project (happy-dom + the React
 * JSX transform); see vitest.config.ts.
 *
 * Determinism / no-network notes:
 *   - Map tiles never load in the headless DOM (that's fine — we assert the
 *     Leaflet container OR the tile-less SVG fallback, never tiles).
 *   - grid/list <img> only need their `src` attribute set; no real image bytes
 *     are fetched or decoded.
 */
import { describe, it, expect } from 'vitest';
import { act, render, within } from '@testing-library/react';
import { QueryResult } from './QueryResult.js';
import { fixtures } from '../query-result.fixtures.js';
import { detectView, type QueryResultShape } from '../lib/query-view.js';

const CDN = 'https://cdn.dinakartumu.com';

/**
 * Render a payload, flushing effects inside act() so Leaflet's mount effect
 * (map view) settles deterministically.
 */
async function mount(payload: QueryResultShape): Promise<HTMLElement> {
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<QueryResult payload={payload} />));
  });
  return container;
}

/** Every render lands inside the shared card <article>. */
function card(container: HTMLElement): HTMLElement {
  const el = container.querySelector('article');
  expect(el).toBeTruthy();
  return el as HTMLElement;
}

// ── TABLE ────────────────────────────────────────────────────────────
describe('TableView render', () => {
  it('renders a <table> with the fixture column headers and a known cell', async () => {
    // forced-table is the image-grid data pinned to view:'table'.
    const container = await mount(fixtures['forced-table']);
    const table = card(container).querySelector('table');
    expect(table).toBeTruthy();
    const headers = [...table!.querySelectorAll('thead th')].map(
      (th) => th.textContent
    );
    expect(headers).toEqual(['album', 'cover', 'plays']);
    // A known cell value from the first data row.
    expect(within(table!).getByText('GUTS')).toBeTruthy();
    // One <tr> per data row (4) plus the header row.
    expect(table!.querySelectorAll('tbody tr')).toHaveLength(4);
  });
});

// ── CHART: bar ───────────────────────────────────────────────────────
describe('ChartView render — bar', () => {
  it('renders an <svg> with one <rect> per category and axis labels', async () => {
    const fx = fixtures['category-chart']; // 5 categories, bar chart
    const container = await mount(fx);
    const svg = card(container).querySelector('svg');
    expect(svg).toBeTruthy();
    // One bar rect per row (5). Bars are the only <rect>s in the bar chart.
    expect(svg!.querySelectorAll('rect')).toHaveLength(fx.rows.length);
    // Axis label for the first category is present as an SVG <text>.
    const labels = [...svg!.querySelectorAll('text')].map((t) => t.textContent);
    expect(labels).toContain('nytimes.com');
  });
});

// ── CHART: line (time series) ────────────────────────────────────────
describe('ChartView render — line', () => {
  it('renders an <svg> with a line <path> and period axis labels', async () => {
    const fx = fixtures['period-chart']; // period → time-series line/area
    const container = await mount(fx);
    const svg = card(container).querySelector('svg');
    expect(svg).toBeTruthy();
    // Line + area = two <path>s; no bar <rect>s in the time-series branch.
    expect(svg!.querySelectorAll('path').length).toBeGreaterThanOrEqual(1);
    expect(svg!.querySelectorAll('rect')).toHaveLength(0);
    const labels = [...svg!.querySelectorAll('text')].map((t) => t.textContent);
    expect(labels).toContain('2025-01');
  });
});

// ── HISTOGRAM ────────────────────────────────────────────────────────
describe('HistogramView render', () => {
  it('renders an <svg> with one <rect> per detected bin', async () => {
    const fx = fixtures['histogram-dist'];
    const expectedBins = detectView(fx).histogramBins!.length;
    expect(expectedBins).toBeGreaterThan(0);
    const container = await mount(fx);
    const svg = card(container).querySelector('svg');
    expect(svg).toBeTruthy();
    // Bins are the only <rect>s (axis marks are <line>/<text>).
    expect(svg!.querySelectorAll('rect')).toHaveLength(expectedBins);
    // Footer names the column + bin count.
    expect(card(container).textContent).toContain('bins');
  });
});

// ── SCATTER ──────────────────────────────────────────────────────────
describe('ScatterView render', () => {
  it('renders an <svg> with one <circle> per point', async () => {
    const fx = fixtures['scatter-plot']; // 10 points
    const container = await mount(fx);
    const svg = card(container).querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg!.querySelectorAll('circle')).toHaveLength(fx.rows.length);
    // Point label from the 3rd (text) column shows in a <title>.
    const titles = [...svg!.querySelectorAll('title')].map(
      (t) => t.textContent
    );
    expect(titles.some((t) => t?.includes('Morning shakeout'))).toBe(true);
  });
});

// ── STACKED BAR ──────────────────────────────────────────────────────
describe('StackedView render', () => {
  it('renders stacked segments and a legend with each series name', async () => {
    const fx = fixtures['stacked-bars'];
    const container = await mount(fx);
    const c = card(container);
    const svg = c.querySelector('svg');
    expect(svg).toBeTruthy();
    // Stacked segments are <rect>s; the 10-row fixture has many segments.
    expect(svg!.querySelectorAll('rect').length).toBeGreaterThan(3);
    // Legend lists every distinct series name.
    for (const series of ['Drama', 'Comedy', 'Horror', 'Sci-Fi']) {
      expect(c.textContent).toContain(series);
    }
    // x-axis category labels (years) are present as SVG text.
    const labels = [...svg!.querySelectorAll('text')].map((t) => t.textContent);
    expect(labels).toContain('2023');
  });
});

// ── TREEMAP ──────────────────────────────────────────────────────────
describe('TreemapView render', () => {
  it('renders one <rect> tile per positive-value category with labels', async () => {
    // treemap-shares auto-detects to treemap (15 categories); force is not
    // needed but assert the detected auto is treemap.
    const fx = fixtures['treemap-shares'];
    expect(detectView(fx).auto).toBe('treemap');
    const container = await mount(fx);
    const svg = card(container).querySelector('svg');
    expect(svg).toBeTruthy();
    // Tiles are the <rect>s; one per (positive) category row.
    expect(svg!.querySelectorAll('rect')).toHaveLength(fx.rows.length);
    // The dominant category label renders as SVG text.
    const labels = [...svg!.querySelectorAll('text')].map((t) => t.textContent);
    expect(labels).toContain('Drama');
    // Footer names the value column + category count.
    expect(card(container).textContent).toContain('categories');
  });
});

// ── SANKEY ───────────────────────────────────────────────────────────
describe('SankeyView render', () => {
  it('renders source + target node rects, link paths, and node labels', async () => {
    const fx = fixtures['sankey-flow']; // genre → decade
    expect(detectView(fx).auto).toBe('sankey');
    const container = await mount(fx);
    const c = card(container);
    const svg = c.querySelector('svg');
    expect(svg).toBeTruthy();
    // 5 distinct sources (genres) + 5 distinct targets (decades) = 10 node rects.
    const sources = new Set(fx.rows.map((r) => r[0]));
    const targets = new Set(fx.rows.map((r) => r[1]));
    expect(svg!.querySelectorAll('rect')).toHaveLength(
      sources.size + targets.size
    );
    // Link ribbons are <path>s; there is at least one flow.
    expect(svg!.querySelectorAll('path').length).toBeGreaterThan(0);
    // Node labels: a source (genre) and a target (decade) both appear.
    const labels = [...svg!.querySelectorAll('text')].map((t) => t.textContent);
    expect(labels).toContain('Drama');
    expect(labels).toContain('2010s');
  });
});

// ── COVER MOSAIC ─────────────────────────────────────────────────────
describe('MosaicView render', () => {
  it('renders one CDN <img> per row sized differently by the metric', async () => {
    // cover-mosaic auto-detects to `list` (image+label+metric); force `mosaic`.
    const fx: QueryResultShape = {
      ...fixtures['cover-mosaic'],
      view: 'mosaic',
    };
    const container = await mount(fx);
    const c = card(container);
    const imgs = c.querySelectorAll('img');
    expect(imgs).toHaveLength(fixtures['cover-mosaic'].rows.length); // 12
    // Every <img> src points at the CDN origin.
    for (const img of imgs) {
      expect(img.getAttribute('src')).toContain(`${CDN}/`);
    }
    // Tiles are sized by the metric: the tile wrapping each <img> has a width,
    // and the largest-metric tile is wider than the smallest.
    const wrappers = [...imgs].map((img) => img.parentElement as HTMLElement);
    const widths = wrappers.map((w) => parseFloat(w.style.width));
    expect(Math.max(...widths)).toBeGreaterThan(Math.min(...widths));
  });
});

// ── CALENDAR HEATMAP ─────────────────────────────────────────────────
describe('CalendarView render', () => {
  it('renders a full year of day cells with month labels', async () => {
    const fx = fixtures['calendar-heatmap']; // one year (2025)
    const container = await mount(fx);
    const svg = card(container).querySelector('svg');
    expect(svg).toBeTruthy();
    // Cells: one <rect> per day rendered in the year grid (365/366). A full
    // year always exceeds 360 day-cells; assert the grid is dense, not sparse.
    const cellCount = svg!.querySelectorAll('rect').length;
    expect(cellCount).toBeGreaterThanOrEqual(365);
    // Month labels: Jan and Dec both appear as SVG text.
    const labels = [...svg!.querySelectorAll('text')].map((t) => t.textContent);
    expect(labels).toContain('Jan');
    expect(labels).toContain('Dec');
  });

  it('renders a separate panel per year for a multi-year fixture', async () => {
    // Two calendar years of data → two <svg> panels.
    const multiYear: QueryResultShape = {
      columns: ['day', 'runs'],
      rows: [
        ['2024-02-10', 3],
        ['2024-07-04', 5],
        ['2024-11-20', 2],
        ['2025-01-15', 4],
        ['2025-06-06', 1],
        ['2025-09-09', 6],
      ],
    };
    expect(detectView(multiYear).auto).toBe('calendar');
    const container = await mount(multiYear);
    const svgs = card(container).querySelectorAll('svg');
    expect(svgs).toHaveLength(2);
    // Year headings for both panels are shown.
    expect(card(container).textContent).toContain('2024');
    expect(card(container).textContent).toContain('2025');
  });
});

// ── POLAR CLOCK ──────────────────────────────────────────────────────
describe('ClockView render — hours', () => {
  it('renders 24 hour spokes and a center total', async () => {
    const fx = fixtures['hour-clock'];
    const container = await mount(fx);
    const svg = card(container).querySelector('svg');
    expect(svg).toBeTruthy();
    // 24 hour spokes = 24 <line>s.
    expect(svg!.querySelectorAll('line')).toHaveLength(24);
    // Center total = sum of every play count.
    const total = fx.rows.reduce((a, r) => a + Number(r[1]), 0);
    const labels = [...svg!.querySelectorAll('text')].map((t) => t.textContent);
    expect(labels).toContain(total.toLocaleString('en-US'));
    expect(labels).toContain('total');
  });
});

describe('ClockView render — weekday', () => {
  it('renders 7 weekday wedges', async () => {
    // 7 weekday buckets keyed by name → 7 <path> wedges.
    const weekday: QueryResultShape = {
      columns: ['weekday', 'plays'],
      rows: [
        ['Monday', 120],
        ['Tuesday', 90],
        ['Wednesday', 140],
        ['Thursday', 110],
        ['Friday', 200],
        ['Saturday', 260],
        ['Sunday', 180],
      ],
    };
    const det = detectView(weekday);
    expect(det.clockKind).toBe('weekday');
    const container = await mount(weekday);
    const svg = card(container).querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg!.querySelectorAll('path')).toHaveLength(7);
  });
});

// ── STAT CARDS ───────────────────────────────────────────────────────
describe('StatView render', () => {
  it('renders one KPI tile per column with humanized labels and formatted numbers', async () => {
    const fx = fixtures['stat-cards']; // films / hours / directors, one row
    const container = await mount(fx);
    const c = card(container);
    // Humanized (Title-Cased, uppercased-in-CSS text is still the raw words).
    expect(c.textContent).toContain('Films');
    expect(c.textContent).toContain('Hours');
    expect(c.textContent).toContain('Directors');
    // Formatted numbers with thousands separators.
    expect(c.textContent).toContain('1,946'); // films
    expect(c.textContent).toContain('2,440'); // hours
    expect(c.textContent).toContain('312'); // directors
  });
});

// ── GRID ─────────────────────────────────────────────────────────────
describe('GridView render', () => {
  it('renders a card per row with a CDN <img> src and the label', async () => {
    // image-grid auto-detects to `list` (it has a metric); force `grid`.
    const fx: QueryResultShape = { ...fixtures['image-grid'], view: 'grid' };
    const container = await mount(fx);
    const c = card(container);
    const imgs = c.querySelectorAll('img');
    expect(imgs).toHaveLength(fixtures['image-grid'].rows.length); // 4 covers
    // Each <img> src points at the CDN origin.
    for (const img of imgs) {
      expect(img.getAttribute('src')).toContain(`${CDN}/`);
    }
    // Album names render as labels.
    expect(c.textContent).toContain('GUTS');
    expect(c.textContent).toContain('SOUR');
  });
});

// ── RANKED LIST ──────────────────────────────────────────────────────
describe('ListView render', () => {
  it('renders ranked rows with rank numbers, an <img> each, and a metric bar', async () => {
    const fx = fixtures['ranked-list']; // 5 artists, auto → list
    expect(detectView(fx).auto).toBe('list');
    const container = await mount(fx);
    const c = card(container);
    // One artwork <img> per ranked row.
    expect(c.querySelectorAll('img')).toHaveLength(fx.rows.length);
    // Rank numbers 1..5 render.
    for (let i = 1; i <= fx.rows.length; i++) {
      expect(c.textContent).toContain(String(i));
    }
    // Top artist name present.
    expect(c.textContent).toContain('Olivia Rodrigo');
    // Metric value (formatted) present for the leader.
    expect(c.textContent).toContain('4,120');
  });
});

// ── MAP ──────────────────────────────────────────────────────────────
// Leaflet DOES initialize in happy-dom here (a `.leaflet-container` is created
// and the mount effect settles under act()), so the primary assertion is the
// Leaflet container. We fall back to accepting the tile-less SVG projector
// render if a future DOM env can't init Leaflet — either path is a valid,
// non-crashing map render. We never assert on tiles (they don't load offline).
describe('MapView render', () => {
  it('mounts the Leaflet container (or the SVG fallback) for a point map', async () => {
    const container = await mount(fixtures['latlng-map']);
    const c = card(container);
    const leaflet = c.querySelector('.leaflet-container');
    const svgFallback = c.querySelector('svg[aria-label="Map of coordinates"]');
    // Leaflet path OR tile-less SVG fallback — the map must render one of them.
    expect(Boolean(leaflet) || Boolean(svgFallback)).toBe(true);
    // Whichever path, the accessible map region is labelled.
    expect(c.querySelector('[aria-label="Map of coordinates"]')).toBeTruthy();
  });

  it('mounts a map for a polyline route fixture', async () => {
    const container = await mount(fixtures['polyline-map']);
    const c = card(container);
    const leaflet = c.querySelector('.leaflet-container');
    const svgFallback = c.querySelector('svg[aria-label="Map of coordinates"]');
    expect(Boolean(leaflet) || Boolean(svgFallback)).toBe(true);
  });
});

// ── RESOLVER → RENDER INTEGRATION ────────────────────────────────────
// Feed each fixture WITHOUT forcing `view` and assert the AUTO-detected view
// renders its expected root marker. This proves detection + rendering are
// wired consistently: a detector that says "chart" while the component crashes
// (or renders the wrong view) fails here.
describe('resolver → render integration', () => {
  /** Assert a rendered card exposes the DOM marker expected for `view`. */
  function assertMarker(view: string, c: HTMLElement) {
    switch (view) {
      case 'table':
        expect(c.querySelector('table')).toBeTruthy();
        break;
      case 'chart':
      case 'histogram':
      case 'scatter':
      case 'stacked':
      case 'sankey':
      case 'treemap':
      case 'calendar':
      case 'clock':
        expect(c.querySelector('svg')).toBeTruthy();
        break;
      case 'mosaic':
        expect(c.querySelector('img')).toBeTruthy();
        break;
      case 'stat':
        // KPI tiles are divs (no table/img/svg); assert a humanized label tile.
        expect(c.querySelector('table')).toBeNull();
        expect(c.querySelectorAll('img')).toHaveLength(0);
        expect(c.textContent).toContain('Films');
        break;
      case 'grid':
      case 'list':
        expect(c.querySelector('img')).toBeTruthy();
        break;
      case 'map':
        expect(
          c.querySelector('.leaflet-container') ||
            c.querySelector('[aria-label="Map of coordinates"]')
        ).toBeTruthy();
        break;
      default:
        throw new Error(`unhandled view: ${view}`);
    }
  }

  for (const [name, fixture] of Object.entries(fixtures)) {
    it(`auto-renders "${name}" as its detected view`, async () => {
      // Strip any forced `view` so detection alone drives the choice.
      const { view: _forced, ...rest } = fixture;
      const payload = rest as QueryResultShape;
      const auto = detectView(payload).auto;
      const container = await mount(payload);
      assertMarker(auto, card(container));
    });
  }
});
