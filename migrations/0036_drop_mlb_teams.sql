-- Drop the legacy mlb_teams table superseded by the new `teams` reference
-- table from migration 0035. Phase 3's mlb_teams was MLB-only with a
-- subset of fields (no logos, no brand colors); 0035's teams covers
-- the same MLB clubs plus other leagues, with logo URLs and full color
-- metadata. Existing references to teams in the rest of the schema use
-- league-native ids (player.primary_team_id, attended_events.event_data
-- .home_team.id) — those continue to resolve via teams.league_team_id.
--
-- Nothing has a foreign key into mlb_teams.id, so this drop is safe.
DROP INDEX IF EXISTS `idx_mlb_teams_abbr`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_mlb_teams_active`;--> statement-breakpoint
DROP TABLE IF EXISTS `mlb_teams`;
