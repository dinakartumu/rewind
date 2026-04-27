import { z } from '@hono/zod-openapi';

// Wire shape for a sports team. The single source of truth for what
// API serializers attach to `home_team` / `away_team` / `primary_team`
// fields, what MCP tools type their `Team` references against, and
// what the UI primitives (TeamLogo, useTeamAccent) consume.
//
// `id` is the league-native int (e.g. 136 for Mariners in MLB), not the
// teams table autoincrement PK — matches what the rest of the API
// already returns. `league` lets a consumer disambiguate when only the
// id is in scope (NBA team 1 vs MLB team 1).
//
// Color and logo fields are nullable because seeding is best-effort:
// new leagues may land in the table before the color pass is curated.
// UI components must handle nulls.
export const Team = z
  .object({
    id: z.number().int().openapi({ example: 136 }),
    league: z.string().openapi({ example: 'mlb' }),
    abbreviation: z.string().openapi({ example: 'SEA' }),
    location: z.string().nullable().openapi({ example: 'Seattle' }),
    name: z.string().openapi({ example: 'Mariners' }),
    full_name: z.string().nullable().openapi({ example: 'Seattle Mariners' }),
    primary_color: z.string().nullable().openapi({ example: '#0C2C56' }),
    secondary_color: z.string().nullable().openapi({ example: '#005C5C' }),
    tertiary_color: z.string().nullable().openapi({ example: null }),
    ui_tint_color: z.string().nullable().openapi({ example: '#0C2C56' }),
    logo_url: z
      .string()
      .nullable()
      .openapi({ example: 'https://www.mlbstatic.com/team-logos/136.svg' }),
    logo_dark_url: z.string().nullable().openapi({
      example: 'https://www.mlbstatic.com/team-logos/team-cap-on-dark/136.svg',
    }),
    logo_light_url: z.string().nullable().openapi({
      example: 'https://www.mlbstatic.com/team-logos/team-cap-on-light/136.svg',
    }),
    conference: z.string().nullable().openapi({ example: 'AL' }),
    division: z.string().nullable().openapi({ example: 'AL West' }),
  })
  .openapi('Team');

export type TeamShape = z.infer<typeof Team>;

// Compact form used in list contexts (player search results, season
// grid cells) where a full Team is more weight than the row needs.
// Pure presentational: enough to render a logo + tinted name.
export const TeamRef = z
  .object({
    id: z.number().int(),
    league: z.string(),
    abbreviation: z.string(),
    name: z.string(),
    primary_color: z.string().nullable(),
    ui_tint_color: z.string().nullable(),
    logo_url: z.string().nullable(),
  })
  .openapi('TeamRef');

export type TeamRefShape = z.infer<typeof TeamRef>;
