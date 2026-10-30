import pytest
from core.core.config import settings
from core.crud.crud_billing_terms import (
    DEFAULT_CREDIT_RATES,
    DEFAULT_TRIAL,
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
        {"credit_rates": {"compute": 1, "egress": 1}},
        {"credit_rates": {**TERMS_PUSH["credit_rates"], "ai": "1"}},
        {"extra": 1},
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
