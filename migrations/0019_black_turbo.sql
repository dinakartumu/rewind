CREATE TABLE `github_commits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`sha` text NOT NULL,
	`repo` text NOT NULL,
	`message` text NOT NULL,
	`additions` integer,
	`deletions` integer,
	`committed_at` text NOT NULL,
	`is_private` integer DEFAULT 0 NOT NULL,
	`url` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_github_commits_sha` ON `github_commits` (`sha`);--> statement-breakpoint
CREATE INDEX `idx_github_commits_user_id` ON `github_commits` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_github_commits_timeline` ON `github_commits` (`user_id`,`committed_at`);--> statement-breakpoint
CREATE INDEX `idx_github_commits_repo` ON `github_commits` (`repo`);--> statement-breakpoint
CREATE TABLE `github_contribution_days` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`date` text NOT NULL,
	`contribution_count` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_github_contrib_user_date` ON `github_contribution_days` (`user_id`,`date`);--> statement-breakpoint
CREATE INDEX `idx_github_contrib_date` ON `github_contribution_days` (`date`);--> statement-breakpoint
CREATE TABLE `github_issues` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`repo` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`state` text NOT NULL,
	`created_at_github` text NOT NULL,
	`closed_at` text,
	`is_private` integer DEFAULT 0 NOT NULL,
	`url` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_github_issues_repo_number` ON `github_issues` (`repo`,`number`);--> statement-breakpoint
CREATE INDEX `idx_github_issues_user_id` ON `github_issues` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_github_issues_timeline` ON `github_issues` (`user_id`,`created_at_github`);--> statement-breakpoint
CREATE TABLE `github_pull_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`repo` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`state` text NOT NULL,
	`created_at_github` text NOT NULL,
	`merged_at` text,
	`closed_at` text,
	`is_private` integer DEFAULT 0 NOT NULL,
	`url` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_github_prs_repo_number` ON `github_pull_requests` (`repo`,`number`);--> statement-breakpoint
CREATE INDEX `idx_github_prs_user_id` ON `github_pull_requests` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_github_prs_timeline` ON `github_pull_requests` (`user_id`,`created_at_github`);--> statement-breakpoint
CREATE TABLE `rescuetime_activities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`timestamp` text NOT NULL,
	`duration_seconds` integer NOT NULL,
	`activity` text NOT NULL,
	`category` text,
	`productivity` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_rescuetime_activities_slot` ON `rescuetime_activities` (`timestamp`,`activity`);--> statement-breakpoint
CREATE INDEX `idx_rescuetime_activities_user_id` ON `rescuetime_activities` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_rescuetime_activities_timeline` ON `rescuetime_activities` (`user_id`,`timestamp`);--> statement-breakpoint
CREATE TABLE `rescuetime_daily_summaries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`date` text NOT NULL,
	`total_seconds` integer NOT NULL,
	`productivity_pulse` integer,
	`very_productive_seconds` integer DEFAULT 0 NOT NULL,
	`productive_seconds` integer DEFAULT 0 NOT NULL,
	`neutral_seconds` integer DEFAULT 0 NOT NULL,
	`distracting_seconds` integer DEFAULT 0 NOT NULL,
	`very_distracting_seconds` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_rescuetime_daily_user_date` ON `rescuetime_daily_summaries` (`user_id`,`date`);--> statement-breakpoint
CREATE INDEX `idx_rescuetime_daily_date` ON `rescuetime_daily_summaries` (`date`);--> statement-breakpoint
CREATE TABLE `wakatime_daily_summaries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`date` text NOT NULL,
	`total_seconds` real NOT NULL,
	`top_language` text,
	`top_project` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_wakatime_daily_user_date` ON `wakatime_daily_summaries` (`user_id`,`date`);--> statement-breakpoint
CREATE INDEX `idx_wakatime_daily_date` ON `wakatime_daily_summaries` (`date`);--> statement-breakpoint
CREATE TABLE `wakatime_durations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`start_time` text NOT NULL,
	`duration_seconds` real NOT NULL,
	`project` text,
	`language` text,
	`entity` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_wakatime_durations_slice` ON `wakatime_durations` (`start_time`,`project`,`entity`);--> statement-breakpoint
CREATE INDEX `idx_wakatime_durations_user_id` ON `wakatime_durations` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_wakatime_durations_timeline` ON `wakatime_durations` (`user_id`,`start_time`);