CREATE TABLE `private_inbox_read` (
	`owner_id` text NOT NULL,
	`application_id` text NOT NULL,
	`event_id` text NOT NULL,
	`read_at` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `application_id`, `event_id`),
	FOREIGN KEY (`owner_id`,`application_id`,`event_id`) REFERENCES `private_application_event`(`owner_id`,`application_id`,`event_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `private_question_answer` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`application_id` text NOT NULL,
	`question_id` text NOT NULL,
	`semantic_hash` text NOT NULL,
	`scope_hash` text NOT NULL,
	`meaning_review_id` text,
	`profile_revision` integer NOT NULL,
	`policy_revision` integer NOT NULL,
	`fact_versions` text NOT NULL,
	`reuse` text NOT NULL,
	`value` text NOT NULL,
	`descriptor` text NOT NULL,
	`provenance` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `private_user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`application_id`) REFERENCES `private_application`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`meaning_review_id`) REFERENCES `private_question_review`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "private_answer_json" CHECK(json_valid("private_question_answer"."value") and json_valid("private_question_answer"."descriptor") and json_valid("private_question_answer"."fact_versions") and json_valid("private_question_answer"."provenance")),
	CONSTRAINT "private_answer_reuse_check" CHECK("private_question_answer"."reuse" in ('application','employer','equivalent') and ("private_question_answer"."reuse" = 'application' or "private_question_answer"."meaning_review_id" is not null)),
	CONSTRAINT "private_answer_versions" CHECK("private_question_answer"."profile_revision" >= 0 and "private_question_answer"."policy_revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `private_answer_owner_id` ON `private_question_answer` (`owner_id`,`id`);--> statement-breakpoint
CREATE INDEX `private_answer_reuse` ON `private_question_answer` (`owner_id`,`semantic_hash`,`profile_revision`,`policy_revision`);--> statement-breakpoint
CREATE TABLE `private_question_intervention` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`question_id` text NOT NULL,
	`application_id` text NOT NULL,
	`worker_id` text NOT NULL,
	`application_revision` integer NOT NULL,
	`fence` integer NOT NULL,
	`question_revision` integer NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`,`question_id`) REFERENCES `private_question`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`application_id`) REFERENCES `private_application`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`worker_id`) REFERENCES `private_worker`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "private_intervention_state" CHECK("private_question_intervention"."status" in ('pending','focused','unavailable','observed') and "private_question_intervention"."revision" > 0 and "private_question_intervention"."application_revision" > 0 and "private_question_intervention"."fence" > 0)
);
--> statement-breakpoint
CREATE INDEX `private_intervention_worker` ON `private_question_intervention` (`owner_id`,`worker_id`,`status`);--> statement-breakpoint
CREATE TABLE `private_question_review` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`semantic_hash` text NOT NULL,
	`meaning_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `private_user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "private_review_hash" CHECK(length("private_question_review"."semantic_hash") = 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `private_review_owner_id` ON `private_question_review` (`owner_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `private_review_semantic` ON `private_question_review` (`owner_id`,`semantic_hash`);--> statement-breakpoint
CREATE TABLE `private_question` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`application_id` text NOT NULL,
	`key` text NOT NULL,
	`descriptor` text NOT NULL,
	`company` text NOT NULL,
	`role` text NOT NULL,
	`semantic_hash` text NOT NULL,
	`scope_hash` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`profile_revision` integer NOT NULL,
	`policy_revision` integer NOT NULL,
	`fact_versions` text NOT NULL,
	`answer_id` text,
	`resolved_at` integer,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`,`application_id`) REFERENCES `private_application`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`answer_id`) REFERENCES `private_question_answer`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "private_question_versions" CHECK("private_question"."revision" > 0 and "private_question"."profile_revision" >= 0 and "private_question"."policy_revision" > 0 and "private_question"."active" in (0,1)),
	CONSTRAINT "private_question_json" CHECK(json_valid("private_question"."descriptor") and length(cast("private_question"."descriptor" as blob)) <= 65536 and json_valid("private_question"."fact_versions"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `private_question_owner_id` ON `private_question` (`owner_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `private_question_field` ON `private_question` (`owner_id`,`application_id`,`key`);--> statement-breakpoint
CREATE INDEX `private_question_unresolved` ON `private_question` (`owner_id`,`active`,`resolved_at`);--> statement-breakpoint
CREATE INDEX `private_question_equivalence` ON `private_question` (`owner_id`,`semantic_hash`);
--> statement-breakpoint
CREATE TRIGGER private_question_answer_no_update BEFORE UPDATE ON private_question_answer
BEGIN SELECT RAISE(ABORT, 'Question answer versions are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER private_question_answer_no_delete BEFORE DELETE ON private_question_answer
BEGIN SELECT RAISE(ABORT, 'Question answer versions are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER private_question_review_no_update BEFORE UPDATE ON private_question_review
BEGIN SELECT RAISE(ABORT, 'Question meaning reviews are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER private_question_review_no_delete BEFORE DELETE ON private_question_review
BEGIN SELECT RAISE(ABORT, 'Question meaning reviews are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER private_question_answer_owner BEFORE INSERT ON private_question_answer
WHEN NOT EXISTS (SELECT 1 FROM private_question q WHERE q.id = NEW.question_id
  AND q.owner_id = NEW.owner_id AND q.application_id = NEW.application_id)
BEGIN SELECT RAISE(ABORT, 'Answer must belong to its question and application'); END;
--> statement-breakpoint
CREATE TRIGGER private_question_identity_immutable BEFORE UPDATE OF owner_id, application_id, key ON private_question
BEGIN SELECT RAISE(ABORT, 'Question identity is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER private_question_no_history_update BEFORE UPDATE ON private_question
WHEN EXISTS (SELECT 1 FROM private_application a WHERE a.id = OLD.application_id AND a.owner_id = OLD.owner_id
  AND a.state IN ('submitting','submission_unknown','submitted','failed','skipped','cancelled'))
BEGIN SELECT RAISE(ABORT, 'Historical or ambiguous questions are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER private_question_no_delete BEFORE DELETE ON private_question
BEGIN SELECT RAISE(ABORT, 'Question history is immutable'); END;
