/**
 * Hand-rolled Google encoded-polyline decoder plus a waypoint sampler.
 *
 * Strava ships routes as Google-encoded polylines (precision 1e-5).
 * Map-oriented MCP clients often render markers and point-to-point
 * directions rather than polylines, so the running tools decode the
 * route and ship a handful of evenly-spaced [lat, lng] waypoints they
 * can chain as stops. No dependency: the algorithm is ~20 lines.
 */

export type LatLng = [number, number];

/**
 * Decode a Google encoded polyline into [lat, lng] pairs.
 *
 * Implements the standard algorithm: each coordinate delta is a
 * zigzag-encoded varint in base-64-ish chunks offset by 63, at 1e-5
 * precision. https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 */
export function decodePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = [];
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

  while (index < encoded.length) {
    lat += readDelta();
    lng += readDelta();
    points.push([lat / 1e5, lng / 1e5]);
  }

  return points;
}

/**
 * Evenly sample a route down to at most `max` waypoints, always
 * including the first and last points. Inputs at or under the limit
 * are returned unchanged.
 */
export function sampleWaypoints(points: LatLng[], max = 8): LatLng[] {
  if (points.length <= max) return points;
  const last = points.length - 1;
  return Array.from(
    { length: max },
    (_, i) => points[Math.round((i * last) / (max - 1))]
  );
}
