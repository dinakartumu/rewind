import type { CSSProperties } from 'react';

interface SparklineProps {
  points: number[];
  /** Stroke color. Falls back to currentColor when omitted. */
  color?: string;
  width?: number;
  height?: number;
  /** Optional aria-label for screen readers. */
  ariaLabel?: string;
}

const DEFAULT_WIDTH = 56;
const DEFAULT_HEIGHT = 16;

/**
 * Minimal sparkline. Renders an SVG polyline normalized to the box, with a
 * subtle fill under the curve. The most-recent bucket is always partial
 * (current week or current day in progress) so the last point gets a
 * lighter cap to suggest "in progress" rather than "dropped off".
 *
 * Returns null for empty / all-zero series so callers don't have to gate.
 */
export function Sparkline({
  points,
  color,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  ariaLabel,
}: SparklineProps) {
  if (!points.length) return null;

  const max = Math.max(...points);
  if (max === 0) return null;

  const stepX = points.length === 1 ? width : width / (points.length - 1);
  const xy = points.map((value, i) => ({
    x: i * stepX,
    // Reserve 1px top + 1px bottom so the stroke isn't clipped.
    y: height - 1 - (value / max) * (height - 2),
  }));

  // Smooth Catmull-Rom-style cubic path through every point — same
  // 1/6-scaled-tangent smoothing used by the larger artist sparkline,
  // so the small inline trend reads as a curve rather than a sawtooth.
  // Control-point y is clamped to the chart bounds so the curve can't
  // dip below the baseline (a dip would visually read as a negative
  // value, which doesn't make sense for play counts).
  const minY = 1;
  const maxY = height - 1;
  const clampY = (v: number) => Math.max(minY, Math.min(maxY, v));
  const fmt = (n: number) => n.toFixed(2);
  let linePath = `M ${fmt(xy[0].x)} ${fmt(xy[0].y)}`;
  for (let i = 1; i < xy.length; i++) {
    const prev = xy[i - 1];
    const curr = xy[i];
    const before = xy[i - 2] ?? prev;
    const after = xy[i + 1] ?? curr;
    const cp1x = prev.x + (curr.x - before.x) / 6;
    const cp1y = clampY(prev.y + (curr.y - before.y) / 6);
    const cp2x = curr.x - (after.x - prev.x) / 6;
    const cp2y = clampY(curr.y - (after.y - prev.y) / 6);
    linePath += ` C ${fmt(cp1x)} ${fmt(cp1y)}, ${fmt(cp2x)} ${fmt(cp2y)}, ${fmt(curr.x)} ${fmt(curr.y)}`;
  }
  const fillPath = `${linePath} L ${fmt(width)} ${height} L 0 ${height} Z`;

  const strokeColor = color ?? 'currentColor';

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role={ariaLabel ? 'img' : 'presentation'}
      aria-label={ariaLabel}
      style={svgStyle}
    >
      <path d={fillPath} fill={strokeColor} fillOpacity={0.15} stroke="none" />
      <path
        d={linePath}
        fill="none"
        stroke={strokeColor}
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const svgStyle: CSSProperties = {
  display: 'block',
  overflow: 'visible',
};
