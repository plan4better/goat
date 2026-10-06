-- Records one credit_usage ledger row and adds its cost to the org balance.
-- Org-centric: the caller passes the org; p_user_id may be NULL (egress/system).
-- Records always; does NOT gate (the over-budget gate is pre-submission).
CREATE OR REPLACE FUNCTION customer.charge_credits(
    p_organization_id uuid,
    p_user_id         uuid,     -- nullable: NULL for egress/system charges
    p_action          text,
    p_category        text,     -- 'compute' | 'egress'
    p_unit            numeric,  -- native: seconds (compute) | bytes (egress)
    p_payload         jsonb
) RETURNS bigint AS $$
DECLARE
    v_rate       numeric;
    v_unit_basis text;
    v_unit_type  text;
    v_cost       numeric;
    v_id         bigint;
BEGIN
    SELECT rate, unit_basis INTO v_rate, v_unit_basis
    FROM customer.credit_rate WHERE category = p_category;
    IF v_rate IS NULL THEN
        RAISE EXCEPTION 'charge_credits: no rate for category %', p_category;
    END IF;

    IF v_unit_basis = 'minute' THEN
        v_cost := (p_unit / 60.0) * v_rate;
        v_unit_type := 'seconds';
    ELSIF v_unit_basis = 'GB' THEN
        v_cost := (p_unit / 1000000000.0) * v_rate;  -- bytes -> GB (decimal)
        v_unit_type := 'bytes';
    ELSE
        RAISE EXCEPTION 'charge_credits: unknown unit_basis %', v_unit_basis;
    END IF;

    INSERT INTO customer.credit_usage
        (created_at, organization_id, user_id, category, action,
         unit, unit_type, rate, cost, payload)
    VALUES
        (CURRENT_TIMESTAMP, p_organization_id, p_user_id, p_category, p_action,
         p_unit, v_unit_type, v_rate, v_cost, COALESCE(p_payload, '{}'::jsonb))
    RETURNING id INTO v_id;

    UPDATE customer.organization
    SET used_credits = COALESCE(used_credits, 0) + v_cost
    WHERE id = p_organization_id;

    RETURN v_id;
END;
$$ LANGUAGE plpgsql;
