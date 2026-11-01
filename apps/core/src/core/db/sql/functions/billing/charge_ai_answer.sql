CREATE OR REPLACE FUNCTION customer.charge_ai_answer(
    p_organization_id uuid,
    p_user_id         uuid,
    p_run_id          uuid,
    p_steps           integer,
    p_payload         jsonb
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_steps   integer := GREATEST(COALESCE(p_steps, 0), 0);
    v_tiers   jsonb;
    v_credits numeric;
    v_id      bigint;
BEGIN
    -- Books one answer of GOAT AI: one credit_usage row (category 'ai') and
    -- its AI credits on the organization's pool. The price comes from the
    -- tiers of the billing terms, core's defaults while none were pushed: the
    -- first tier whose max_steps is null or at least the answer's steps.
    -- Records always and never refuses; refusing the next answer is the
    -- assistant's check with ai_credits_left.
    --
    -- Once per run: a second call with the same run id (a retry, a run ended
    -- twice) books nothing and returns 0.
    --
    -- SECURITY DEFINER so a role that may only read the customer tables can
    -- book; every table is qualified (see ai_credits_left.sql). Not PUBLIC
    -- (the REVOKE below): any role that can reach the schema could otherwise
    -- use up any organization's AI credits.
    IF p_run_id IS NULL THEN
        RAISE EXCEPTION 'charge_ai_answer: a run id is required';
    END IF;

    SELECT t.ai_credit_tiers INTO v_tiers
    FROM customer.billing_terms t
    WHERE t.id = 1;
    v_tiers := COALESCE(
        v_tiers,
        '[{"max_steps": 10, "credits": 1}, {"max_steps": 20, "credits": 2}, {"max_steps": null, "credits": 3}]'::jsonb
    );

    SELECT (e.tier->>'credits')::numeric INTO v_credits
    FROM jsonb_array_elements(v_tiers) WITH ORDINALITY AS e(tier, n)
    WHERE e.tier->>'max_steps' IS NULL
       OR (e.tier->>'max_steps')::numeric >= v_steps
    ORDER BY e.n
    LIMIT 1;
    IF v_credits IS NULL THEN
        RAISE EXCEPTION 'charge_ai_answer: no tier for % steps', v_steps;
    END IF;

    INSERT INTO customer.credit_usage
        (organization_id, user_id, category, action,
         unit, unit_type, rate, cost, payload)
    VALUES
        (p_organization_id, p_user_id, 'ai', 'assistant_answer',
         v_steps, 'steps', v_credits, v_credits,
         COALESCE(p_payload, '{}'::jsonb)
             || jsonb_build_object('run_id', p_run_id::text))
    ON CONFLICT ((payload->>'run_id')) WHERE category = 'ai' DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
        RETURN 0;
    END IF;

    UPDATE customer.organization
    SET used_ai_credits = COALESCE(used_ai_credits, 0) + v_credits
    WHERE id = p_organization_id;

    RETURN v_credits;
END;
$$;

REVOKE ALL ON FUNCTION customer.charge_ai_answer(uuid, uuid, uuid, integer, jsonb)
    FROM PUBLIC;
