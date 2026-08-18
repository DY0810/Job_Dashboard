CREATE TABLE `connector_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`connector` text NOT NULL,
	`status` text NOT NULL,
	`fetched` integer DEFAULT 0 NOT NULL,
	`new_postings` integer DEFAULT 0 NOT NULL,
	`merged` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`error` text,
	`started_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connector_runs_run_connector_idx` ON `connector_runs` (`run_id`,`connector`);--> statement-breakpoint
CREATE TABLE `enrichment_cache` (
	`content_hash` text PRIMARY KEY NOT NULL,
	`classification` text NOT NULL,
	`model` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `posting_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`posting_id` integer NOT NULL,
	`source` text NOT NULL,
	`source_url` text NOT NULL,
	`posted_at` integer NOT NULL,
	`source_priority` integer NOT NULL,
	`last_seen_run` text NOT NULL,
	`absence_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`posting_id`) REFERENCES `postings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `posting_sources_posting_url_idx` ON `posting_sources` (`posting_id`,`source_url`);--> statement-breakpoint
CREATE TABLE `postings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dedupe_key` text NOT NULL,
	`canonical_url` text NOT NULL,
	`posted_at` integer NOT NULL,
	`delisted_at` integer,
	`first_seen_run` text NOT NULL,
	`company` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`description_hash` text,
	`company_norm` text NOT NULL,
	`title_norm` text NOT NULL,
	`location_key` text NOT NULL,
	`city_norm` text,
	`state` text,
	`country` text,
	`is_remote` integer DEFAULT false NOT NULL,
	`enriched_at` integer,
	`track` text,
	`seniority` text,
	`employment_type` text,
	`internship_season` text,
	`paid` integer,
	`work_mode` text,
	`location` text,
	`pay_rate_min` real,
	`pay_rate_max` real,
	`pay_rate_period` text,
	`expected_grad` text,
	`summary` text,
	`responsibilities` text,
	`skills` text,
	`education` text,
	`badges` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `postings_dedupe_key_unique` ON `postings` (`dedupe_key`);