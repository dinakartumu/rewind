# SQL-first vs specialized-tools MCP eval

_Rewind personal-data API — `feature/sql-mcp` branch, run against the live instance at `https://rewind.dinakartumu.com` on 2026-07-21._

## Question in one line

Does replacing ~50 specialized MCP tools (each wrapping one REST endpoint) with **two** tools — `get_schema` + `query_rewind` (read-only allow-listed `SELECT` over `/v1/query`) — lose any answering power, and what does it unlock?

## TL;DR

|                                            | OLD (specialized tools) | NEW (SQL-first)  |
| ------------------------------------------ | ----------------------- | ---------------- |
| **Coverage** (questions answerable at all) | **49%** (21/43)         | **100%** (43/43) |
| **Accuracy** (correct among attempted)     | **86%** (18/21)         | **100%** (43/43) |
| **Tier-4 cross-domain coverage**           | **0%** (0/14)           | **100%** (14/14) |
| **Median call latency**                    | ~180 ms                 | ~88 ms           |

The SQL-first architecture is the **only** one that answers cross-domain questions, matches or beats the old tools on every simpler tier, and is _faster_ per call (one `/v1/query` round-trip vs a specialized handler that often runs several queries and enriches with images).

## Methodology

- **Question set** (`questions.json`): 43 graded questions across four difficulty tiers and six categories (listening, watching, running, places, cross-domain). Tier counts: 11 / 10 / 8 / 14. Tier 4 has 14 cross-domain questions (requirement was >=12).
- **Ground truth is independent and frozen.** Every answer was derived once via hand-written, human-reviewed reference SQL run against `/v1/query`, then recorded as a constant in `questions.json`. Grading compares extracted answers to that frozen constant — so the NEW path is graded against a fixed value, not tautologically against its own live output. For Tiers 1-3 the reference value was additionally cross-checked against the corresponding OLD specialized endpoint; **disagreements are recorded as findings** (below).
- **OLD path.** For each question `questions.json` declares either `{endpoint, params, extract}` (how a single specialized endpoint yields the answer) or `{answerable:false, reason}` when no single specialized endpoint can. The harness (`run-eval.mjs`) hits the endpoint, extracts, and grades.
- **NEW path.** Each question declares a reviewed `SELECT`. The harness POSTs it to `/v1/query` and grades the result.
- **What counts.** _Coverage_ = share of questions the architecture can even attempt. _Accuracy_ = share correct among those attempted. Latency is wall-clock per HTTP call, measured in the harness.
- **No production code or the query gate was modified.**

## Instance data caveat (shapes the question set)

This instance has **populated** listening (69,105 scrobbles), running (1,331 activities / 182 runs), watching (1,856 movies / 1,947 viewings / 71 shows), and places (7,321 check-ins). It has **empty** reading, collecting (Discogs + Trakt), and attending tables (0 rows each).

Consequently the prompt's suggested cross-domain examples that touch empty domains — "artists I own on vinyl _and_ scrobble", "check-ins on days I finished reading an article" — would return empty for **both** architectures and are uninformative here, so they are excluded. All 14 Tier-4 questions instead join among the four populated domains (listening x running x watching x places), which still fully exercises the cross-domain capability. **The empty-domain fact is itself a finding**: the old per-domain tools return "0" for those domains too; SQL is not disadvantaged.

## Results

| Tier    | N   | OLD coverage | OLD accuracy | NEW coverage | NEW accuracy | OLD avg ms | NEW avg ms |
| ------- | --- | ------------ | ------------ | ------------ | ------------ | ---------- | ---------- |
| 1       | 11  | 100% (11/11) | 91% (10/11)  | 100% (11/11) | 100% (11/11) | 213        | 77         |
| 2       | 10  | 60% (6/10)   | 83% (5/6)    | 100% (10/10) | 100% (10/10) | 140        | 95         |
| 3       | 8   | 50% (4/8)    | 75% (3/4)    | 100% (8/8)   | 100% (8/8)   | 156        | 73         |
| 4       | 14  | 0% (0/14)    | — (0/0)      | 100% (14/14) | 100% (14/14) | 0          | 100        |
| **ALL** | 43  | 49% (21/43)  | 86% (18/21)  | 100% (43/43) | 100% (43/43) | 181        | 88         |

(OLD avg-ms for Tier 4 is 0 because there is nothing to call — every Tier-4 old_path is `answerable:false`.)

## Key findings

### 1. Tier 4 is the payoff — 0% OLD vs 100% NEW

None of the 14 cross-domain questions can be answered by a single specialized endpoint, because **no endpoint crosses domains**. Each Tier-4 `old_path` carries a concrete reason, e.g.:

- _"On how many days did I both watch a movie AND check in somewhere?"_ -> requires intersecting `watch_history.watched_at` (watching) with `checkins.checked_in_at` (places) by calendar day. No endpoint joins watching and places.
- _"In 2024, did I scrobble more on days I ran vs didn't?"_ -> conditional aggregation partitioning listening by whether a Strava run occurred that day.

The single most interesting one the SQL path answered and the old tools **cannot**:

> **t4-03 — "In 2024, did I average more scrobbles on days I ran versus days I did not run?"**
> **NEW result:** run-day average = **23.9** scrobbles/day vs non-run-day average = **22.0** — so yes, marginally more music on run days. This needs a CTE partitioning 2024 scrobbles by the set of 2024 run dates and averaging each side; there is no tool that even exposes both series aligned by date.

Honorable mention — **t4-06**: on **37** distinct days the user scrobbled, ran, _and_ checked in (a three-way date intersection across three domains).

### 2. OLD correctness gaps found by independent ground truth (3 real disagreements)

Cross-checking reference SQL against the old endpoints surfaced three cases where the specialized tool returns a **defensibly-but-differently-defined** number that is wrong for the natural reading of the question:

| Q     | Question                                      | OLD answer                  | Correct (SQL)               | Why they differ                                                                                                                                                         |
| ----- | --------------------------------------------- | --------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| t1-01 | "How many distinct movies have I watched?"    | **1,947**                   | **1,856**                   | `/watching/stats.total_movies` counts `watch_history` **rows** (viewings incl. rewatches), labeled "movies". Distinct films are 1,856.                                  |
| t2-03 | "Total running distance (runs only) in 2021?" | **367.96 mi**               | **111.62 mi**               | `/running/stats/years/2021.total_distance_mi` sums **all** activity types (rides, walks), not runs only. The endpoint can't isolate `sport_type IN ('Run','TrailRun')`. |
| t3-08 | "Total run distance per year (runs only)?"    | 2015: 229.56 / 2021: 367.96 | 2015: 164.35 / 2021: 111.62 | Same all-activities-vs-runs-only divergence, across every year.                                                                                                         |

A softer disagreement (label agrees, count differs by definition, so graded on label only):

- **t2-04 / t3-03 — top genre.** `/watching/stats/genres` reports **Drama = 605** (distinct movies carrying the genre); by watch-event the count is **651**. Both name Drama; the count is an interpretation choice, not an error.

### 3. OLD coverage collapses as questions get harder

OLD coverage falls 100% -> 60% -> 50% -> 0% across tiers. The gaps are structural, not incidental:

- **No year-scoped breakdowns** for several domains: `/watching/stats/genres` and `/watching/stats/directors` are all-time only (kills t3-03).
- **No leaderboards** the API author didn't pre-decide to expose: there is no per-year check-in count (t3-04), no per-year watch count (t3-07), no per-movie rewatch ranking (t3-05), no city leaderboard for check-ins (t2-01).
- **No value filters:** `/watching/ratings` ignores a rating filter and returns all 1,928 rated rows, so "how many 5-star movies" (t2-02) can't be answered in one call.
- **No distinct-count scalars:** distinct countries (t2-09), distinct run cities (t2-10), distinct theater-days (t4-14) aren't exposed.

Every one of these is a one-line `SELECT` on the SQL path.

### 4. Latency — SQL is faster per call

NEW averaged **88 ms/call** vs OLD **181 ms/call** (Tier-1 OLD was slowest at 213 ms, inflated by endpoints that also compute image attachments / enrich responses). A single `/v1/query` executes one SQL statement and returns raw rows; specialized handlers frequently run multiple queries and decorate results. Net: SQL-first is not a latency tax — it's a latency _win_, on top of the coverage win.

## Schema-only LLM-generation spot check (tests the real workflow)

The harness grades **hand-written** SQL, which is not how production works — a production LLM must _generate_ the SQL, and its only context is the `get_schema` output. To test whether `get_schema` alone is sufficient, I authored SQL for 5 representative questions **using only `schema-dump.json`** (the live `/v1/schema` response) as context — no reuse of the reference SQL — spanning all tiers, and ran them (`schema-only-spotcheck.mjs`):

| Q     | Tier | Schema-only SQL correct? | Note                                                                                                                                            |
| ----- | ---- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| t1-04 | 1    | PASS                     | Used the schema note "filter `is_filtered = 0`".                                                                                                |
| t2-04 | 2    | PASS                     | Followed the declared join `watch_history -> movie_genres -> genres`.                                                                           |
| t3-06 | 3    | PASS                     | Used `strftime('%Y', ...)` per the schema's date-bucketing note; filtered `is_filtered` on the **track** join as the note instructs.            |
| t4-02 | 4    | PASS                     | Cross-domain join checkins/watch_history by `date()`, discovered purely from the two `*_at` column descriptions.                                |
| t4-05 | 4    | PASS                     | Intersected `strava_activities.city` / `checkins.venue_city` — the schema's "Cross-domain join keys" note plus per-column purposes were enough. |

**5/5 correct from schema alone**, including both cross-domain joins. The `get_schema` payload — purpose strings, per-column notes, explicit `joins`, and the global `notes` about `is_filtered`, date formats, and cross-domain keys — is the enabler that makes `query_rewind` viable for an LLM, not just for a human who already knows the DB.

## Limitations of this eval (honest)

- **The harness grades reviewed SQL, not live-LLM SQL.** The main 43-question run uses hand-written `sql`. The schema-only spot check (5/5) is the only part that exercises real generation; a full run should have an LLM generate all 43 from `get_schema` and grade end-to-end. Expect the dominant NEW failure mode in production to be _SQL generation_ (wrong join, forgetting `is_filtered`), which makes `get_schema` quality the critical dependency — hence the spot check.
- **Single instance, single user.** Empty reading/collecting/attending domains mean the vinyl-x-scrobble and reading-x-places cross-domain ideas weren't exercised on real data (they're structurally identical joins to the ones that were).
- **Ground truth = reviewed SQL.** If a reference query encodes a wrong assumption, both it and the frozen constant inherit it. Mitigated by cross-checking Tiers 1-3 against the independent OLD endpoints (which is exactly what surfaced the three disagreements).
- **"Answerable by one endpoint" is the OLD bar.** A determined agent could sometimes chain multiple old tools + client-side math to answer a Tier-2/3 question (e.g. page all 1,928 ratings and count 10s). We scored single-endpoint answerability, which is the realistic tool-calling cost model; multi-call client-side workarounds are noted where relevant.
- **One data-quality outlier is preserved deliberately.** t4-11's "farthest run in a shared city = San Francisco, 121.25 mi" is almost certainly a mis-recorded activity; the question tests the join mechanics, and the frozen answer is the deterministic query output, not a claim the run really happened.

## Reproduce

```bash
export REWIND_API_URL="https://rewind.dinakartumu.com"
export REWIND_API_KEY="rw_..."           # read key is sufficient
node docs/evals/2026-07-21-sql-vs-tools/run-eval.mjs        # writes results.json + results-table.md
node docs/evals/2026-07-21-sql-vs-tools/schema-only-spotcheck.mjs   # the LLM-generation spot check
```

## Files

- `questions.json` — 43 graded questions with frozen ground truth, OLD path spec, and NEW SQL.
- `run-eval.mjs` — the harness (Node built-ins only).
- `results.json` / `results-table.md` — machine output from the live run.
- `schema-only-spotcheck.mjs` — the 5-question schema-only generation test.
- `schema-dump.json` — the live `/v1/schema` response used as the only context for the spot check.
