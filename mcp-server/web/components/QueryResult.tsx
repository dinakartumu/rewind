import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { cardOuterChrome, CARD_OUTER_CLASSNAME } from '../lib/card-tokens.js';
import {
  detectView,
  isCdnImageUrl,
  isHexColor,
  isNumericCell,
  looksLikeTimestamp,
  toNumber,
  weekdayNameToIndex,
  type MapConfig,
  type QueryResultShape,
  type ViewMode,
} from '../lib/query-view.js';
import {
  boundsOf,
  decodePolyline,
  makeProjector,
  routeToPath,
  type Bounds,
} from '../lib/geo-projection.js';

/**
 * Generic query-result renderer. Reads a raw SQL result and adapts it into a
 * table, card-grid, chart, or tile-less map. Auto-detects the best view (or
 * honours an explicit `view`) and offers a lightweight switcher; `table` is
 * always available and is the safe default.
 */

// ── shared style tokens ──────────────────────────────────────────────
const cardStyle: CSSProperties = {
  ...cardOuterChrome,
  padding: 0,
  overflow: 'hidden',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '12px 16px',
  borderBottom: '1px solid var(--color-border-tertiary, rgba(0,0,0,0.1))',
  flexWrap: 'wrap',
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  fontWeight: 600,
  letterSpacing: 0.2,
  opacity: 0.85,
};

const tabsStyle: CSSProperties = {
  display: 'flex',
  gap: 4,
  background: 'var(--color-background-secondary, rgba(0,0,0,0.04))',
  borderRadius: 8,
  padding: 3,
};

function tabStyle(active: boolean): CSSProperties {
  return {
    border: 'none',
    background: active
      ? 'var(--color-background-primary, #fff)'
      : 'transparent',
    color: active
      ? 'var(--color-text-primary, inherit)'
      : 'var(--color-text-secondary, rgba(0,0,0,0.6))',
    fontWeight: active ? 600 : 500,
    fontSize: 12,
    padding: '4px 10px',
    borderRadius: 6,
    cursor: 'pointer',
    textTransform: 'capitalize',
    boxShadow: active ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
  };
}

const bodyStyle: CSSProperties = { padding: 16, overflowX: 'auto' };

const emptyStyle: CSSProperties = {
  padding: 24,
  textAlign: 'center',
  opacity: 0.6,
  fontSize: 14,
};

// Chart accent: the host doesn't publish an accent var, so derive one from the
// primary text color with a fallback that reads on both light + dark cards.
const ACCENT = 'var(--color-text-primary, #3b82f6)';

// ── cell formatting ──────────────────────────────────────────────────
const CELL_MAX = 80;

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const opts: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  };
  // Include time only when it isn't midnight.
  if (/[T ]\d{2}:\d{2}/.test(iso) && !/[T ]00:00/.test(iso)) {
    opts.hour = 'numeric';
    opts.minute = '2-digit';
  }
  return d.toLocaleString('en-US', opts);
}

function displayCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  if (looksLikeTimestamp(s)) return formatTimestamp(s);
  if (s.length > CELL_MAX) return s.slice(0, CELL_MAX - 1) + '…';
  return s;
}

// ── TABLE ────────────────────────────────────────────────────────────
function TableView({
  columns,
  rows,
  numericCols,
  art,
}: {
  columns: string[];
  rows: unknown[][];
  numericCols: Set<number>;
  art?: Record<string, string>;
}) {
  return (
    <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
      <thead>
        <tr>
          {columns.map((c, i) => (
            <th
              key={i}
              style={{
                textAlign: numericCols.has(i) ? 'right' : 'left',
                padding: '6px 10px',
                borderBottom:
                  '1px solid var(--color-border-tertiary, rgba(0,0,0,0.1))',
                fontWeight: 600,
                opacity: 0.7,
                whiteSpace: 'nowrap',
              }}
            >
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, ri) => (
          <tr key={ri}>
            {row.map((cell, ci) => (
              <td
                key={ci}
                style={{
                  textAlign: numericCols.has(ci) ? 'right' : 'left',
                  padding: '6px 10px',
                  borderBottom:
                    '1px solid var(--color-border-tertiary, rgba(0,0,0,0.06))',
                  fontVariantNumeric: numericCols.has(ci)
                    ? 'tabular-nums'
                    : 'normal',
                  whiteSpace: 'nowrap',
                  maxWidth: 320,
                }}
              >
                <CellContent value={cell} art={art} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CellContent({
  value,
  art,
}: {
  value: unknown;
  art?: Record<string, string>;
}) {
  if (isHexColor(value)) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span
          style={{
            width: 12,
            height: 12,
            borderRadius: 3,
            background: value,
            border: '1px solid rgba(127,127,127,0.35)',
            display: 'inline-block',
          }}
        />
        {value}
      </span>
    );
  }
  if (isCdnImageUrl(value)) {
    const src = art?.[value] ?? value;
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        style={{
          width: 28,
          height: 28,
          borderRadius: 4,
          objectFit: 'cover',
          verticalAlign: 'middle',
        }}
      />
    );
  }
  return <>{displayCell(value)}</>;
}

// ── GRID ─────────────────────────────────────────────────────────────
function GridView({
  rows,
  imageIndex,
  labelIndex,
  metricIndex,
  metricLabel,
  art,
  onOpen,
}: {
  rows: unknown[][];
  imageIndex: number;
  labelIndex: number;
  metricIndex: number | null;
  metricLabel: string | null;
  art?: Record<string, string>;
  onOpen?: (url: string) => void;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
        gap: 12,
      }}
    >
      {rows.map((row, i) => {
        const rawUrl = row[imageIndex];
        const url = typeof rawUrl === 'string' ? rawUrl : '';
        const src = (url && art?.[url]) || url;
        const label = displayCell(row[labelIndex]);
        const metric =
          metricIndex !== null ? displayCell(row[metricIndex]) : '';
        return (
          <div
            key={i}
            role={onOpen ? 'button' : undefined}
            onClick={onOpen && url ? () => onOpen(url) : undefined}
            style={{ cursor: onOpen && url ? 'pointer' : 'default' }}
          >
            <div
              style={{
                width: '100%',
                aspectRatio: '1 / 1',
                borderRadius: 8,
                overflow: 'hidden',
                background:
                  'var(--color-background-secondary, rgba(0,0,0,0.04))',
              }}
            >
              {src ? (
                <img
                  src={src}
                  alt={label}
                  loading="lazy"
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : null}
            </div>
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                marginTop: 6,
                lineHeight: 1.25,
              }}
            >
              {label}
            </div>
            {metric ? (
              <div style={{ fontSize: 11, opacity: 0.6, marginTop: 1 }}>
                {metricLabel ? `${metric} ${metricLabel}` : metric}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// ── CHART ────────────────────────────────────────────────────────────
const CHART_W = 480;
const CHART_H = 160;
const CHART_TOP = 8;
const CHART_LABEL_BAND = 22;
const CHART_PLOT_H = CHART_H - CHART_TOP - CHART_LABEL_BAND;

function ChartView({
  rows,
  labelIndex,
  valueIndex,
  isTimeSeries,
}: {
  rows: unknown[][];
  labelIndex: number;
  valueIndex: number;
  isTimeSeries: boolean;
}) {
  const points = rows.map((r) => ({
    label: displayCell(r[labelIndex]),
    value: toNumber(r[valueIndex]),
  }));
  const values = points.map((p) => (Number.isFinite(p.value) ? p.value : 0));
  const max = Math.max(0, ...values);
  const hasData = max > 0;

  if (!hasData) {
    return <div style={emptyStyle}>No data to chart</div>;
  }

  const n = points.length;
  const step = n > 0 ? CHART_W / n : CHART_W;

  // Thin labels when crowded so ticks stay legible.
  const labelStride = Math.max(1, Math.ceil(n / 12));

  if (isTimeSeries) {
    // Line/area time series.
    const xs = points.map((_, i) =>
      n === 1 ? CHART_W / 2 : (i / (n - 1)) * CHART_W
    );
    const ys = values.map(
      (v) => CHART_TOP + CHART_PLOT_H - (v / max) * CHART_PLOT_H
    );
    const line = xs
      .map((x, i) => `${i === 0 ? 'M' : 'L'} ${round1(x)},${round1(ys[i])}`)
      .join(' ');
    const area = `${line} L ${round1(xs[n - 1])},${CHART_TOP + CHART_PLOT_H} L ${round1(xs[0])},${CHART_TOP + CHART_PLOT_H} Z`;
    return (
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        role="img"
        style={{ width: '100%', height: 'auto' }}
      >
        <path d={area} fill={ACCENT} opacity={0.12} />
        <path
          d={line}
          fill="none"
          stroke={ACCENT}
          strokeWidth={2}
          strokeLinejoin="round"
        />
        {points.map((p, i) =>
          i % labelStride === 0 ? (
            <text
              key={i}
              x={xs[i]}
              y={CHART_H - 6}
              fontSize={10}
              textAnchor="middle"
              fill="var(--color-text-secondary, rgba(0,0,0,0.6))"
            >
              {p.label}
            </text>
          ) : null
        )}
      </svg>
    );
  }

  // Bar chart.
  const barWidth = Math.min(28, step * 0.62);
  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      role="img"
      style={{ width: '100%', height: 'auto' }}
    >
      {points.map((p, i) => {
        const h = (values[i] / max) * CHART_PLOT_H;
        const x = i * step + (step - barWidth) / 2;
        const y = CHART_TOP + CHART_PLOT_H - h;
        return (
          <g key={i}>
            <rect
              x={round1(x)}
              y={round1(y)}
              width={round1(barWidth)}
              height={round1(h)}
              rx={2}
              fill={ACCENT}
              opacity={0.85}
            />
            {i % labelStride === 0 ? (
              <text
                x={i * step + step / 2}
                y={CHART_H - 6}
                fontSize={10}
                textAnchor="middle"
                fill="var(--color-text-secondary, rgba(0,0,0,0.6))"
              >
                {p.label}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

// ── HISTOGRAM ────────────────────────────────────────────────────────
// Distribution of a single numeric column: the detector pre-bins the raw
// values (Freedman–Diaconis) and this is a pure renderer. Bars run along the
// value axis; the y-axis is a frequency (count) axis.
const HIST_W = 480;
const HIST_H = 180;
const HIST_TOP = 8;
const HIST_LEFT = 30; // room for the count axis
const HIST_LABEL_BAND = 24; // room for value axis labels
const HIST_PLOT_H = HIST_H - HIST_TOP - HIST_LABEL_BAND;
const HIST_PLOT_W = HIST_W - HIST_LEFT;

/** Compact numeric label for an axis tick. */
function axisNumber(v: number): string {
  if (!Number.isFinite(v)) return '';
  const abs = Math.abs(v);
  const decimals = Number.isInteger(v) ? 0 : abs < 10 ? 1 : abs < 100 ? 1 : 0;
  return v.toLocaleString('en-US', { maximumFractionDigits: decimals });
}

function HistogramView({
  bins,
  columnName,
}: {
  bins: { lo: number; hi: number; count: number }[];
  columnName: string;
}) {
  const maxCount = Math.max(0, ...bins.map((b) => b.count));
  if (!bins.length || maxCount <= 0) {
    return <div style={emptyStyle}>No distribution to chart</div>;
  }
  const n = bins.length;
  const barSlot = HIST_PLOT_W / n;
  const barGap = Math.min(2, barSlot * 0.12);
  const barWidth = Math.max(1, barSlot - barGap);

  // Count-axis ticks: 0, mid, max.
  const yTicks = [0, Math.round(maxCount / 2), maxCount].filter(
    (v, i, a) => a.indexOf(v) === i
  );
  // Value-axis labels: bin edges, thinned when crowded.
  const edgeStride = Math.max(1, Math.ceil(n / 8));

  return (
    <div>
      <svg
        viewBox={`0 0 ${HIST_W} ${HIST_H}`}
        role="img"
        aria-label={`Histogram of ${columnName}`}
        style={{ width: '100%', height: 'auto' }}
      >
        {/* count-axis gridlines + labels */}
        {yTicks.map((t, i) => {
          const y = HIST_TOP + HIST_PLOT_H - (t / maxCount) * HIST_PLOT_H;
          return (
            <g key={i}>
              <line
                x1={HIST_LEFT}
                y1={round1(y)}
                x2={HIST_W}
                y2={round1(y)}
                stroke="var(--color-border-tertiary, rgba(0,0,0,0.08))"
                strokeWidth={1}
              />
              <text
                x={HIST_LEFT - 4}
                y={round1(y) + 3}
                fontSize={9}
                textAnchor="end"
                fill="var(--color-text-secondary, rgba(0,0,0,0.55))"
              >
                {axisNumber(t)}
              </text>
            </g>
          );
        })}
        {bins.map((b, i) => {
          const h = (b.count / maxCount) * HIST_PLOT_H;
          const x = HIST_LEFT + i * barSlot + barGap / 2;
          const y = HIST_TOP + HIST_PLOT_H - h;
          return (
            <rect
              key={i}
              x={round1(x)}
              y={round1(y)}
              width={round1(barWidth)}
              height={round1(h)}
              rx={1}
              fill={ACCENT}
              opacity={0.82}
            >
              <title>{`${axisNumber(b.lo)}–${axisNumber(b.hi)}: ${b.count}`}</title>
            </rect>
          );
        })}
        {/* value-axis edge labels */}
        {bins.map((b, i) =>
          i % edgeStride === 0 ? (
            <text
              key={i}
              x={round1(HIST_LEFT + i * barSlot)}
              y={HIST_H - 8}
              fontSize={9}
              textAnchor="middle"
              fill="var(--color-text-secondary, rgba(0,0,0,0.6))"
            >
              {axisNumber(b.lo)}
            </text>
          ) : null
        )}
        {/* trailing edge label for the last bin */}
        <text
          x={round1(HIST_LEFT + n * barSlot)}
          y={HIST_H - 8}
          fontSize={9}
          textAnchor="middle"
          fill="var(--color-text-secondary, rgba(0,0,0,0.6))"
        >
          {axisNumber(bins[n - 1].hi)}
        </text>
      </svg>
      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>
        {humanizeColumn(columnName)} · {n} bins
      </div>
    </div>
  );
}

// ── SCATTER ──────────────────────────────────────────────────────────
// Two numeric columns → a dot cloud. x = col0, y = col1; an optional 3rd text
// column labels each point (tooltip title).
const SCAT_W = 480;
const SCAT_H = 300;
const SCAT_PAD_L = 34;
const SCAT_PAD_B = 26;
const SCAT_PAD_T = 10;
const SCAT_PAD_R = 10;

function ScatterView({
  rows,
  xIndex,
  yIndex,
  labelIndex,
  xName,
  yName,
}: {
  rows: unknown[][];
  xIndex: number;
  yIndex: number;
  labelIndex: number | null;
  xName: string;
  yName: string;
}) {
  const pts = useMemo(() => {
    const out: { x: number; y: number; label: string }[] = [];
    for (const r of rows) {
      const x = toNumber(r[xIndex]);
      const y = toNumber(r[yIndex]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const label = labelIndex !== null ? displayCell(r[labelIndex]) : '';
      out.push({ x, y, label });
    }
    return out;
  }, [rows, xIndex, yIndex, labelIndex]);

  const bounds = useMemo(() => {
    if (!pts.length) return null;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    // Pad degenerate spans so a single-valued axis still renders.
    if (minX === maxX) {
      minX -= 0.5;
      maxX += 0.5;
    }
    if (minY === maxY) {
      minY -= 0.5;
      maxY += 0.5;
    }
    return { minX, maxX, minY, maxY };
  }, [pts]);

  if (!bounds) {
    return <div style={emptyStyle}>No points to plot</div>;
  }

  const plotW = SCAT_W - SCAT_PAD_L - SCAT_PAD_R;
  const plotH = SCAT_H - SCAT_PAD_T - SCAT_PAD_B;
  const sx = (x: number) =>
    SCAT_PAD_L + ((x - bounds.minX) / (bounds.maxX - bounds.minX)) * plotW;
  const sy = (y: number) =>
    SCAT_PAD_T +
    plotH -
    ((y - bounds.minY) / (bounds.maxY - bounds.minY)) * plotH;

  const dotR = pts.length > 200 ? 2 : pts.length > 60 ? 2.75 : 3.5;
  const xTicks = [bounds.minX, (bounds.minX + bounds.maxX) / 2, bounds.maxX];
  const yTicks = [bounds.minY, (bounds.minY + bounds.maxY) / 2, bounds.maxY];

  return (
    <div>
      <svg
        viewBox={`0 0 ${SCAT_W} ${SCAT_H}`}
        role="img"
        aria-label={`Scatter plot of ${yName} vs ${xName}`}
        style={{ width: '100%', height: 'auto' }}
      >
        {/* axes */}
        <line
          x1={SCAT_PAD_L}
          y1={SCAT_PAD_T}
          x2={SCAT_PAD_L}
          y2={SCAT_PAD_T + plotH}
          stroke="var(--color-border-tertiary, rgba(0,0,0,0.15))"
          strokeWidth={1}
        />
        <line
          x1={SCAT_PAD_L}
          y1={SCAT_PAD_T + plotH}
          x2={SCAT_PAD_L + plotW}
          y2={SCAT_PAD_T + plotH}
          stroke="var(--color-border-tertiary, rgba(0,0,0,0.15))"
          strokeWidth={1}
        />
        {/* y ticks */}
        {yTicks.map((t, i) => (
          <text
            key={`y${i}`}
            x={SCAT_PAD_L - 4}
            y={round1(sy(t)) + 3}
            fontSize={9}
            textAnchor="end"
            fill="var(--color-text-secondary, rgba(0,0,0,0.55))"
          >
            {axisNumber(t)}
          </text>
        ))}
        {/* x ticks */}
        {xTicks.map((t, i) => (
          <text
            key={`x${i}`}
            x={round1(sx(t))}
            y={SCAT_PAD_T + plotH + 14}
            fontSize={9}
            textAnchor="middle"
            fill="var(--color-text-secondary, rgba(0,0,0,0.55))"
          >
            {axisNumber(t)}
          </text>
        ))}
        {pts.map((p, i) => (
          <circle
            key={i}
            cx={round1(sx(p.x))}
            cy={round1(sy(p.y))}
            r={dotR}
            fill={ACCENT}
            opacity={0.7}
          >
            {p.label ? (
              <title>{`${p.label} (${axisNumber(p.x)}, ${axisNumber(p.y)})`}</title>
            ) : (
              <title>{`(${axisNumber(p.x)}, ${axisNumber(p.y)})`}</title>
            )}
          </circle>
        ))}
      </svg>
      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>
        {humanizeColumn(xName)} (x) · {humanizeColumn(yName)} (y)
      </div>
    </div>
  );
}

// ── STACKED BAR ──────────────────────────────────────────────────────
// category (x-axis) + series (stacked segments) + numeric value. Segments are
// colored by series with a legend below.
const STACK_W = 480;
const STACK_H = 200;
const STACK_TOP = 8;
const STACK_LEFT = 30;
const STACK_LABEL_BAND = 24;
const STACK_PLOT_H = STACK_H - STACK_TOP - STACK_LABEL_BAND;
const STACK_PLOT_W = STACK_W - STACK_LEFT;

// A small categorical palette derived from the accent hue plus muted tones;
// opacity varies so it reads on both light and dark cards without new colors.
const SERIES_OPACITY = [0.9, 0.68, 0.5, 0.36, 0.26, 0.85, 0.6, 0.44];

function StackedView({
  rows,
  categoryIndex,
  seriesIndex,
  valueIndex,
  categoryName,
}: {
  rows: unknown[][];
  categoryIndex: number;
  seriesIndex: number;
  valueIndex: number;
  categoryName: string;
}) {
  const { categories, series, matrix, max } = useMemo(() => {
    const catOrder: string[] = [];
    const catSeen = new Set<string>();
    const serOrder: string[] = [];
    const serSeen = new Set<string>();
    // category → series → summed value
    const map = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const cat = displayCell(r[categoryIndex]);
      const ser = displayCell(r[seriesIndex]);
      const v = toNumber(r[valueIndex]);
      const val = Number.isFinite(v) ? v : 0;
      if (!catSeen.has(cat)) {
        catSeen.add(cat);
        catOrder.push(cat);
      }
      if (!serSeen.has(ser)) {
        serSeen.add(ser);
        serOrder.push(ser);
      }
      let inner = map.get(cat);
      if (!inner) {
        inner = new Map();
        map.set(cat, inner);
      }
      inner.set(ser, (inner.get(ser) ?? 0) + val);
    }
    // Dense matrix [category][series]; totals per category for the y-scale.
    const mtx = catOrder.map((cat) =>
      serOrder.map((ser) => map.get(cat)?.get(ser) ?? 0)
    );
    const mx = Math.max(0, ...mtx.map((row) => row.reduce((a, b) => a + b, 0)));
    return { categories: catOrder, series: serOrder, matrix: mtx, max: mx };
  }, [rows, categoryIndex, seriesIndex, valueIndex]);

  if (!categories.length || max <= 0) {
    return <div style={emptyStyle}>No data to chart</div>;
  }

  const n = categories.length;
  const slot = STACK_PLOT_W / n;
  const barWidth = Math.min(40, slot * 0.66);
  const labelStride = Math.max(1, Math.ceil(n / 12));
  const yTicks = [0, Math.round(max / 2), max].filter(
    (v, i, a) => a.indexOf(v) === i
  );
  const colorFor = (si: number) => SERIES_OPACITY[si % SERIES_OPACITY.length];

  return (
    <div>
      <svg
        viewBox={`0 0 ${STACK_W} ${STACK_H}`}
        role="img"
        aria-label={`Stacked bar chart by ${categoryName}`}
        style={{ width: '100%', height: 'auto' }}
      >
        {yTicks.map((t, i) => {
          const y = STACK_TOP + STACK_PLOT_H - (t / max) * STACK_PLOT_H;
          return (
            <g key={i}>
              <line
                x1={STACK_LEFT}
                y1={round1(y)}
                x2={STACK_W}
                y2={round1(y)}
                stroke="var(--color-border-tertiary, rgba(0,0,0,0.08))"
                strokeWidth={1}
              />
              <text
                x={STACK_LEFT - 4}
                y={round1(y) + 3}
                fontSize={9}
                textAnchor="end"
                fill="var(--color-text-secondary, rgba(0,0,0,0.55))"
              >
                {axisNumber(t)}
              </text>
            </g>
          );
        })}
        {categories.map((cat, ci) => {
          const x = STACK_LEFT + ci * slot + (slot - barWidth) / 2;
          let cursorY = STACK_TOP + STACK_PLOT_H;
          return (
            <g key={ci}>
              {series.map((ser, si) => {
                const val = matrix[ci][si];
                if (val <= 0) return null;
                const h = (val / max) * STACK_PLOT_H;
                cursorY -= h;
                return (
                  <rect
                    key={si}
                    x={round1(x)}
                    y={round1(cursorY)}
                    width={round1(barWidth)}
                    height={round1(h)}
                    fill={ACCENT}
                    opacity={colorFor(si)}
                  >
                    <title>{`${cat} · ${ser}: ${formatNumber(val)}`}</title>
                  </rect>
                );
              })}
              {ci % labelStride === 0 ? (
                <text
                  x={round1(STACK_LEFT + ci * slot + slot / 2)}
                  y={STACK_H - 8}
                  fontSize={9}
                  textAnchor="middle"
                  fill="var(--color-text-secondary, rgba(0,0,0,0.6))"
                >
                  {cat}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {/* legend */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 10,
          marginTop: 8,
          fontSize: 11,
          opacity: 0.75,
        }}
      >
        {series.map((ser, si) => (
          <span
            key={si}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 2,
                background: ACCENT,
                opacity: colorFor(si),
                display: 'inline-block',
              }}
            />
            {ser}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── TREEMAP ──────────────────────────────────────────────────────────
// category (text) + numeric value with MANY categories → share-of-whole
// rectangles sized by value. A squarified-ish slice-and-dice layout keeps tiles
// close to square; sequential opacity by value (bigger = more opaque). Labels
// render only when a tile is big enough to hold them. Handles 1 dominant + a
// long tail gracefully (tiny tiles simply drop their label).
const TREE_W = 480;
const TREE_H = 300;

type TreeTile = {
  x: number;
  y: number;
  w: number;
  h: number;
  name: string;
  value: number;
};

/**
 * Squarified-ish slice-and-dice: recursively split the remaining rectangle
 * along its LONGER edge, packing a prefix of items whose summed value fills a
 * proportional slice, so tiles stay close to square. Pure; deterministic.
 */
function layoutTreemap(
  items: { name: string; value: number }[],
  x: number,
  y: number,
  w: number,
  h: number
): TreeTile[] {
  if (items.length === 0 || w <= 0 || h <= 0) return [];
  if (items.length === 1) {
    return [{ x, y, w, h, name: items[0].name, value: items[0].value }];
  }
  const total = items.reduce((a, b) => a + b.value, 0);
  if (total <= 0) return [];
  // Take a prefix summing to ~half the value so each split is balanced.
  const half = total / 2;
  let acc = 0;
  let split = 1;
  for (let i = 0; i < items.length; i++) {
    acc += items[i].value;
    split = i + 1;
    if (acc >= half) break;
  }
  // Guard against a lone dominant item swallowing the whole prefix.
  if (split >= items.length) split = items.length - 1;
  const headItems = items.slice(0, split);
  const tailItems = items.slice(split);
  const headSum = headItems.reduce((a, b) => a + b.value, 0);
  const frac = headSum / total;
  // Split along the longer edge so tiles trend square.
  if (w >= h) {
    const wHead = w * frac;
    return [
      ...layoutTreemap(headItems, x, y, wHead, h),
      ...layoutTreemap(tailItems, x + wHead, y, w - wHead, h),
    ];
  }
  const hHead = h * frac;
  return [
    ...layoutTreemap(headItems, x, y, w, hHead),
    ...layoutTreemap(tailItems, x, y + hHead, w, h - hHead),
  ];
}

function TreemapView({
  rows,
  labelIndex,
  valueIndex,
  valueName,
}: {
  rows: unknown[][];
  labelIndex: number;
  valueIndex: number;
  valueName: string;
}) {
  const { tiles, max } = useMemo(() => {
    const items: { name: string; value: number }[] = [];
    for (const r of rows) {
      const v = toNumber(r[valueIndex]);
      if (!Number.isFinite(v) || v <= 0) continue;
      items.push({ name: displayCell(r[labelIndex]), value: v });
    }
    // Largest-first so the layout packs the dominant tile first.
    items.sort((a, b) => b.value - a.value);
    const mx = items.length ? items[0].value : 0;
    return {
      tiles: layoutTreemap(items, 0, 0, TREE_W, TREE_H),
      max: mx,
    };
  }, [rows, labelIndex, valueIndex]);

  if (!tiles.length || max <= 0) {
    return <div style={emptyStyle}>No data to chart</div>;
  }

  // Sequential opacity by value: bigger tile = more opaque.
  const opacityFor = (v: number) => 0.28 + 0.62 * (v / max);

  return (
    <div>
      <svg
        viewBox={`0 0 ${TREE_W} ${TREE_H}`}
        role="img"
        aria-label={`Treemap of ${valueName}`}
        style={{ width: '100%', height: 'auto' }}
      >
        {tiles.map((t, i) => {
          // Label only when the tile can hold it.
          const showName = t.w >= 46 && t.h >= 22;
          const showValue = t.w >= 46 && t.h >= 34;
          return (
            <g key={i}>
              <rect
                x={round1(t.x)}
                y={round1(t.y)}
                width={round1(Math.max(0, t.w - 1))}
                height={round1(Math.max(0, t.h - 1))}
                rx={2}
                fill={ACCENT}
                opacity={opacityFor(t.value)}
                stroke="var(--color-background-primary, #fff)"
                strokeWidth={1}
              >
                <title>{`${t.name}: ${formatNumber(t.value)}`}</title>
              </rect>
              {showName ? (
                <text
                  x={round1(t.x + 5)}
                  y={round1(t.y + 14)}
                  fontSize={11}
                  fontWeight={600}
                  fill="var(--color-text-primary, #fff)"
                  style={{ pointerEvents: 'none' }}
                >
                  {t.name.length > 18 ? t.name.slice(0, 17) + '…' : t.name}
                </text>
              ) : null}
              {showValue ? (
                <text
                  x={round1(t.x + 5)}
                  y={round1(t.y + 27)}
                  fontSize={10}
                  fill="var(--color-text-primary, rgba(255,255,255,0.8))"
                  opacity={0.85}
                  style={{ pointerEvents: 'none' }}
                >
                  {formatNumber(t.value)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>
        {humanizeColumn(valueName)} · {tiles.length} categories
      </div>
    </div>
  );
}

// ── SANKEY ───────────────────────────────────────────────────────────
// source (text) + target (text) + numeric value → a 2-column flow diagram.
// Left nodes (sources) and right nodes (targets) are sized by throughput;
// curved links are width-proportional to value. Nodes are capped (~12 per side)
// with the overflow bucketed into "Other" so the diagram stays legible.
const SANK_W = 480;
const SANK_H = 320;
const SANK_PAD_T = 12;
const SANK_PAD_B = 12;
const SANK_NODE_W = 12;
const SANK_NODE_GAP = 6;
const SANK_MAX_NODES = 12;

type SankNode = { name: string; value: number; y0: number; y1: number };

/** Aggregate + cap a side's nodes to SANK_MAX_NODES, bucketing the rest. */
function capNodes(entries: [string, number][]): [string, number][] {
  const sorted = [...entries].sort((a, b) => b[1] - a[1]);
  if (sorted.length <= SANK_MAX_NODES) return sorted;
  const head = sorted.slice(0, SANK_MAX_NODES - 1);
  const tail = sorted.slice(SANK_MAX_NODES - 1);
  const other = tail.reduce((a, b) => a + b[1], 0);
  return [...head, ['Other', other]];
}

function SankeyView({
  rows,
  sourceIndex,
  targetIndex,
  valueIndex,
}: {
  rows: unknown[][];
  sourceIndex: number;
  targetIndex: number;
  valueIndex: number;
}) {
  const model = useMemo(() => {
    // Aggregate source totals, target totals, and per source→target flow.
    const srcTotals = new Map<string, number>();
    const tgtTotals = new Map<string, number>();
    const flows = new Map<string, number>(); // "src tgt" → value
    for (const r of rows) {
      const src = displayCell(r[sourceIndex]);
      const tgt = displayCell(r[targetIndex]);
      const v = toNumber(r[valueIndex]);
      if (!Number.isFinite(v) || v <= 0) continue;
      srcTotals.set(src, (srcTotals.get(src) ?? 0) + v);
      tgtTotals.set(tgt, (tgtTotals.get(tgt) ?? 0) + v);
      const key = `${src} ${tgt}`;
      flows.set(key, (flows.get(key) ?? 0) + v);
    }
    const srcCapped = capNodes([...srcTotals.entries()]);
    const tgtCapped = capNodes([...tgtTotals.entries()]);
    // Map any bucketed original names to "Other".
    const srcKeep = new Set(srcCapped.map((e) => e[0]));
    const tgtKeep = new Set(tgtCapped.map((e) => e[0]));
    const remap = (name: string, keep: Set<string>) =>
      keep.has(name) ? name : 'Other';

    // Rebuild flows against the capped node sets.
    const capFlows = new Map<string, number>();
    for (const [key, v] of flows) {
      const [src, tgt] = key.split(' ');
      const s = remap(src, srcKeep);
      const t = remap(tgt, tgtKeep);
      const k = `${s} ${t}`;
      capFlows.set(k, (capFlows.get(k) ?? 0) + v);
    }

    const grand = srcCapped.reduce((a, b) => a + b[1], 0);
    return { srcCapped, tgtCapped, capFlows, grand };
  }, [rows, sourceIndex, targetIndex, valueIndex]);

  const { srcCapped, tgtCapped, capFlows, grand } = model;
  if (!srcCapped.length || !tgtCapped.length || grand <= 0) {
    return <div style={emptyStyle}>No flows to chart</div>;
  }

  // Lay out each side vertically: node height ∝ throughput, with a small gap.
  const layoutSide = (entries: [string, number][]): SankNode[] => {
    const n = entries.length;
    const gaps = (n - 1) * SANK_NODE_GAP;
    const avail = SANK_H - SANK_PAD_T - SANK_PAD_B - gaps;
    const sum = entries.reduce((a, b) => a + b[1], 0) || 1;
    const nodes: SankNode[] = [];
    let cursor = SANK_PAD_T;
    for (const [name, value] of entries) {
      const h = Math.max(3, (value / sum) * avail);
      nodes.push({ name, value, y0: cursor, y1: cursor + h });
      cursor += h + SANK_NODE_GAP;
    }
    return nodes;
  };

  const srcNodes = layoutSide(srcCapped);
  const tgtNodes = layoutSide(tgtCapped);
  const srcByName = new Map(srcNodes.map((nd) => [nd.name, nd]));
  const tgtByName = new Map(tgtNodes.map((nd) => [nd.name, nd]));

  const leftX = 4;
  const rightX = SANK_W - SANK_NODE_W - 4;
  const linkLeftX = leftX + SANK_NODE_W;
  const linkRightX = rightX;

  // Vertical cursors tracking where the next link attaches on each node.
  const srcCursor = new Map(srcNodes.map((nd) => [nd.name, nd.y0]));
  const tgtCursor = new Map(tgtNodes.map((nd) => [nd.name, nd.y0]));

  // Build link ribbons in a stable order (source-major, target order).
  const links: {
    d: string;
    value: number;
    src: string;
    tgt: string;
    opacity: number;
  }[] = [];
  const flowSum = [...capFlows.values()].reduce((a, b) => a + b, 0) || 1;
  for (const [srcName] of srcCapped) {
    for (const [tgtName] of tgtCapped) {
      const v = capFlows.get(`${srcName} ${tgtName}`);
      if (!v || v <= 0) continue;
      const s = srcByName.get(srcName)!;
      const t = tgtByName.get(tgtName)!;
      const sSum = s.value || 1;
      const tSum = t.value || 1;
      const sThick = (v / sSum) * (s.y1 - s.y0);
      const tThick = (v / tSum) * (t.y1 - t.y0);
      const sy = srcCursor.get(srcName)!;
      const ty = tgtCursor.get(tgtName)!;
      srcCursor.set(srcName, sy + sThick);
      tgtCursor.set(tgtName, ty + tThick);
      const sy0 = sy;
      const sy1 = sy + sThick;
      const ty0 = ty;
      const ty1 = ty + tThick;
      const midX = (linkLeftX + linkRightX) / 2;
      // A filled ribbon: top edge left→right (cubic), down the right node,
      // bottom edge right→left (cubic), close.
      const d = [
        `M ${round1(linkLeftX)},${round1(sy0)}`,
        `C ${round1(midX)},${round1(sy0)} ${round1(midX)},${round1(ty0)} ${round1(linkRightX)},${round1(ty0)}`,
        `L ${round1(linkRightX)},${round1(ty1)}`,
        `C ${round1(midX)},${round1(ty1)} ${round1(midX)},${round1(sy1)} ${round1(linkLeftX)},${round1(sy1)}`,
        'Z',
      ].join(' ');
      links.push({
        d,
        value: v,
        src: srcName,
        tgt: tgtName,
        opacity: 0.18 + 0.32 * (v / flowSum),
      });
    }
  }

  return (
    <div>
      <svg
        viewBox={`0 0 ${SANK_W} ${SANK_H}`}
        role="img"
        aria-label="Sankey flow diagram"
        style={{ width: '100%', height: 'auto' }}
      >
        {/* link ribbons (drawn under the node bars) */}
        {links.map((lk, i) => (
          <path key={i} d={lk.d} fill={ACCENT} opacity={lk.opacity}>
            <title>{`${lk.src} → ${lk.tgt}: ${formatNumber(lk.value)}`}</title>
          </path>
        ))}
        {/* source node bars + labels (left) */}
        {srcNodes.map((nd, i) => (
          <g key={`s${i}`}>
            <rect
              x={leftX}
              y={round1(nd.y0)}
              width={SANK_NODE_W}
              height={round1(nd.y1 - nd.y0)}
              rx={2}
              fill={ACCENT}
              opacity={0.85}
            >
              <title>{`${nd.name}: ${formatNumber(nd.value)}`}</title>
            </rect>
            <text
              x={leftX + SANK_NODE_W + 4}
              y={round1((nd.y0 + nd.y1) / 2) + 3}
              fontSize={10}
              textAnchor="start"
              fill="var(--color-text-secondary, rgba(0,0,0,0.7))"
            >
              {nd.name.length > 16 ? nd.name.slice(0, 15) + '…' : nd.name}
            </text>
          </g>
        ))}
        {/* target node bars + labels (right) */}
        {tgtNodes.map((nd, i) => (
          <g key={`t${i}`}>
            <rect
              x={rightX}
              y={round1(nd.y0)}
              width={SANK_NODE_W}
              height={round1(nd.y1 - nd.y0)}
              rx={2}
              fill={ACCENT}
              opacity={0.85}
            >
              <title>{`${nd.name}: ${formatNumber(nd.value)}`}</title>
            </rect>
            <text
              x={rightX - 4}
              y={round1((nd.y0 + nd.y1) / 2) + 3}
              fontSize={10}
              textAnchor="end"
              fill="var(--color-text-secondary, rgba(0,0,0,0.7))"
            >
              {nd.name.length > 16 ? nd.name.slice(0, 15) + '…' : nd.name}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

// ── COVER MOSAIC ─────────────────────────────────────────────────────
// A packed wall of cover images SIZED by the metric (bigger = more plays). A
// simple sized-tile flow: each cover's edge scales between a min and max by the
// metric's share of the max, wrapping with flexbox. Images load straight from
// the CDN (already CSP-allowed); names are captions/tooltips.
const MOSAIC_MIN = 56;
const MOSAIC_MAX = 132;

function MosaicView({
  rows,
  imageIndex,
  labelIndex,
  metricIndex,
  metricLabel,
  art,
  onOpen,
}: {
  rows: unknown[][];
  imageIndex: number;
  labelIndex: number;
  metricIndex: number;
  metricLabel: string | null;
  art?: Record<string, string>;
  onOpen?: (url: string) => void;
}) {
  const values = rows.map((r) => {
    const n = toNumber(r[metricIndex]);
    return Number.isFinite(n) ? n : 0;
  });
  const max = Math.max(0, ...values);

  const sizeFor = (v: number) => {
    if (max <= 0) return MOSAIC_MIN;
    // sqrt scale so area (not edge) trends with the metric — a big value doesn't
    // dwarf the wall.
    const frac = Math.sqrt(v / max);
    return Math.round(MOSAIC_MIN + frac * (MOSAIC_MAX - MOSAIC_MIN));
  };

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
        alignItems: 'flex-end',
      }}
    >
      {rows.map((row, i) => {
        const rawUrl = row[imageIndex];
        const url = typeof rawUrl === 'string' ? rawUrl : '';
        const src = (url && art?.[url]) || url;
        const label = displayCell(row[labelIndex]);
        const value = values[i];
        const edge = sizeFor(value);
        const caption = metricLabel
          ? `${label} · ${formatNumber(value)} ${metricLabel}`
          : `${label} · ${formatNumber(value)}`;
        return (
          <div
            key={i}
            role={onOpen && url ? 'button' : undefined}
            onClick={onOpen && url ? () => onOpen(url) : undefined}
            title={caption}
            style={{
              width: edge,
              height: edge,
              borderRadius: 6,
              overflow: 'hidden',
              flexShrink: 0,
              cursor: onOpen && url ? 'pointer' : 'default',
              background: 'var(--color-background-secondary, rgba(0,0,0,0.04))',
            }}
          >
            {src ? (
              <img
                src={src}
                alt={label}
                loading="lazy"
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// ── shared formatting ────────────────────────────────────────────────
/** Humanize a snake/camel column name into a Title-Cased label. */
function humanizeColumn(name: string): string {
  const spaced = name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  return spaced.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Format a numeric cell for display: thousands separators, and up to one
 * decimal place for non-integers. We deliberately DON'T reinterpret durations
 * (seconds/hours) — the raw number is shown so we never over-infer units.
 */
function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return '';
  const decimals = Number.isInteger(v) ? 0 : 1;
  return v.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

// ── STAT CARDS ───────────────────────────────────────────────────────
function StatView({
  columns,
  row,
  numericCols,
}: {
  columns: string[];
  row: unknown[];
  numericCols: Set<number>;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: 12,
      }}
    >
      {columns.map((col, i) => {
        const raw = row[i];
        const numeric = numericCols.has(i) && isNumericCell(raw);
        return (
          <div
            key={i}
            style={{
              padding: '14px 16px',
              borderRadius: 10,
              background: 'var(--color-background-secondary, rgba(0,0,0,0.04))',
              border:
                '1px solid var(--color-border-tertiary, rgba(0,0,0,0.08))',
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: 0.3,
                textTransform: 'uppercase',
                opacity: 0.55,
                marginBottom: 6,
              }}
            >
              {humanizeColumn(col)}
            </div>
            <div
              style={{
                fontSize: numeric ? 26 : 15,
                fontWeight: 700,
                lineHeight: 1.1,
                fontVariantNumeric: 'tabular-nums',
                wordBreak: 'break-word',
              }}
            >
              {numeric ? formatNumber(toNumber(raw)) : displayCell(raw)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── RANKED LIST WITH ART ─────────────────────────────────────────────
function ListView({
  rows,
  imageIndex,
  labelIndex,
  metricIndex,
  metricLabel,
  art,
  onOpen,
}: {
  rows: unknown[][];
  imageIndex: number;
  labelIndex: number;
  metricIndex: number | null;
  metricLabel: string | null;
  art?: Record<string, string>;
  onOpen?: (url: string) => void;
}) {
  const values =
    metricIndex !== null
      ? rows.map((r) => {
          const n = toNumber(r[metricIndex]);
          return Number.isFinite(n) ? n : 0;
        })
      : [];
  const max = values.length ? Math.max(0, ...values) : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {rows.map((row, i) => {
        const rawUrl = row[imageIndex];
        const url = typeof rawUrl === 'string' ? rawUrl : '';
        const src = (url && art?.[url]) || url;
        const label = displayCell(row[labelIndex]);
        const value = metricIndex !== null ? values[i] : null;
        const pct = max > 0 && value !== null ? (value / max) * 100 : 0;
        return (
          <div
            key={i}
            role={onOpen && url ? 'button' : undefined}
            onClick={onOpen && url ? () => onOpen(url) : undefined}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '6px 4px',
              cursor: onOpen && url ? 'pointer' : 'default',
            }}
          >
            <div
              style={{
                width: 22,
                textAlign: 'right',
                fontSize: 13,
                fontWeight: 700,
                fontVariantNumeric: 'tabular-nums',
                opacity: 0.45,
                flexShrink: 0,
              }}
            >
              {i + 1}
            </div>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 6,
                overflow: 'hidden',
                flexShrink: 0,
                background:
                  'var(--color-background-secondary, rgba(0,0,0,0.04))',
              }}
            >
              {src ? (
                <img
                  src={src}
                  alt={label}
                  loading="lazy"
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : null}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {label}
              </div>
              {metricIndex !== null ? (
                <div
                  style={{
                    marginTop: 4,
                    height: 5,
                    borderRadius: 3,
                    background:
                      'var(--color-background-secondary, rgba(0,0,0,0.06))',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${round1(pct)}%`,
                      height: '100%',
                      borderRadius: 3,
                      background: ACCENT,
                      opacity: 0.8,
                    }}
                  />
                </div>
              ) : null}
            </div>
            {metricIndex !== null && value !== null ? (
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  fontVariantNumeric: 'tabular-nums',
                  opacity: 0.7,
                  flexShrink: 0,
                  textAlign: 'right',
                }}
              >
                {formatNumber(value)}
                {metricLabel ? (
                  <span style={{ opacity: 0.55, fontWeight: 500 }}>
                    {' '}
                    {metricLabel}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// ── CALENDAR HEATMAP ─────────────────────────────────────────────────
const CAL_CELL = 12; // cell edge (px)
const CAL_GAP = 2; // gap between cells
const CAL_STEP = CAL_CELL + CAL_GAP;
const CAL_LEFT = 26; // room for weekday labels
const CAL_TOP = 16; // room for month labels
// 5-step scale, low → high. Empty/zero days use the muted track color.
const CAL_EMPTY = 'var(--color-background-secondary, rgba(0,0,0,0.06))';

/** Days between two YYYY-MM-DD dates (UTC), b - a. */
function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/** Monday=0 … Sunday=6 weekday index for a UTC date. */
function mondayIndex(d: Date): number {
  return (d.getUTCDay() + 6) % 7;
}

const WEEKDAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'];
const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** One calendar year's worth of cells + geometry. */
type CalYear = {
  year: number;
  weeks: number;
  cells: {
    x: number;
    y: number;
    date: string;
    value: number;
    monthStart: number | null;
  }[];
};

/**
 * Build a GitHub-style grid for one calendar year: columns are ISO weeks
 * (starting on the Monday on/before Jan 1), rows are Mon–Sun. Days with no data
 * get value 0. Returns the cells plus the week count for sizing.
 */
function buildCalYear(year: number, valueByDate: Map<string, number>): CalYear {
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const dec31 = new Date(Date.UTC(year, 11, 31));
  // Grid origin: the Monday on/before Jan 1.
  const origin = new Date(jan1.getTime() - mondayIndex(jan1) * 86400000);
  const cells: CalYear['cells'] = [];
  let maxWeek = 0;
  for (
    let d = new Date(origin);
    d <= dec31;
    d = new Date(d.getTime() + 86400000)
  ) {
    if (d < jan1) continue; // skip padding days from the previous year
    const offset = daysBetween(origin, d);
    const week = Math.floor(offset / 7);
    const row = mondayIndex(d);
    maxWeek = Math.max(maxWeek, week);
    const iso = d.toISOString().slice(0, 10);
    const value = valueByDate.get(iso) ?? 0;
    cells.push({
      x: CAL_LEFT + week * CAL_STEP,
      y: CAL_TOP + row * CAL_STEP,
      date: iso,
      value,
      monthStart: d.getUTCDate() === 1 ? d.getUTCMonth() : null,
    });
  }
  return { year, weeks: maxWeek + 1, cells };
}

function CalendarView({
  rows,
  dateIndex,
  valueIndex,
}: {
  rows: unknown[][];
  dateIndex: number;
  valueIndex: number;
}) {
  const { years, max } = useMemo(() => {
    const valueByDate = new Map<string, number>();
    const yearSet = new Set<number>();
    let mx = 0;
    for (const r of rows) {
      const raw = r[dateIndex];
      if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) continue;
      const v = toNumber(r[valueIndex]);
      const value = Number.isFinite(v) ? v : 0;
      // Aggregate duplicate days by summing.
      valueByDate.set(raw, (valueByDate.get(raw) ?? 0) + value);
      yearSet.add(Number(raw.slice(0, 4)));
      mx = Math.max(mx, valueByDate.get(raw)!);
    }
    const ys = [...yearSet].sort((a, b) => a - b);
    return {
      years: ys.map((y) => buildCalYear(y, valueByDate)),
      max: mx,
    };
  }, [rows, dateIndex, valueIndex]);

  if (!years.length || max <= 0) {
    return <div style={emptyStyle}>No dated data to chart</div>;
  }

  // 5-step linear scale over [1, max]; index 0 is the empty/zero cell.
  const bucket = (v: number): number => {
    if (v <= 0) return 0;
    const step = Math.ceil((v / max) * 4);
    return Math.min(4, Math.max(1, step));
  };
  // Accent opacity ramp for the four filled steps.
  const fillFor = (v: number): string => {
    const b = bucket(v);
    if (b === 0) return CAL_EMPTY;
    return ACCENT;
  };
  const opacityFor = (v: number): number => {
    const b = bucket(v);
    return [0, 0.28, 0.48, 0.7, 0.95][b];
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {years.map((yr) => {
        const width = CAL_LEFT + yr.weeks * CAL_STEP;
        const height = CAL_TOP + 7 * CAL_STEP;
        // Month label positions: first cell of each month.
        const monthTicks = yr.cells.filter((c) => c.monthStart !== null);
        return (
          <div key={yr.year}>
            {years.length > 1 ? (
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  opacity: 0.7,
                  marginBottom: 4,
                }}
              >
                {yr.year}
              </div>
            ) : null}
            <svg
              viewBox={`0 0 ${width} ${height}`}
              role="img"
              aria-label={`Calendar heatmap for ${yr.year}`}
              style={{ width: '100%', height: 'auto', maxWidth: width }}
            >
              {WEEKDAY_LABELS.map((lbl, row) =>
                lbl ? (
                  <text
                    key={row}
                    x={CAL_LEFT - 4}
                    y={CAL_TOP + row * CAL_STEP + CAL_CELL - 2}
                    fontSize={9}
                    textAnchor="end"
                    fill="var(--color-text-secondary, rgba(0,0,0,0.55))"
                  >
                    {lbl}
                  </text>
                ) : null
              )}
              {monthTicks.map((c, i) => (
                <text
                  key={i}
                  x={c.x}
                  y={CAL_TOP - 5}
                  fontSize={9}
                  textAnchor="start"
                  fill="var(--color-text-secondary, rgba(0,0,0,0.55))"
                >
                  {MONTH_LABELS[c.monthStart!]}
                </text>
              ))}
              {yr.cells.map((c, i) => (
                <rect
                  key={i}
                  x={c.x}
                  y={c.y}
                  width={CAL_CELL}
                  height={CAL_CELL}
                  rx={2}
                  fill={fillFor(c.value)}
                  opacity={c.value > 0 ? opacityFor(c.value) : 1}
                >
                  <title>{`${c.date}: ${formatNumber(c.value)}`}</title>
                </rect>
              ))}
            </svg>
          </div>
        );
      })}
      {/* Legend: less → more */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 10,
          opacity: 0.6,
        }}
      >
        <span>Less</span>
        {[1, 2, 3, 4].map((b) => (
          <span
            key={b}
            style={{
              width: CAL_CELL,
              height: CAL_CELL,
              borderRadius: 2,
              background: ACCENT,
              opacity: [0, 0.28, 0.48, 0.7, 0.95][b],
              display: 'inline-block',
            }}
          />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}

// ── POLAR CLOCK ──────────────────────────────────────────────────────
const CLOCK_SIZE = 320;
const CLOCK_CX = CLOCK_SIZE / 2;
const CLOCK_CY = CLOCK_SIZE / 2;
const CLOCK_INNER = 46; // hollow center radius
const CLOCK_OUTER = 130; // max spoke/wedge radius
const CLOCK_LABEL_R = 146; // label ring radius

/** Polar → cartesian; angle 0 at top (12 o'clock), clockwise. */
function polar(
  cx: number,
  cy: number,
  r: number,
  angleRad: number
): [number, number] {
  return [cx + r * Math.sin(angleRad), cy - r * Math.cos(angleRad)];
}

function ClockView({
  rows,
  labelIndex,
  valueIndex,
  kind,
}: {
  rows: unknown[][];
  labelIndex: number;
  valueIndex: number;
  kind: 'hour' | 'weekday';
}) {
  const slots = kind === 'hour' ? 24 : 7;
  const { buckets, total, max } = useMemo(() => {
    const b = new Array<number>(slots).fill(0);
    let tot = 0;
    for (const r of rows) {
      const raw = r[labelIndex];
      let idx: number | null = null;
      if (kind === 'hour') {
        const n = toNumber(raw);
        if (Number.isInteger(n) && n >= 0 && n <= 23) idx = n;
      } else {
        idx = weekdayNameToIndex(raw);
        if (idx === null) {
          const n = toNumber(raw);
          if (Number.isInteger(n) && n >= 0 && n <= 6) idx = n;
        }
      }
      if (idx === null) continue;
      const v = toNumber(r[valueIndex]);
      if (Number.isFinite(v)) {
        b[idx] += v;
        tot += v;
      }
    }
    return { buckets: b, total: tot, max: Math.max(0, ...b) };
  }, [rows, labelIndex, valueIndex, kind, slots]);

  if (max <= 0) {
    return <div style={emptyStyle}>No cyclic data to chart</div>;
  }

  const step = (2 * Math.PI) / slots;
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  return (
    <svg
      viewBox={`0 0 ${CLOCK_SIZE} ${CLOCK_SIZE}`}
      role="img"
      aria-label={
        kind === 'hour'
          ? 'Hour-of-day radial histogram'
          : 'Day-of-week radial histogram'
      }
      style={{ width: '100%', height: 'auto', maxWidth: CLOCK_SIZE }}
    >
      {/* guide ring */}
      <circle
        cx={CLOCK_CX}
        cy={CLOCK_CY}
        r={CLOCK_OUTER}
        fill="none"
        stroke="var(--color-border-tertiary, rgba(0,0,0,0.08))"
        strokeWidth={1}
      />
      {buckets.map((v, i) => {
        const frac = max > 0 ? v / max : 0;
        const r = CLOCK_INNER + frac * (CLOCK_OUTER - CLOCK_INNER);
        if (kind === 'hour') {
          // Hour spokes: thick radial lines.
          const angle = i * step;
          const [x1, y1] = polar(CLOCK_CX, CLOCK_CY, CLOCK_INNER, angle);
          const [x2, y2] = polar(CLOCK_CX, CLOCK_CY, r, angle);
          return (
            <line
              key={i}
              x1={round1(x1)}
              y1={round1(y1)}
              x2={round1(x2)}
              y2={round1(y2)}
              stroke={ACCENT}
              strokeWidth={6}
              strokeLinecap="round"
              opacity={0.35 + 0.6 * frac}
            >
              <title>{`${String(i).padStart(2, '0')}:00 — ${formatNumber(v)}`}</title>
            </line>
          );
        }
        // Weekday wedges: annular sectors.
        const a0 = i * step - step / 2;
        const a1 = i * step + step / 2;
        const [ix0, iy0] = polar(CLOCK_CX, CLOCK_CY, CLOCK_INNER, a0);
        const [ix1, iy1] = polar(CLOCK_CX, CLOCK_CY, CLOCK_INNER, a1);
        const [ox0, oy0] = polar(CLOCK_CX, CLOCK_CY, r, a0);
        const [ox1, oy1] = polar(CLOCK_CX, CLOCK_CY, r, a1);
        const d = [
          `M ${round1(ix0)},${round1(iy0)}`,
          `L ${round1(ox0)},${round1(oy0)}`,
          `A ${round1(r)},${round1(r)} 0 0 1 ${round1(ox1)},${round1(oy1)}`,
          `L ${round1(ix1)},${round1(iy1)}`,
          `A ${CLOCK_INNER},${CLOCK_INNER} 0 0 0 ${round1(ix0)},${round1(iy0)}`,
          'Z',
        ].join(' ');
        return (
          <path key={i} d={d} fill={ACCENT} opacity={0.35 + 0.6 * frac}>
            <title>{`${dayNames[i]} — ${formatNumber(v)}`}</title>
          </path>
        );
      })}
      {/* labels around the ring */}
      {buckets.map((_, i) => {
        const angle = i * step;
        const [lx, ly] = polar(CLOCK_CX, CLOCK_CY, CLOCK_LABEL_R, angle);
        // Show every 3rd hour to avoid crowding; all 7 weekdays.
        if (kind === 'hour' && i % 3 !== 0) return null;
        const label = kind === 'hour' ? String(i) : dayNames[i];
        return (
          <text
            key={i}
            x={round1(lx)}
            y={round1(ly) + 3}
            fontSize={10}
            textAnchor="middle"
            fill="var(--color-text-secondary, rgba(0,0,0,0.55))"
          >
            {label}
          </text>
        );
      })}
      {/* center total */}
      <text
        x={CLOCK_CX}
        y={CLOCK_CY - 2}
        fontSize={22}
        fontWeight={700}
        textAnchor="middle"
        fill="var(--color-text-primary, inherit)"
      >
        {formatNumber(total)}
      </text>
      <text
        x={CLOCK_CX}
        y={CLOCK_CY + 14}
        fontSize={10}
        textAnchor="middle"
        fill="var(--color-text-secondary, rgba(0,0,0,0.55))"
      >
        total
      </text>
    </svg>
  );
}

// ── MAP ──────────────────────────────────────────────────────────────
// A real slippy map: Leaflet with a configurable raster tile provider. When the
// server supplies structuredContent.map_config (provider 'mapbox'), we use its
// Mapbox tile URL / attribution / maxZoom; otherwise we default to
// OpenStreetMap (no API token). Falls back to a tile-less SVG projector render
// if Leaflet fails to init (e.g. no network / tile errors / a thrown init), so
// the view never fully breaks. Tiles load as <img> under the resource CSP
// resourceDomains.
const MAP_W = 480;
const MAP_H = 300;
const MAP_PAD = 16;
const MAP_HEIGHT = 360; // Leaflet needs a definite container height.

// Point-marker stroke: Leaflet circleMarker (no default PNG icon → no extra
// unpkg CSP origin, no broken icons in the sandboxed iframe).
const ROUTE_STROKE = '#e2503f';
const POINT_STROKE = '#e2503f';

// Default OpenStreetMap tile layer — used when no map_config is supplied.
const OSM_TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTRIBUTION = '© OpenStreetMap contributors';
const OSM_MAX_ZOOM = 19;

/** Resolve the effective tile layer from an optional server map_config. */
function resolveTileLayer(mapConfig?: MapConfig): {
  tileUrl: string;
  attribution: string;
  maxZoom: number;
  /** Short legend label for the provider. */
  source: string;
} {
  if (mapConfig && mapConfig.provider === 'mapbox') {
    return {
      tileUrl: mapConfig.tileUrl,
      attribution: mapConfig.attribution,
      maxZoom: mapConfig.maxZoom,
      source: 'Mapbox',
    };
  }
  return {
    tileUrl: OSM_TILE_URL,
    attribution: OSM_ATTRIBUTION,
    maxZoom: OSM_MAX_ZOOM,
    source: 'OpenStreetMap',
  };
}

type MapData = {
  /** [lat, lng, label] tuples for point markers. */
  points: { lat: number; lng: number; label: string }[];
  /** decoded [lat, lng][] paths for route polylines. */
  routes: [number, number][][];
  bounds: Bounds | null;
};

/**
 * Decode result rows into point markers and route paths + combined bounds.
 * Shared by both the Leaflet renderer and the SVG fallback so they always
 * plot the same geometry.
 */
function useMapData(
  rows: unknown[][],
  latIndex: number | null,
  lngIndex: number | null,
  polylineIndex: number | null,
  labelIndex: number | null
): MapData {
  return useMemo(() => {
    const points: MapData['points'] = [];
    if (latIndex !== null && lngIndex !== null) {
      for (const row of rows) {
        const lat = toNumber(row[latIndex]);
        const lng = toNumber(row[lngIndex]);
        if (
          Number.isFinite(lat) &&
          Number.isFinite(lng) &&
          lat >= -90 &&
          lat <= 90 &&
          lng >= -180 &&
          lng <= 180
        ) {
          const label = labelIndex !== null ? displayCell(row[labelIndex]) : '';
          points.push({ lat, lng, label });
        }
      }
    }
    const routes: [number, number][][] = [];
    if (polylineIndex !== null) {
      for (const row of rows) {
        const v = row[polylineIndex];
        if (typeof v === 'string' && v.length >= 8) {
          const pts = decodePolyline(v);
          if (pts.length >= 2) routes.push(pts);
        }
      }
    }
    // Combined bounds over all points + all route vertices.
    let bounds: Bounds | null = boundsOf(points.map((p) => [p.lat, p.lng]));
    for (const r of routes) {
      const b = boundsOf(r);
      if (b) {
        bounds = bounds
          ? {
              minLat: Math.min(bounds.minLat, b.minLat),
              maxLat: Math.max(bounds.maxLat, b.maxLat),
              minLng: Math.min(bounds.minLng, b.minLng),
              maxLng: Math.max(bounds.maxLng, b.maxLng),
            }
          : b;
      }
    }
    return { points, routes, bounds };
  }, [rows, latIndex, lngIndex, polylineIndex, labelIndex]);
}

function mapLegend(data: MapData, source: string): string {
  const parts: string[] = [];
  if (data.points.length > 0) {
    parts.push(
      `${data.points.length} point${data.points.length === 1 ? '' : 's'}`
    );
  }
  if (data.routes.length > 0) {
    parts.push(
      `${data.routes.length} route${data.routes.length === 1 ? '' : 's'}`
    );
  }
  parts.push(source);
  return parts.join(' · ');
}

/** Tile-less SVG projector render — the fallback when Leaflet can't init. */
function SvgMapView({ data }: { data: MapData }) {
  const { points, routes, bounds } = data;
  if (!bounds) {
    return <div style={emptyStyle}>No mappable coordinates</div>;
  }
  const project = makeProjector(bounds, MAP_W, MAP_H, MAP_PAD);
  const dotR = points.length > 200 ? 1.5 : points.length > 50 ? 2.5 : 4;

  return (
    <div>
      <svg
        viewBox={`0 0 ${MAP_W} ${MAP_H}`}
        role="img"
        aria-label="Map of coordinates"
        style={{ width: '100%', height: 'auto', display: 'block' }}
      >
        <rect
          x={0.5}
          y={0.5}
          width={MAP_W - 1}
          height={MAP_H - 1}
          rx={8}
          fill="var(--color-background-secondary, rgba(0,0,0,0.03))"
          stroke="var(--color-border-tertiary, rgba(0,0,0,0.1))"
        />
        {routes.map((r, i) => {
          const d = routeToPath(r, project);
          return d ? (
            <path
              key={i}
              d={d}
              fill="none"
              stroke={ACCENT}
              strokeWidth={2}
              opacity={0.75}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ) : null;
        })}
        {points.map(({ lat, lng }, i) => {
          const [x, y] = project(lat, lng);
          return (
            <circle
              key={i}
              cx={x}
              cy={y}
              r={dotR}
              fill={ACCENT}
              opacity={0.8}
            />
          );
        })}
      </svg>
      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 8 }}>
        {mapLegend(data, 'tile-less')}
      </div>
    </div>
  );
}

function MapView({
  rows,
  latIndex,
  lngIndex,
  polylineIndex,
  labelIndex,
  mapConfig,
}: {
  rows: unknown[][];
  latIndex: number | null;
  lngIndex: number | null;
  polylineIndex: number | null;
  labelIndex: number | null;
  mapConfig?: MapConfig;
}) {
  const data = useMapData(rows, latIndex, lngIndex, polylineIndex, labelIndex);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // null = not yet attempted; true = Leaflet is live; false = fell back to SVG.
  const [leafletOk, setLeafletOk] = useState<boolean | null>(null);
  // Effective tile provider: Mapbox when the server supplied map_config, else
  // the OpenStreetMap default.
  const tiles = resolveTileLayer(mapConfig);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !data.bounds) return;

    let map: L.Map | null = null;
    try {
      map = L.map(el, {
        zoomControl: true,
        attributionControl: true,
        // Keep interactions contained inside the small iframe card.
        scrollWheelZoom: false,
      });

      // The URL is authored with a 256px tile grid (@2x for retina density),
      // so tileSize 256 / zoomOffset 0 matches both OSM and the Mapbox
      // outdoors-v12 256/@2x tile URL.
      L.tileLayer(tiles.tileUrl, {
        attribution: tiles.attribution,
        maxZoom: tiles.maxZoom,
        tileSize: 256,
        zoomOffset: 0,
      }).addTo(map);

      // Routes as polylines.
      for (const r of data.routes) {
        L.polyline(r, {
          color: ROUTE_STROKE,
          weight: 3,
          opacity: 0.85,
          lineJoin: 'round',
          lineCap: 'round',
        }).addTo(map);
      }

      // Points as circleMarkers (never the default PNG icon).
      for (const p of data.points) {
        const marker = L.circleMarker([p.lat, p.lng], {
          radius: 5,
          color: POINT_STROKE,
          weight: 2,
          fillColor: POINT_STROKE,
          fillOpacity: 0.7,
        }).addTo(map);
        if (p.label) marker.bindTooltip(p.label);
      }

      // Fit to combined geometry; a lone point gets a sensible zoom.
      const b = data.bounds;
      if (
        data.points.length === 1 &&
        data.routes.length === 0 &&
        b.minLat === b.maxLat &&
        b.minLng === b.maxLng
      ) {
        map.setView([b.minLat, b.minLng], 13);
      } else {
        map.fitBounds(
          [
            [b.minLat, b.minLng],
            [b.maxLat, b.maxLng],
          ],
          { padding: [24, 24] }
        );
      }

      // The iframe/card mounts the container at a definite height, but
      // Leaflet still needs a nudge once it's actually in layout.
      map.invalidateSize();
      setLeafletOk(true);
    } catch {
      // Init threw → tear down and fall back to the SVG projector render.
      try {
        map?.remove();
      } catch {
        /* ignore */
      }
      map = null;
      setLeafletOk(false);
      return;
    }

    return () => {
      try {
        map?.remove();
      } catch {
        /* ignore */
      }
    };
  }, [data, tiles.tileUrl, tiles.attribution, tiles.maxZoom]);

  if (!data.bounds) {
    return <div style={emptyStyle}>No mappable coordinates</div>;
  }

  // Fell back: render the tile-less SVG map instead.
  if (leafletOk === false) {
    return <SvgMapView data={data} />;
  }

  return (
    <div>
      <div
        ref={containerRef}
        role="application"
        aria-label="Map of coordinates"
        style={{
          width: '100%',
          height: MAP_HEIGHT,
          borderRadius: 8,
          overflow: 'hidden',
          background: 'var(--color-background-secondary, rgba(0,0,0,0.03))',
        }}
      />
      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 8 }}>
        {mapLegend(data, tiles.source)}
      </div>
    </div>
  );
}

// ── top-level component ──────────────────────────────────────────────
export function QueryResult({
  payload,
  onOpen,
}: {
  payload: QueryResultShape;
  onOpen?: (url: string) => void;
}) {
  const columns = Array.isArray(payload.columns) ? payload.columns : [];
  const rows = Array.isArray(payload.rows) ? payload.rows : [];

  const detection = useMemo(() => detectView(payload), [payload]);

  // Numeric column set for table right-alignment: a column whose sampled
  // values are mostly numeric.
  const numericCols = useMemo(() => {
    const set = new Set<number>();
    columns.forEach((_, ci) => {
      let numeric = 0;
      let total = 0;
      for (let ri = 0; ri < rows.length && total < 25; ri++) {
        const v = rows[ri]?.[ci];
        if (v === null || v === undefined || v === '') continue;
        total++;
        if (isNumericCell(v)) numeric++;
      }
      if (total > 0 && numeric / total >= 0.8) set.add(ci);
    });
    return set;
  }, [columns, rows]);

  // Tabs: table always first, then any richer views detection found, in a
  // stable order.
  const tabs = useMemo<ViewMode[]>(() => {
    const order: ViewMode[] = [
      'table',
      'stat',
      'calendar',
      'clock',
      'stacked',
      'sankey',
      'scatter',
      'histogram',
      'chart',
      'treemap',
      'map',
      'list',
      'grid',
      'mosaic',
    ];
    return order.filter(
      (v) => v === 'table' || detection.available.includes(v)
    );
  }, [detection.available]);

  // Honour explicit server `view`, else fall back to detection's auto view
  // (but only if it's actually available). Table otherwise.
  const forced = payload.view && payload.view !== 'auto' ? payload.view : null;
  const initial: ViewMode =
    forced && tabs.includes(forced)
      ? forced
      : tabs.includes(detection.auto)
        ? detection.auto
        : 'table';

  const [active, setActive] = useState<ViewMode>(initial);
  const view = tabs.includes(active) ? active : 'table';

  if (columns.length === 0 || rows.length === 0) {
    return (
      <article className={CARD_OUTER_CLASSNAME} style={cardStyle}>
        <div style={emptyStyle}>Query returned no rows.</div>
      </article>
    );
  }

  // Grid/list/mosaic metric: a numeric column that isn't the image or label
  // column. detection.metricIndex already resolves this; keep the local for
  // callers.
  const metricIndex =
    view === 'grid' || view === 'list' || view === 'mosaic'
      ? detection.metricIndex
      : null;
  const metricLabel = metricIndex !== null ? columns[metricIndex] : null;

  return (
    <article className={CARD_OUTER_CLASSNAME} style={cardStyle}>
      <header style={headerStyle}>
        <h1 style={titleStyle}>
          {rows.length} row{rows.length === 1 ? '' : 's'} · {columns.length} col
          {columns.length === 1 ? '' : 's'}
        </h1>
        {tabs.length > 1 ? (
          <div style={tabsStyle} role="tablist">
            {tabs.map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={view === t}
                onClick={() => setActive(t)}
                style={tabStyle(view === t)}
              >
                {t}
              </button>
            ))}
          </div>
        ) : null}
      </header>
      <div style={bodyStyle}>
        {view === 'table' && (
          <TableView
            columns={columns}
            rows={rows}
            numericCols={numericCols}
            art={payload.art}
          />
        )}
        {view === 'grid' &&
          detection.imageIndex !== null &&
          detection.labelIndex !== null && (
            <GridView
              rows={rows}
              imageIndex={detection.imageIndex}
              labelIndex={detection.labelIndex}
              metricIndex={metricIndex}
              metricLabel={metricLabel}
              art={payload.art}
              onOpen={onOpen}
            />
          )}
        {view === 'stat' && (
          <StatView columns={columns} row={rows[0]} numericCols={numericCols} />
        )}
        {view === 'calendar' &&
          detection.calendarDateIndex !== null &&
          detection.calendarValueIndex !== null && (
            <CalendarView
              rows={rows}
              dateIndex={detection.calendarDateIndex}
              valueIndex={detection.calendarValueIndex}
            />
          )}
        {view === 'clock' &&
          detection.clockLabelIndex !== null &&
          detection.clockValueIndex !== null &&
          detection.clockKind !== null && (
            <ClockView
              rows={rows}
              labelIndex={detection.clockLabelIndex}
              valueIndex={detection.clockValueIndex}
              kind={detection.clockKind}
            />
          )}
        {view === 'list' &&
          detection.imageIndex !== null &&
          detection.labelIndex !== null && (
            <ListView
              rows={rows}
              imageIndex={detection.imageIndex}
              labelIndex={detection.labelIndex}
              metricIndex={metricIndex}
              metricLabel={metricLabel}
              art={payload.art}
              onOpen={onOpen}
            />
          )}
        {view === 'chart' &&
          detection.chartLabelIndex !== null &&
          detection.chartValueIndex !== null && (
            <ChartView
              rows={rows}
              labelIndex={detection.chartLabelIndex}
              valueIndex={detection.chartValueIndex}
              isTimeSeries={detection.chartIsTimeSeries}
            />
          )}
        {view === 'histogram' &&
          detection.histogramValueIndex !== null &&
          detection.histogramBins !== null && (
            <HistogramView
              bins={detection.histogramBins}
              columnName={columns[detection.histogramValueIndex] ?? ''}
            />
          )}
        {view === 'scatter' &&
          detection.scatterXIndex !== null &&
          detection.scatterYIndex !== null && (
            <ScatterView
              rows={rows}
              xIndex={detection.scatterXIndex}
              yIndex={detection.scatterYIndex}
              labelIndex={detection.scatterLabelIndex}
              xName={columns[detection.scatterXIndex] ?? ''}
              yName={columns[detection.scatterYIndex] ?? ''}
            />
          )}
        {view === 'stacked' &&
          detection.stackedCategoryIndex !== null &&
          detection.stackedSeriesIndex !== null &&
          detection.stackedValueIndex !== null && (
            <StackedView
              rows={rows}
              categoryIndex={detection.stackedCategoryIndex}
              seriesIndex={detection.stackedSeriesIndex}
              valueIndex={detection.stackedValueIndex}
              categoryName={columns[detection.stackedCategoryIndex] ?? ''}
            />
          )}
        {view === 'treemap' &&
          detection.treemapLabelIndex !== null &&
          detection.treemapValueIndex !== null && (
            <TreemapView
              rows={rows}
              labelIndex={detection.treemapLabelIndex}
              valueIndex={detection.treemapValueIndex}
              valueName={columns[detection.treemapValueIndex] ?? ''}
            />
          )}
        {view === 'sankey' &&
          detection.sankeySourceIndex !== null &&
          detection.sankeyTargetIndex !== null &&
          detection.sankeyValueIndex !== null && (
            <SankeyView
              rows={rows}
              sourceIndex={detection.sankeySourceIndex}
              targetIndex={detection.sankeyTargetIndex}
              valueIndex={detection.sankeyValueIndex}
            />
          )}
        {view === 'mosaic' &&
          detection.imageIndex !== null &&
          detection.labelIndex !== null &&
          detection.mosaicMetricIndex !== null && (
            <MosaicView
              rows={rows}
              imageIndex={detection.imageIndex}
              labelIndex={detection.labelIndex}
              metricIndex={detection.mosaicMetricIndex}
              metricLabel={metricLabel}
              art={payload.art}
              onOpen={onOpen}
            />
          )}
        {view === 'map' && (
          <MapView
            rows={rows}
            latIndex={detection.latIndex}
            lngIndex={detection.lngIndex}
            polylineIndex={detection.polylineIndex}
            labelIndex={detection.labelIndex}
            mapConfig={payload.map_config}
          />
        )}
      </div>
    </article>
  );
}
