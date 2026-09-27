-- An unknown submission may close as failed only when the applicant confirmed the employer never received it.
DROP TRIGGER private_application_no_unsafe_requeue;
--> statement-breakpoint
CREATE TRIGGER private_application_no_unsafe_requeue BEFORE UPDATE OF state ON private_application
WHEN (OLD.state = 'submission_unknown' AND NEW.state NOT IN ('submission_unknown','submitted')
    AND NOT (NEW.state = 'failed' AND NEW.reason_code IS 'applicant_confirmed_not_submitted'))
  OR (OLD.state IN ('submitted','failed','skipped','cancelled') AND NEW.state != OLD.state)
BEGIN SELECT RAISE(ABORT, 'Unsafe application transition'); END;
