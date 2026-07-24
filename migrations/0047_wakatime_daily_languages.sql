CREATE TABLE `wakatime_daily_languages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`date` text NOT NULL,
	`language` text NOT NULL,
	`total_seconds` real NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_wakatime_daily_lang_user_date_lang` ON `wakatime_daily_languages` (`user_id`,`date`,`language`);--> statement-breakpoint
CREATE INDEX `idx_wakatime_daily_lang_date` ON `wakatime_daily_languages` (`date`);