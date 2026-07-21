/**
 * Tile-less geo projection for the query-result map view.
 *
 * Ported and generalized from the website's `src/lib/polyline.ts`
 * (decodePolyline + polylineToSvgPath). One equirectangular projector is
 * shared by BOTH point plots (check-ins / activity coordinates) and route
 * plots (decoded Strava polylines), so a mixed result — dots + strokes —
 * lands on a single consistent canvas.
 *
 * NO map tiles, NO external requests, NO API key: we compute a bounding box
 * over every coordinate, project with a cos(midLat) x-scale so east-west
 * distance isn't exaggerated at latitude, then fit-to-box with aspect
 * preserved and center on both axes.
 */

/**
 * Decode a Google encoded polyline (precision 1e-5) to [lat, lng] pairs.
 * Each coordinate is a delta from the previous one, zigzag-encoded in
 * base-64-ish 5-bit chunks offset by 63. Returns [] on malformed input
 * rather than throwing — the map view must never crash on odd data.
 */
export function decodePolyline(encoded: string): [number, number][] {
  const points: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  const readDelta = (): number => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };

  try {
    while (index < encoded.length) {
      lat += readDelta();
      lng += readDelta();
      const dLat = lat * 1e-5;
      const dLng = lng * 1e-5;
      if (!Number.isFinite(dLat) || !Number.isFinite(dLng)) break;
      points.push([dLat, dLng]);
    }
  } catch {
    return points;
  }
  return points;
}

/** Most points a single route keeps after downsampling. */
const MAX_ROUTE_POINTS = 120;

/** Round to one decimal — sub-0.05px precision is dead weight in the SVG. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** A lat/lng bounding box. */
export type Bounds = {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
};

/** Grow (or seed) a bounds with one coordinate. */
function extend(b: Bounds | null, lat: number, lng: number): Bounds {
  if (!b) return { minLat: lat, maxLat: lat, minLng: lng, maxLng: lng };
  return {
    minLat: Math.min(b.minLat, lat),
    maxLat: Math.max(b.maxLat, lat),
    minLng: Math.min(b.minLng, lng),
    maxLng: Math.max(b.maxLng, lng),
  };
}

/** Compute the bounds of a flat list of [lat, lng] points. Null when empty. */
export function boundsOf(points: [number, number][]): Bounds | null {
  let b: Bounds | null = null;
  for (const [lat, lng] of points) b = extend(b, lat, lng);
  return b;
}

/**
 * A projector fitting a fixed lat/lng bounds into a width x height box with
 * padding, aspect preserved (equirectangular, cos(midLat) x-scale), centered.
 * Returns a `project(lat, lng) -> [x, y]` closure so points AND routes share
 * one coordinate frame.
 */
export function makeProjector(
  bounds: Bounds,
  width: number,
  height: number,
  padding: number
): (lat: number, lng: number) => [number, number] {
  const midLat = (bounds.minLat + bounds.maxLat) / 2;
  const xScale = Math.cos((midLat * Math.PI) / 180) || 1;

  // Projected extents (x east, y south — SVG y grows downward).
  const px = (lng: number) => lng * xScale;
  const py = (lat: number) => -lat;

  const minX = px(bounds.minLng);
  const maxX = px(bounds.maxLng);
  const minY = py(bounds.maxLat);
  const maxY = py(bounds.minLat);

  const spanX = maxX - minX;
  const spanY = maxY - minY;

  const innerW = width - 2 * padding;
  const innerH = height - 2 * padding;
  // When a span is zero (single point / a straight N-S or E-W line) fall back
  // to a scale from the other axis so we still center rather than divide by 0.
  const scaleX = spanX > 0 ? innerW / spanX : Infinity;
  const scaleY = spanY > 0 ? innerH / spanY : Infinity;
  let scale = Math.min(scaleX, scaleY);
  if (!Number.isFinite(scale)) scale = 1; // single point: no extent at all

  const offsetX = padding + (innerW - spanX * scale) / 2;
  const offsetY = padding + (innerH - spanY * scale) / 2;

  return (lat: number, lng: number): [number, number] => [
    round1((px(lng) - minX) * scale + offsetX),
    round1((py(lat) - minY) * scale + offsetY),
  ];
}

/**
 * Downsample a route to at most MAX_ROUTE_POINTS, always keeping first + last,
 * then project each point through `project` and stitch into an SVG path
 * ("M x,y L x,y ..."). Returns null for a degenerate route (< 2 points).
 */
export function routeToPath(
  points: [number, number][],
  project: (lat: number, lng: number) => [number, number]
): string | null {
  if (points.length < 2) return null;
  let sampled = points;
  if (points.length > MAX_ROUTE_POINTS) {
    const step = (points.length - 1) / (MAX_ROUTE_POINTS - 1);
    sampled = [];
    for (let i = 0; i < MAX_ROUTE_POINTS; i++) {
      sampled.push(points[Math.round(i * step)]);
    }
  }
  const coords = sampled.map(([lat, lng]) => {
    const [x, y] = project(lat, lng);
    return `${x},${y}`;
  });
  return `M ${coords[0]} L ${coords.slice(1).join(' L ')}`;
}
