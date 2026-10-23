-- A run follows the policy its applicant enables: its policy moves forward to a newer revision, never back.
-- Its owner and worker never change.
DROP TRIGGER private_application_run_assignment_immutable;
--> statement-breakpoint
CREATE TRIGGER private_application_run_assignment_immutable BEFORE UPDATE OF owner_id, worker_id ON private_application_run
BEGIN SELECT RAISE(ABORT, 'Run assignment is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER private_application_run_policy_forward BEFORE UPDATE OF policy_revision, policy_version, policy_hash ON private_application_run
WHEN NEW.policy_revision <= OLD.policy_revision
BEGIN SELECT RAISE(ABORT, 'Run policy moves only forward'); END;
