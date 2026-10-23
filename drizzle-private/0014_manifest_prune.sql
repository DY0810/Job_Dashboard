-- A discovery manifest is retained while a run, target or application points at it; a superseded one nothing refers to may be pruned.
DROP TRIGGER private_manifest_no_delete;
--> statement-breakpoint
CREATE TRIGGER private_manifest_no_delete BEFORE DELETE ON private_discovery_manifest
WHEN EXISTS (SELECT 1 FROM private_application_run r WHERE r.owner_id = OLD.owner_id AND r.current_manifest_id = OLD.id)
  OR EXISTS (SELECT 1 FROM private_discovery_target t WHERE t.owner_id = OLD.owner_id AND t.manifest_id = OLD.id)
  OR EXISTS (SELECT 1 FROM private_application a WHERE a.owner_id = OLD.owner_id AND a.snapshot_manifest_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'Discovery manifests in use are retained'); END;
