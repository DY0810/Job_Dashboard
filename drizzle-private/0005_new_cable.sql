CREATE TABLE `private_application_receipt` (
	`intent_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`application_id` text NOT NULL,
	`ats` text NOT NULL,
	`tenant` text NOT NULL,
	`requisition` text NOT NULL,
	`company` text NOT NULL,
	`role` text NOT NULL,
	`receipt_id` text NOT NULL,
	`submitted_at` integer NOT NULL,
	`evidence` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`,`application_id`) REFERENCES `private_application`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`intent_id`) REFERENCES `private_application_submission`(`intent_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "private_receipt_evidence" CHECK(json_valid("private_application_receipt"."evidence") and length(cast("private_application_receipt"."evidence" as blob)) <= 16384)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `private_receipt_owner_application` ON `private_application_receipt` (`owner_id`,`application_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `private_receipt_owner_receipt` ON `private_application_receipt` (`owner_id`,`ats`,`tenant`,`receipt_id`);--> statement-breakpoint
CREATE TABLE `private_application_submission` (
	`intent_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`application_id` text NOT NULL,
	`worker_id` text NOT NULL,
	`ats` text NOT NULL,
	`tenant` text NOT NULL,
	`requisition` text NOT NULL,
	`company` text NOT NULL,
	`role` text NOT NULL,
	`manifest_hash` text NOT NULL,
	`artifact_hashes` text NOT NULL,
	`request_hash` text NOT NULL,
	`state` text DEFAULT 'intent' NOT NULL,
	`created_at` integer NOT NULL,
	`submitted_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `private_user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`owner_id`,`application_id`) REFERENCES `private_application`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`worker_id`) REFERENCES `private_worker`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "private_submission_manifest_hash" CHECK(length("private_application_submission"."manifest_hash") = 64 and "private_application_submission"."manifest_hash" not glob '*[^a-f0-9]*'),
	CONSTRAINT "private_submission_artifacts" CHECK(json_valid("private_application_submission"."artifact_hashes") and length(cast("private_application_submission"."artifact_hashes" as blob)) <= 16384),
	CONSTRAINT "private_submission_state" CHECK("private_application_submission"."state" in ('intent','unknown','submitted') and ("private_application_submission"."state" != 'submitted' or "private_application_submission"."submitted_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `private_submission_owner_application` ON `private_application_submission` (`owner_id`,`application_id`);--> statement-breakpoint
CREATE INDEX `private_submission_worker_state` ON `private_application_submission` (`owner_id`,`worker_id`,`state`);--> statement-breakpoint
CREATE TRIGGER private_submission_identity_immutable BEFORE UPDATE OF owner_id,application_id,worker_id,ats,tenant,requisition,company,role,manifest_hash,artifact_hashes,request_hash,created_at ON private_application_submission
BEGIN SELECT RAISE(ABORT, 'Submission intents are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER private_submission_no_delete BEFORE DELETE ON private_application_submission
BEGIN SELECT RAISE(ABORT, 'Submission intents are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER private_receipt_owner BEFORE INSERT ON private_application_receipt
WHEN NOT EXISTS (SELECT 1 FROM private_application_submission s WHERE s.intent_id = NEW.intent_id AND s.owner_id = NEW.owner_id AND s.application_id = NEW.application_id)
BEGIN SELECT RAISE(ABORT, 'Receipt must belong to its submission intent'); END;
--> statement-breakpoint
CREATE TRIGGER private_receipt_no_update BEFORE UPDATE ON private_application_receipt
BEGIN SELECT RAISE(ABORT, 'Application receipts are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER private_receipt_no_delete BEFORE DELETE ON private_application_receipt
BEGIN SELECT RAISE(ABORT, 'Application receipts are immutable'); END;
