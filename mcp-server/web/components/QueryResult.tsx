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
      'chart',
      'map',
      'list',
      'grid',
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

  // Grid/list metric: a numeric column that isn't the image or label column.
  // detection.metricIndex already resolves this; keep the local for callers.
  const metricIndex =
    view === 'grid' || view === 'list' ? detection.metricIndex : null;
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
