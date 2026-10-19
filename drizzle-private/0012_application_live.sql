CREATE TABLE `private_application_live` (
	`owner_id` text NOT NULL,
	`application_id` text NOT NULL,
	`step` text NOT NULL,
	`image` text,
	`fields` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `application_id`),
	CONSTRAINT "private_application_live_fields_json" CHECK("private_application_live"."fields" is null or json_valid("private_application_live"."fields"))
);
