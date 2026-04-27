// Team seeder for the attending domain.
//
// Pulls MLB roster data from the MLB Stats API and brand colors from
// the ESPN site API, joins to our local `venues` table for the home
// venue FK when names match, and upserts into `teams`. Re-runnable —
// uses ON CONFLICT(league, league_team_id) so refreshing colors or
// adding a backfilled column is a no-op for unchanged rows.
//
// Best-effort: a single team failing on ESPN (color lookup) doesn't
// abort the run — that team gets written with null colors and shows up
// in `failures`. MLB Stats API failure aborts (no point continuing
// without the canonical roster).
//
// Logo URLs follow the public mlbstatic.com pattern documented at
// MLB.com Gameday — keyed on the league_team_id, so they're stable
// across seasons.

import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { teams, venues } from '../../db/schema/attending.js';

const MLB_TEAMS_URL =
  'https://statsapi.mlb.com/api/v1/teams?sportId=1&activeStatus=Y';

const ESPN_TEAM_URL = (abbr: string) =>
  `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/teams/${abbr.toLowerCase()}`;

const LOGO_URL = (id: number) =>
  `https://www.mlbstatic.com/team-logos/${id}.svg`;
const LOGO_DARK_URL = (id: number) =>
  `https://www.mlbstatic.com/team-logos/team-cap-on-dark/${id}.svg`;
const LOGO_LIGHT_URL = (id: number) =>
  `https://www.mlbstatic.com/team-logos/team-cap-on-light/${id}.svg`;

export interface SeedTeamsOptions {
  // Skip ESPN color lookups (faster; useful when re-running just to add
  // a new column or pick up a roster change).
  skipColors?: boolean;
  // Limit to a subset of league_team_ids (debugging / partial refresh).
  leagueTeamIds?: number[];
}

export interface SeedTeamsResult {
  league: 'mlb';
  scanned: number;
  inserted: number;
  updated: number;
  failures: Array<{ league_team_id: number; reason: string }>;
}

interface MlbTeamRaw {
  id: number;
  name: string;
  teamName: string;
  abbreviation: string;
  locationName?: string;
  firstYearOfPlay?: string;
  league?: { name?: string };
  division?: { name?: string };
  venue?: { name?: string };
}

interface EspnTeamRaw {
  team: {
    id: string;
    color?: string;
    alternateColor?: string;
  };
}

export async function seedMlbTeams(
  db: Database,
  opts: SeedTeamsOptions = {}
): Promise<SeedTeamsResult> {
  const { skipColors = false, leagueTeamIds } = opts;

  const result: SeedTeamsResult = {
    league: 'mlb',
    scanned: 0,
    inserted: 0,
    updated: 0,
    failures: [],
  };

  const venueByName = await loadVenueIndex(db);
  const rosterRes = await fetch(MLB_TEAMS_URL);
  if (!rosterRes.ok) {
    throw new Error(
      `MLB Stats API ${rosterRes.status}: ${await rosterRes.text()}`
    );
  }
  const roster = (await rosterRes.json()) as { teams: MlbTeamRaw[] };
  const filter = leagueTeamIds ? new Set(leagueTeamIds) : null;

  for (const t of roster.teams) {
    if (filter && !filter.has(t.id)) continue;
    result.scanned += 1;

    let primaryColor: string | null = null;
    let secondaryColor: string | null = null;
    if (!skipColors) {
      try {
        const colors = await fetchEspnColors(t.abbreviation);
        primaryColor = colors.primary;
        secondaryColor = colors.secondary;
      } catch (err) {
        // Don't abort the whole seed for one team — write with null
        // colors and continue. A later refresh can fill them in.
        result.failures.push({
          league_team_id: t.id,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const homeVenueId = t.venue?.name
      ? (venueByName.get(t.venue.name) ?? null)
      : null;
    const conference = leagueShortName(t.league?.name);
    const division = divisionShortName(t.division?.name);
    const now = new Date().toISOString();

    const row = {
      league: 'mlb',
      leagueTeamId: t.id,
      abbreviation: t.abbreviation,
      location: t.locationName ?? null,
      name: t.teamName,
      fullName: t.name,
      primaryColor,
      secondaryColor,
      tertiaryColor: null,
      uiTintColor: primaryColor, // default; curated tweaks happen later
      logoUrl: LOGO_URL(t.id),
      logoDarkUrl: LOGO_DARK_URL(t.id),
      logoLightUrl: LOGO_LIGHT_URL(t.id),
      logoKey: null,
      conference,
      division,
      homeVenueId,
      externalIds: null,
      aliases: null,
      foundedYear: t.firstYearOfPlay ? parseInt(t.firstYearOfPlay, 10) : null,
      createdAt: now,
      updatedAt: now,
    };

    const inserted = await db
      .insert(teams)
      .values(row)
      .onConflictDoUpdate({
        target: [teams.league, teams.leagueTeamId],
        set: {
          abbreviation: row.abbreviation,
          location: row.location,
          name: row.name,
          fullName: row.fullName,
          primaryColor: row.primaryColor,
          secondaryColor: row.secondaryColor,
          uiTintColor: row.uiTintColor,
          logoUrl: row.logoUrl,
          logoDarkUrl: row.logoDarkUrl,
          logoLightUrl: row.logoLightUrl,
          conference: row.conference,
          division: row.division,
          homeVenueId: row.homeVenueId,
          foundedYear: row.foundedYear,
          updatedAt: now,
        },
      })
      .returning({ id: teams.id, createdAt: teams.createdAt });

    const wasInsert = inserted[0]?.createdAt === now;
    if (wasInsert) result.inserted += 1;
    else result.updated += 1;
  }

  return result;
}

async function fetchEspnColors(
  abbr: string
): Promise<{ primary: string | null; secondary: string | null }> {
  const res = await fetch(ESPN_TEAM_URL(abbr));
  if (!res.ok) {
    throw new Error(`ESPN ${res.status} for ${abbr}`);
  }
  const data = (await res.json()) as EspnTeamRaw;
  return {
    primary: hexify(data.team.color),
    secondary: hexify(data.team.alternateColor),
  };
}

function hexify(raw: string | undefined): string | null {
  if (!raw) return null;
  return raw.startsWith('#') ? raw.toUpperCase() : `#${raw.toUpperCase()}`;
}

async function loadVenueIndex(db: Database): Promise<Map<string, number>> {
  const rows = await db
    .select({ id: venues.id, name: venues.name, aliases: venues.aliases })
    .from(venues)
    .where(eq(venues.userId, 1));
  const map = new Map<string, number>();
  for (const v of rows) {
    map.set(v.name, v.id);
    if (v.aliases) {
      try {
        const aliases = JSON.parse(v.aliases) as string[];
        for (const a of aliases) map.set(a, v.id);
      } catch {
        // bad JSON in aliases: ignore for indexing purposes
      }
    }
  }
  return map;
}

function leagueShortName(name: string | undefined): string | null {
  if (!name) return null;
  if (name.includes('American')) return 'AL';
  if (name.includes('National')) return 'NL';
  return name;
}

function divisionShortName(name: string | undefined): string | null {
  if (!name) return null;
  // "American League West" -> "AL West", etc.
  return name.replace('American League', 'AL').replace('National League', 'NL');
}
