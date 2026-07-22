# Generic query-result MCP-UI renderer

**Date:** 2026-07-22
**Scope:** `mcp-server/` — one adaptive MCP Apps bundle that renders ANY
`query_rewind` SQL result as a table, chart, slippy map, or card grid.

This is "Option A, generalized" from issue #3: rather than authoring a
per-question component, `query_rewind` ships a single bundle that inspects the
result shape at render time and picks the best view. Complex and cross-domain
SELECTs get rich rendering for free.

## Architecture

```
query_rewind (src/tools/query.ts)
  ├─ input: sql, view?: 'auto'|'table'|'chart'|'map'|'grid' (default 'auto'), embed_art?
  ├─ result: text table + inline image blocks (unchanged, backward-compatible)
  │          structuredContent { columns, rows, row_count, truncated, view, art?, map_config? }
  └─ _meta.ui.resourceUri = ui://rewind/query-result.html   (registration + result)

ui://rewind/query-result.html  (registered in src/server.ts)
  csp.resourceDomains: cdn.dinakartumu.com + api.mapbox.com + OSM tile hosts (<img> loads)
  └─ web/query-result.tsx  →  <QueryResult payload={structuredContent} />

web/components/QueryResult.tsx  — view switcher + 4 views
web/lib/query-view.ts           — pure detection (detectView, cell classifiers)
web/lib/geo-projection.ts       — SVG fallback projector (decode + project + path)
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

## Map view — Leaflet with a configurable tile provider

The map view is a **real slippy map**: [Leaflet](https://leafletjs.com/)
(bundled dependency) with a **configurable raster tile provider**.

- **Tile provider (configurable):** when a `MAPBOX_TOKEN` is configured on the
  server, the query tool attaches a `map_config` to structuredContent and the
  bundle renders **Mapbox `outdoors-v12` raster tiles**
  (`https://api.mapbox.com/styles/v1/mapbox/outdoors-v12/tiles/256/{z}/{x}/{y}@2x?access_token=<TOKEN>`,
  `maxZoom 22`, attribution `© Mapbox © OpenStreetMap`, `tileSize 256` /
  `zoomOffset 0` to match the 256/@2x URL). When no token is set, `map_config`
  is **omitted** and the bundle falls back to **OpenStreetMap raster tiles**
  (`https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png`, `maxZoom 19`,
  attribution `© OpenStreetMap contributors`; Leaflet's `{s}` cycles the
  `a`/`b`/`c` subdomains). No API token, no account for the OSM fallback.
- **Token threading:** `MAPBOX_TOKEN` is a **public, rotatable** Mapbox
  access token. It reaches the query tool via a `{ mapboxToken }` config on
  `createServer` — read from the Worker secret `env.MAPBOX_TOKEN` in the remote
  path (`src/worker.ts`) and from `process.env.MAPBOX_TOKEN` in the local stdio
  path (`src/index.ts`). It is injected into `map_config.tileUrl` per response;
  since that lives in structuredContent (model-visible), only a **public**
  token is ever used — never a secret/private `sk.` token.
- **Geometry:** the same row-decode feeds both renderers. Point rows
  (lat/lng columns) become `L.circleMarker`s (radius 5, filled); route rows
  (decoded via the retained `decodePolyline`) become `L.polyline`s
  (accent stroke, weight 3, rounded). We deliberately **never** use Leaflet's
  default marker icon — that would fetch PNG icons from unpkg (an extra CSP
  origin + broken icons in the sandboxed iframe). `circleMarker` only.
- **Framing:** `map.fitBounds` over the combined point+route bounds with
  padding; a lone point uses `setView(..., 13)`. Zoom control on, scroll-wheel
  zoom off (keeps the small card contained). `map.invalidateSize()` runs after
  mount because the container has a definite `360px` height. Markers carry a
  tooltip from the row's name/label column when present.
- **Legend:** `N points · M routes · <provider>`, where `<provider>` is
  `Mapbox` when a token is configured, else `OpenStreetMap`.
- **Leaflet CSS** is imported (`import 'leaflet/dist/leaflet.css'`) and
  **inlined** into the single-file bundle by `vite-plugin-singlefile` — the
  built `query-result.html` has zero external `<link rel=stylesheet>` and the
  `.leaflet-container`/`.leaflet-tile` rules live inline. The map is fully
  self-contained in the one HTML bundle.

### CSP

Tiles load as `<img>`, so the query-result resource's `csp.resourceDomains`
(img-src) includes both `api.mapbox.com` (the Mapbox raster-tile host, used
when a token is configured) and the OSM tile hosts (the tokenless fallback),
alongside the existing artwork host — **only this resource** is changed:

```
resourceDomains: [
  'https://cdn.dinakartumu.com',
  'https://api.mapbox.com',
  'https://a.tile.openstreetmap.org',
  'https://b.tile.openstreetmap.org',
  'https://c.tile.openstreetmap.org',
  'https://tile.openstreetmap.org',
]
```

Per the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/):
the OSM fallback is a low-volume personal-archive use with clear attribution
and no bulk downloading, which the policy permits.

### Tile-less SVG fallback (retained)

`web/lib/geo-projection.ts` is **kept** as the offline fallback. If Leaflet
throws during init, or there's no network (tiles fail), the view catches the
failure and renders the original tile-less SVG projector instead — the map
never fully breaks:

1. `decodePolyline(str)` — hand-rolled Google-polyline decoder (precision 1e-5,
   zigzag 5-bit chunks). Returns `[]` on malformed input instead of throwing.
   Shared by the Leaflet path AND the fallback.
2. `boundsOf(points)` — lat/lng bounding box over every plotted coordinate.
3. `makeProjector(bounds, w, h, pad)` — **equirectangular** projection with a
   `cos(midLat)` x-scale; fit-to-box preserving aspect, centered; degenerate
   spans fall back gracefully. Returns a `project(lat,lng)→[x,y]` closure.
4. Points render as `<circle>` dots (radius shrinks with density); routes as
   stroked `<path>` (downsampled to ≤120 points). Legend reads
   `N points · M routes · tile-less` so the fallback is visually labelled.

The fallback needs no tiles, no external requests, no API key.

## What was reused vs added

**Reused (unchanged):** `web/lib/root-style.ts`, `web/lib/state-style.ts`,
`web/lib/card-tokens.ts` (`cardOuterChrome`, `CARD_OUTER_CLASSNAME`), the
`useApp`/`useHostStyles`/`createRoot`/`ontoolresult`/`openLink` entry pattern
(cloned from `top-albums.tsx`), the `registerUiResource` + CSP registration
path, the `_meta.ui.resourceUri` attach convention, and `scripts/inline-bundles.mjs`.

**Added:** `web/lib/query-view.ts` (detection), `web/lib/geo-projection.ts`
(SVG fallback projector, ported from the website), `leaflet` (bundled
dependency powering the OSM slippy map), `web/components/QueryResult.tsx`
(4 views

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
