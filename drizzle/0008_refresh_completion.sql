ALTER TABLE `refresh_requests` ADD `completed_at` integer;--> statement-breakpoint
ALTER TABLE `refresh_requests` ADD `error` text;--> statement-breakpoint
-- Old claims have no recorded outcome; retire them without claiming success.
UPDATE `refresh_requests`
SET `completed_at` = coalesce(`claimed_at`, `requested_at`),
    `error` = 'Legacy request; request a new refresh';--> statement-breakpoint
CREATE UNIQUE INDEX `refresh_requests_active_idx` ON `refresh_requests` ((1)) WHERE "refresh_requests"."completed_at" is null;
