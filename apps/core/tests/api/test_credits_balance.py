import pytest
from core.core.config import settings
from core.db.models.credit_rate import CreditRate
from sqlalchemy import delete
from tests.billing import enable_billing
from tests.utils import org_with_default_user


@pytest.fixture(autouse=True)
def billing_on(monkeypatch: pytest.MonkeyPatch) -> None:
    enable_billing(monkeypatch)


@pytest.mark.asyncio
async def test_balance_reports_over_budget(client, db_session):
    await org_with_default_user(db_session, total_credits=100, used_credits=100)

    resp = await client.get(f"{settings.API_V2_STR}/credits/balance")
    assert resp.status_code == 200
    body = resp.json()
    assert body["used_credits"] == 100.0
    assert body["total_credits"] == 100.0
    assert body["over_budget"] is True
    # the prices come along, for the page that explains them
    assert isinstance(body["rates"], list)


@pytest.mark.asyncio
async def test_balance_unlimited_is_never_over_budget(client, db_session):
    await org_with_default_user(db_session, total_credits=None, used_credits=999999)

    resp = await client.get(f"{settings.API_V2_STR}/credits/balance")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total_credits"] is None
    assert body["over_budget"] is False


@pytest.mark.asyncio
async def test_credits_do_not_exist_without_billing(client, monkeypatch):
    # Self-hosted: no Usage page, so no credit routes either.
    monkeypatch.setattr(settings, "BILLING_ENABLED", False)
    for path in ("balance", "usage", "breakdown"):
        resp = await client.get(f"{settings.API_V2_STR}/credits/{path}")
        assert resp.status_code == 404, path


@pytest.mark.asyncio
async def test_balance_reports_the_ai_credit_pool(client, db_session):
    from core.crud.crud_billing_terms import (
        DEFAULT_AI_CREDIT_TIERS,
        DEFAULT_AI_CREDITS_PER_EDITOR,
    )

    await org_with_default_user(
        db_session,
        on_trial=False,
        total_editors=5,
        total_ai_credits=1000,
        used_ai_credits=412,
        total_credits=100,
        used_credits=100,
    )
    body = (await client.get(f"{settings.API_V2_STR}/credits/balance")).json()
    assert (body["used_ai_credits"], body["total_ai_credits"]) == (412.0, 1000.0)
    assert body["ai_credit_tiers"] == DEFAULT_AI_CREDIT_TIERS
    # The allowance follows the seats: the page names the amount per editor.
    assert body["ai_credits_per_editor"] == DEFAULT_AI_CREDITS_PER_EDITOR
    # The AI pool is apart from the credits.
    assert (body["used_credits"], body["over_budget"]) == (100.0, True)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "values",
    [
        {"on_trial": True, "total_ai_credits": 100},
        {"on_trial": False, "total_ai_credits": 5000, "ai_credits_override": True},
    ],
)
async def test_a_trial_or_a_special_deal_has_no_per_editor_amount(
    client, db_session, values
):
    await org_with_default_user(db_session, **values)
    body = (await client.get(f"{settings.API_V2_STR}/credits/balance")).json()
    assert body["total_ai_credits"] == values["total_ai_credits"]
    assert body["ai_credits_per_editor"] is None


@pytest.mark.asyncio
async def test_unlimited_ai_credits_are_null(client, db_session):
    await org_with_default_user(db_session, total_ai_credits=None, used_ai_credits=7)
    body = (await client.get(f"{settings.API_V2_STR}/credits/balance")).json()
    assert (body["used_ai_credits"], body["total_ai_credits"]) == (7.0, None)


@pytest.mark.asyncio
async def test_balance_lists_only_the_rates_core_charges(client, db_session):
    """A rate core no longer charges (written back by a pod of an older
    version) is never shown."""
    await org_with_default_user(db_session)
    db_session.add(
        CreditRate(category="ai", rate=1, unit_basis="1k_tokens", source="default")
    )
    await db_session.commit()
    try:
        body = (await client.get(f"{settings.API_V2_STR}/credits/balance")).json()
        assert "ai" not in {r["category"] for r in body["rates"]}
    finally:
        await db_session.execute(delete(CreditRate).where(CreditRate.category == "ai"))
        await db_session.commit()
