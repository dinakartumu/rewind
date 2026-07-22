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
- **calendar** (heatmap) — col0 is a **DAY-precision date** (`YYYY-MM-DD`, ≥60%
  of samples, no time component) AND there is **exactly one** numeric column.
  Requires ≥1 row. Deliberately distinct from the time-series chart, which
  fires on coarser `YYYY` / `YYYY-MM` period granularity — a `YYYY-MM` result
  stays a chart, never a calendar. Renders a GitHub-contributions grid (weeks as
  columns, Mon–Sun rows, one stacked panel per calendar year, month labels + a
  less→more legend); missing days render as empty cells and duplicate days sum.
- **clock** (polar) — col0 is a **cyclic category** plus **one** numeric count
  column: integer **hours** all in `[0,23]` (≥90%, with real spread — ≥6
  distinct values and at least one in the 7–23 band so tiny small-integer
  categories don't qualify), integer **weekday** indices all in `[0,6]` (≥90%,
  ≥4 distinct), or **weekday names** (`Mon`/`Monday`/… ≥80%). Requires ≥1 row.
  Guarded tightly so an ordinary category+count stays a bar chart; when
  ambiguous it prefers the chart. Renders a radial histogram (24 hour spokes or
  7 weekday wedges, length + opacity by count, ring labels, center total).
- **stat** (cards) — **exactly one row** AND ≥1 numeric column. Renders each
  column as a labeled big-number KPI tile (humanized column name, thousands
  separators; durations are shown raw — no unit inference); non-numeric columns
  become small caption tiles.
- **grid / list** (both offered) — a CDN image-URL column
  (`https://cdn.dinakartumu.com/...`, ≥50% of samples) AND a name/label text
  column (`name`/`title`/`label`/`track`/…, or any text column), with ≥1 row. A
  leftover numeric column (not the image or label) is the ranking metric. BOTH
  the **card grid** and the **ranked list** tabs are shown whenever this shape
  holds. Default: **list** when there is exactly one obvious metric to rank by,
  else **grid**. The list is horizontal rows — rank number (1,2,3… by result
  order), a small square cover, the name, a proportional metric bar + its value.
- **stacked** (stacked bar) — exactly **three** columns resolving to one
  discrete **category** + one discrete **series** (both text, or a period-ish
  column such as `year` that reads numeric) + one **numeric value**, with **≥2
  distinct categories**. Groups by category on the x-axis, stacks the series
  segments, and shows a colored legend (`year, genre, count` → years on x, genre
  segments stacked). Guarded tight so an ordinary 2-column category+metric stays
  a plain **bar chart**, never a stack.
- **scatter** — exactly **two numeric** columns (both ≥80% numeric) + **≥5
  rows**, and col0 NOT reading as a period/date (so it never steals a
  time-series). x = col0, y = col1, rendered as a dot cloud with axis ticks +
  labels. An optional **3rd text column** supplies per-point labels (tooltip
  title) — e.g. `distance_km, pace_min_km, name`. A period-ish first column
  (`year, plays`) stays a chart.
- **histogram** — a **single numeric** column of **raw values** (one column,
  ≥80% numeric) with **≥8 rows** to bin. The distribution is bucketed
  (Freedman–Diaconis bin width `2·IQR·n^(-1/3)`, falling back to ~`sqrt(n)` when
  the IQR is zero, capped at **30 bins**) and rendered as an SVG histogram —
  bars along the value axis, a frequency (count) axis, edge labels. This is for
  RAW value distributions ("all my movie ratings", "run distances"), distinct
  from a **chart** (which needs a category/period + a metric). A single numeric
  column with <8 rows, or one that yields <2 distinct bucketed values, stays a
  table.
- **chart** — exactly 2 columns, ≥1 row, resolving to one category/period
  column + one numeric column. If the category column reads as a period
  (`YYYY`, `YYYY-MM`, or ISO date, ≥60% of samples) → **line/area time-series**;
  otherwise → **bar chart**. Two numeric columns count as a chart only when the
  first looks period-ish (e.g. `year, plays`).
- **treemap** — the SAME category (text) + one numeric column shape the bar
  **chart** fires on, offered as an **additional tab** — but only when there are
  **≥8 distinct categories** and the category column is NOT a period
  (a treemap of months makes no sense). Reads as share-of-whole: rectangles
  sized by value (squarified-ish slice-and-dice so tiles trend square), labeled
  (name + value) when the tile is big enough, sequential opacity by value
  (bigger = more opaque). Handles a single dominant tile + a long tail
  gracefully (tiny tiles drop their labels). BOTH the `chart` and `treemap`
  tabs are shown; `auto` stays **chart** for small N and flips to **treemap**
  once there are ≥8 categories.
- **sankey** — a **flow diagram** over a 3-col shape: exactly **one source
  (text)** + **one target (text)** + **one numeric value**, with **≥2 distinct
  sources OR targets**. Left nodes (sources) and right nodes (targets) are sized
  by throughput; curved link ribbons are width-proportional to value; nodes are
  capped at **~12 per side** with the overflow bucketed into an "Other" node so
  the diagram stays legible (2 columns of nodes only — no multi-level). This is
  the **same text+text+num shape as `stacked`**, so BOTH are offered as tabs;
  see the **stacked-vs-sankey default rule** below.
- **mosaic** (cover mosaic) — a **variant of `grid`**: detects the SAME signal
  (CDN image-URL column + name/label column) AND requires a **numeric metric**,
  offered as an **additional tab** whenever grid applies with a metric. Renders
  a packed wall of cover images **sized by the metric** (bigger = more
  plays/watches; a `sqrt` scale keeps area — not edge — proportional so one big
  value doesn't dwarf the wall), wrapping via flexbox; names are tooltips/
  captions. Images load straight from the CDN (already CSP-allowed). **Never the
  `auto` default** — grid/list keep that; mosaic is purely an extra tab.
- **density** (density map) — an **additional tab** on the SAME lat/lng POINT
  shape `map` fires on: offered whenever there ARE lat/lng point columns AND
  **≥1 in-range point** (NOT for a route-only/polyline result). Renders a
  heat/density read over the SAME Leaflet base map — a **hand-rolled binned
  aggregation** (snap each point to a lat/lng grid cell sized off the data
  bounds, sum points per cell) drawn as **graduated `circleMarker`s** with
  radius (`sqrt`-scaled so area trends with count) + opacity scaled by the
  cell's local point count, so clusters read as "where I go most". **No heatmap
  plugin dep.** The tile-less SVG fallback draws the same density dots on the
  SVG projector when Leaflet can't init. **Never the `auto` default** — `map`
  keeps that; density is purely an extra tab.
- **gallery** (route gallery) — a POLYLINE column with **MANY route rows (≥4
  decodable encoded polylines)** → **small-multiples**: a grid of individual
  mini route-shape SVGs, **each route normalized into its OWN box** (its own
  bounds → its own projector via `boundsOf` + `makeProjector` + `routeToPath`),
  labeled by a name/label column when present. The "wall of run shapes". NO
  tiles, zero network — pure decoded polyline paths. A **NEW auto default** at
  ≥4 routes (placed at map's altitude); a single/few-route result stays `map`
  (which is still offered as a tab).
- **streak** (streak strip) — the SAME daily-date (YYYY-MM-DD) + numeric shape
  as `calendar`, offered as an **additional tab**. A **horizontal timeline**
  from first→last dated day: consecutive-day runs where count>0 are streaks;
  active days are filled marks, rest days muted dots, and the **longest streak**,
  **current (trailing) streak**, and **active-day count** are annotated.
  Complements the calendar grid with a streak-focused read. **Never the `auto`
  default** — `calendar` keeps that; streak is purely an extra tab.
- **detail** (entity detail) — a **single row** (row_count === 1) that carries
  a **CDN image-URL column** PLUS a name/label column AND **≥2 columns beyond the
  image** → a rich single-entity card: a large cover, the primary name/title (a
  `name`/`title`/`album`/… column, else the first text col), then the remaining
  columns as a **humanized labeled field list** (formatted numbers, readable
  dates, hex→swatch, other CDN-image cols as small thumbs). This is the
  single-row-WITH-image case — distinct from `stat` (single-row ALL-numeric KPI
  tiles). It becomes the `auto` view for that shape, sitting **above stat and
  grid/list**, so a 1-row all-numeric result stays `stat` and a multi-row image
  result stays grid/list. A bare 1-row image+label (2 cols) stays grid/list.
- **wrapped** (year-in-review) — a **curated composite the model REQUESTS via
  `view:'wrapped'`; NEVER auto-detected** (it is not in `detection.available`).
  It reads a documented UNION-ALL contract: highlight rows with columns
  `section, label, value, image` (image optional), grouped by `section`. Rows
  are grouped by section (order-preserving) and each section renders as a mini
  panel — a **ranked list with covers** when the section has images, else a
  **labeled stat**. A leading `SELECT 'Year' AS section, '<year> in review' AS
label, NULL, NULL` row titles the card. Resilient: unknown sections render
  generically; missing images fall back to text. Only appears as a tab when
  `view:'wrapped'` is forced.
- **table** — everything else, and the fallback whenever a richer view fails.

**Stacked-vs-sankey default rule.** `stacked` and `sankey` share the 3-col
text+text+num shape, so BOTH are always offered as tabs for it. The `auto`
DEFAULT is chosen from **col0** (the category/source): when col0 reads
**ordinal/temporal** — a period (`YYYY` / `YYYY-MM` / date, ≥60% of samples) —
you'd read the result over an ordered x-axis, so **stacked** is the default;
when col0 is a **free-form categorical** (col0 is NOT period-ish), it's two
categorical dimensions flowing into each other, so **sankey** is the default.
Practically, a `year, genre, count` result has col0 (`year`) classify numeric/
period, which leaves only ONE text column — so it never satisfies sankey's
"two text cols" guard and stays **stacked**; a `genre, decade, count` (both
free-form text) satisfies sankey and, because col0 (`genre`) isn't period-ish,
defaults to **sankey** (with a `stacked` tab still available).

**Auto priority (finalized):**
`gallery > map > calendar > clock > detail > stat > (grid | list) > (stacked | sankey) > scatter > histogram > (chart | treemap) > table`.
`detail` (1-row with an image + several fields) sits above `stat` and
`grid/list`. `wrapped` is NEVER in the auto priority — it activates only when
`view:'wrapped'` is explicitly forced.
`gallery` (≥4 polyline routes) is a NEW auto default sitting just above `map` (a
wall of route shapes beats a single overlaid map). `density` (point-map tab) and
`streak` (daily-date tab) are **additional tabs** layered onto shapes that
already resolve (point-map / daily-date+count) and never change `auto` — `map`
and `calendar` keep those defaults.
The `stacked`/`sankey` (3-col cat+series/target+num), `scatter` (2 numerics),
and `histogram` (1 numeric) views are MORE specific than the generic chart, so
they sit just before it; each guard stays tight so an ordinary category+metric
still lands on `chart` (or `treemap` at ≥8 categories) and odd shapes fall back
to `table`. `treemap` and `mosaic` are **additional tabs** layered onto shapes
that already resolve (category+metric / image+metric); `sankey` is a **new auto
view** for the free-form source+target+value shape (default chosen by the
stacked-vs-sankey rule above). The `view` arg forces one mode (validated by the
input enum:
`auto | table | chart | map | grid | calendar | clock | stat | list | histogram | scatter | stacked | treemap | sankey | mosaic | density | gallery | streak`).
The UI always shows a **table** tab plus a tab for each detected richer view;
table is the safe default tab, and `auto` selects the richest applicable view on
first render.

### Example SQL per auto-selected view

- **calendar** — `SELECT date(started_at) AS day, COUNT(*) AS runs FROM
strava_activities GROUP BY day` (daily dates + one count).
- **clock** — `SELECT CAST(strftime('%H', scrobbled_at) AS INT) AS hour,
COUNT(*) AS plays FROM lastfm_scrobbles GROUP BY hour` (hours 0–23 + count);
  weekday names via a `CASE strftime('%w', …)` also land here.
- **stat** — `SELECT COUNT(*) AS films, SUM(runtime)/60 AS hours,
COUNT(DISTINCT director) AS directors FROM watching_movies` (single row, 3
  numerics → "1,946 Films · 2,440 Hours · 312 Directors").
- **list / grid** — `SELECT name AS artist, image_url AS cover, play_count AS
plays FROM lastfm_artists ORDER BY plays DESC LIMIT 20` (image + label +
  one metric → ranked list by default; grid tab also available).
- **stacked** — `SELECT strftime('%Y', watched_at) AS year, genre,
COUNT(*) AS count FROM watching_movies m JOIN movie_genres g ON …
GROUP BY year, genre` (category + series + numeric → years on x, genre
  segments stacked).
- **scatter** — `SELECT distance_km, pace_min_km, name FROM strava_activities
WHERE distance_km > 0` (two numeric columns + a text label → pace vs distance;
  "rating vs runtime" is the same shape).
- **histogram** — `SELECT rating FROM watching_movies WHERE rating IS NOT NULL`
  (one numeric column of raw values → binned distribution of all ratings; "run
  distances" via `SELECT distance_km FROM strava_activities` is the same shape).
- **treemap** — `SELECT genre, SUM(runtime)/60 AS hours FROM watching_movies m
JOIN movie_genres g ON … GROUP BY genre ORDER BY hours DESC` (one category +
  one metric with ≥8 genres → share-of-whole tiles; "scrobbles by artist" via
  `SELECT name AS artist, play_count AS scrobbles FROM lastfm_artists ORDER BY
scrobbles DESC LIMIT 20` is the same shape). Fewer than 8 categories stays a
  bar `chart`.
- **sankey** — `SELECT genre, decade, COUNT(*) AS films FROM … GROUP BY genre,
decade` (source + target + value flow → genre→decade ribbons); "sport → city"
  via `SELECT sport, city, COUNT(*) AS sessions FROM … GROUP BY sport, city` is
  the same shape. Both free-form categoricals → sankey default (stacked tab also
  offered).
- **mosaic** — `SELECT name AS album, image_url AS cover, play_count AS plays
FROM lastfm_albums ORDER BY plays DESC LIMIT 24` (image + label + metric →
  a cover wall with each cover sized by plays). Same shape as list/grid; mosaic
  is the extra tab, never the auto default.
- **density** — `SELECT venue, lat, lng FROM places_checkins` (lat/lng points →
  the point `map` by default, with a **density** tab binning the points into
  graduated markers so clusters read as "where I go most"). Same shape as the
  point map; density is the extra tab, never the auto default. Not offered for a
  route-only result.
- **gallery** — `SELECT name, map_polyline FROM strava_activities WHERE
map_polyline IS NOT NULL ORDER BY started_at DESC LIMIT 24` (≥4 encoded
  polylines → a wall of individual mini route shapes, each labeled by name).
  Four-plus routes make gallery the auto default; a single-route result stays
  `map`.
- **streak** — `SELECT date(started_at) AS day, COUNT(*) AS runs FROM
strava_activities GROUP BY day` (daily dates + a count → the `calendar` heatmap
  by default, with a **streak** tab annotating consecutive-day runs — longest /
  current streak). Same shape as calendar; streak is the extra tab, never the
  auto default.
- **detail** — `SELECT al.name AS album, '<cdn_url>' AS cover, ar.name AS artist,
al.released_year, al.playcount, i.accent_color AS accent FROM lastfm_albums al
JOIN lastfm_artists ar ON ar.id = al.artist_id … WHERE al.id = 1` (ONE row with
  a cover URL + several fields → a rich single-entity card). A single-row
  all-numeric result (no image) stays `stat`.
- **wrapped** — `view:'wrapped'` with a cross-domain UNION-ALL:
  `SELECT 'Year' AS section, '2024 in review' AS label, NULL AS value, NULL AS
image UNION ALL SELECT 'Top Artists', ar.name, ar.playcount, '<cdn_url>' FROM
lastfm_artists ar WHERE ar.is_filtered = 0 ORDER BY ar.playcount DESC LIMIT 3
UNION ALL SELECT 'Top Films', m.title, wh.user_rating, '<poster_url>' FROM
watch_history wh JOIN movies m ON m.id = wh.movie_id … UNION ALL SELECT
'Miles Run', CAST(ROUND(SUM(distance)/1609.34) AS TEXT) || ' miles',
SUM(distance), NULL FROM strava_activities WHERE started_at LIKE '2024%'`
  (labeled highlight rows grouped by `section` → the year-in-review card). Every
  SELECT projects the SAME four columns in order; aliases only on the first.
  Never auto-selected — always requested via `view:'wrapped'`.

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

**Added later (first visualization batch, issue #4):** four more auto-detected
views in the same pure-detection + inline-SVG style, **zero new runtime deps** —
**calendar** heatmap, **clock** polar radial histogram, **stat** KPI cards, and
**list** ranked-with-art (sharing the grid signal). Detectors are pure functions
in `query-view.ts`; the `view` input enum + result schema grew to
`… | calendar | clock | stat | list`.

**Added later (section-A visualization batch, issue #4):** three more
auto-detected views, again pure-detection + inline-SVG, **zero new runtime
deps** — **histogram** (single numeric column of raw values, Freedman–Diaconis
binning), **scatter** (two numeric columns + optional text point label), and
**stacked** bar (category + series + numeric, colored legend). The `binValues`
histogram binner lives beside the detectors in `query-view.ts`; the `view` input
enum + result schema grew to `… | histogram | scatter | stacked`. Final auto
priority: `map > calendar > clock > stat > (grid | list) > stacked > scatter >
histogram > chart > table`.

**Added later (visualization batch, issue #5):** three more views, again
pure-detection + inline-SVG, **zero new runtime deps** — **treemap**
(category+metric with ≥8 distinct categories, squarified-ish share-of-whole
tiles; an extra tab on the bar-chart shape, and the `auto` default for large N),
**sankey** (a NEW auto view for the free-form source+target+value 3-col shape:
sized left/right nodes + width-proportional curved link ribbons, ~12 nodes/side
with an "Other" bucket), and **mosaic** (a `grid` variant sizing cover images by
a metric; an extra tab on the image+metric shape, never the auto default). The
`treemap`/`mosaic` tabs layer onto shapes that already resolve; `sankey` shares
the 3-col text+text+num shape with `stacked` and is disambiguated by the
**stacked-vs-sankey default rule** (period col0 → stacked, free-form col0 →
sankey). The `view` input enum + result schema grew to
`… | treemap | sankey | mosaic`.

**Added later (visualization batch, issue #6):** three more views, again
pure-detection + inline-SVG/Leaflet, **zero new runtime deps** (reusing
`geo-projection.ts` + the existing Leaflet dep) — **density** (a binned
graduated-marker heat/density overlay on the SAME point-map shape; hand-rolled
lat/lng grid binning, no heatmap plugin, with density dots on the SVG fallback;
an extra tab, never the auto default), **gallery** (small-multiples of route
shapes — ≥4 decodable polylines each normalized into its own mini-SVG box; a NEW
auto default at ≥4 routes, single-route stays `map`), and **streak** (a
horizontal consecutive-day-streak timeline on the SAME daily-date+count shape as
calendar — longest/current streak annotated; an extra tab, never the auto
default). The `view` input enum + result schema grew to
`… | density | gallery | streak`. Final auto priority:
`gallery > map > calendar > clock > stat > (grid | list) > (stacked | sankey) >
scatter > histogram > (chart | treemap) > table`.

**Added later (final section-B batch, issue #4):** two more views, again
pure-detection/curated + inline-SVG-free DOM, **zero new runtime deps** —
**detail** (a rich single-ENTITY card: a SINGLE-ROW result carrying a CDN image
URL column PLUS several other fields → a large cover, the primary name/title,
and the remaining columns as a humanized labeled field list, with hex→swatch and
other CDN-image cols as small thumbs; it becomes the `auto` view for the
single-row-with-image shape, sitting above `stat` and `grid/list` so a 1-row
all-numeric result stays `stat` and a multi-row image result stays grid/list),
and **wrapped** (a CURATED year-in-review composite that is **never
auto-detected** — the model requests it via `view:'wrapped'`). The wrapped view
reads a documented UNION-ALL contract: highlight rows with columns
`section, label, value, image` (image optional), grouped by `section`. It groups
rows by section (order-preserving) and renders each as a mini panel — a ranked
list with covers when the section carries images, else a labeled stat; a
leading `SELECT 'Year' AS section, '<year> in review' AS label, NULL, NULL`
titles the card. Resilient: unknown sections render generically and missing
images fall back to text. `detail`'s detection is pure in `query-view.ts`
(`detailImageIndex`/`detailNameIndex`); `wrapped` has no detector (never in
`detection.available`) and only appears as a tab when forced. The `view` input
enum + result schema grew to `… | detail | wrapped`. Final auto priority:
`gallery > map > calendar > clock > detail > stat > (grid | list) >
(stacked | sankey) > scatter > histogram > (chart | treemap) > table`.

The **wrapped query contract** is also documented in the `query_rewind` tool
description and in a `get_schema` global note (parent `src/lib/schema-doc.ts`),
with an example cross-domain UNION so the model knows how to build it.

**Added:** `web/lib/query-view.ts` (detection), `web/lib/geo-projection.ts`
(SVG fallback projector, ported from the website), `leaflet` (bundled
dependency powering the OSM slippy map), `web/components/QueryResult.tsx`
(20 views

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
