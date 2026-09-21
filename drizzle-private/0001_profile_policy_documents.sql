CREATE TABLE `private_document_upload_grant` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`document_id` text NOT NULL,
	`request_id` text NOT NULL,
	`input_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`token_issued` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `private_user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`owner_id`,`document_id`) REFERENCES `private_document`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "private_document_grant_token_check" CHECK("private_document_upload_grant"."token_issued" in (0,1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `private_document_upload_grant_document_id_unique` ON `private_document_upload_grant` (`document_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `private_document_grant_owner_request_unique` ON `private_document_upload_grant` (`owner_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `private_document_grant_expiry_idx` ON `private_document_upload_grant` (`expires_at`);--> statement-breakpoint
CREATE TABLE `private_document` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`role` text,
	`parent_id` text,
	`master_id` text NOT NULL,
	`version` integer NOT NULL,
	`object_key` text NOT NULL,
	`storage` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`safety_check` text DEFAULT 'pending' NOT NULL,
	`callback_hash` text,
	`lease_id` text,
	`lease_until` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `private_user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`owner_id`,`parent_id`) REFERENCES `private_document`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`master_id`) REFERENCES `private_document`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "private_document_kind_check" CHECK("private_document"."kind" in ('resume_master','resume_source','transcript','certificate','supporting')),
	CONSTRAINT "private_document_state_check" CHECK("private_document"."state" in ('pending','quarantined','available','rejected','expired')),
	CONSTRAINT "private_document_safety_check" CHECK("private_document"."safety_check" in ('pending','passed','rejected','deferred')),
	CONSTRAINT "private_document_storage_check" CHECK("private_document"."storage" in ('local','blob')),
	CONSTRAINT "private_document_size_check" CHECK(typeof("private_document"."size") = 'integer' and "private_document"."size" between 1 and 10485760),
	CONSTRAINT "private_document_version_check" CHECK(typeof("private_document"."version") = 'integer' and "private_document"."version" > 0),
	CONSTRAINT "private_document_attempts_check" CHECK(typeof("private_document"."attempts") = 'integer' and "private_document"."attempts" >= 0),
	CONSTRAINT "private_document_hash_check" CHECK("private_document"."sha256" is null or (length("private_document"."sha256") = 64 and "private_document"."sha256" not glob '*[^a-f0-9]*')),
	CONSTRAINT "private_document_available_check" CHECK("private_document"."state" != 'available' or ("private_document"."sha256" is not null and "private_document"."safety_check" = 'passed')),
	CONSTRAINT "private_document_mime_check" CHECK("private_document"."mime" in ('application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `private_document_object_key_unique` ON `private_document` (`object_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `private_document_owner_id_unique` ON `private_document` (`owner_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `private_document_master_version_unique` ON `private_document` (`master_id`,`version`);--> statement-breakpoint
CREATE INDEX `private_document_owner_state_idx` ON `private_document` (`owner_id`,`state`);--> statement-breakpoint
CREATE TABLE `private_policy_command` (
	`owner_id` text NOT NULL,
	`request_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`revision` integer NOT NULL,
	`acknowledgement` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `request_id`),
	FOREIGN KEY (`owner_id`) REFERENCES `private_user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "private_policy_command_revision_check" CHECK(typeof("private_policy_command"."revision") = 'integer' and "private_policy_command"."revision" > 0),
	CONSTRAINT "private_policy_ack_json_check" CHECK(json_valid("private_policy_command"."acknowledgement"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `private_policy_command_revision_unique` ON `private_policy_command` (`owner_id`,`revision`);--> statement-breakpoint
CREATE TABLE `private_policy_head` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`policy_version` integer NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`accepted_policy_version` integer,
	`accepted_policy_hash` text,
	`accepted_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `private_user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`owner_id`,`policy_version`) REFERENCES `private_policy_version`(`owner_id`,`version`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`accepted_policy_version`) REFERENCES `private_policy_version`(`owner_id`,`version`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "private_policy_head_revision_check" CHECK(typeof("private_policy_head"."revision") = 'integer' and "private_policy_head"."revision" > 0),
	CONSTRAINT "private_policy_enabled_check" CHECK("private_policy_head"."enabled" in (0, 1)),
	CONSTRAINT "private_policy_acceptance_check" CHECK(("private_policy_head"."enabled" = 0 and "private_policy_head"."accepted_policy_version" is null and "private_policy_head"."accepted_policy_hash" is null and "private_policy_head"."accepted_at" is null) or ("private_policy_head"."enabled" = 1 and "private_policy_head"."accepted_policy_version" = "private_policy_head"."policy_version" and "private_policy_head"."accepted_policy_hash" is not null and "private_policy_head"."accepted_at" is not null))
);
--> statement-breakpoint
CREATE TABLE `private_policy_version` (
	`owner_id` text NOT NULL,
	`version` integer NOT NULL,
	`hash` text NOT NULL,
	`policy` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `version`),
	FOREIGN KEY (`owner_id`) REFERENCES `private_user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "private_policy_version_check" CHECK(typeof("private_policy_version"."version") = 'integer' and "private_policy_version"."version" > 0),
	CONSTRAINT "private_policy_json_check" CHECK(json_valid("private_policy_version"."policy") and length(cast("private_policy_version"."policy" as blob)) <= 131072)
);
--> statement-breakpoint
CREATE TABLE `private_profile_head` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `private_user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`owner_id`,`revision`) REFERENCES `private_profile_version`(`owner_id`,`revision`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `private_profile_version` (
	`owner_id` text NOT NULL,
	`revision` integer NOT NULL,
	`request_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`profile` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `revision`),
	FOREIGN KEY (`owner_id`) REFERENCES `private_user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "private_profile_revision_check" CHECK(typeof("private_profile_version"."revision") = 'integer' and "private_profile_version"."revision" > 0),
	CONSTRAINT "private_profile_json_check" CHECK(json_valid("private_profile_version"."profile") and length(cast("private_profile_version"."profile" as blob)) <= 131072)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `private_profile_request_unique` ON `private_profile_version` (`owner_id`,`request_id`);
--> statement-breakpoint
CREATE TRIGGER private_profile_version_immutable_update BEFORE UPDATE ON private_profile_version
BEGIN SELECT RAISE(ABORT, 'Immutable profile version'); END;
--> statement-breakpoint
CREATE TRIGGER private_profile_version_immutable_delete BEFORE DELETE ON private_profile_version
BEGIN SELECT RAISE(ABORT, 'Immutable profile version'); END;
--> statement-breakpoint
CREATE TRIGGER private_policy_version_immutable_update BEFORE UPDATE ON private_policy_version
BEGIN SELECT RAISE(ABORT, 'Immutable policy version'); END;
--> statement-breakpoint
CREATE TRIGGER private_policy_version_immutable_delete BEFORE DELETE ON private_policy_version
BEGIN SELECT RAISE(ABORT, 'Immutable policy version'); END;
--> statement-breakpoint
CREATE TRIGGER private_policy_command_immutable_update BEFORE UPDATE ON private_policy_command
BEGIN SELECT RAISE(ABORT, 'Immutable policy acknowledgement'); END;
--> statement-breakpoint
CREATE TRIGGER private_policy_command_immutable_delete BEFORE DELETE ON private_policy_command
BEGIN SELECT RAISE(ABORT, 'Immutable policy acknowledgement'); END;
--> statement-breakpoint
CREATE TRIGGER private_document_immutable_metadata BEFORE UPDATE ON private_document
WHEN NEW.id IS NOT OLD.id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.kind IS NOT OLD.kind
  OR NEW.name IS NOT OLD.name OR NEW.role IS NOT OLD.role OR NEW.parent_id IS NOT OLD.parent_id
  OR NEW.master_id IS NOT OLD.master_id OR NEW.version IS NOT OLD.version
  OR NEW.object_key IS NOT OLD.object_key OR NEW.storage IS NOT OLD.storage
  OR NEW.mime IS NOT OLD.mime OR NEW.size IS NOT OLD.size OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.sha256 IS NOT NULL AND NEW.sha256 IS NOT OLD.sha256)
  OR (OLD.state = 'available' AND (NEW.state IS NOT OLD.state OR NEW.safety_check IS NOT OLD.safety_check))
BEGIN SELECT RAISE(ABORT, 'Immutable document version'); END;
