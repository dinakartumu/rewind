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

  it('detects a grid for CDN image + label columns', () => {
    const d = detectView(fixtures['image-grid']);
    expect(d.auto).toBe('grid');
    expect(d.imageIndex).not.toBeNull();
    expect(d.labelIndex).not.toBeNull();
    expect(d.available).toContain('grid');
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
