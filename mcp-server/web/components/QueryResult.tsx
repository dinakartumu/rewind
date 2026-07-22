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
    const order: ViewMode[] = ['table', 'chart', 'map', 'grid'];
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

  // Grid metric: a numeric column that isn't the image or label column.
  const metricIndex =
    view === 'grid'
      ? ([...numericCols].find(
          (i) => i !== detection.imageIndex && i !== detection.labelIndex
        ) ?? null)
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
