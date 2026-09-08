ALTER TABLE `posting_sources` ADD `publisher_id` text;--> statement-breakpoint
CREATE INDEX `posting_sources_url_idx` ON `posting_sources` (`source_url`);--> statement-breakpoint
CREATE INDEX `posting_sources_publisher_idx` ON `posting_sources` (`source`,`publisher_id`);