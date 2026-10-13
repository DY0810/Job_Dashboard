ALTER TABLE `private_worker` ADD `daily_start_minute` integer CHECK(`daily_start_minute` between 0 and 1439);--> statement-breakpoint
ALTER TABLE `private_worker` ADD `time_zone` text;--> statement-breakpoint
ALTER TABLE `private_worker` ADD `daily_start_updated_at` integer;
