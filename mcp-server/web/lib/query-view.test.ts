import { describe, expect, it } from 'vitest';
import { detectView, isHexColor, isCdnImageUrl } from './query-view.js';
import { fixtures } from '../query-result.fixtures.js';

describe('detectView', () => {
  it('falls back to table for a scalar/mixed result', () => {
    const d = detectView(fixtures['scalar-table']);
    expect(d.auto).toBe('table');
    expect(d.available).not.toContain('chart');
  });

  it('detects a time-series chart for a period + numeric result', () => {
    const d = detectView(fixtures['period-chart']);
    expect(d.auto).toBe('chart');
    expect(d.available).toContain('chart');
    expect(d.chartIsTimeSeries).toBe(true);
    expect(d.chartLabelIndex).toBe(0);
    expect(d.chartValueIndex).toBe(1);
  });

  it('detects a bar chart for a category + numeric result', () => {
    const d = detectView(fixtures['category-chart']);
    expect(d.auto).toBe('chart');
    expect(d.chartIsTimeSeries).toBe(false);
  });

  it('detects a map for lat/lng columns', () => {
    const d = detectView(fixtures['latlng-map']);
    expect(d.auto).toBe('map');
    expect(d.latIndex).not.toBeNull();
    expect(d.lngIndex).not.toBeNull();
    expect(d.available).toContain('map');
  });

  it('detects a map for a polyline column', () => {
    const d = detectView(fixtures['polyline-map']);
    expect(d.auto).toBe('map');
    expect(d.polylineIndex).not.toBeNull();
  });

  it('detects a card grid for CDN image + label columns', () => {
    const d = detectView(fixtures['image-grid']);
    // image-grid carries a `plays` metric, so `list` is the auto default now,
    // but the grid view is still offered as a tab.
    expect(d.available).toContain('grid');
    expect(d.available).toContain('list');
    expect(d.imageIndex).not.toBeNull();
    expect(d.labelIndex).not.toBeNull();
  });

  it('never crashes on empty / malformed results and returns table', () => {
    expect(detectView({ columns: [], rows: [] }).auto).toBe('table');
    // Odd shapes: undefined cells, mismatched row lengths.
    const d = detectView({
      columns: ['a', 'b'],
      rows: [[undefined as unknown], [1, 2, 3]],
    });
    expect(d.auto).toBe('table');
    expect(d.available).toEqual(expect.any(Array));
  });

  it('map/grid take priority over chart in auto selection', () => {
    // lat/lng + a numeric metric still lands on map, not chart.
    const d = detectView({
      columns: ['lat', 'lng'],
      rows: [
        [37.77, -122.41],
        [37.78, -122.42],
      ],
    });
    expect(d.auto).toBe('map');
  });

  // ── calendar heatmap ────────────────────────────────────────────────
  it('detects a calendar heatmap for a daily-date + numeric result', () => {
    const d = detectView(fixtures['calendar-heatmap']);
    expect(d.auto).toBe('calendar');
    expect(d.available).toContain('calendar');
    expect(d.calendarDateIndex).toBe(0);
    expect(d.calendarValueIndex).toBe(1);
  });

  it('does NOT treat a YYYY-MM period as a calendar (stays a chart)', () => {
    const d = detectView(fixtures['period-chart']);
    expect(d.auto).toBe('chart');
    expect(d.available).not.toContain('calendar');
    expect(d.calendarDateIndex).toBeNull();
  });

  it('calendar beats chart when a daily-date + count is present', () => {
    const d = detectView({
      columns: ['day', 'miles'],
      rows: [
        ['2025-01-01', 3],
        ['2025-01-02', 5],
        ['2025-06-15', 8],
      ],
    });
    expect(d.auto).toBe('calendar');
  });

  // ── polar clock ─────────────────────────────────────────────────────
  it('detects a clock for hour-of-day (0-23) + count', () => {
    const d = detectView(fixtures['hour-clock']);
    expect(d.auto).toBe('clock');
    expect(d.available).toContain('clock');
    expect(d.clockKind).toBe('hour');
    expect(d.clockLabelIndex).toBe(0);
    expect(d.clockValueIndex).toBe(1);
  });

  it('detects a clock for weekday names + count', () => {
    const d = detectView({
      columns: ['weekday', 'plays'],
      rows: [
        ['Monday', 120],
        ['Tuesday', 90],
        ['Wednesday', 110],
        ['Thursday', 130],
        ['Friday', 200],
        ['Saturday', 240],
        ['Sunday', 180],
      ],
    });
    expect(d.auto).toBe('clock');
    expect(d.clockKind).toBe('weekday');
  });

  it('does NOT hijack an ordinary category + count as a clock (stays a chart)', () => {
    const d = detectView(fixtures['category-chart']);
    expect(d.auto).toBe('chart');
    expect(d.available).not.toContain('clock');
    expect(d.clockKind).toBeNull();
  });

  it('does NOT treat arbitrary large integers as hour-of-day', () => {
    const d = detectView({
      columns: ['bpm', 'songs'],
      rows: [
        [128, 12],
        [140, 8],
        [90, 20],
      ],
    });
    expect(d.auto).not.toBe('clock');
    expect(d.clockKind).toBeNull();
  });

  // ── stat cards ──────────────────────────────────────────────────────
  it('detects stat cards for a single-row numeric result', () => {
    const d = detectView(fixtures['stat-cards']);
    expect(d.auto).toBe('stat');
    expect(d.available).toContain('stat');
  });

  it('does NOT use stat cards for a multi-row result', () => {
    const d = detectView(fixtures['category-chart']);
    expect(d.available).not.toContain('stat');
  });

  // ── ranked list with art ────────────────────────────────────────────
  it('offers BOTH grid and list for an image + label + metric result', () => {
    const d = detectView(fixtures['ranked-list']);
    expect(d.available).toContain('grid');
    expect(d.available).toContain('list');
    // With exactly one obvious metric, the default is list.
    expect(d.auto).toBe('list');
    expect(d.metricIndex).not.toBeNull();
  });

  it('defaults to grid when an image+label result has no ranking metric', () => {
    const d = detectView(fixtures['image-grid']);
    // image-grid HAS a plays metric → list default; a metric-less variant:
    const d2 = detectView({
      columns: ['album', 'cover'],
      rows: [['GUTS', 'https://cdn.dinakartumu.com/a/1.jpg']],
    });
    expect(d.available).toContain('list');
    expect(d2.auto).toBe('grid');
    expect(d2.available).toContain('grid');
    expect(d2.available).toContain('list');
    expect(d2.metricIndex).toBeNull();
  });

  it('table remains the fallback for an odd multi-column shape', () => {
    const d = detectView({
      columns: ['a', 'b', 'c'],
      rows: [
        ['x', 'y', 'z'],
        ['p', 'q', 'r'],
      ],
    });
    expect(d.auto).toBe('table');
  });
});

describe('cell classifiers', () => {
  it('recognizes hex colors', () => {
    expect(isHexColor('#abc')).toBe(true);
    expect(isHexColor('#1a2b3c')).toBe(true);
    expect(isHexColor('red')).toBe(false);
    expect(isHexColor(42)).toBe(false);
  });

  it('recognizes CDN image URLs', () => {
    expect(isCdnImageUrl('https://cdn.dinakartumu.com/x/y.jpg')).toBe(true);
    expect(isCdnImageUrl('https://example.com/x.jpg')).toBe(false);
  });
});
