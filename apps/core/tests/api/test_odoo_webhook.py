import pytest
from core.core.config import settings
from tests.utils import make_organization


@pytest.mark.asyncio
async def test_odoo_entitlement_applies_and_resets(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "ODOO_WEBHOOK_SECRET", "shh")
    org = make_organization(total_credits=1000, used_credits=900)
    db_session.add(org)
    await db_session.commit()
    await db_session.refresh(org)

    resp = await client.post(
        f"{settings.API_V2_STR}/webhooks/odoo/entitlement",
        headers={"X-Webhook-Secret": "shh"},
        json={
            "organization_id": str(org.id),
            "total_credits": 5000,
            "extras": ["white_label"],
            "plan_renewal_date": "2026-08-01T00:00:00",
            "reset_usage": True,
        },
    )
    assert resp.status_code == 200
    await db_session.refresh(org)
    assert float(org.total_credits) == 5000
    assert float(org.used_credits) == 0
    assert org.extras == ["white_label"]


@pytest.mark.asyncio
async def test_trial_webhook_expired_suspends(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "ODOO_WEBHOOK_SECRET", "shh")
    org = make_organization(on_trial=True)
    db_session.add(org)
    await db_session.commit()
    await db_session.refresh(org)

    resp = await client.post(
        f"{settings.API_V2_STR}/webhooks/trial",
        headers={"X-Webhook-Secret": "shh"},
        json={"organization_id": str(org.id), "stage": "expired"},
    )
    assert resp.status_code == 200
    await db_session.refresh(org)
    assert org.suspended is True
    assert org.on_trial is True  # still a trial, just expired


@pytest.mark.asyncio
async def test_trial_webhook_expiring_does_not_suspend(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "ODOO_WEBHOOK_SECRET", "shh")
    org = make_organization(on_trial=True)
    db_session.add(org)
    await db_session.commit()
    await db_session.refresh(org)

    resp = await client.post(
        f"{settings.API_V2_STR}/webhooks/trial",
        headers={"X-Webhook-Secret": "shh"},
        json={"organization_id": str(org.id), "stage": "expiring"},
    )
    assert resp.status_code == 200
    await db_session.refresh(org)
    assert org.suspended is False


@pytest.mark.asyncio
async def test_trial_webhook_rejects_unknown_stage(client, monkeypatch):
    monkeypatch.setattr(settings, "ODOO_WEBHOOK_SECRET", "shh")
    resp = await client.post(
        f"{settings.API_V2_STR}/webhooks/trial",
        headers={"X-Webhook-Secret": "shh"},
        json={"organization_id": "x", "stage": "nonsense"},
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_odoo_entitlement_bad_secret(client, monkeypatch):
    monkeypatch.setattr(settings, "ODOO_WEBHOOK_SECRET", "shh")
    resp = await client.post(
        f"{settings.API_V2_STR}/webhooks/odoo/entitlement",
        headers={"X-Webhook-Secret": "wrong"},
        json={"organization_id": "x"},
    )
    assert resp.status_code == 401
