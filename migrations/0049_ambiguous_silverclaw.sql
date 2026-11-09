CREATE TABLE `podcast_backups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`filename` text NOT NULL,
	`exported_at` text NOT NULL,
	`device_name` text,
	`device_model` text,
	`model_version` integer,
	`show_count` integer DEFAULT 0 NOT NULL,
	`episode_count` integer DEFAULT 0 NOT NULL,
	`session_count` integer DEFAULT 0 NOT NULL,
	`imported_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_podcast_backups_file` ON `podcast_backups` (`user_id`,`filename`);--> statement-breakpoint
CREATE INDEX `idx_podcast_backups_exported` ON `podcast_backups` (`exported_at`);--> statement-breakpoint
CREATE TABLE `podcast_episodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`show_id` integer,
	`castro_episode_id` text NOT NULL,
	`castro_short_code` text,
	`castro_url` text,
	`title` text,
	`episode_number` integer,
	`published_at` text,
	`duration_seconds` integer,
	`audio_url` text,
	`artwork_url` text,
	`match_confidence` text DEFAULT 'none' NOT NULL,
	`match_delta_seconds` real,
	`match_candidates` text,
	`starred` integer DEFAULT 0 NOT NULL,
	`unpublished` integer DEFAULT 0 NOT NULL,
	`resume_position_seconds` real,
	`in_library_state` text,
	`times_played` integer DEFAULT 0 NOT NULL,
	`total_listened_seconds` integer DEFAULT 0 NOT NULL,
	`max_played_seconds` real,
	`completed` integer DEFAULT 0 NOT NULL,
	`first_played_at` text,
	`last_played_at` text,
	`language` text,
	`has_transcript` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`show_id`) REFERENCES `podcast_shows`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_podcast_episodes_user_castro` ON `podcast_episodes` (`user_id`,`castro_episode_id`);--> statement-breakpoint
CREATE INDEX `idx_podcast_episodes_show` ON `podcast_episodes` (`show_id`);--> statement-breakpoint
CREATE INDEX `idx_podcast_episodes_user_id` ON `podcast_episodes` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_podcast_episodes_confidence` ON `podcast_episodes` (`match_confidence`);--> statement-breakpoint
CREATE INDEX `idx_podcast_episodes_starred` ON `podcast_episodes` (`starred`);--> statement-breakpoint
CREATE INDEX `idx_podcast_episodes_played` ON `podcast_episodes` (`last_played_at`);--> statement-breakpoint
CREATE INDEX `idx_podcast_episodes_transcript` ON `podcast_episodes` (`has_transcript`);--> statement-breakpoint
CREATE TABLE `podcast_play_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`episode_id` integer,
	`show_id` integer,
	`castro_episode_id` text,
	`castro_podcast_id` text,
	`began_at` text NOT NULL,
	`finished_at` text,
	`played_from_seconds` real,
	`played_to_seconds` real,
	`listened_seconds` real,
	`trimmed` integer DEFAULT 0 NOT NULL,
	`backup_id` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`episode_id`) REFERENCES `podcast_episodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`show_id`) REFERENCES `podcast_shows`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`backup_id`) REFERENCES `podcast_backups`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_podcast_sessions_unique` ON `podcast_play_sessions` (`user_id`,`castro_episode_id`,`began_at`);--> statement-breakpoint
CREATE INDEX `idx_podcast_sessions_episode` ON `podcast_play_sessions` (`episode_id`);--> statement-breakpoint
CREATE INDEX `idx_podcast_sessions_show` ON `podcast_play_sessions` (`show_id`);--> statement-breakpoint
CREATE INDEX `idx_podcast_sessions_began` ON `podcast_play_sessions` (`began_at`);--> statement-breakpoint
CREATE INDEX `idx_podcast_sessions_user_id` ON `podcast_play_sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `podcast_shows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`castro_public_id` text NOT NULL,
	`castro_short_code` text,
	`castro_url` text,
	`itunes_id` text,
	`feed_url` text,
	`website` text,
	`title` text,
	`author` text,
	`description` text,
	`artwork_url` text,
	`categories` text,
	`subscribed` integer DEFAULT 0 NOT NULL,
	`playback_rate` integer,
	`trim_silence` integer DEFAULT 0 NOT NULL,
	`mono_mix` integer DEFAULT 0 NOT NULL,
	`enhanced_audio` integer DEFAULT 0 NOT NULL,
	`episode_limit` integer,
	`policy` integer,
	`start_episodes_at` integer,
	`end_episodes_at` integer,
	`most_recent_episode_id` text,
	`episode_count` integer DEFAULT 0 NOT NULL,
	`episodes_played` integer DEFAULT 0 NOT NULL,
	`session_count` integer DEFAULT 0 NOT NULL,
	`total_listened_seconds` integer DEFAULT 0 NOT NULL,
	`first_played_at` text,
	`last_played_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_podcast_shows_user_castro` ON `podcast_shows` (`user_id`,`castro_public_id`);--> statement-breakpoint
CREATE INDEX `idx_podcast_shows_user_id` ON `podcast_shows` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_podcast_shows_itunes` ON `podcast_shows` (`itunes_id`);--> statement-breakpoint
CREATE INDEX `idx_podcast_shows_subscribed` ON `podcast_shows` (`subscribed`);--> statement-breakpoint
CREATE INDEX `idx_podcast_shows_listened` ON `podcast_shows` (`total_listened_seconds`);--> statement-breakpoint
CREATE TABLE `podcast_transcripts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`episode_id` integer NOT NULL,
	`language` text,
	`engine` text NOT NULL,
	`word_count` integer DEFAULT 0 NOT NULL,
	`text` text NOT NULL,
	`ad_seconds_removed` real DEFAULT 0 NOT NULL,
	`ad_spans` text,
	`ad_detection_method` text,
	`segments_r2_key` text,
	`raw_text_r2_key` text,
	`transcribed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`episode_id`) REFERENCES `podcast_episodes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_podcast_transcripts_episode` ON `podcast_transcripts` (`episode_id`);--> statement-breakpoint
CREATE INDEX `idx_podcast_transcripts_user_id` ON `podcast_transcripts` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_podcast_transcripts_engine` ON `podcast_transcripts` (`engine`);