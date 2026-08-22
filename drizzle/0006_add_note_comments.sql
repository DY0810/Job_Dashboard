CREATE TABLE `note_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`note_id` integer NOT NULL,
	`body` text NOT NULL,
	`author` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `note_comments_note_idx` ON `note_comments` (`note_id`);--> statement-breakpoint
CREATE INDEX `note_comments_created_idx` ON `note_comments` (`created_at`);