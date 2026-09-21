CREATE TABLE `private_discovery_manifest` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`run_id` text NOT NULL,
	`policy_revision` integer NOT NULL,
	`artifact` text NOT NULL,
	`hash` text NOT NULL,
	`captured_at` integer NOT NULL,
	`candidate_count` integer NOT NULL,
	`staged_count` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`state` text DEFAULT 'staging' NOT NULL,
	FOREIGN KEY (`owner_id`,`run_id`) REFERENCES `private_application_run`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "private_manifest_artifact" CHECK(json_valid("private_discovery_manifest"."artifact") and length(cast("private_discovery_manifest"."artifact" as blob)) <= 16777216 and length("private_discovery_manifest"."hash") = 64),
	CONSTRAINT "private_manifest_progress" CHECK("private_discovery_manifest"."candidate_count" between 0 and 10000 and "private_discovery_manifest"."staged_count" between 0 and "private_discovery_manifest"."candidate_count" and "private_discovery_manifest"."revision" > 0 and "private_discovery_manifest"."state" in ('staging','ready','abandoned') and ("private_discovery_manifest"."state" != 'ready' or "private_discovery_manifest"."staged_count" = "private_discovery_manifest"."candidate_count"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `private_manifest_owner_id` ON `private_discovery_manifest` (`owner_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `private_manifest_owner_run_id` ON `private_discovery_manifest` (`owner_id`,`run_id`,`id`);--> statement-breakpoint
CREATE TABLE `private_discovery_target` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`run_id` text NOT NULL,
	`manifest_id` text NOT NULL,
	`target_key` text NOT NULL,
	`candidate_index` integer NOT NULL,
	`candidate_hash` text NOT NULL,
	`ats` text,
	`tenant` text,
	`requisition` text,
	`employer_key` text,
	`disposition` text NOT NULL,
	`application_id` text,
	FOREIGN KEY (`owner_id`,`run_id`,`manifest_id`) REFERENCES `private_discovery_manifest`(`owner_id`,`run_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`application_id`) REFERENCES `private_application`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "private_target_disposition" CHECK(disposition in ('eligible','duplicate','unresolved','held_policy','held_cap','manual_reported')),
	CONSTRAINT "private_target_identity" CHECK(("private_discovery_target"."ats" is null and "private_discovery_target"."tenant" is null and "private_discovery_target"."requisition" is null) or ("private_discovery_target"."ats" is not null and "private_discovery_target"."tenant" is not null and "private_discovery_target"."requisition" is not null)),
	CONSTRAINT "private_target_snapshot" CHECK("private_discovery_target"."candidate_index" >= 0 and length("private_discovery_target"."candidate_hash") = 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `private_target_run_key` ON `private_discovery_target` (`owner_id`,`run_id`,`target_key`);--> statement-breakpoint
CREATE INDEX `private_target_manifest` ON `private_discovery_target` (`owner_id`,`manifest_id`);--> statement-breakpoint
CREATE TABLE `private_legacy_import_preview` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`request_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`preview` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `private_user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "private_import_preview_json" CHECK(json_valid("private_legacy_import_preview"."preview") and length(cast("private_legacy_import_preview"."preview" as blob)) <= 4194304)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `private_import_preview_owner_id` ON `private_legacy_import_preview` (`owner_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `private_import_preview_request` ON `private_legacy_import_preview` (`owner_id`,`request_id`);--> statement-breakpoint
CREATE TABLE `private_manual_application_mark` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`preview_id` text NOT NULL,
	`posting_id` integer NOT NULL,
	`evidence` text NOT NULL,
	`ats` text,
	`tenant` text,
	`requisition` text,
	`status` text DEFAULT 'manual_reported' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`,`preview_id`) REFERENCES `private_legacy_import_preview`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "private_manual_evidence" CHECK(json_valid("private_manual_application_mark"."evidence") and "private_manual_application_mark"."status" = 'manual_reported'),
	CONSTRAINT "private_manual_identity_check" CHECK(("private_manual_application_mark"."ats" is null and "private_manual_application_mark"."tenant" is null and "private_manual_application_mark"."requisition" is null) or ("private_manual_application_mark"."ats" is not null and "private_manual_application_mark"."tenant" is not null and "private_manual_application_mark"."requisition" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `private_manual_preview_posting` ON `private_manual_application_mark` (`owner_id`,`preview_id`,`posting_id`);--> statement-breakpoint
CREATE INDEX `private_manual_identity` ON `private_manual_application_mark` (`owner_id`,`ats`,`tenant`,`requisition`);--> statement-breakpoint
-- Additive upgrade preserves Phase 3 foreign keys, records and immutable-state triggers.
ALTER TABLE private_application ADD COLUMN attempt integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE private_application ADD COLUMN previous_application_id text;--> statement-breakpoint
ALTER TABLE private_application ADD COLUMN snapshot_manifest_id text;--> statement-breakpoint
ALTER TABLE private_application ADD COLUMN snapshot_target_key text;--> statement-breakpoint
ALTER TABLE private_application ADD COLUMN snapshot_hash text;--> statement-breakpoint
ALTER TABLE private_application ADD COLUMN employer_key text;--> statement-breakpoint
ALTER TABLE private_application ADD COLUMN started_at integer
  CONSTRAINT private_application_attempt CHECK(typeof(attempt) = 'integer' AND attempt > 0 AND
    ((attempt = 1 AND previous_application_id IS NULL) OR (attempt > 1 AND previous_application_id IS NOT NULL)))
  CONSTRAINT private_application_snapshot CHECK(
    (snapshot_manifest_id IS NULL AND snapshot_target_key IS NULL AND snapshot_hash IS NULL) OR
    (snapshot_manifest_id IS NOT NULL AND snapshot_target_key IS NOT NULL AND snapshot_hash IS NOT NULL AND length(snapshot_hash) = 64));
--> statement-breakpoint
DROP INDEX private_application_identity;--> statement-breakpoint
CREATE UNIQUE INDEX `private_application_identity` ON `private_application` (`owner_id`,`ats`,`tenant`,`requisition`,`attempt`);--> statement-breakpoint
CREATE UNIQUE INDEX `private_application_one_successor` ON `private_application` (`owner_id`,`previous_application_id`);--> statement-breakpoint
ALTER TABLE private_application_run ADD COLUMN discovery_state text DEFAULT 'idle' NOT NULL
  CONSTRAINT private_run_discovery_state CHECK(discovery_state IN ('idle','capturing','staging','ready','failed','abandoned'));--> statement-breakpoint
ALTER TABLE private_application_run ADD COLUMN capture_token text;--> statement-breakpoint
ALTER TABLE private_application_run ADD COLUMN capture_until integer;--> statement-breakpoint
ALTER TABLE private_application_run ADD COLUMN current_manifest_id text;--> statement-breakpoint
ALTER TABLE private_application_run ADD COLUMN last_attempt_at integer;--> statement-breakpoint
ALTER TABLE private_application_run ADD COLUMN last_scan_at integer;--> statement-breakpoint
ALTER TABLE private_application_run ADD COLUMN discovery_error text;
--> statement-breakpoint
CREATE TRIGGER private_manifest_content_immutable BEFORE UPDATE OF id,owner_id,run_id,policy_revision,artifact,hash,captured_at,candidate_count ON private_discovery_manifest
BEGIN SELECT RAISE(ABORT, 'Discovery manifests are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER private_manifest_no_delete BEFORE DELETE ON private_discovery_manifest
BEGIN SELECT RAISE(ABORT, 'Discovery manifests are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER private_manifest_progress_guard BEFORE UPDATE OF state,staged_count,revision ON private_discovery_manifest
WHEN OLD.state != 'staging' OR NEW.staged_count < OLD.staged_count OR NEW.revision < OLD.revision
BEGIN SELECT RAISE(ABORT, 'Discovery progress cannot rewind'); END;
--> statement-breakpoint
CREATE TRIGGER private_target_key_immutable BEFORE UPDATE OF id,owner_id,run_id,target_key ON private_discovery_target
BEGIN SELECT RAISE(ABORT, 'Discovery target keys are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER private_target_used_snapshot_immutable BEFORE UPDATE OF manifest_id,candidate_index,candidate_hash,ats,tenant,requisition,employer_key ON private_discovery_target
WHEN OLD.application_id IS NOT NULL OR OLD.disposition = 'manual_reported'
BEGIN SELECT RAISE(ABORT, 'Used discovery evidence is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER private_target_no_delete BEFORE DELETE ON private_discovery_target
BEGIN SELECT RAISE(ABORT, 'Discovery targets are retained'); END;
--> statement-breakpoint
CREATE TRIGGER private_import_preview_no_update BEFORE UPDATE ON private_legacy_import_preview
BEGIN SELECT RAISE(ABORT, 'Import previews are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER private_import_preview_no_delete BEFORE DELETE ON private_legacy_import_preview
BEGIN SELECT RAISE(ABORT, 'Import previews are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER private_manual_mark_no_update BEFORE UPDATE ON private_manual_application_mark
BEGIN SELECT RAISE(ABORT, 'Manual reports are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER private_manual_mark_no_delete BEFORE DELETE ON private_manual_application_mark
BEGIN SELECT RAISE(ABORT, 'Manual reports are retained'); END;
--> statement-breakpoint
CREATE TRIGGER private_application_attempt_immutable BEFORE UPDATE OF attempt,previous_application_id,snapshot_manifest_id,snapshot_target_key,snapshot_hash,employer_key,created_at ON private_application
BEGIN SELECT RAISE(ABORT, 'Application attempts and source evidence are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER private_application_started_immutable BEFORE UPDATE OF started_at ON private_application
WHEN OLD.started_at IS NOT NULL AND NEW.started_at IS NOT OLD.started_at
BEGIN SELECT RAISE(ABORT, 'Application start time is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER private_application_successor_guard BEFORE INSERT ON private_application
WHEN NEW.attempt > 1 AND (NEW.snapshot_manifest_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM private_application p WHERE p.id = NEW.previous_application_id AND p.owner_id = NEW.owner_id
    AND p.ats = NEW.ats AND p.tenant = NEW.tenant AND p.requisition = NEW.requisition
    AND p.attempt + 1 = NEW.attempt AND p.state IN ('submitted','failed','skipped','cancelled') AND p.lease_until IS NULL))
BEGIN SELECT RAISE(ABORT, 'Invalid application successor'); END;
--> statement-breakpoint
CREATE TRIGGER private_application_snapshot_guard BEFORE INSERT ON private_application
WHEN NEW.snapshot_manifest_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM private_discovery_target t JOIN private_discovery_manifest m ON m.id = t.manifest_id AND m.owner_id = t.owner_id
  WHERE t.owner_id = NEW.owner_id AND t.run_id = NEW.run_id AND t.manifest_id = NEW.snapshot_manifest_id
    AND t.target_key = NEW.snapshot_target_key AND t.candidate_hash = NEW.snapshot_hash
    AND t.ats = NEW.ats AND t.tenant = NEW.tenant AND t.requisition = NEW.requisition
    AND t.disposition IN ('eligible','held_cap','duplicate') AND m.state IN ('staging','ready'))
BEGIN SELECT RAISE(ABORT, 'Invalid application snapshot'); END;
--> statement-breakpoint
CREATE TRIGGER private_application_no_delete BEFORE DELETE ON private_application
BEGIN SELECT RAISE(ABORT, 'Application history is retained'); END;
