"""The AI-credit functions the assistant calls: ai_credits_left before an
answer, charge_ai_answer after it (credits by the answer's steps, once per run)."""

import json
import os
import uuid
from typing import Any

import pytest
from core.core.config import settings
from core.crud.crud_billing_terms import DEFAULT_AI_CREDIT_TIERS
from core.db.models.billing_terms import BillingTerms
from core.db.models.user import User
from core.db.session import session_manager
from sqlalchemy import delete, text
from tests.utils import make_organization

S = settings.SCHEMA


@pytest.fixture(autouse=True)
async def no_terms(db_session):
    """No terms pushed: the functions use core's default tiers."""
    await db_session.execute(delete(BillingTerms))
    await db_session.commit()
    yield
    await db_session.execute(delete(BillingTerms))
    await db_session.commit()


async def _org(db_session, **values: Any):
    org = make_organization(**values)
    db_session.add(org)
    await db_session.commit()
    await db_session.refresh(org)
    user = User(
        id=uuid.uuid4(),
        email=f"{uuid.uuid4().hex}@t.local",
        firstname="A",
        lastname="I",
        organization_id=org.id,
    )
    db_session.add(user)
    await db_session.commit()
    return org, user


async def _charge(
    db_session,
    org,
    user,
    steps: int,
    run: uuid.UUID | None = None,
    payload: dict | None = None,
) -> float:
    charged = (
        await db_session.execute(
            text(f"SELECT {S}.charge_ai_answer(:o, :u, :r, :steps, :p)"),
            {
                "o": org.id,
                "u": user.id,
                "r": run or uuid.uuid4(),
                "steps": steps,
                "p": json.dumps(payload or {}),
            },
        )
    ).scalar_one()
    await db_session.commit()
    return float(charged)


async def _pool(db_session, org) -> tuple[float, float]:
    used, compute = (
        await db_session.execute(
            text(
                f"SELECT used_ai_credits, used_credits FROM {S}.organization WHERE id = :o"
            ),
            {"o": org.id},
        )
    ).one()
    return float(used), float(compute)


async def _left(db_session, org_id) -> float | None:
    left = (
        await db_session.execute(text(f"SELECT {S}.ai_credits_left(:o)"), {"o": org_id})
    ).scalar_one()
    return None if left is None else float(left)


def _credits_for(tiers: list[dict], steps: int) -> float:
    """The rule the function implements: the first tier the steps fit in."""
    for tier in tiers:
        if tier["max_steps"] is None or tier["max_steps"] >= steps:
            return tier["credits"]
    raise AssertionError("tiers end without an open tier")


@pytest.mark.asyncio
async def test_an_answer_costs_one_two_or_three_credits_by_its_steps(db_session):
    org, user = await _org(db_session, total_ai_credits=100)
    charged = [await _charge(db_session, org, user, s) for s in (0, 10, 11, 20, 21)]
    assert charged == [1, 1, 2, 2, 3]
    # AI credits only: the compute and traffic credits are a pool of their own.
    assert await _pool(db_session, org) == (9, 0)


@pytest.mark.asyncio
async def test_without_pushed_terms_the_tiers_are_cores_defaults(db_session):
    org, user = await _org(db_session)
    for steps in (0, 1, 9, 10, 11, 19, 20, 21, 500):
        assert await _charge(db_session, org, user, steps) == _credits_for(
            DEFAULT_AI_CREDIT_TIERS, steps
        ), steps


@pytest.mark.asyncio
async def test_pushed_tiers_set_the_price(db_session):
    tiers = [{"max_steps": 5, "credits": 0.5}, {"max_steps": None, "credits": 4}]
    db_session.add(
        BillingTerms(
            id=1,
            trial_days=30,
            trial_credits=1,
            trial_storage_mb=1,
            trial_projects=1,
            trial_editors=1,
            trial_viewers=1,
            ai_credit_tiers=tiers,
        )
    )
    await db_session.commit()
    org, user = await _org(db_session)
    assert [await _charge(db_session, org, user, s) for s in (5, 6)] == [0.5, 4]


@pytest.mark.asyncio
async def test_a_run_is_charged_once(db_session):
    """A retried or twice-ended run (lease takeover, restart) books nothing more."""
    org, user = await _org(db_session)
    run_id = uuid.uuid4()
    assert await _charge(db_session, org, user, 12, run_id) == 2
    assert await _charge(db_session, org, user, 30, run_id) == 0
    assert await _pool(db_session, org) == (2, 0)
    rows = (
        await db_session.execute(
            text(
                f"SELECT count(*) FROM {S}.credit_usage "
                "WHERE category = 'ai' AND payload->>'run_id' = :r"
            ),
            {"r": str(run_id)},
        )
    ).scalar_one()
    assert rows == 1


@pytest.mark.asyncio
async def test_the_ledger_row_records_the_answer(db_session):
    org, user = await _org(db_session)
    run_id = uuid.uuid4()
    await _charge(
        db_session,
        org,
        user,
        14,
        run_id,
        {"model": "m", "conversation_id": "c", "run_id": "not this one"},
    )
    row = (
        (
            await db_session.execute(
                text(
                    "SELECT user_id, category, action, unit, unit_type, rate, cost, "
                    f"payload FROM {S}.credit_usage WHERE organization_id = :o"
                ),
                {"o": org.id},
            )
        )
        .mappings()
        .one()
    )
    assert row["user_id"] == user.id
    assert (row["category"], row["action"], row["unit_type"]) == (
        "ai",
        "assistant_answer",
        "steps",
    )
    assert (float(row["unit"]), float(row["rate"]), float(row["cost"])) == (14, 2, 2)
    assert row["payload"] == {
        "model": "m",
        "conversation_id": "c",
        "run_id": str(run_id),
    }


@pytest.mark.asyncio
async def test_a_charge_is_recorded_even_past_the_allowance(db_session):
    """The function records; refusing the next answer is the gate's job."""
    org, user = await _org(db_session, total_ai_credits=1, used_ai_credits=1)
    assert await _charge(db_session, org, user, 0) == 1
    assert await _pool(db_session, org) == (2, 0)
    assert await _left(db_session, org.id) == 0


@pytest.mark.asyncio
async def test_a_charge_needs_a_run_id(db_session):
    """Without one, a retry could not be told apart from a new answer."""
    org, user = await _org(db_session)
    org_id, user_id = org.id, user.id
    with pytest.raises(Exception, match="run id"):
        await db_session.execute(
            text(f"SELECT {S}.charge_ai_answer(:o, :u, NULL, 3, '{{}}')"),
            {"o": org_id, "u": user_id},
        )
    await db_session.rollback()
    used = (
        await db_session.execute(
            text(f"SELECT used_ai_credits FROM {S}.organization WHERE id = :o"),
            {"o": org_id},
        )
    ).scalar_one()
    assert float(used) == 0


@pytest.mark.asyncio
async def test_credits_left(db_session):
    org, _ = await _org(db_session, total_ai_credits=100, used_ai_credits=30)
    assert await _left(db_session, org.id) == 70
    over, _ = await _org(db_session, total_ai_credits=100, used_ai_credits=120)
    assert await _left(db_session, over.id) == 0


@pytest.mark.asyncio
async def test_unlimited_or_unknown_organizations_have_no_limit(db_session):
    org, _ = await _org(db_session, total_ai_credits=None, used_ai_credits=999)
    assert await _left(db_session, org.id) is None
    assert await _left(db_session, uuid.uuid4()) is None


@pytest.mark.asyncio
async def test_the_functions_run_as_their_owner_on_the_installed_schema(db_session):
    """SECURITY DEFINER with a pinned search_path, so a role that may only read
    the organization can call them; not executable by PUBLIC, so only a role
    granted EXECUTE can; every table is qualified with the schema the install
    mapped `customer.` to."""
    rows = (
        (
            await db_session.execute(
                text(
                    "SELECT p.proname, p.prosecdef, p.proconfig, p.prosrc, "
                    "has_function_privilege('public', p.oid, 'EXECUTE') AS public "
                    "FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
                    "WHERE n.nspname = :s "
                    "AND p.proname IN ('ai_credits_left', 'charge_ai_answer')"
                ),
                {"s": S},
            )
        )
        .mappings()
        .all()
    )
    assert {r["proname"] for r in rows} == {"ai_credits_left", "charge_ai_answer"}
    for r in rows:
        assert r["prosecdef"], r["proname"]
        assert r["proconfig"] == ["search_path=pg_catalog, pg_temp"], r["proname"]
        assert r["public"] is False, r["proname"]
        assert f"{S}.organization" in r["prosrc"], r["proname"]
        if S != "customer":
            assert "customer." not in r["prosrc"], r["proname"]


@pytest.mark.asyncio
async def test_only_a_role_granted_execute_may_call_them(db_session):
    """A role with nothing but USAGE on the schema (like a read-only role) may
    call neither function; granted EXECUTE, it books and reads the pool
    without any right on the tables (the functions run as their owner)."""
    org, user = await _org(db_session, total_ai_credits=10)
    role = f"ai_credit_probe_{os.getpid()}"
    calls = {
        "ai_credits_left": f"SELECT {S}.ai_credits_left(:o)",
        "charge_ai_answer": f"SELECT {S}.charge_ai_answer(:o, :u, :r, 3, '{{}}')",
    }
    params = {"o": org.id, "u": user.id, "r": uuid.uuid4()}
    async with session_manager.connect() as connection:

        async def as_role(sql: str) -> Any:
            await connection.execute(text(f'SET ROLE "{role}"'))
            try:
                return (await connection.execute(text(sql), params)).scalar_one()
            finally:
                await connection.execute(text("RESET ROLE"))

        await connection.execute(text(f'DROP ROLE IF EXISTS "{role}"'))
        await connection.execute(text(f'CREATE ROLE "{role}" NOLOGIN'))
        try:
            await connection.execute(text(f'GRANT USAGE ON SCHEMA "{S}" TO "{role}"'))
            for name, sql in calls.items():
                with pytest.raises(
                    Exception, match=f"permission denied for function {name}"
                ):
                    await as_role(sql)

            for name in calls:
                await connection.execute(
                    text(f'GRANT EXECUTE ON FUNCTION {S}.{name} TO "{role}"')
                )
            assert float(await as_role(calls["charge_ai_answer"])) == 1
            assert float(await as_role(calls["ai_credits_left"])) == 9
        finally:
            await connection.execute(text("RESET ROLE"))
            await connection.execute(text(f'DROP OWNED BY "{role}"'))
            await connection.execute(text(f'DROP ROLE "{role}"'))
