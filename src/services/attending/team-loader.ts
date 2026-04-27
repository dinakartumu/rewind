// Team hydration helpers. Every place the API returns something with
// a team reference (event home/away, player primary team, per-game
// appearance team) calls these to attach the full Team shape inline,
// so UI consumers never need a follow-up lookup.
//
// The DB stores the league-native id on existing rows (e.g.
// players.primaryTeamId = 136 for the Mariners). The composite unique
// index on teams (league, league_team_id) powers the join.

import { and, inArray, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { teams } from '../../db/schema/attending.js';
import type { TeamShape } from '../../lib/schemas/team.js';

export type TeamPair = { league: string; leagueTeamId: number };

const teamKey = (league: string, leagueTeamId: number) =>
  `${league}:${leagueTeamId}`;

// Convert a teams-table row to the wire shape. Single source of truth
// for the API serialization — every route that returns a team funnels
// through here.
export function serializeTeam(row: {
  leagueTeamId: number;
  league: string;
  abbreviation: string;
  location: string | null;
  name: string;
  fullName: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
  tertiaryColor: string | null;
  uiTintColor: string | null;
  logoUrl: string | null;
  logoDarkUrl: string | null;
  logoLightUrl: string | null;
  conference: string | null;
  division: string | null;
}): TeamShape {
  return {
    id: row.leagueTeamId,
    league: row.league,
    abbreviation: row.abbreviation,
    location: row.location,
    name: row.name,
    full_name: row.fullName,
    primary_color: row.primaryColor,
    secondary_color: row.secondaryColor,
    tertiary_color: row.tertiaryColor,
    ui_tint_color: row.uiTintColor ?? row.primaryColor,
    logo_url: row.logoUrl,
    logo_dark_url: row.logoDarkUrl,
    logo_light_url: row.logoLightUrl,
    conference: row.conference,
    division: row.division,
  };
}

// Batch loader: one query for any number of (league, league_team_id)
// pairs. Returns a map keyed on `${league}:${leagueTeamId}` so callers
// can resolve each pair without a second round trip.
export async function loadTeams(
  db: Database,
  pairs: TeamPair[]
): Promise<Map<string, TeamShape>> {
  if (pairs.length === 0) return new Map();

  // Group ids by league so we can build a single OR-of-AND per league.
  const byLeague = new Map<string, Set<number>>();
  for (const p of pairs) {
    let set = byLeague.get(p.league);
    if (!set) {
      set = new Set();
      byLeague.set(p.league, set);
    }
    set.add(p.leagueTeamId);
  }

  const map = new Map<string, TeamShape>();

  // Drizzle doesn't have a clean tuple-IN, so issue one query per
  // league. This bounds at the number of leagues represented across a
  // page (today: 1 — MLB only), which makes it effectively a single
  // round-trip in practice.
  for (const [league, idSet] of byLeague) {
    const ids = Array.from(idSet);
    const rows = await db
      .select()
      .from(teams)
      .where(and(eq(teams.league, league), inArray(teams.leagueTeamId, ids)));
    for (const r of rows) {
      const t = serializeTeam(r);
      map.set(teamKey(r.league, r.leagueTeamId), t);
    }
  }

  return map;
}

// Lookup helper for callers that already have a TeamPair. Returns null
// if the team isn't seeded yet — the UI handles nulls so the API doesn't
// have to fail-fast on missing reference data.
export function getTeam(
  map: Map<string, TeamShape>,
  league: string | null | undefined,
  leagueTeamId: number | null | undefined
): TeamShape | null {
  if (!league || leagueTeamId == null) return null;
  return map.get(teamKey(league, leagueTeamId)) ?? null;
}

// Walks event_data, replaces home_team / away_team stubs with full Team
// objects when seeded. event_data is opaque to the schema (record(any)),
// so this mutates in place after we've parsed the JSON column.
//
// Stub shape from MLB sync: { id, abbr, name }. Once enriched,
// home_team/away_team match TeamShape exactly. Existing fields that
// weren't on TeamShape (e.g. `abbr` legacy spelling) are dropped — the
// abbreviation lives on TeamShape under `abbreviation` for consistency
// with the rest of the wire shape.
export function attachTeamsToEventData(
  league: string | null | undefined,
  eventData: Record<string, unknown> | null,
  map: Map<string, TeamShape>
): Record<string, unknown> | null {
  if (!eventData || !league) return eventData;
  const result = { ...eventData };
  for (const side of ['home_team', 'away_team'] as const) {
    const stub = result[side] as { id?: number } | null | undefined;
    if (stub && typeof stub.id === 'number') {
      const team = getTeam(map, league, stub.id);
      if (team) result[side] = team;
    }
  }
  return result;
}

// Walks an array of events, collects every (league, team_id) pair that
// appears in event_data.home_team / event_data.away_team, and returns
// them deduped — feeds straight into loadTeams.
export function collectEventTeamPairs(
  events: Array<{
    eventData: Record<string, unknown> | null;
    league?: string | null;
  }>,
  leagueResolver: (
    eventData: Record<string, unknown> | null
  ) => string | null = (ed) =>
    typeof ed?.league === 'string' ? ed.league : null
): TeamPair[] {
  const seen = new Set<string>();
  const pairs: TeamPair[] = [];
  for (const e of events) {
    const league = e.league ?? leagueResolver(e.eventData);
    if (!league || !e.eventData) continue;
    for (const side of ['home_team', 'away_team']) {
      const stub = e.eventData[side] as { id?: number } | undefined;
      if (stub && typeof stub.id === 'number') {
        const k = teamKey(league, stub.id);
        if (!seen.has(k)) {
          seen.add(k);
          pairs.push({ league, leagueTeamId: stub.id });
        }
      }
    }
  }
  return pairs;
}
