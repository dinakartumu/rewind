/**
 * Unit tests for the hand-rolled Google polyline decoder and the
 * waypoint sampler used by the running tools to ship map-friendly
 * route stops instead of raw encoded polylines.
 */
import { describe, it, expect } from 'vitest';
import { decodePolyline, sampleWaypoints } from '../tools/polyline.js';

describe('decodePolyline', () => {
  it('decodes the canonical Google example at 1e-5 precision', () => {
    expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')).toEqual([
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ]);
  });

  it('decodes a single-point polyline', () => {
    // Encoding of [38.5, -120.2] alone.
    expect(decodePolyline('_p~iF~ps|U')).toEqual([[38.5, -120.2]]);
  });

  it('returns an empty array for an empty string', () => {
    expect(decodePolyline('')).toEqual([]);
  });
});

describe('sampleWaypoints', () => {
  const point = (i: number): [number, number] => [i, -i];

  it('returns points unchanged when at or under the max', () => {
    const three = [point(0), point(1), point(2)];
    expect(sampleWaypoints(three)).toEqual(three);
    const eight = Array.from({ length: 8 }, (_, i) => point(i));
    expect(sampleWaypoints(eight)).toEqual(eight);
  });

  it('samples down to max points, preserving both endpoints', () => {
    const hundred = Array.from({ length: 100 }, (_, i) => point(i));
    const sampled = sampleWaypoints(hundred);
    expect(sampled).toHaveLength(8);
    expect(sampled[0]).toEqual(point(0));
    expect(sampled[sampled.length - 1]).toEqual(point(99));
  });

  it('samples evenly across the route', () => {
    const points = Array.from({ length: 15 }, (_, i) => point(i));
    const sampled = sampleWaypoints(points);
    // indices round(i * 14 / 7) = 0, 2, 4, 6, 8, 10, 12, 14
    expect(sampled).toEqual([0, 2, 4, 6, 8, 10, 12, 14].map(point));
  });

  it('respects a custom max', () => {
    const points = Array.from({ length: 10 }, (_, i) => point(i));
    const sampled = sampleWaypoints(points, 3);
    // indices round(i * 9 / 2) = 0, 5, 9 (Math.round rounds 4.5 up)
    expect(sampled).toEqual([point(0), point(5), point(9)]);
  });

  it('handles empty and single-point inputs', () => {
    expect(sampleWaypoints([])).toEqual([]);
    expect(sampleWaypoints([point(1)])).toEqual([point(1)]);
  });
});
