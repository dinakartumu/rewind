/**
 * Per-player aggregate stats across attended games.
 *
 * MLB-only today; non-MLB players return `{ supported: false, ... }` plus
 * appearance summaries so the consumer can still answer "what games did I
 * see this player in" without per-player stat lines. NFL/NBA/NCAAF
 * box-score parsers are tracked in the sports-boxscore-parity project.
 *
 * Scope:
 *   - season undefined  -> career across every attended game (default)
 *   - season set        -> single-season slice
 *
 * Phase 0 of attending-deep-stats found single-season samples are tiny
 * (max 50 PAs across the dataset). Career is where the meaningful slash
 * lines live (Cal Raleigh 130 PA / 32 games; Kirby 238 BF / 10 starts),
 * which is why the default flipped from required-season to optional.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  attendedEvents,
  attendedEventPlayers,
  players,
} from '../../db/schema/attending.js';
import type { TeamShape } from '../../lib/schemas/team.js';
import { getTeam, loadTeams } from './team-loader.js';

type BattingLine = {
  ab?: number;
  r?: number;
  h?: number;
  rbi?: number;
  bb?: number;
  k?: number;
  hr?: number;
  doubles?: number;
  triples?: number;
  sb?: number;
  hbp?: number;
  pa?: number;
  total_bases?: number;
};

type PitchingLine = {
  ip?: string;
  h?: number;
  r?: number;
  er?: number;
  bb?: number;
  k?: number;
  hr?: number;
  pitches?: number;
  strikes?: number;
  batters_faced?: number;
};

export interface PlayerStatsHitter {
  supported: true;
  league: string;
  scope: 'career' | 'season';
  season?: number;
  player: {
    id: number;
    full_name: string;
    primary_position: string | null;
    primary_team: TeamShape | null;
  };
  games: number;
  games_with_box_score: number;
  batting: {
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
    hbp: number;
    total_bases: number;
    avg: string | null;
    slg: string | null;
  };
}

export interface PlayerStatsPitcher {
  supported: true;
  league: string;
  scope: 'career' | 'season';
  season?: number;
  player: {
    id: number;
    full_name: string;
    primary_position: string | null;
    primary_team: TeamShape | null;
  };
  games: number;
  games_with_box_score: number;
  pitching: {
    ip: string;
    bf: number;
    h: number;
    r: number;
    er: number;
    bb: number;
    k: number;
    hr: number;
    pitches: number;
    strikes: number;
    era: string | null;
    whip: string | null;
    decisions: { w: number; l: number; sv: number; hld: number; bs: number };
  };
}

export interface PlayerStatsUnsupported {
  supported: false;
  league: string;
  reason: string;
  scope: 'career' | 'season';
  season?: number;
  player: {
    id: number;
    full_name: string;
    primary_position: string | null;
    primary_team: TeamShape | null;
  };
  appearances: Array<{
    event_id: number;
    event_date: string;
    title: string;
    home_team: string | null;
    away_team: string | null;
    final_score: string | null;
    my_team_won: boolean | null;
  }>;
}

export type PlayerStatsResponse =
  | (PlayerStatsHitter & { hitter: true })
  | (PlayerStatsPitcher & { pitcher: true })
  | PlayerStatsUnsupported;

export class PlayerNotFoundError extends Error {}

/**
 * Build the response. Single SQL query loads the player + every attended
 * appearance (with event metadata), then aggregation is done in-process —
 * cheaper than two round-trips and the per-player JSON parsing is
 * straightforward.
 */
export async function aggregatePlayerStats(
  db: Database,
  playerId: number,
  season?: number
): Promise<PlayerStatsResponse> {
  const [player] = await db
    .select()
    .from(players)
    .where(and(eq(players.id, playerId), eq(players.userId, 1)));

  if (!player) {
    throw new PlayerNotFoundError(`player ${playerId} not found`);
  }

  // Filter to attended events; optionally to the requested season.
  const conditions = [
    eq(attendedEventPlayers.playerId, playerId),
    eq(attendedEventPlayers.userId, 1),
    eq(attendedEvents.attended, 1),
  ];
  if (season !== undefined) {
    conditions.push(
      sql`json_extract(${attendedEvents.eventData}, '$.season') = ${season}`
    );
  }

  const rows = await db
    .select({
      eventId: attendedEvents.id,
      eventDate: attendedEvents.eventDate,
      title: attendedEvents.title,
      eventData: attendedEvents.eventData,
      battingLine: attendedEventPlayers.battingLine,
      pitchingLine: attendedEventPlayers.pitchingLine,
      decision: attendedEventPlayers.decision,
    })
    .from(attendedEventPlayers)
    .innerJoin(
      attendedEvents,
      eq(attendedEventPlayers.eventId, attendedEvents.id)
    )
    .where(and(...conditions))
    .orderBy(attendedEvents.eventDate);

  const teamMap =
    player.primaryTeamId != null
      ? await loadTeams(db, [
          { league: player.league, leagueTeamId: player.primaryTeamId },
        ])
      : new Map();
  const playerSummary = {
    id: player.id,
    full_name: player.fullName,
    primary_position: player.primaryPosition,
    primary_team: getTeam(teamMap, player.league, player.primaryTeamId),
  };
  const scope =
    season !== undefined ? ('season' as const) : ('career' as const);

  // Non-MLB: return appearances without aggregation.
  if (player.league !== 'mlb') {
    const appearances = rows.map((r) => {
      const ed = parseJson<Record<string, unknown>>(r.eventData);
      const home =
        (ed?.home_team as { name?: string } | undefined)?.name ?? null;
      const away =
        (ed?.away_team as { name?: string } | undefined)?.name ?? null;
      const homeScore = ed?.home_score as number | undefined;
      const awayScore = ed?.away_score as number | undefined;
      const finalScore =
        homeScore !== undefined && awayScore !== undefined
          ? `${homeScore}-${awayScore}`
          : null;
      const myTeamWon = (ed?.my_team_won as boolean | undefined) ?? null;
      return {
        event_id: r.eventId,
        event_date: r.eventDate,
        title: r.title,
        home_team: home,
        away_team: away,
        final_score: finalScore,
        my_team_won: myTeamWon,
      };
    });
    return {
      supported: false,
      league: player.league,
      reason: `box-score parsing not yet supported for ${player.league}`,
      scope,
      ...(season !== undefined ? { season } : {}),
      player: playerSummary,
      appearances,
    };
  }

  // MLB: hitter or pitcher branch decided by which lines exist on this
  // player's appearances. Two-way players (Ohtani, etc.) — pitching wins
  // since that's the more discriminating signal; revisit if/when it matters.
  const hasPitching = rows.some((r) => r.pitchingLine);
  const hasBatting = rows.some((r) => r.battingLine);
  const games = rows.length;
  const gamesWithBox = rows.filter(
    (r) => r.battingLine || r.pitchingLine
  ).length;

  if (hasPitching) {
    const acc = {
      bf: 0,
      h: 0,
      r: 0,
      er: 0,
      bb: 0,
      k: 0,
      hr: 0,
      pitches: 0,
      strikes: 0,
      outs: 0,
      decisions: { w: 0, l: 0, sv: 0, hld: 0, bs: 0 },
    };
    for (const row of rows) {
      const p = parseJson<PitchingLine>(row.pitchingLine);
      if (!p) continue;
      acc.bf += p.batters_faced ?? 0;
      acc.h += p.h ?? 0;
      acc.r += p.r ?? 0;
      acc.er += p.er ?? 0;
      acc.bb += p.bb ?? 0;
      acc.k += p.k ?? 0;
      acc.hr += p.hr ?? 0;
      acc.pitches += p.pitches ?? 0;
      acc.strikes += p.strikes ?? 0;
      acc.outs += parseIpToOuts(p.ip);
      const d = row.decision;
      if (d === 'W') acc.decisions.w++;
      else if (d === 'L') acc.decisions.l++;
      else if (d === 'SV') acc.decisions.sv++;
      else if (d === 'HLD') acc.decisions.hld++;
      else if (d === 'BS') acc.decisions.bs++;
    }
    const innings = acc.outs / 3;
    return {
      supported: true,
      pitcher: true,
      league: 'mlb',
      scope,
      ...(season !== undefined ? { season } : {}),
      player: playerSummary,
      games,
      games_with_box_score: gamesWithBox,
      pitching: {
        ip: formatIp(acc.outs),
        bf: acc.bf,
        h: acc.h,
        r: acc.r,
        er: acc.er,
        bb: acc.bb,
        k: acc.k,
        hr: acc.hr,
        pitches: acc.pitches,
        strikes: acc.strikes,
        era: acc.outs > 0 ? ((acc.er * 27) / acc.outs).toFixed(2) : null,
        whip: acc.outs > 0 ? ((acc.h + acc.bb) / innings).toFixed(2) : null,
        decisions: acc.decisions,
      },
    };
  }

  if (hasBatting) {
    const acc = {
      pa: 0,
      ab: 0,
      r: 0,
      h: 0,
      doubles: 0,
      triples: 0,
      hr: 0,
      rbi: 0,
      bb: 0,
      k: 0,
      sb: 0,
      hbp: 0,
      total_bases: 0,
    };
    for (const row of rows) {
      const b = parseJson<BattingLine>(row.battingLine);
      if (!b) continue;
      acc.pa += b.pa ?? 0;
      acc.ab += b.ab ?? 0;
      acc.r += b.r ?? 0;
      acc.h += b.h ?? 0;
      acc.doubles += b.doubles ?? 0;
      acc.triples += b.triples ?? 0;
      acc.hr += b.hr ?? 0;
      acc.rbi += b.rbi ?? 0;
      acc.bb += b.bb ?? 0;
      acc.k += b.k ?? 0;
      acc.sb += b.sb ?? 0;
      acc.hbp += b.hbp ?? 0;
      acc.total_bases += b.total_bases ?? 0;
    }
    return {
      supported: true,
      hitter: true,
      league: 'mlb',
      scope,
      ...(season !== undefined ? { season } : {}),
      player: playerSummary,
      games,
      games_with_box_score: gamesWithBox,
      batting: {
        pa: acc.pa,
        ab: acc.ab,
        r: acc.r,
        h: acc.h,
        doubles: acc.doubles,
        triples: acc.triples,
        hr: acc.hr,
        rbi: acc.rbi,
        bb: acc.bb,
        k: acc.k,
        sb: acc.sb,
        hbp: acc.hbp,
        total_bases: acc.total_bases,
        avg: acc.ab > 0 ? formatRate(acc.h / acc.ab) : null,
        slg: acc.ab > 0 ? formatRate(acc.total_bases / acc.ab) : null,
      },
    };
  }

  // MLB player with attended games but no batting or pitching lines (e.g.
  // pinch-runner that game; very rare). Treat as hitter with zeros.
  return {
    supported: true,
    hitter: true,
    league: 'mlb',
    scope,
    ...(season !== undefined ? { season } : {}),
    player: playerSummary,
    games,
    games_with_box_score: 0,
    batting: {
      pa: 0,
      ab: 0,
      r: 0,
      h: 0,
      doubles: 0,
      triples: 0,
      hr: 0,
      rbi: 0,
      bb: 0,
      k: 0,
      sb: 0,
      hbp: 0,
      total_bases: 0,
      avg: null,
      slg: null,
    },
  };
}

// MLB stores innings pitched as a baseball-style decimal: "6.2" means
// 6 innings + 2 outs = 20 outs. Sum-of-decimals would lose those outs at
// the third one (.3 wraps to the next integer).
export function parseIpToOuts(ip: string | undefined): number {
  if (!ip) return 0;
  const [whole, frac = '0'] = ip.split('.');
  const innings = parseInt(whole, 10);
  const outs = parseInt(frac, 10);
  if (!Number.isFinite(innings) || !Number.isFinite(outs)) return 0;
  return innings * 3 + outs;
}

export function formatIp(totalOuts: number): string {
  const whole = Math.floor(totalOuts / 3);
  const frac = totalOuts % 3;
  return `${whole}.${frac}`;
}

function formatRate(n: number): string {
  // Baseball convention: 3-decimal rate, leading zero trimmed.
  const fixed = n.toFixed(3);
  return fixed.startsWith('0.') ? fixed.slice(1) : fixed;
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
