PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_private_application_receipt` (
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
	CONSTRAINT "private_receipt_evidence" CHECK(json_valid("__new_private_application_receipt"."evidence") and length(cast("__new_private_application_receipt"."evidence" as blob)) <= 16384)
);
--> statement-breakpoint
INSERT INTO `__new_private_application_receipt`("intent_id", "owner_id", "application_id", "ats", "tenant", "requisition", "company", "role", "receipt_id", "submitted_at", "evidence", "created_at") SELECT "intent_id", "owner_id", "application_id", "ats", "tenant", "requisition", "company", "role", "receipt_id", "submitted_at", "evidence", "created_at" FROM `private_application_receipt`;--> statement-breakpoint
DROP TABLE `private_application_receipt`;--> statement-breakpoint
ALTER TABLE `__new_private_application_receipt` RENAME TO `private_application_receipt`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `private_receipt_owner_application` ON `private_application_receipt` (`owner_id`,`application_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `private_receipt_owner_receipt` ON `private_application_receipt` (`owner_id`,`ats`,`tenant`,`receipt_id`);--> statement-breakpoint
CREATE TRIGGER private_receipt_owner BEFORE INSERT ON private_application_receipt
WHEN NOT EXISTS (SELECT 1 FROM private_application_submission s WHERE s.intent_id = NEW.intent_id AND s.owner_id = NEW.owner_id AND s.application_id = NEW.application_id)
BEGIN SELECT RAISE(ABORT, 'Receipt must belong to its submission intent'); END;
--> statement-breakpoint
CREATE TRIGGER private_receipt_no_update BEFORE UPDATE ON private_application_receipt
BEGIN SELECT RAISE(ABORT, 'Application receipts are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER private_receipt_no_delete BEFORE DELETE ON private_application_receipt
BEGIN SELECT RAISE(ABORT, 'Application receipts are immutable'); END;
