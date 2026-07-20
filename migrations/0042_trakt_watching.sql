-- Custom SQL migration file, put your code below! --

-- Rename Plex-specific show tables to source-neutral names and add Trakt
-- columns. The `shows` table is rebuilt (not just renamed) because
-- `plex_rating_key` must become nullable -- Trakt-sourced shows have no
-- Plex rating key -- and SQLite cannot drop NOT NULL via ALTER TABLE.
PRAGMA defer_foreign_keys = on;--> statement-breakpoint
ALTER TABLE `plex_shows` RENAME TO `shows`;--> statement-breakpoint
ALTER TABLE `plex_episodes_watched` RENAME TO `episodes_watched`;--> statement-breakpoint
CREATE TABLE `shows_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`plex_rating_key` text,
	`trakt_id` integer,
	`title` text NOT NULL,
	`year` integer,
	`tmdb_id` integer,
	`summary` text,
	`poster_path` text,
	`backdrop_path` text,
	`content_rating` text,
	`tmdb_rating` real,
	`image_key` text,
	`total_seasons` integer,
	`total_episodes` integer,
	`created_at` text NOT NULL
);--> statement-breakpoint
INSERT INTO `shows_new` (`id`, `user_id`, `plex_rating_key`, `trakt_id`, `title`, `year`, `tmdb_id`, `summary`, `poster_path`, `backdrop_path`, `content_rating`, `tmdb_rating`, `image_key`, `total_seasons`, `total_episodes`, `created_at`)
SELECT `id`, `user_id`, `plex_rating_key`, NULL, `title`, `year`, `tmdb_id`, `summary`, `poster_path`, `backdrop_path`, `content_rating`, `tmdb_rating`, `image_key`, `total_seasons`, `total_episodes`, `created_at` FROM `shows`;--> statement-breakpoint
DROP TABLE `shows`;--> statement-breakpoint
ALTER TABLE `shows_new` RENAME TO `shows`;--> statement-breakpoint
ALTER TABLE `episodes_watched` ADD `source` text DEFAULT 'plex' NOT NULL;--> statement-breakpoint
ALTER TABLE `episodes_watched` ADD `trakt_history_id` integer;--> statement-breakpoint
ALTER TABLE `watch_history` ADD `trakt_history_id` integer;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_plex_shows_user_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_plex_shows_tmdb_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_plex_episodes_watched_show_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_plex_episodes_watched_watched_at`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_plex_episodes_watched_user_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_plex_episodes_timeline`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_plex_episodes_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `shows_plex_rating_key_unique` ON `shows` (`plex_rating_key`);--> statement-breakpoint
CREATE INDEX `idx_shows_user_id` ON `shows` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_shows_tmdb_id` ON `shows` (`tmdb_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `shows_trakt_id_unique` ON `shows` (`trakt_id`);--> statement-breakpoint
CREATE INDEX `idx_episodes_watched_show_id` ON `episodes_watched` (`show_id`);--> statement-breakpoint
CREATE INDEX `idx_episodes_watched_watched_at` ON `episodes_watched` (`watched_at`);--> statement-breakpoint
CREATE INDEX `idx_episodes_watched_user_id` ON `episodes_watched` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_episodes_timeline` ON `episodes_watched` (`user_id`,`watched_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_episodes_unique` ON `episodes_watched` (`show_id`,`season_number`,`episode_number`,`watched_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_episodes_trakt_history_id` ON `episodes_watched` (`trakt_history_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_watch_history_trakt_history_id` ON `watch_history` (`trakt_history_id`);
