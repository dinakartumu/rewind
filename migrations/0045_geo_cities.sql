CREATE TABLE `geo_cities` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`admin1` text,
	`country_code` text NOT NULL,
	`lat` real NOT NULL,
	`lng` real NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_geo_cities_lat` ON `geo_cities` (`lat`);