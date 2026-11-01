CREATE OR REPLACE FUNCTION customer.ai_credits_left(p_organization_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
    -- The AI credits an organization has left in its credit period, never
    -- below 0: what the assistant checks before GOAT AI answers. NULL when the
    -- organization has no limit (total_ai_credits NULL, as with billing off)
    -- or is unknown.
    --
    -- SECURITY DEFINER so a role that may not read the organization table can
    -- still ask; for the same reason it is not PUBLIC (the REVOKE below): a
    -- role calls it only with an explicit GRANT EXECUTE. The pinned
    -- search_path does not name the data schema: the install rewrites only
    -- the qualified `customer.` names, so every table here is qualified.
    SELECT CASE
        WHEN o.total_ai_credits IS NULL THEN NULL
        ELSE GREATEST(o.total_ai_credits - COALESCE(o.used_ai_credits, 0), 0)
    END
    FROM customer.organization o
    WHERE o.id = p_organization_id;
$$;

REVOKE ALL ON FUNCTION customer.ai_credits_left(uuid) FROM PUBLIC;
