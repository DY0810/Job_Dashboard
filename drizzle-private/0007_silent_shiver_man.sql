CREATE TABLE `private_application_artifact` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`application_id` text NOT NULL,
	`request_id` text NOT NULL,
	`source_document_id` text NOT NULL,
	`source_version` integer NOT NULL,
	`source_hash` text NOT NULL,
	`document_id` text NOT NULL,
	`output_hash` text NOT NULL,
	`manifest_hash` text NOT NULL,
	`manifest` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `private_user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`owner_id`,`application_id`) REFERENCES `private_application`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`source_document_id`) REFERENCES `private_document`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`document_id`) REFERENCES `private_document`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "private_artifact_source_version_check" CHECK(typeof("private_application_artifact"."source_version") = 'integer' and "private_application_artifact"."source_version" > 0),
	CONSTRAINT "private_artifact_hash_check" CHECK(length("private_application_artifact"."source_hash") = 64 and "private_application_artifact"."source_hash" not glob '*[^a-f0-9]*' and length("private_application_artifact"."output_hash") = 64 and "private_application_artifact"."output_hash" not glob '*[^a-f0-9]*' and length("private_application_artifact"."manifest_hash") = 64 and "private_application_artifact"."manifest_hash" not glob '*[^a-f0-9]*'),
	CONSTRAINT "private_artifact_manifest_check" CHECK(json_valid("private_application_artifact"."manifest") and length(cast("private_application_artifact"."manifest" as blob)) <= 262144)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `private_artifact_owner_request_unique` ON `private_application_artifact` (`owner_id`,`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `private_artifact_owner_document_unique` ON `private_application_artifact` (`owner_id`,`document_id`);--> statement-breakpoint
CREATE INDEX `private_artifact_owner_application_idx` ON `private_application_artifact` (`owner_id`,`application_id`,`created_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_private_document` (
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
	CONSTRAINT "private_document_kind_check" CHECK("__new_private_document"."kind" in ('resume_master','resume_source','resume_artifact','transcript','certificate','supporting')),
	CONSTRAINT "private_document_state_check" CHECK("__new_private_document"."state" in ('pending','quarantined','available','rejected','expired')),
	CONSTRAINT "private_document_safety_check" CHECK("__new_private_document"."safety_check" in ('pending','passed','rejected','deferred')),
	CONSTRAINT "private_document_storage_check" CHECK("__new_private_document"."storage" in ('local','blob')),
	CONSTRAINT "private_document_size_check" CHECK(typeof("__new_private_document"."size") = 'integer' and "__new_private_document"."size" between 1 and 10485760),
	CONSTRAINT "private_document_version_check" CHECK(typeof("__new_private_document"."version") = 'integer' and "__new_private_document"."version" > 0),
	CONSTRAINT "private_document_attempts_check" CHECK(typeof("__new_private_document"."attempts") = 'integer' and "__new_private_document"."attempts" >= 0),
	CONSTRAINT "private_document_hash_check" CHECK("__new_private_document"."sha256" is null or (length("__new_private_document"."sha256") = 64 and "__new_private_document"."sha256" not glob '*[^a-f0-9]*')),
	CONSTRAINT "private_document_available_check" CHECK("__new_private_document"."state" != 'available' or ("__new_private_document"."sha256" is not null and "__new_private_document"."safety_check" = 'passed')),
	CONSTRAINT "private_document_mime_check" CHECK("__new_private_document"."mime" in ('application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document'))
);
--> statement-breakpoint
INSERT INTO `__new_private_document`("id", "owner_id", "kind", "name", "role", "parent_id", "master_id", "version", "object_key", "storage", "mime", "size", "sha256", "state", "safety_check", "callback_hash", "lease_id", "lease_until", "attempts", "created_at") SELECT "id", "owner_id", "kind", "name", "role", "parent_id", "master_id", "version", "object_key", "storage", "mime", "size", "sha256", "state", "safety_check", "callback_hash", "lease_id", "lease_until", "attempts", "created_at" FROM `private_document`;--> statement-breakpoint
DROP TABLE `private_document`;--> statement-breakpoint
ALTER TABLE `__new_private_document` RENAME TO `private_document`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `private_document_object_key_unique` ON `private_document` (`object_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `private_document_owner_id_unique` ON `private_document` (`owner_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `private_document_master_version_unique` ON `private_document` (`master_id`,`version`);--> statement-breakpoint
CREATE INDEX `private_document_owner_state_idx` ON `private_document` (`owner_id`,`state`);--> statement-breakpoint
CREATE TRIGGER private_document_immutable_metadata BEFORE UPDATE ON private_document
WHEN NEW.id IS NOT OLD.id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.kind IS NOT OLD.kind
  OR NEW.name IS NOT OLD.name OR NEW.role IS NOT OLD.role OR NEW.parent_id IS NOT OLD.parent_id
  OR NEW.master_id IS NOT OLD.master_id OR NEW.version IS NOT OLD.version
  OR NEW.object_key IS NOT OLD.object_key OR NEW.storage IS NOT OLD.storage
  OR NEW.mime IS NOT OLD.mime OR NEW.size IS NOT OLD.size OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.sha256 IS NOT NULL AND NEW.sha256 IS NOT OLD.sha256)
  OR (OLD.state = 'available' AND (NEW.state IS NOT OLD.state OR NEW.safety_check IS NOT OLD.safety_check))
BEGIN SELECT RAISE(ABORT, 'Immutable document version'); END;
--> statement-breakpoint
CREATE TRIGGER private_application_artifact_no_update BEFORE UPDATE ON private_application_artifact
BEGIN SELECT RAISE(ABORT, 'Application artifacts are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER private_application_artifact_no_delete BEFORE DELETE ON private_application_artifact
BEGIN SELECT RAISE(ABORT, 'Application artifacts are immutable'); END;
