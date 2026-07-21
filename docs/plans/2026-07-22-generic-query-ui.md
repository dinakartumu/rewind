# Generic query-result MCP-UI renderer

**Date:** 2026-07-22
**Scope:** `mcp-server/` — one adaptive MCP Apps bundle that renders ANY
`query_rewind` SQL result as a table, chart, tile-less map, or card grid.

This is "Option A, generalized" from issue #3: rather than authoring a
per-question component, `query_rewind` ships a single bundle that inspects the
result shape at render time and picks the best view. Complex and cross-domain
SELECTs get rich rendering for free.

## Architecture

```
query_rewind (src/tools/query.ts)
  ├─ input: sql, view?: 'auto'|'table'|'chart'|'map'|'grid' (default 'auto'), embed_art?
  ├─ result: text table + inline image blocks (unchanged, backward-compatible)
  │          structuredContent { columns, rows, row_count, truncated, view, art? }
  └─ _meta.ui.resourceUri = ui://rewind/query-result.html   (registration + result)

ui://rewind/query-result.html  (registered in src/server.ts)
  csp.resourceDomains: ['https://cdn.dinakartumu.com']       (CDN <img> loads)
  └─ web/query-result.tsx  →  <QueryResult payload={structuredContent} />

web/components/QueryResult.tsx  — view switcher + 4 views
web/lib/query-view.ts           — pure detection (detectView, cell classifiers)
web/lib/geo-projection.ts       — tile-less projector (decode + project + path)
```

The detection logic lives in a **pure, DOM-free module** (`web/lib/query-view.ts`)
so it is unit-testable (`web/lib/query-view.test.ts`) and reused by the
component and the fixtures. The component is a thin renderer over `detectView`.

## Detection rules (client-side, from column names + value sampling)

Columns are classified by name hint AND a sample of up to 25 non-null values.
Never throws; **table is always available and is the universal fallback.**

- **map** — a lat column (name matches `lat`/`latitude`, ≥80% numeric in
  [-90,90]) AND a lng column (`lng`/`lon`/`long`/`longitude`, ≥80% numeric in
  [-180,180]), OR a polyline column (name matches
  `map_polyline`/`polyline`/`route`/`encoded_path` with ≥50% encoded-looking
  string values). Requires ≥1 row.
- **chart** — exactly 2 columns, ≥1 row, resolving to one category/period
  column + one numeric column. If the category column reads as a period
  (`YYYY`, `YYYY-MM`, or ISO date, ≥60% of samples) → **line/area time-series**;
  otherwise → **bar chart**. Two numeric columns count as a chart only when the
  first looks period-ish (e.g. `year, plays`).
- **grid** — a CDN image-URL column (`https://cdn.dinakartumu.com/...`, ≥50% of
  samples) AND a name/label text column (`name`/`title`/`label`/`track`/…, or
  any text column), with ≥1 row. A leftover numeric column becomes the card
  metric.
- **table** — everything else, and the fallback whenever a richer view fails.

**Auto priority:** `map > grid > chart > table`. The `view` arg forces one
mode (still validated by the input enum). The UI always shows a **table** tab
plus a tab for each detected richer view; table is the safe default tab, and
`auto` selects the richest applicable view on first render.

## Tile-less map projection

Ported from the website's `src/lib/polyline.ts` and generalized into
`web/lib/geo-projection.ts` so **points and routes share one projector**:

1. `decodePolyline(str)` — hand-rolled Google-polyline decoder (precision 1e-5,
   zigzag 5-bit chunks). Returns `[]` on malformed input instead of throwing.
2. `boundsOf(points)` — lat/lng bounding box over every plotted coordinate
   (all check-in points + every route vertex combined).
3. `makeProjector(bounds, w, h, pad)` — **equirectangular** projection with a
   `cos(midLat)` x-scale so east-west distance isn't exaggerated at latitude;
   fit-to-box preserving aspect, centered on both axes; degenerate spans
   (single point / straight line) fall back gracefully rather than dividing by
   zero. Returns a `project(lat,lng)→[x,y]` closure.
4. Points render as `<circle>` dots (radius shrinks as density grows:
   4 → 2.5 → 1.5px past 50 / 200 points); routes render as stroked
   `<path>` (downsampled to ≤120 points via `routeToPath`). A subtle bounding
   frame + a legend (`N points · M routes · tile-less`) complete the canvas.

**No tiles, no external requests, no API key** — everything is inline SVG
computed from the coordinates in the result.

## What was reused vs added

**Reused (unchanged):** `web/lib/root-style.ts`, `web/lib/state-style.ts`,
`web/lib/card-tokens.ts` (`cardOuterChrome`, `CARD_OUTER_CLASSNAME`), the
`useApp`/`useHostStyles`/`createRoot`/`ontoolresult`/`openLink` entry pattern
(cloned from `top-albums.tsx`), the `registerUiResource` + CSP registration
path, the `_meta.ui.resourceUri` attach convention, and `scripts/inline-bundles.mjs`.

**Added:** `web/lib/query-view.ts` (detection), `web/lib/geo-projection.ts`
(projector, ported from the website), `web/components/QueryResult.tsx` (4 views

- switcher), `web/query-result.{tsx,html,fixtures.ts}`, and the `view` input
  arg + result `_meta` wiring in `query.ts`.

## Trade-offs

- **Detection is heuristic**, not schema-driven — it samples 25 rows and uses
  name regexes. A column literally named `route` holding non-encoded text won't
  trip the map (values must look encoded); a genuinely ambiguous 2-column shape
  defaults to table. The `view` override exists for when the heuristic guesses
  wrong.
- **Chart is intentionally restricted to the 2-column case.** Multi-series
  charts were out of scope; a 3+ column numeric result renders as a table where
  the model can still read every value.
- **Bundle size** matches the sibling cards (~454 KB / 464,814 chars) — React +
  the shared style lib dominate; the detection + projection code is a few KB.
  We accepted the shared-React footprint rather than shipping a hand-rolled
  renderer, for consistency with the existing bundles.
- **Backward compatible:** non-UI hosts still get the exact text table + inline
  image blocks + full `structuredContent` as before; the bundle is purely
  additive via `_meta`.

```

```
