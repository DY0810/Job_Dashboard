CREATE TABLE `private_account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `private_user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `private_account_user_id_idx` ON `private_account` (`user_id`);--> statement-breakpoint
CREATE TABLE `private_rate_limit` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`count` integer NOT NULL,
	`last_request` integer NOT NULL,
	CONSTRAINT "private_rate_limit_count_check" CHECK(typeof("private_rate_limit"."count") = 'integer' and "private_rate_limit"."count" >= 0),
	CONSTRAINT "private_rate_limit_last_request_check" CHECK(typeof("private_rate_limit"."last_request") = 'integer' and "private_rate_limit"."last_request" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `private_rate_limit_key_unique` ON `private_rate_limit` (`key`);--> statement-breakpoint
CREATE TABLE `private_session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `private_user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `private_session_token_unique` ON `private_session` (`token`);--> statement-breakpoint
CREATE INDEX `private_session_user_id_idx` ON `private_session` (`user_id`);--> statement-breakpoint
CREATE TABLE `private_user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "private_user_email_verified_check" CHECK("private_user"."email_verified" in (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `private_user_email_unique` ON `private_user` (`email`);--> statement-breakpoint
CREATE TABLE `private_verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `private_verification_identifier_idx` ON `private_verification` (`identifier`);