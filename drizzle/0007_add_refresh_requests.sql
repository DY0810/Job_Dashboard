CREATE TABLE `refresh_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`requested_by` text,
	`requested_at` integer NOT NULL,
	`claimed_at` integer
);
--> statement-breakpoint
CREATE INDEX `refresh_requests_claimed_idx` ON `refresh_requests` (`claimed_at`);