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
  const xy = points.map((value, i) => {
    const x = i * stepX;
    // Reserve 1px top + 1px bottom so the stroke isn't clipped.
    const y = height - 1 - (value / max) * (height - 2);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  const linePath = `M ${xy.join(' L ')}`;
  const fillPath = `${linePath} L ${width.toFixed(2)},${height} L 0,${height} Z`;

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
