/**
 * MLB Stats career history + current-season splits.
 *
 * `fetchPlayerCareer` pulls year-by-year batting (or pitching) for one
 * player off `/api/v1/people/{id}/stats?stats=yearByYear&group=…`.
 * `fetchPlayerSplits` pulls current-season home/away/vs-LHP/vs-RHP
 * via `?stats=statSplits&sitCodes=h,a,vl,vr&season=…`.
 *
 * Both KV-cached for 24h. Year-by-year is mostly stable (only the
 * current season's row mutates daily during the season); splits churn
 * inside a single season but a 24h TTL is fine for archival data and
 * still keeps the worker fast on cache hits. Errors degrade to null.
 */

import type { Env } from '../../types/env.js';

const STATS_API = 'https://statsapi.mlb.com/api/v1';
const CAREER_TTL = 60 * 60 * 24; // 24h
const SPLITS_TTL = 60 * 60 * 6; // 6h — splits change more during the active season
const FETCH_TIMEOUT_MS = 6000;

export type StatGroup = 'hitting' | 'pitching';

export interface CareerHittingSeason {
  season: string;
  team_id: number | null;
  team_name: string | null;
  league_name: string | null;
  age: number | null;
  games_played: number;
  pa: number;
  ab: number;
  r: number;
  h: number;
  doubles: number;
  triples: number;
  hr: number;
  rbi: number;
  bb: number;
  k: number;
  sb: number;
  avg: string | null;
  obp: string | null;
  slg: string | null;
  ops: string | null;
}

export interface CareerPitchingSeason {
  season: string;
  team_id: number | null;
  team_name: string | null;
  league_name: string | null;
  age: number | null;
  games_played: number;
  games_started: number;
  ip: string | null;
  bf: number;
  h: number;
  r: number;
  er: number;
  bb: number;
  k: number;
  hr: number;
  era: string | null;
  whip: string | null;
  wins: number;
  losses: number;
  saves: number;
}

export interface CareerHistory {
  group: StatGroup;
  seasons: CareerHittingSeason[] | CareerPitchingSeason[];
  fetched_at: string;
  cache_hit: boolean;
}

export interface SplitStats {
  avg: string | null;
  obp: string | null;
  slg: string | null;
  ops: string | null;
  hr: number;
  rbi: number;
  ab: number;
  h: number;
  era?: string | null;
  whip?: string | null;
  k?: number;
}

export interface SeasonSplits {
  season: number;
  group: StatGroup;
  home: SplitStats | null;
  away: SplitStats | null;
  vs_left: SplitStats | null;
  vs_right: SplitStats | null;
  fetched_at: string;
  cache_hit: boolean;
}

interface RawSplitTeam {
  id?: number;
  name?: string;
}
interface RawSplitLeague {
  name?: string;
}
interface RawSplit {
  season?: string;
  team?: RawSplitTeam;
  league?: RawSplitLeague;
  numTeams?: number;
  split?: { code?: string; description?: string };
  stat?: Record<string, unknown>;
}
interface RawStatRow {
  group?: { displayName?: string };
  splits?: RawSplit[];
}
interface RawStatsResponse {
  stats?: RawStatRow[];
}

function num(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const p = parseInt(v, 10);
    if (Number.isFinite(p)) return p;
  }
  return 0;
}

function str(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return null;
}

function intOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const p = parseInt(v, 10);
    if (Number.isFinite(p)) return p;
  }
  return null;
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function mapHittingSeason(sp: RawSplit): CareerHittingSeason {
  const s = sp.stat ?? {};
  return {
    season: sp.season ?? '',
    team_id: sp.team?.id ?? null,
    team_name: sp.team?.name ?? null,
    league_name: sp.league?.name ?? null,
    age: intOrNull(s.age),
    games_played: num(s.gamesPlayed),
    pa: num(s.plateAppearances),
    ab: num(s.atBats),
    r: num(s.runs),
    h: num(s.hits),
    doubles: num(s.doubles),
    triples: num(s.triples),
    hr: num(s.homeRuns),
    rbi: num(s.rbi),
    bb: num(s.baseOnBalls),
    k: num(s.strikeOuts),
    sb: num(s.stolenBases),
    avg: str(s.avg),
    obp: str(s.obp),
    slg: str(s.slg),
    ops: str(s.ops),
  };
}

function mapPitchingSeason(sp: RawSplit): CareerPitchingSeason {
  const s = sp.stat ?? {};
  return {
    season: sp.season ?? '',
    team_id: sp.team?.id ?? null,
    team_name: sp.team?.name ?? null,
    league_name: sp.league?.name ?? null,
    age: intOrNull(s.age),
    games_played: num(s.gamesPlayed),
    games_started: num(s.gamesStarted),
    ip: str(s.inningsPitched),
    bf: num(s.battersFaced),
    h: num(s.hits),
    r: num(s.runs),
    er: num(s.earnedRuns),
    bb: num(s.baseOnBalls),
    k: num(s.strikeOuts),
    hr: num(s.homeRuns),
    era: str(s.era),
    whip: str(s.whip),
    wins: num(s.wins),
    losses: num(s.losses),
    saves: num(s.saves),
  };
}

function mapSplit(sp: RawSplit, group: StatGroup): SplitStats {
  const s = sp.stat ?? {};
  if (group === 'hitting') {
    return {
      avg: str(s.avg),
      obp: str(s.obp),
      slg: str(s.slg),
      ops: str(s.ops),
      hr: num(s.homeRuns),
      rbi: num(s.rbi),
      ab: num(s.atBats),
      h: num(s.hits),
    };
  }
  return {
    avg: str(s.avg),
    obp: str(s.obp),
    slg: str(s.slg),
    ops: str(s.ops),
    hr: num(s.homeRuns),
    rbi: num(s.rbi),
    ab: num(s.atBats),
    h: num(s.hits),
    era: str(s.era),
    whip: str(s.whip),
    k: num(s.strikeOuts),
  };
}

/**
 * Year-by-year career history for one player. MLB Stats returns one
 * `splits` row per (season, team) pair — a player traded mid-season
 * shows up as two rows; we surface them as-is so the UI can collapse
 * if it wants.
 */
export async function fetchPlayerCareer(
  env: Env,
  mlbStatsId: number,
  group: StatGroup
): Promise<CareerHistory | null> {
  const cacheKey = `mlb_stats:career:v1:${mlbStatsId}:${group}`;

  try {
    const cached = await env.REWIND_CACHE.get(cacheKey, 'json');
    if (cached && typeof cached === 'object') {
      return {
        ...(cached as Omit<CareerHistory, 'cache_hit'>),
        cache_hit: true,
      };
    }
  } catch {
    /* fall through */
  }

  const url = `${STATS_API}/people/${mlbStatsId}/stats?stats=yearByYear&group=${group}`;
  let body: RawStatsResponse;
  try {
    const resp = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
    if (!resp.ok) {
      console.log(`[WARN] MLB Stats career ${resp.status} for ${mlbStatsId}`);
      return null;
    }
    body = (await resp.json()) as RawStatsResponse;
  } catch (err) {
    console.log(
      `[WARN] MLB Stats career fetch failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }

  const splits = body.stats?.[0]?.splits ?? [];
  // Some seasons appear with `numTeams > 1` as an aggregated row that
  // duplicates the per-team rows — drop those to avoid double counting
  // when callers fold rows into a per-season totals view.
  const filtered = splits.filter(
    (sp) => !(sp.numTeams && sp.numTeams > 1 && !sp.team?.id)
  );

  const seasons =
    group === 'hitting'
      ? filtered.map(mapHittingSeason)
      : filtered.map(mapPitchingSeason);

  const result: CareerHistory = {
    group,
    seasons,
    fetched_at: new Date().toISOString(),
    cache_hit: false,
  };

  try {
    await env.REWIND_CACHE.put(cacheKey, JSON.stringify(result), {
      expirationTtl: CAREER_TTL,
    });
  } catch {
    /* swallow */
  }
  return result;
}

/**
 * Current-season splits — home/away/vs-LHP/vs-RHP — for one player.
 * Pass `group=hitting` for hitters, `group=pitching` for pitchers.
 */
export async function fetchPlayerSplits(
  env: Env,
  mlbStatsId: number,
  season: number,
  group: StatGroup
): Promise<SeasonSplits | null> {
  const cacheKey = `mlb_stats:splits:v1:${mlbStatsId}:${season}:${group}`;

  try {
    const cached = await env.REWIND_CACHE.get(cacheKey, 'json');
    if (cached && typeof cached === 'object') {
      return {
        ...(cached as Omit<SeasonSplits, 'cache_hit'>),
        cache_hit: true,
      };
    }
  } catch {
    /* fall through */
  }

  const url =
    `${STATS_API}/people/${mlbStatsId}/stats` +
    `?stats=statSplits&sitCodes=h,a,vl,vr` +
    `&season=${season}&group=${group}`;
  let body: RawStatsResponse;
  try {
    const resp = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
    if (!resp.ok) {
      console.log(`[WARN] MLB Stats splits ${resp.status} for ${mlbStatsId}`);
      return null;
    }
    body = (await resp.json()) as RawStatsResponse;
  } catch (err) {
    console.log(
      `[WARN] MLB Stats splits fetch failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }

  const splits = body.stats?.[0]?.splits ?? [];
  let home: SplitStats | null = null;
  let away: SplitStats | null = null;
  let vsLeft: SplitStats | null = null;
  let vsRight: SplitStats | null = null;
  for (const sp of splits) {
    const code = sp.split?.code;
    const mapped = mapSplit(sp, group);
    if (code === 'h') home = mapped;
    else if (code === 'a') away = mapped;
    else if (code === 'vl') vsLeft = mapped;
    else if (code === 'vr') vsRight = mapped;
  }

  const result: SeasonSplits = {
    season,
    group,
    home,
    away,
    vs_left: vsLeft,
    vs_right: vsRight,
    fetched_at: new Date().toISOString(),
    cache_hit: false,
  };

  try {
    await env.REWIND_CACHE.put(cacheKey, JSON.stringify(result), {
      expirationTtl: SPLITS_TTL,
    });
  } catch {
    /* swallow */
  }
  return result;
}
