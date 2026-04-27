-- Teams reference table for the attending domain.
--
-- Globally shared (no user_id): a team is a brand-and-roster entity that
-- exists independent of who watched their games. Per-user data lives on
-- attended_event_players + attended_events, both of which already join
-- via league-native ids.
--
-- Identity model: keep `league_team_id` as the league-native int that
-- the rest of the codebase already uses (e.g. attendedEvents.eventData
-- carries home_team.id = 136 for the Mariners, players.primary_team_id
-- stores 136). The composite (league, league_team_id) unique index
-- powers the join from those existing rows. teams.id (autoincrement) is
-- internal and only used for FKs we add later.
--
-- Logo storage: `logo_url` holds the canonical upstream URL — for MLB
-- this is mlbstatic.com SVG. Hot-linking is the v1 strategy. `logo_key`
-- is reserved for the case where we mirror to R2 through the existing
-- image pipeline (pattern matches player_silo). Light/dark variants are
-- separate fields because some logos render poorly on the off-theme
-- background.
--
-- Colors: `primary_color` / `secondary_color` / `tertiary_color` come
-- from ESPN's brand colors. `ui_tint_color` is curated separately —
-- ESPN's primary isn't always the right tint against card backgrounds.
-- Defaults to primary; override per-team as needed.

CREATE TABLE IF NOT EXISTS teams (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  league text NOT NULL,                                  -- 'mlb', 'nfl', 'nba', 'mls'
  league_team_id integer NOT NULL,                       -- e.g. 136 for Mariners in MLB
  abbreviation text NOT NULL,                            -- 'SEA'
  location text,                                         -- 'Seattle'
  name text NOT NULL,                                    -- 'Mariners'
  full_name text,                                        -- 'Seattle Mariners'
  primary_color text,                                    -- hex '#0C2C56'
  secondary_color text,
  tertiary_color text,
  ui_tint_color text,                                    -- curated; defaults to primary
  logo_url text,                                         -- canonical upstream
  logo_dark_url text,                                    -- on-dark variant (logo for dark backgrounds)
  logo_light_url text,                                   -- on-light variant
  logo_key text,                                         -- R2 key if mirrored
  conference text,                                       -- 'AL', 'NL', 'AFC'
  division text,                                         -- 'AL West'
  home_venue_id integer REFERENCES venues(id),
  external_ids text,                                     -- JSON: { espn_id, sportradar_id, ... }
  aliases text,                                          -- JSON: ["Cleveland Indians"]
  founded_year integer,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_league_native_id
  ON teams (league, league_team_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_league_abbr
  ON teams (league, abbreviation);
CREATE INDEX IF NOT EXISTS idx_teams_league ON teams (league);
CREATE INDEX IF NOT EXISTS idx_teams_division ON teams (conference, division);
CREATE INDEX IF NOT EXISTS idx_teams_home_venue ON teams (home_venue_id);
