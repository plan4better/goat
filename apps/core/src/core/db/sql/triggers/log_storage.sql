-- Storage accounting for an organization, maintained from its layers.
--
-- SECURITY DEFINER on purpose: the function is owned by the application role,
-- which may write `customer.organization`, while callers that hold only a
-- narrow grant on `customer.layer` may not. The thumbnail task is the case
-- that forced this — it connects as the read-only role, holds a column grant
-- on `layer.thumbnail_url`, and every write it made aborted with
-- "permission denied for table organization" raised by this trigger. Book-
-- keeping a row the caller cannot see is the definer's job, not the caller's.
--
-- The pinned `search_path` deliberately does NOT name the data schema:
-- init_triggers.py rewrites the literal `customer.` in this file to the
-- configured schema and would not reach a bare word here, leaving a stale
-- name behind on any deployment that renames it. Every reference in the body
-- is qualified, so the path does not need it.
CREATE OR REPLACE FUNCTION customer.log_storage_usage()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    organization_id_input UUID;
    size_difference float := 0;  -- Default size difference
BEGIN
    -- An update that leaves `size` alone moves nothing: the difference below
    -- is zero, and writing that zero still costs a lock on the organization
    -- row and an UPDATE privilege the caller may not hold. Renames, restyles,
    -- moves and thumbnail writes all land here.
    --
    -- This guard lives in the body rather than in a WHEN clause on a second
    -- trigger so that the table only ever carries one trigger name. A rollback
    -- to an image whose copy of this file predates the guard would not know to
    -- drop a second trigger, and the two would then count the same delta
    -- twice.
    IF TG_OP = 'UPDATE' AND NEW.size IS NOT DISTINCT FROM OLD.size THEN
        RETURN NEW;
    END IF;

    -- The layer is the organization's of its creator; when the creator's
    -- account was removed (`user_id` NULL), of the space it lives in: the
    -- organization's own space, one of its teams' spaces or a member's
    -- personal space. A catalog layer has neither and counts for nobody.
    -- log_project_count and Alembic 0020_project_count follow the same rule.
    SELECT COALESCE(
        (SELECT u.organization_id
         FROM customer.user u
         WHERE u.id = COALESCE(NEW.user_id, OLD.user_id)),
        (SELECT COALESCE(s.organization_id, t.organization_id, m.organization_id)
         FROM customer.space s
         LEFT JOIN customer.team t ON t.id = s.team_id
         LEFT JOIN customer.user m ON m.id = s.user_id
         WHERE s.id = COALESCE(NEW.space_id, OLD.space_id))
    )
    INTO organization_id_input;

    -- Handle INSERT: Only NEW.SIZE is relevant
    IF TG_OP = 'INSERT' THEN
        size_difference := COALESCE(NEW.size, 0) / 1048576::float;

    -- Handle DELETE: Only OLD.SIZE is relevant
    ELSIF TG_OP = 'DELETE' THEN
        size_difference := -COALESCE(OLD.size, 0) / 1048576::float;

    -- Handle UPDATE: Both OLD.SIZE and NEW.SIZE are relevant
    ELSIF TG_OP = 'UPDATE' THEN
        size_difference := (COALESCE(NEW.size, 0) - COALESCE(OLD.size, 0)) / 1048576::float;
    END IF;

    -- Update the organization's used_storage
    UPDATE customer.organization o
    SET used_storage = used_storage + size_difference
    WHERE o.id = organization_id_input;

    RETURN NEW;
END;
$$;


-- A second trigger briefly carried the size guard; drop it so an install that
-- already saw that shape does not keep counting the same delta twice.
DROP TRIGGER IF EXISTS log_storage_usage_update_trigger ON customer.layer;

-- Drop the existing update trigger
DROP TRIGGER IF EXISTS log_storage_usage_trigger ON customer.layer;

-- Create a single trigger for INSERT, UPDATE, and DELETE
CREATE OR REPLACE TRIGGER log_storage_usage_trigger
AFTER INSERT OR UPDATE OR DELETE
ON customer.layer
FOR EACH ROW
EXECUTE FUNCTION customer.log_storage_usage();
