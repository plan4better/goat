CREATE OR REPLACE FUNCTION customer.credits_exhausted(p_organization_id uuid)
RETURNS boolean AS $$
    -- Whether an organization has used up its credits for the period: the one
    -- rule behind the balance's over_budget, processes' credit gate (checked
    -- before a tool or workflow starts) and geoapi's download flag (set by
    -- traffic_rollup). NULL total_credits is unlimited; NULL for an unknown
    -- organization.
    SELECT o.total_credits IS NOT NULL
       AND COALESCE(o.used_credits, 0) >= o.total_credits
    FROM customer.organization o
    WHERE o.id = p_organization_id;
$$ LANGUAGE sql STABLE;
