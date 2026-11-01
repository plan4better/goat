-- The organization's project count (`used_projects`), maintained from its
-- projects. It counts what the project listings show plus the projects in
-- the trash, which count until the purge removes them: a project template's
-- hidden copy (`is_template_source`, set when the copy is inserted and never
-- changed) is in no listing and never counts.
--
-- A project is the organization's of its creator; when the creator's account
-- was removed (`user_id` NULL), of the space it lives in: the organization's
-- own space, one of its teams' spaces or a member's personal space. Alembic
-- 0020_project_count recounts the column with the same rule.
CREATE OR REPLACE FUNCTION customer.log_project_count()
RETURNS TRIGGER AS $$
DECLARE
    organization_id_input UUID;
    project_count_difference int := 0;  -- Default project count difference
BEGIN
    IF COALESCE(NEW.is_template_source, OLD.is_template_source) THEN
        RETURN NULL;
    END IF;

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

    -- Handle INSERT: A new project is added
    IF TG_OP = 'INSERT' THEN
        project_count_difference := 1;

    -- Handle DELETE: A project is removed
    ELSIF TG_OP = 'DELETE' THEN
        project_count_difference := -1;
    END IF;

    -- Update the organization's project count
    UPDATE customer.organization o
    SET used_projects = used_projects + project_count_difference
    WHERE o.id = organization_id_input;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Create a trigger for INSERT and DELETE
CREATE OR REPLACE TRIGGER log_project_count_trigger
AFTER INSERT OR DELETE
ON customer.project
FOR EACH ROW
EXECUTE FUNCTION customer.log_project_count();
