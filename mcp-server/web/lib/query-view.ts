/**
 * Client-side view auto-detection for the generic query-result renderer.
 *
 * Given a raw SQL result ({ columns, rows }) this infers WHICH rich view best
 * fits the shape — map, chart, grid, or table — purely from column names plus
 * value sampling. It never throws and always includes `table` as a fallback,
 * so a bizarre result simply renders as a styled table.
 *
 * Kept dependency-free and pure so it can be unit-tested and reused by the
 * React component and the fixtures without a DOM.
 */

export type Cell = unknown;
export type Row = Cell[];

/**
 * Optional tile-provider config for the map view. Present when the server has a
 * MAPBOX_TOKEN configured; absent → the map defaults to OpenStreetMap tiles.
 */
export type MapConfig = {
  provider: 'mapbox' | 'osm';
  tileUrl: string;
  attribution: string;
  maxZoom: number;
};

export type QueryResultShape = {
  columns: string[];
  rows: Row[];
  /** Optional server-forced view. 'auto' (or undefined) → run detection. */
  view?: ViewMode | 'auto';
  /** Optional base64 art map keyed by original CDN URL (embed_art). */
  art?: Record<string, string>;
  /** Optional tile-provider config for the map view (Mapbox when configured). */
  map_config?: MapConfig;
};

export type ViewMode = 'table' | 'chart' | 'map' | 'grid';

/** Public CDN origin — a cell under this host is Rewind artwork. */
export const CDN_ORIGIN = 'https://cdn.dinakartumu.com';

/** A value is a CDN image URL when it's an https URL under the CDN origin. */
export function isCdnImageUrl(v: Cell): v is string {
  return typeof v === 'string' && v.startsWith(`${CDN_ORIGIN}/`);
}

/** A 3- or 6-digit hex color string, e.g. "#1a2b3c" or "#abc". */
export function isHexColor(v: Cell): v is string {
  return typeof v === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v);
}

/** True when the string parses as a finite number (ints, decimals, negatives). */
function looksNumericString(v: string): boolean {
  if (v.trim() === '') return false;
  return Number.isFinite(Number(v));
}

/** A cell is numeric when it's a JS number or a numeric-looking string. */
export function isNumericCell(v: Cell): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return looksNumericString(v);
  return false;
}

/** Coerce a cell to a number for charting; NaN when not numeric. */
export function toNumber(v: Cell): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  return NaN;
}

/** ISO date / period: "2024", "2024-07", "2024-07-22", or a full ISO datetime. */
export function looksLikePeriod(v: Cell): boolean {
  if (typeof v !== 'string') return false;
  return (
    /^\d{4}$/.test(v) || // year
    /^\d{4}-\d{2}$/.test(v) || // year-month
    /^\d{4}-\d{2}-\d{2}/.test(v) // date or ISO datetime
  );
}

/** A cell that reads as a full ISO 8601 timestamp (has a time component). */
export function looksLikeTimestamp(v: Cell): boolean {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v);
}

/** How many rows to sample when classifying a column. */
const SAMPLE = 25;

type ColKind = 'numeric' | 'lat' | 'lng' | 'polyline' | 'image' | 'text';

type ColInfo = {
  name: string;
  index: number;
  kind: ColKind;
  /** Fraction of non-null sampled values matching the kind's predicate. */
  confidence: number;
};

const LAT_RE = /(^|_)lat(itude)?($|_)/i;
const LNG_RE = /(^|_)(lng|lon|long|longitude)($|_)/i;
const POLYLINE_RE = /(map_?polyline|polyline|route|encoded_?path)/i;
const NAME_RE = /(name|title|label|track|album|artist|movie|show|venue|city)/i;

/** Sample non-null cells from a column. */
function sampleColumn(rows: Row[], index: number): Cell[] {
  const out: Cell[] = [];
  for (let i = 0; i < rows.length && out.length < SAMPLE; i++) {
    const v = rows[i]?.[index];
    if (v !== null && v !== undefined && v !== '') out.push(v);
  }
  return out;
}

function fractionMatching(cells: Cell[], pred: (c: Cell) => boolean): number {
  if (cells.length === 0) return 0;
  let n = 0;
  for (const c of cells) if (pred(c)) n++;
  return n / cells.length;
}

/** Classify one column by name + value sampling. */
function classifyColumn(
  columns: string[],
  rows: Row[],
  index: number
): ColInfo {
  const name = columns[index] ?? `col_${index}`;
  const cells = sampleColumn(rows, index);
  const numericConf = fractionMatching(cells, isNumericCell);
  const imageConf = fractionMatching(cells, isCdnImageUrl);

  // Polyline: name hints AND values that look like encoded strings (non-numeric
  // strings with a bit of length). We DON'T require a strict polyline decode
  // here — that would need the decoder; the map view decodes at render.
  if (
    POLYLINE_RE.test(name) &&
    fractionMatching(
      cells,
      (c) => typeof c === 'string' && c.length >= 8 && !looksNumericString(c)
    ) >= 0.5
  ) {
    return { name, index, kind: 'polyline', confidence: 1 };
  }

  // Lat / lng require BOTH a name hint and mostly-numeric values in range.
  if (LAT_RE.test(name) && numericConf >= 0.8) {
    const inRange = fractionMatching(cells, (c) => {
      const n = toNumber(c);
      return Number.isFinite(n) && n >= -90 && n <= 90;
    });
    if (inRange >= 0.8)
      return { name, index, kind: 'lat', confidence: inRange };
  }
  if (LNG_RE.test(name) && numericConf >= 0.8) {
    const inRange = fractionMatching(cells, (c) => {
      const n = toNumber(c);
      return Number.isFinite(n) && n >= -180 && n <= 180;
    });
    if (inRange >= 0.8)
      return { name, index, kind: 'lng', confidence: inRange };
  }

  if (imageConf >= 0.5)
    return { name, index, kind: 'image', confidence: imageConf };

  // Numeric column: mostly-numeric values AND not obviously an id/year we want
  // to treat as a category. We keep years numeric — the chart detector decides
  // period-vs-value by column ROLE (only col, first vs second), not here.
  if (numericConf >= 0.8)
    return { name, index, kind: 'numeric', confidence: numericConf };

  return { name, index, kind: 'text', confidence: 1 };
}

export type Detection = {
  /** Chosen default view when `view` is 'auto'. */
  auto: ViewMode;
  /** Which non-table views detection considers applicable (tabs to show). */
  available: ViewMode[];
  columns: ColInfo[];
  /** Convenience indices used by the views. */
  latIndex: number | null;
  lngIndex: number | null;
  polylineIndex: number | null;
  imageIndex: number | null;
  labelIndex: number | null;
  /** Chart hints: category/period column + value column. */
  chartLabelIndex: number | null;
  chartValueIndex: number | null;
  chartIsTimeSeries: boolean;
};

/** Pick a label column: an image-adjacent name/title/text column. */
function pickLabelIndex(cols: ColInfo[]): number | null {
  const named = cols.find((c) => c.kind === 'text' && NAME_RE.test(c.name));
  if (named) return named.index;
  const anyText = cols.find((c) => c.kind === 'text');
  return anyText ? anyText.index : null;
}

/**
 * Run detection over a result. Pure, never throws. `table` is always valid and
 * is the fallback whenever nothing richer applies.
 */
export function detectView(result: QueryResultShape): Detection {
  const columns = Array.isArray(result.columns) ? result.columns : [];
  const rows = Array.isArray(result.rows) ? result.rows : [];
  const cols = columns.map((_, i) => classifyColumn(columns, rows, i));

  const latIndex = cols.find((c) => c.kind === 'lat')?.index ?? null;
  const lngIndex = cols.find((c) => c.kind === 'lng')?.index ?? null;
  const polylineIndex = cols.find((c) => c.kind === 'polyline')?.index ?? null;
  const imageIndex = cols.find((c) => c.kind === 'image')?.index ?? null;
  const labelIndex = pickLabelIndex(cols);

  const available: ViewMode[] = [];

  // MAP: lat AND lng, or a polyline column — with at least one row.
  const hasMap =
    rows.length > 0 &&
    ((latIndex !== null && lngIndex !== null) || polylineIndex !== null);
  if (hasMap) available.push('map');

  // GRID: an image column AND a label column AND at least one row.
  const hasGrid = rows.length > 0 && imageIndex !== null && labelIndex !== null;
  if (hasGrid) available.push('grid');

  // CHART: exactly one text/period column + exactly one numeric column
  // (i.e. a 2-column category→value shape). We locate them by role.
  let chartLabelIndex: number | null = null;
  let chartValueIndex: number | null = null;
  let chartIsTimeSeries = false;
  if (cols.length === 2 && rows.length > 0) {
    const numericCols = cols.filter((c) => c.kind === 'numeric');
    const nonNumeric = cols.filter((c) => c.kind !== 'numeric');
    if (numericCols.length === 1 && nonNumeric.length === 1) {
      chartValueIndex = numericCols[0].index;
      chartLabelIndex = nonNumeric[0].index;
    } else if (numericCols.length === 2) {
      // Two numeric cols: treat the first as the category/period axis if it
      // looks period-ish (years), else fall back — the first is the label.
      const first = cols[0];
      const firstCells = sampleColumn(rows, first.index);
      if (fractionMatching(firstCells, looksLikePeriod) >= 0.6) {
        chartLabelIndex = cols[0].index;
        chartValueIndex = cols[1].index;
      }
    }
    if (chartLabelIndex !== null && chartValueIndex !== null) {
      const labelCells = sampleColumn(rows, chartLabelIndex);
      chartIsTimeSeries = fractionMatching(labelCells, looksLikePeriod) >= 0.6;
      available.push('chart');
    }
  }

  // Default view priority: map > grid > chart > table. Table is always the
  // safe default tab in the UI, but `auto` picks the richest applicable view.
  let auto: ViewMode = 'table';
  if (hasMap) auto = 'map';
  else if (hasGrid) auto = 'grid';
  else if (chartValueIndex !== null) auto = 'chart';

  return {
    auto,
    available,
    columns: cols,
    latIndex,
    lngIndex,
    polylineIndex,
    imageIndex,
    labelIndex,
    chartLabelIndex,
    chartValueIndex,
    chartIsTimeSeries,
  };
}
