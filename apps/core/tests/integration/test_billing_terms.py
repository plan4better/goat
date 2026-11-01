import pytest
from core.core.config import settings
from core.crud.crud_billing_terms import (
    DEFAULT_AI_CREDIT_TIERS,
    DEFAULT_AI_CREDITS_PER_EDITOR,
    DEFAULT_CREDIT_RATES,
    DEFAULT_TRIAL,
    ai_terms,
    seed_default_credit_rates,
)
from core.crud.crud_organization import trial_quotas
from core.db.models.billing_terms import BillingTerms
from core.db.models.credit_rate import CreditRate
from sqlalchemy import delete, select
from tests.billing import TERMS_PUSH, WEBHOOK_SECRET, enable_billing

URL = f"{settings.API_V2_STR}/webhooks/billing/terms"


async def _rates(db_session) -> dict[str, CreditRate]:
    db_session.expire_all()
    rows = (await db_session.execute(select(CreditRate))).scalars().all()
    return {row.category: row for row in rows}


@pytest.fixture(autouse=True)
async def empty_tables(db_session):
    # The test database is shared by the session: start and leave them empty.
    for model in (CreditRate, BillingTerms):
        await db_session.execute(delete(model))
    await db_session.commit()
    yield
    for model in (CreditRate, BillingTerms):
        await db_session.execute(delete(model))
    await db_session.commit()


async def _push(client, body):
    return await client.post(
        URL, headers={"X-Webhook-Secret": WEBHOOK_SECRET}, json=body
    )


@pytest.mark.asyncio
async def test_billing_off_seeds_nothing(db_session):
    await seed_default_credit_rates(db_session)
    assert await _rates(db_session) == {}


@pytest.mark.asyncio
async def test_until_the_first_push_core_uses_its_defaults(db_session, monkeypatch):
    enable_billing(monkeypatch)
    await seed_default_credit_rates(db_session)
    rates = await _rates(db_session)
    assert {k: float(r.rate) for k, r in rates.items()} == DEFAULT_CREDIT_RATES
    assert {r.source for r in rates.values()} == {"default"}
    quotas, days = await trial_quotas(db_session)
    assert days == DEFAULT_TRIAL["days"]
    assert quotas["credits"] == DEFAULT_TRIAL["credits"]
    assert quotas["editors"] == DEFAULT_TRIAL["editors"]
    assert quotas["ai_credits"] == DEFAULT_TRIAL["ai_credits"]
    assert await ai_terms(db_session) == {
        "per_editor": DEFAULT_AI_CREDITS_PER_EDITOR,
        "tiers": DEFAULT_AI_CREDIT_TIERS,
    }


@pytest.mark.asyncio
async def test_pushed_terms_replace_the_defaults_and_survive_a_restart(
    client, db_session, monkeypatch
):
    enable_billing(monkeypatch)
    await seed_default_credit_rates(db_session)
    resp = await _push(client, TERMS_PUSH)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"status": "ok"}

    trial = TERMS_PUSH["trial"]
    quotas, days = await trial_quotas(db_session)
    assert days == trial["days"]
    assert quotas == {
        "credits": trial["credits"],
        "storage": trial["storage_mb"],
        "projects": trial["projects"],
        "editors": trial["editors"],
        "viewers": trial["viewers"],
        # Not in this push: core's default.
        "ai_credits": DEFAULT_TRIAL["ai_credits"],
    }
    rates = await _rates(db_session)
    assert {k: float(r.rate) for k, r in rates.items()} == TERMS_PUSH["credit_rates"]
    assert {r.source for r in rates.values()} == {"billing"}
    assert rates["egress"].unit_basis == "GB"

    # A restart writes defaults only where nothing is: the pushed rates stay.
    await seed_default_credit_rates(db_session)
    rates = await _rates(db_session)
    assert {k: float(r.rate) for k, r in rates.items()} == TERMS_PUSH["credit_rates"]


@pytest.mark.asyncio
async def test_an_older_push_is_ignored(client, db_session, monkeypatch):
    enable_billing(monkeypatch)
    newer = {**TERMS_PUSH, "as_of": "2026-10-26T12:00:00+00:00"}
    older = {
        **TERMS_PUSH,
        "trial": {**TERMS_PUSH["trial"], "days": 99},
        "as_of": "2026-10-26T11:00:00+00:00",
    }
    assert (await _push(client, newer)).json() == {"status": "ok"}
    assert (await _push(client, older)).json() == {"status": "stale"}
    _quotas, days = await trial_quotas(db_session)
    assert days == TERMS_PUSH["trial"]["days"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change",
    [
        {"trial": {**TERMS_PUSH["trial"], "days": 0}},
        {"trial": {**TERMS_PUSH["trial"], "editors": 2.5}},
        {"trial": {**TERMS_PUSH["trial"], "credits": -1}},
        {"trial": {**TERMS_PUSH["trial"], "days": 3000000}},
        {"trial": {**TERMS_PUSH["trial"], "projects": 2**31}},
        {"credit_rates": {"compute": 1}},
        # AI answers are priced by the tiers, not by a rate per token.
        {"credit_rates": {**TERMS_PUSH["credit_rates"], "ai": 1}},
        {"extra": 1},
        {"trial": {**TERMS_PUSH["trial"], "ai_credits": -1}},
        {"trial": {**TERMS_PUSH["trial"], "ai_credits": None}},
        {"ai_credits_per_editor": -5},
        {"ai_credits_per_editor": "200"},
        {"ai_credits_per_editor": None},
        {"ai_credit_tiers": []},
        {"ai_credit_tiers": None},
        {"ai_credit_tiers": [{"max_steps": 10, "credits": 1}]},  # no open tier
        {
            "ai_credit_tiers": [
                {"max_steps": None, "credits": 3},
                {"max_steps": 10, "credits": 1},
            ]
        },
        {
            "ai_credit_tiers": [
                {"max_steps": 20, "credits": 2},
                {"max_steps": 10, "credits": 1},
                {"max_steps": None, "credits": 3},
            ]
        },
        {
            "ai_credit_tiers": [
                {"max_steps": 10, "credits": 1},
                {"max_steps": 10, "credits": 2},
                {"max_steps": None, "credits": 3},
            ]
        },
        {
            "ai_credit_tiers": [
                {"max_steps": 2.5, "credits": 1},
                {"max_steps": None, "credits": 2},
            ]
        },
        {"ai_credit_tiers": [{"max_steps": None, "credits": -1}]},
        {"ai_credit_tiers": [{"max_steps": None, "credits": "1"}]},
        {"ai_credit_tiers": [{"max_steps": None}]},
        {"ai_credit_tiers": [{"max_steps": None, "credits": 1, "label": "x"}]},
    ],
)
async def test_invalid_terms_are_refused(client, db_session, monkeypatch, change):
    enable_billing(monkeypatch)
    resp = await _push(client, {**TERMS_PUSH, **change})
    assert resp.status_code == 422
    assert await db_session.get(BillingTerms, 1) is None


@pytest.mark.asyncio
async def test_terms_need_the_secret_and_billing(client, db_session, monkeypatch):
    enable_billing(monkeypatch)
    resp = await client.post(
        URL, headers={"X-Webhook-Secret": "wrong"}, json=TERMS_PUSH
    )
    assert resp.status_code == 401
    monkeypatch.setattr(settings, "BILLING_ENABLED", False)
    assert (await _push(client, TERMS_PUSH)).status_code == 404


@pytest.mark.asyncio
async def test_a_push_without_a_time_keeps_the_stale_check(
    client, db_session, monkeypatch
):
    enable_billing(monkeypatch)
    newer = {**TERMS_PUSH, "as_of": "2026-10-26T12:00:00+00:00"}
    assert (await _push(client, newer)).json() == {"status": "ok"}
    assert (await _push(client, TERMS_PUSH)).json() == {"status": "ok"}
    older = {**TERMS_PUSH, "as_of": "2026-10-26T11:00:00+00:00"}
    assert (await _push(client, older)).json() == {"status": "stale"}


AI_TERMS = {
    "ai_credits_per_editor": 150,
    "ai_credit_tiers": [
        {"max_steps": 5, "credits": 1},
        {"max_steps": 15, "credits": 2.5},
        {"max_steps": None, "credits": 4},
    ],
}


@pytest.mark.asyncio
async def test_pushed_ai_terms_are_kept_until_a_push_changes_them(
    client, db_session, monkeypatch
):
    enable_billing(monkeypatch)
    push = {
        **TERMS_PUSH,
        "trial": {**TERMS_PUSH["trial"], "ai_credits": 40},
        **AI_TERMS,
    }
    assert (await _push(client, push)).json() == {"status": "ok"}
    quotas, _days = await trial_quotas(db_session)
    assert quotas["ai_credits"] == 40
    assert await ai_terms(db_session) == {
        "per_editor": 150,
        "tiers": AI_TERMS["ai_credit_tiers"],
    }

    # A push without the AI terms changes the rest and keeps them.
    later = {**TERMS_PUSH, "trial": {**TERMS_PUSH["trial"], "days": 21}}
    assert (await _push(client, later)).json() == {"status": "ok"}
    db_session.expire_all()
    quotas, days = await trial_quotas(db_session)
    assert (days, quotas["ai_credits"]) == (21, 40)
    assert (await ai_terms(db_session))["per_editor"] == 150

    # One AI term at a time.
    one = {**TERMS_PUSH, "ai_credits_per_editor": 300}
    assert (await _push(client, one)).json() == {"status": "ok"}
    db_session.expire_all()
    assert await ai_terms(db_session) == {
        "per_editor": 300,
        "tiers": AI_TERMS["ai_credit_tiers"],
    }


@pytest.mark.asyncio
async def test_a_first_push_without_ai_terms_stores_cores_defaults(
    client, db_session, monkeypatch
):
    enable_billing(monkeypatch)
    assert (await _push(client, TERMS_PUSH)).json() == {"status": "ok"}
    row = await db_session.get(BillingTerms, 1)
    assert row is not None
    assert float(row.trial_ai_credits) == DEFAULT_TRIAL["ai_credits"]
    assert float(row.ai_credits_per_editor) == DEFAULT_AI_CREDITS_PER_EDITOR
    assert row.ai_credit_tiers == DEFAULT_AI_CREDIT_TIERS


@pytest.mark.asyncio
async def test_the_token_rate_is_gone(db_session, monkeypatch):
    enable_billing(monkeypatch)
    await seed_default_credit_rates(db_session)
    assert set(await _rates(db_session)) == {"compute", "egress"}


@pytest.mark.asyncio
async def test_a_new_amount_per_editor_reaches_the_seat_allowances_at_once(
    client, db_session, monkeypatch
):
    """Subscriptions whose AI credits follow their seats get the new amount
    with the terms; special deals, trials and unlimited seats keep theirs."""
    from tests.utils import make_organization

    enable_billing(monkeypatch)
    orgs = {
        # Off the seats on purpose: only a recompute changes it.
        "seats": make_organization(
            on_trial=False, total_editors=5, total_ai_credits=999
        ),
        "deal": make_organization(
            on_trial=False,
            total_editors=5,
            total_ai_credits=7000,
            ai_credits_override=True,
        ),
        "trial": make_organization(
            on_trial=True, total_editors=5, total_ai_credits=100
        ),
        "unlimited": make_organization(
            on_trial=False, total_editors=None, total_ai_credits=None
        ),
    }
    db_session.add_all(orgs.values())
    await db_session.commit()

    async def allowances() -> dict:
        db_session.expire_all()
        out = {}
        for name, org in orgs.items():
            await db_session.refresh(org)
            out[name] = org.total_ai_credits and float(org.total_ai_credits)
        return out

    # The first push with core's default amount changes no allowance.
    assert (
        await _push(client, {**TERMS_PUSH, "ai_credits_per_editor": 200})
    ).json() == {"status": "ok"}
    assert (await allowances())["seats"] == 999

    assert (
        await _push(client, {**TERMS_PUSH, "ai_credits_per_editor": 250})
    ).json() == {"status": "ok"}
    assert await allowances() == {
        "seats": 1250,
        "deal": 7000,
        "trial": 100,
        "unlimited": None,
    }

    # A push that leaves the amount out (or repeats it) recomputes nothing.
    orgs["seats"].total_ai_credits = 999
    await db_session.commit()
    assert (await _push(client, TERMS_PUSH)).json() == {"status": "ok"}
    assert (await allowances())["seats"] == 999


@pytest.mark.asyncio
async def test_a_rate_of_an_unknown_category_is_removed_at_startup(
    db_session, monkeypatch
):
    """A rate core no longer charges (a pod of an older version wrote it back)
    goes with the next startup."""
    enable_billing(monkeypatch)
    db_session.add(
        CreditRate(category="ai", rate=1, unit_basis="1k_tokens", source="default")
    )
    await db_session.commit()
    await seed_default_credit_rates(db_session)
    assert set(await _rates(db_session)) == {"compute", "egress"}
