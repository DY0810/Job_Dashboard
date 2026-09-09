ALTER TABLE `notes` ADD `client_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `notes_client_key_idx` ON `notes` (`client_key`);