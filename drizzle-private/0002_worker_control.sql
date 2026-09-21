CREATE TABLE `private_application_event` (
	`owner_id` text NOT NULL,
	`application_id` text NOT NULL,
	`event_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`acknowledgement` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `application_id`, `event_id`),
	FOREIGN KEY (`owner_id`,`application_id`) REFERENCES `private_application`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "private_application_event_json" CHECK(json_valid("private_application_event"."acknowledgement"))
);
--> statement-breakpoint
CREATE TABLE `private_application_run` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`worker_id` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`state` text DEFAULT 'running' NOT NULL,
	`policy_revision` integer NOT NULL,
	`policy_version` integer NOT NULL,
	`policy_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `private_user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`worker_id`) REFERENCES `private_worker`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`policy_version`) REFERENCES `private_policy_version`(`owner_id`,`version`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "private_run_state" CHECK("private_application_run"."state" in ('running','paused','stopped') and "private_application_run"."revision" > 0 and "private_application_run"."policy_revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `private_run_owner_id` ON `private_application_run` (`owner_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `private_run_assignment` ON `private_application_run` (`owner_id`,`id`,`worker_id`);--> statement-breakpoint
CREATE TABLE `private_application` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`run_id` text NOT NULL,
	`worker_id` text NOT NULL,
	`ats` text NOT NULL,
	`tenant` text NOT NULL,
	`requisition` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`fence` integer DEFAULT 0 NOT NULL,
	`lease_until` integer,
	`lease_checked_at` integer,
	`checkpoint` text,
	`reason_code` text,
	`retries` integer DEFAULT 0 NOT NULL,
	`available_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `private_user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`run_id`,`worker_id`) REFERENCES `private_application_run`(`owner_id`,`id`,`worker_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "private_application_state" CHECK(state in ('queued','screening','tailoring','filling','ready','needs_answer','needs_document','needs_policy_decision','needs_login','needs_verification','provider_unavailable','retryable_failure','blocked_unsupported','submitting','submission_unknown','submitted','failed','skipped','cancelled')),
	CONSTRAINT "private_application_counters" CHECK("private_application"."revision" > 0 and "private_application"."fence" >= 0 and "private_application"."retries" between 0 and 3),
	CONSTRAINT "private_application_lease" CHECK(("private_application"."lease_until" is null and "private_application"."lease_checked_at" is null) or ("private_application"."lease_until" is not null and "private_application"."lease_checked_at" is not null and "private_application"."fence" > 0 and "private_application"."lease_until" > "private_application"."lease_checked_at" and "private_application"."state" in ('screening','tailoring','filling','ready','submitting','submission_unknown'))),
	CONSTRAINT "private_application_checkpoint" CHECK("private_application"."checkpoint" is null or (json_valid("private_application"."checkpoint") and length("private_application"."checkpoint") <= 1024))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `private_application_owner_id` ON `private_application` (`owner_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `private_application_identity` ON `private_application` (`owner_id`,`ats`,`tenant`,`requisition`);--> statement-breakpoint
CREATE UNIQUE INDEX `private_application_active_tenant` ON `private_application` (`owner_id`,`ats`,`tenant`) WHERE "private_application"."lease_until" is not null;--> statement-breakpoint
CREATE INDEX `private_application_queue` ON `private_application` (`owner_id`,`worker_id`,`available_at`);--> statement-breakpoint
CREATE TABLE `private_worker_command` (
	`owner_id` text NOT NULL,
	`request_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`acknowledgement` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `request_id`),
	FOREIGN KEY (`owner_id`) REFERENCES `private_user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "private_worker_command_json" CHECK(json_valid("private_worker_command"."acknowledgement"))
);
--> statement-breakpoint
CREATE TABLE `private_worker_pairing` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`grant_hash` text NOT NULL,
	`credential_binding` text NOT NULL,
	`label` text NOT NULL,
	`request_id` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `private_user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "private_pairing_revision" CHECK("private_worker_pairing"."revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `private_worker_pairing_grant_hash_unique` ON `private_worker_pairing` (`grant_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `private_pairing_owner_id` ON `private_worker_pairing` (`owner_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `private_pairing_request` ON `private_worker_pairing` (`owner_id`,`request_id`);--> statement-breakpoint
CREATE TABLE `private_worker` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`pairing_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`credential_binding` text NOT NULL,
	`registration_id` text NOT NULL,
	`registration_hash` text NOT NULL,
	`label` text NOT NULL,
	`protocol_version` integer NOT NULL,
	`worker_version` text NOT NULL,
	`capabilities` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `private_user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`pairing_id`) REFERENCES `private_worker_pairing`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "private_worker_protocol" CHECK("private_worker"."protocol_version" = 1 and json_valid("private_worker"."capabilities") and "private_worker"."capabilities" = '["control-v1"]'),
	CONSTRAINT "private_worker_revision" CHECK("private_worker"."revision" > 0),
	CONSTRAINT "private_worker_hashes" CHECK(length("private_worker"."token_hash") = 64 and length("private_worker"."credential_binding") = 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `private_worker_pairing_id_unique` ON `private_worker` (`pairing_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `private_worker_token_hash_unique` ON `private_worker` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `private_worker_owner_id` ON `private_worker` (`owner_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `private_worker_registration` ON `private_worker` (`owner_id`,`registration_id`);
--> statement-breakpoint
CREATE TRIGGER private_application_event_no_update BEFORE UPDATE ON private_application_event
BEGIN SELECT RAISE(ABORT, 'Application events are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER private_application_event_no_delete BEFORE DELETE ON private_application_event
BEGIN SELECT RAISE(ABORT, 'Application events are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER private_worker_command_no_update BEFORE UPDATE ON private_worker_command
BEGIN SELECT RAISE(ABORT, 'Worker commands are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER private_worker_command_no_delete BEFORE DELETE ON private_worker_command
BEGIN SELECT RAISE(ABORT, 'Worker commands are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER private_application_identity_immutable BEFORE UPDATE OF owner_id, run_id, worker_id, ats, tenant, requisition ON private_application
BEGIN SELECT RAISE(ABORT, 'Application identity and assignment are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER private_application_run_assignment_immutable BEFORE UPDATE OF owner_id, worker_id, policy_revision, policy_version, policy_hash ON private_application_run
BEGIN SELECT RAISE(ABORT, 'Run assignment and policy are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER private_application_no_unsafe_requeue BEFORE UPDATE OF state ON private_application
WHEN (OLD.state = 'submission_unknown' AND NEW.state NOT IN ('submission_unknown','submitted'))
  OR (OLD.state IN ('submitted','failed','skipped','cancelled') AND NEW.state != OLD.state)
BEGIN SELECT RAISE(ABORT, 'Unsafe application transition'); END;
