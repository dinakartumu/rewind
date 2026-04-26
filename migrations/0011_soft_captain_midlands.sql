CREATE TABLE `lastfm_yearly_stats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`year` integer NOT NULL,
	`scrobbles` integer DEFAULT 0 NOT NULL,
	`unique_artists` integer DEFAULT 0 NOT NULL,
	`unique_albums` integer DEFAULT 0 NOT NULL,
	`unique_tracks` integer DEFAULT 0 NOT NULL,
	`top_artist_id` integer,
	`computed_at` text NOT NULL,
	FOREIGN KEY (`top_artist_id`) REFERENCES `lastfm_artists`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_lastfm_yearly_stats_unique` ON `lastfm_yearly_stats` (`user_id`,`year`);--> statement-breakpoint
CREATE INDEX `idx_lastfm_yearly_stats_user_id` ON `lastfm_yearly_stats` (`user_id`);