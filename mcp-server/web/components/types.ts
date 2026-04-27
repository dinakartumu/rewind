// Shared type shapes used across the UI cards. Mirror the wire shapes
// served by the API (src/lib/schemas/team.ts on the API side); when the
// API shape changes, both sides update together.

export type Team = {
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

export type Photo = {
  cdn_url?: string | null;
  url?: string | null;
  thumbhash?: string | null;
  dominant_color?: string | null;
  accent_color?: string | null;
} | null;
