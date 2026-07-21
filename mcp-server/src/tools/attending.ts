import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RewindClient } from '../client.js';
import {
  withRichResponse,
  text,
  imageBlock,
  formatDate,
  fmt,
  READ_ONLY_ANNOTATIONS,
  includeImagesParam,
  LIST_IMAGE_PX,
  type ContentBlock,
} from './helpers.js';
import {
  attendedSeasonOutputSchema,
  attendedEventDetailOutputSchema,
  attendedPlayerOutputSchema,
  playerSchema,
} from './schemas/attending.js';

// ─── Types ───────────────────────────────────────────────────────────
//
// Types below are derived from the Zod output schemas (schemas/attending.ts)
// where the structuredContent shape is exactly the tool's return shape, so
// the declared schema and the TS type cannot drift. Team stays hand-written
// -- it describes the raw-API team fragment used inside the player card.

type Team = {
  id: number;
  league: string;
  abbreviation: string;
  location: string | null;
  name: string;
  full_name: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  tertiary_color: string | null;
  ui_tint_color: string | null;
  logo_url: string | null;
  logo_dark_url: string | null;
  logo_light_url: string | null;
  conference: string | null;
  division: string | null;
};

type Player = z.infer<typeof playerSchema>;

type AttendedEventDetail = z.infer<typeof attendedEventDetailOutputSchema>;

type AttendedSeasonResponse = z.infer<typeof attendedSeasonOutputSchema>;

// ─── Tool registration ───────────────────────────────────────────────

export function registerAttendingTools(
  server: McpServer,
  client: RewindClient
): void {
  // get_attended_season ─────────────────────────────────────────────
  // Drives the season-grid card UI in MCP Apps hosts.
  server.registerTool(
    'get_attended_season',
    {
      title: 'Sports season',
      description:
        'Get every game you attended (or hold tickets for) in a given league + season, with W/L record. league is a slug like "mlb", "nfl", "ncaaf", "nba", "wnba". In MCP Apps hosts, renders an interactive season grid with score, attendance, and notable performers.',
      inputSchema: {
        league: z
          .string()
          .describe(
            'League slug (lowercase): "mlb", "nfl", "nba", "wnba", "ncaaf", "ncaab", "mls".'
          ),
        season: z
          .number()
          .int()
          .describe('Season year (e.g. 2024 for the 2024 MLB season).'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: attendedSeasonOutputSchema,
      _meta: {
        ui: { resourceUri: 'ui://rewind/attended-season.html' },
        'ui/resourceUri': 'ui://rewind/attended-season.html',
      },
    },
    async ({ league, season }) =>
      withRichResponse(async () => {
        const data = await client.get<AttendedSeasonResponse>(
          `/attending/seasons/${league}/${season}`
        );

        if (!data.data.length) {
          return {
            content: [
              text(`No attended ${league.toUpperCase()} games in ${season}.`),
            ],
            structuredContent: data,
          };
        }

        const lines = [
          `${league.toUpperCase()} ${season}: ${data.attended_count} games attended (${data.wins}-${data.losses})`,
          '',
        ];
        for (const e of data.data) {
          const date = formatDate(e.event_date);
          const venue = e.venue ? ` @ ${e.venue.name}` : '';
          const score = e.subtitle ? ` -- ${e.subtitle}` : '';
          const noShow = e.attended ? '' : ' [no-show]';
          // Lead with `id=N` so Claude can pass it directly to
          // `get_attended_event(id)` for the rich card.
          lines.push(`id=${e.id} ${date}: ${e.title}${venue}${score}${noShow}`);
        }

        return {
          content: [text(lines.join('\n'))],
          structuredContent: data,
        };
      })
  );

  // get_attended_player ───────────────────────────────────────────
  // Registered via server.registerTool so we can attach `_meta.ui.resourceUri`.
  // Hosts that support MCP Apps render the athlete card inline; others fall
  // back to the text + photo response.
  //
  // structuredContent uses the DESIGN.md nested shape: { player, supported,
  // season_stats, attended_summary, attended_appearances, attended_appearance_count }.
  // Appearances are capped at 10 most recent to keep the response within the
  // 8 KB token budget.
  server.registerTool(
    'get_attended_player',
    {
      title: 'Player',
      description:
        'Detailed athlete card for an MLB / NFL / NCAAF / NBA player you\'ve watched play in person. **Use this whenever the user asks how a specific player is performing this season, what their batting average / ERA / current stats are, how their career has gone, or how they\'ve played in the games you attended** — e.g. "how\'s JP Crawford playing this year", "what are Cal Raleigh\'s numbers", "show me Kirby\'s stats", "tell me about Julio Rodriguez". Returns bio (position, jersey, debut, height/weight, college, awards), team logo, current-season stats (live MLB Stats API for MLB players, KV-cached 1h), career-by-season table, home/away/L-R splits, the **season_attended_summary** (this player\'s line in only the games you attended this season — use this to answer "how has he done in the games I\'ve been to this year"), the **attended_summary** (career line across every game you\'ve ever seen this player in), and the 10 most recent attended appearances. Trust season_attended_summary.games_attended as the count of games you\'ve attended this season — do NOT derive it by filtering attended_appearances yourself; that array is capped at 10 most-recent and will undercount for players you see often. MLB-only for the live-stats panel — non-MLB players surface as supported:false. In MCP Apps hosts, renders the rich inline athlete card. If you do not have the player id, first call `get_attended_players` with `name` to resolve the id, then call this to render the card.',
      inputSchema: {
        id: z.number().int().describe('Player id.'),
        ...includeImagesParam,
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: attendedPlayerOutputSchema,
      _meta: {
        ui: { resourceUri: 'ui://rewind/attended-player.html' },
        'ui/resourceUri': 'ui://rewind/attended-player.html',
      },
    },
    async ({ id, include_images }) =>
      withRichResponse(async () => {
        const data = await client.get<
          Player & {
            supported: boolean;
            birth_city: string | null;
            birth_state_province: string | null;
            height: string | null;
            weight: number | null;
            college_name: string | null;
            awards: Array<{ season: string; id: string; name: string }>;
            season_stats: {
              season: number;
              fetched_at: string;
              cache_hit: boolean;
              hitter: Record<string, unknown> | null;
              pitcher: Record<string, unknown> | null;
            } | null;
            career: {
              group: 'hitting' | 'pitching';
              seasons: Array<Record<string, unknown>>;
              fetched_at: string;
              cache_hit: boolean;
            } | null;
            splits: {
              season: number;
              group: 'hitting' | 'pitching';
              home: Record<string, unknown> | null;
              away: Record<string, unknown> | null;
              vs_left: Record<string, unknown> | null;
              vs_right: Record<string, unknown> | null;
              fetched_at: string;
              cache_hit: boolean;
            } | null;
            attended_summary: {
              games_attended: number;
              games_with_box_score: number;
              wins: number;
              losses: number;
              hitter: Record<string, unknown> | null;
              pitcher: Record<string, unknown> | null;
            };
            season_attended_summary: {
              games_attended: number;
              games_with_box_score: number;
              wins: number;
              losses: number;
              hitter: Record<string, unknown> | null;
              pitcher: Record<string, unknown> | null;
            } | null;
            season_attended_summary_season: number | null;
            appearances: Array<{
              event_id: number;
              event_date: string;
              title: string;
              team: Team | null;
              is_home: boolean;
              batting_line: Record<string, unknown> | null;
              pitching_line: Record<string, unknown> | null;
              decision: 'W' | 'L' | 'SV' | 'HLD' | 'BS' | null;
              notable: boolean;
            }>;
            appearance_count: number;
          }
        >(`/attending/players/${id}`);

        const bio = [
          `${data.full_name}${data.primary_number ? ` #${data.primary_number}` : ''}${data.primary_position ? ` (${data.primary_position})` : ''}`,
          data.primary_team
            ? `Team: ${data.primary_team.full_name ?? data.primary_team.name} (${data.primary_team.abbreviation})`
            : null,
          data.bats || data.throws
            ? `Bats: ${data.bats ?? '?'}, Throws: ${data.throws ?? '?'}`
            : null,
          data.debut_date ? `MLB debut: ${formatDate(data.debut_date)}` : null,
          data.height || data.weight
            ? `${data.height ?? ''}${data.weight ? `, ${data.weight} lbs` : ''}`
                .trim()
                .replace(/^,\s*/, '')
            : null,
          data.birth_city || data.birth_state_province || data.birth_country
            ? `From: ${[data.birth_city, data.birth_state_province, data.birth_country].filter(Boolean).join(', ')}`
            : null,
          data.college_name ? `College: ${data.college_name}` : null,
        ].filter((l) => l !== null);

        const lines = [bio.join('\n')];

        // This-season stats — for MLB hitters/pitchers.
        if (data.season_stats?.hitter) {
          const h = data.season_stats.hitter;
          lines.push(
            '',
            `${data.season_stats.season} season: .${(h.avg ?? '.000').toString().replace(/^\./, '')} / .${(h.slg ?? '.000').toString().replace(/^\./, '')} (AVG / SLG), ${h.hr ?? 0} HR, ${h.rbi ?? 0} RBI in ${h.games_played ?? 0} games`
          );
        } else if (data.season_stats?.pitcher) {
          const p = data.season_stats.pitcher;
          lines.push(
            '',
            `${data.season_stats.season} season: ${p.era ?? '0.00'} ERA, ${p.whip ?? '0.00'} WHIP, ${p.k ?? 0} K in ${p.ip ?? '0'} IP`
          );
        }

        // Season-scoped attended summary — surfaced before the career line
        // so the model has the "this year, in games I've seen" answer
        // pre-computed and doesn't have to filter the appearance list.
        // Skip when zero games (preseason, or player you've never seen
        // play in the active season).
        const seasonSum = data.season_attended_summary;
        const seasonLabel = data.season_attended_summary_season;
        if (seasonSum && seasonSum.games_attended > 0 && seasonLabel != null) {
          if (seasonSum.hitter) {
            const h = seasonSum.hitter;
            lines.push(
              '',
              `In ${seasonSum.games_attended} ${seasonLabel} game${seasonSum.games_attended === 1 ? '' : 's'} you attended: ${h.h ?? 0}-for-${h.ab ?? 0} (.${(h.avg ?? '.000').toString().replace(/^\./, '')}), ${h.hr ?? 0} HR, ${h.rbi ?? 0} RBI`
            );
          } else if (seasonSum.pitcher) {
            const p = seasonSum.pitcher;
            const dec = p.decisions as
              | { w: number; l: number; sv: number }
              | undefined;
            lines.push(
              '',
              `In ${seasonSum.games_attended} ${seasonLabel} game${seasonSum.games_attended === 1 ? '' : 's'} you attended: ${p.ip ?? '0'} IP, ${p.k ?? 0} K, ${p.era ?? '0.00'} ERA${dec ? ` (${dec.w ?? 0}-${dec.l ?? 0})` : ''}`
            );
          }
        }

        // Career attended summary — your stat line across every game
        // you've ever seen this player in.
        if (data.attended_summary.hitter) {
          const h = data.attended_summary.hitter;
          lines.push(
            '',
            `Across all ${data.attended_summary.games_attended} games you've ever attended: ${h.h ?? 0} hits in ${h.ab ?? 0} AB, ${h.hr ?? 0} HR, ${h.rbi ?? 0} RBI`
          );
        } else if (data.attended_summary.pitcher) {
          const p = data.attended_summary.pitcher;
          const dec = p.decisions as
            | { w: number; l: number; sv: number }
            | undefined;
          lines.push(
            '',
            `Across all ${data.attended_summary.games_attended} games you've ever attended: ${p.ip ?? '0'} IP, ${p.k ?? 0} K, ${p.era ?? '0.00'} ERA${dec ? ` (${dec.w ?? 0}-${dec.l ?? 0})` : ''}`
          );
        }

        if (data.appearance_count > 0) {
          lines.push(
            '',
            `${data.appearance_count} attended appearance${data.appearance_count === 1 ? '' : 's'}:`
          );
          for (const a of data.appearances.slice(0, 25)) {
            const date = formatDate(a.event_date);
            const stat = summarizeAppearance(a);
            const decision = a.decision ? ` (${a.decision})` : '';
            lines.push(`${date}: ${a.title}${decision} -- ${stat}`);
          }
          if (data.appearance_count > 25) {
            lines.push(`... and ${data.appearance_count - 25} more.`);
          }
        }

        const images: ContentBlock[] = [];
        if (include_images) {
          const silo = await imageBlock(client, data.photo_silo, LIST_IMAGE_PX);
          if (silo) images.push(silo);
        }

        // structuredContent: nested DESIGN.md shape. Appearances capped at
        // 10 most recent for the card; total surfaced via attended_appearance_count.
        const structuredContent = {
          player: {
            id: data.id,
            mlb_stats_id: data.mlb_stats_id,
            full_name: data.full_name,
            primary_position: data.primary_position,
            primary_number: data.primary_number,
            bats: data.bats,
            throws: data.throws,
            debut_date: data.debut_date,
            birth_date: data.birth_date,
            birth_city: data.birth_city,
            birth_state_province: data.birth_state_province,
            birth_country: data.birth_country,
            height: data.height,
            weight: data.weight,
            college_name: data.college_name,
            awards: data.awards,
            photo_silo: data.photo_silo,
            photo_full: data.photo_full,
            league: data.league,
            primary_team: data.primary_team,
          },
          supported: data.supported,
          season_stats: data.season_stats,
          career: data.career,
          splits: data.splits,
          attended_summary: data.attended_summary,
          season_attended_summary: data.season_attended_summary,
          season_attended_summary_season: data.season_attended_summary_season,
          attended_appearances: data.appearances.slice(0, 10).map((a) => ({
            event_id: a.event_id,
            event_date: a.event_date,
            title: a.title,
            is_home: a.is_home,
            batting_line: a.batting_line,
            pitching_line: a.pitching_line,
            decision: a.decision,
            notable: a.notable,
            // Notable reasons stitched from batting/pitching lines for the
            // card. Lightweight client-side derivation matches the season
            // grid card's existing pattern.
            notable_reasons: deriveNotableReasons(a),
          })),
          attended_appearance_count: data.appearance_count,
        };

        return {
          content: [text(lines.join('\n')), ...images],
          structuredContent,
        };
      })
  );

  // get_attended_event ──────────────────────────────────────────────
  // Uses server.registerTool so we can attach _meta.ui.resourceUri.
  // MCP Apps hosts (Claude Desktop, Claude web, Claude iOS) render the
  // game card inline via ui://rewind/attended-event.html; non-MCP-Apps
  // clients fall back to the text + structuredContent response.
  server.registerTool(
    'get_attended_event',
    {
      title: 'Event',
      description:
        'Get a single attended event (sports game, concert, theater show) in full detail, including venue, tickets, and per-player stat lines for sports games. Renders the rich inline event card — linescore, top performers with photos, ticket info — in MCP Apps hosts. Use this when the user asks about ONE specific event: "tell me about my last Mariners game," "who pitched in that Phillies game," "the Springsteen show I went to," "what happened at that game." If you do not have the event id, first call `get_attended_events` with a `team` / `event_type` filter (and `limit: 1` if the user asked for the most recent) to find the id, then call this to render the card.',
      inputSchema: {
        id: z.number().int().describe('Event id.'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: attendedEventDetailOutputSchema,
      _meta: {
        ui: { resourceUri: 'ui://rewind/attended-event.html' },
        'ui/resourceUri': 'ui://rewind/attended-event.html',
      },
    },
    async ({ id }) =>
      withRichResponse(async () => {
        const data = await client.get<AttendedEventDetail>(
          `/attending/events/${id}`
        );

        const date = formatDate(data.event_date);
        const venue = data.venue ? ` @ ${data.venue.name}` : '';
        const score = data.subtitle ? ` -- ${data.subtitle}` : '';
        const lines = [`${date}: ${data.title}${venue}${score}`];

        if (data.event_data) {
          const ed = data.event_data;
          if (ed.attendance)
            lines.push(`Attendance: ${fmt(ed.attendance as number)}`);
          if (ed.weather && typeof ed.weather === 'object') {
            const w = ed.weather as {
              condition?: string;
              temp?: string;
              wind?: string;
            };
            const parts = [
              w.condition,
              w.temp ? `${w.temp}°F` : null,
              w.wind,
            ].filter(Boolean);
            if (parts.length) lines.push(`Weather: ${parts.join(', ')}`);
          }
          if (ed.duration_minutes)
            lines.push(`Duration: ${ed.duration_minutes} min`);
        }

        const notable = data.players.filter((p) => p.notable);
        if (notable.length) {
          lines.push('', 'Notable performances:');
          for (const a of notable.slice(0, 12)) {
            const stat = summarizeAppearance(a);
            const decision = a.decision ? ` (${a.decision})` : '';
            lines.push(`  ${a.player.full_name}${decision} -- ${stat}`);
          }
        }

        return {
          content: [text(lines.join('\n'))],
          structuredContent: data,
        };
      })
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────

// Reasons a particular attended appearance is "notable" — feeds the
// athlete card's bullet highlights ("3 HRs you witnessed live", etc.).
// Cheap and stateless; matches the criteria used by the per-game
// notable=1 backend flag.
function deriveNotableReasons(a: {
  batting_line: Record<string, unknown> | null;
  pitching_line: Record<string, unknown> | null;
  decision: string | null;
}): string[] {
  const reasons: string[] = [];
  if (a.batting_line) {
    const b = a.batting_line as {
      h?: number;
      hr?: number;
      rbi?: number;
      sb?: number;
    };
    if ((b.hr ?? 0) > 0) reasons.push(`${b.hr} HR`);
    if ((b.h ?? 0) >= 3) reasons.push('multi-hit');
    if ((b.rbi ?? 0) >= 4) reasons.push(`${b.rbi} RBI`);
    if ((b.sb ?? 0) >= 2) reasons.push(`${b.sb} SB`);
  }
  if (a.pitching_line) {
    const p = a.pitching_line as { ip?: string; k?: number };
    const ipNum = parseFloat(p.ip ?? '0');
    if (ipNum >= 9) reasons.push('complete game');
    if ((p.k ?? 0) >= 10) reasons.push(`${p.k} K`);
  }
  if (a.decision === 'W') reasons.push('win');
  if (a.decision === 'SV') reasons.push('save');
  return reasons;
}

function summarizeAppearance(a: {
  batting_line: Record<string, unknown> | null;
  pitching_line: Record<string, unknown> | null;
}): string {
  const parts: string[] = [];
  if (a.batting_line) {
    const b = a.batting_line as {
      ab?: number;
      h?: number;
      rbi?: number;
      hr?: number;
      bb?: number;
      k?: number;
    };
    const line = `${b.h ?? 0}-for-${b.ab ?? 0}`;
    const extras: string[] = [];
    if (b.hr) extras.push(`${b.hr} HR`);
    if (b.rbi) extras.push(`${b.rbi} RBI`);
    if (b.bb) extras.push(`${b.bb} BB`);
    if (b.k) extras.push(`${b.k} K`);
    parts.push(extras.length ? `${line}, ${extras.join(', ')}` : line);
  }
  if (a.pitching_line) {
    const p = a.pitching_line as {
      ip?: string;
      h?: number;
      er?: number;
      bb?: number;
      k?: number;
    };
    parts.push(
      `${p.ip ?? '0.0'} IP, ${p.h ?? 0} H, ${p.er ?? 0} ER, ${p.bb ?? 0} BB, ${p.k ?? 0} K`
    );
  }
  return parts.length ? parts.join(' | ') : '-';
}
