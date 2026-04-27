# Phase 0 — Coverage and Sample-Size Baseline

Captured by hitting `api.rewind.rest` directly during Phase 0 of the attending-deep-stats project. This is the before-photo for the Phase 4 checkpoint and the source of two design changes the audit forced.

## Per-season MLB box-score coverage

Each row: events attended that season, fraction with at least one `attended_event_players` row, fraction with at least one batting line, fraction with at least one pitching line, total rows in `attended_event_players` for that season, average batting-line rows per event.

| Season    | Events | With box score | With batting | With pitching | Total player rows | Avg batting rows / event |
| --------- | ------ | -------------- | ------------ | ------------- | ----------------- | ------------------------ |
| 2014      | 2      | 2 (100%)       | 2            | 2             | 98                | 20.0                     |
| 2017      | 2      | 2 (100%)       | 2            | 2             | 99                | 19.5                     |
| 2019      | 1      | 0 (0%)         | 0            | 0             | 0                 | 0.0                      |
| 2022      | 4      | 4 (100%)       | 4            | 4             | 218               | 21.8                     |
| 2023      | 9      | 7 (78%)        | 7            | 7             | 362               | 16.4                     |
| 2024      | 9      | 8 (89%)        | 8            | 8             | 414               | 18.9                     |
| 2025      | 14     | 12 (86%)       | 12           | 12            | 631               | 18.3                     |
| 2026      | 4      | 3 (75%)        | 2            | 2             | 155               | 9.8                      |
| **TOTAL** | **45** | **38 (84%)**   | **37**       | **37**        | **1977**          | **17.3**                 |

**Headline**: 84% overall coverage. Recent seasons hover 75–89%. The 2019 zero is a single attended game with no enrichment (worth investigating later but not blocking).

**Implication for the proposed `coverage_warning` flag**: I'd set the threshold at `< 80%`, which would fire on 2023 (78%), 2026 (75%), and 2019 (0%). For 2024 / 2025 (the user's recent seasons) it would not fire. That feels right — the warning signals "this aggregate is meaningfully partial," which is true for 2023 and 2026 but not for the current usage years.

## Per-(player, season) sample-size distribution

Hitters — total PAs accumulated across attended games for that player, that season:

| Bucket  | Count   | % of total                               |
| ------- | ------- | ---------------------------------------- |
| 1–10    | 390     | 88.8%                                    |
| 11–25   | 36      | 8.2%                                     |
| 26–50   | 13      | 3.0%                                     |
| 51–100  | 0       | 0.0%                                     |
| 101–200 | 0       | 0.0%                                     |
| **All** | **439** | min 1 / median 4 / mean 6.2 / **max 50** |

Pitchers — total batters faced across attended games for that player, that season:

| Bucket  | Count   | % of total                                |
| ------- | ------- | ----------------------------------------- |
| 1–10    | 150     | 63.8%                                     |
| 11–25   | 66      | 28.1%                                     |
| 26–60   | 16      | 6.8%                                      |
| 61–120  | 3       | 1.3%                                      |
| 121–250 | 0       | 0.0%                                      |
| **All** | **235** | min 1 / median 6 / mean 11.6 / **max 98** |

**Headline**: per-season-per-player sample sizes are tiny. The proposed `pa < 50` hitter threshold would fire on **97% of pairs**. The proposed `bf < 60` pitcher threshold would fire on **98.7%**. Single-season slices are not where meaningful per-player aggregates live — which forces the design change captured below.

## Top players across all attended games (career-at-my-games)

This is where the meaningful per-player samples actually exist:

| Player          | Total PA | Games | Sample assessment    |
| --------------- | -------- | ----- | -------------------- |
| Cal Raleigh     | 130      | 32    | Decent slash line    |
| Julio Rodríguez | 125      | 30    | Decent slash line    |
| J.P. Crawford   | 110      | 26    | Decent slash line    |
| Ty France       | 68       | 18    | Approximate          |
| Eugenio Suárez  | 64       | 16    | Approximate          |
| Randy Arozarena | 63       | 15    | Approximate          |
| Jorge Polanco   | 61       | 17    | Approximate          |
| Mitch Haniger   | 55       | 14    | Approximate          |
| Dylan Moore     | 49       | 16    | Small, but countable |
| Mitch Garver    | 47       | 13    | Small, but countable |

| Pitcher        | Total BF | Games | Sample assessment                    |
| -------------- | -------- | ----- | ------------------------------------ |
| George Kirby   | 238      | 10    | Real ERA / WHIP signal               |
| Luis Castillo  | 122      | 5     | Approximate                          |
| Logan Gilbert  | 106      | 5     | Approximate                          |
| Bryan Woo      | 88       | 4     | Approximate                          |
| Bryce Miller   | 60       | 3     | Approximate                          |
| Andrés Muñoz   | 54       | 14    | Reliever — sample is innings, not BF |
| Trent Thornton | 39       | 7     | Reliever — small                     |

**Implication for Phase 2 design**: career-at-my-games is the meaningful slice. "How many times have I seen Kirby pitch" → 10 with 238 BFs aggregated → real ERA and K/BB worth quoting. "Julio's batting average at games I attended" → 125 PAs across 30 games → meaningful AVG/SLG; bumpy enough that the response should always cite the sample size in the same envelope.

## Forced design changes

The audit invalidates two design assumptions in the original plan. Captured here, propagated to README + DESIGN.md.

**1. `season` becomes optional, defaulting to career across all attended games**

The plan said "required-param, not default-current-year." Reasoning was "force the consumer to be explicit." But the data shows career-across-attended-games is the only slice with meaningful sample sizes for most players. Pivot:

- `season` is **optional**. Omit → response aggregates across every attended game ever (`scope: 'career'`).
- `season=2025` → response aggregates that one season (`scope: 'season'`, plus `season: 2025`).

This also matches how the user actually phrases queries — "Julio's average at games I've attended" (no year specified) is the natural form for the high-signal answer.

**2. Drop the boolean `sample_size_warning` flag; surface raw `pa` / `bf` / `games` instead**

If 97% of hitter pairs are under-50-PA and 98.7% of pitcher pairs are under-60-BF, the boolean is signal noise — it always fires. The model needs the raw numbers anyway to phrase the response honestly. Pivot:

- Response always includes `pa` (hitter) or `bf` (pitcher) and `games`.
- Tool description explicitly says: "Single-season slices typically have small samples (max 50 PAs across the dataset). Always cite the sample size when responding."
- The boolean is dropped.

## Phase 0.3 — Pre-existing query behavior

Pre-execution baseline transcripts of the four target queries through the existing MCP tool surface live in `baseline-queries.md`. That file requires user action (Claude Desktop session); Phase 1 does not block on it.
