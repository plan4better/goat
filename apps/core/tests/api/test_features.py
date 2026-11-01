import pytest
from core.core.config import settings
from tests.billing import enable_billing

URL = f"{settings.API_V2_STR}/users/me/features"


@pytest.mark.asyncio
async def test_self_hosted_runs_neither(client, monkeypatch):
    for name in (
        "ODOO_URL",
        "ODOO_DB",
        "BILLING_WEBHOOK_SECRET",
        "ODOO_SUPPORT_API_KEY",
    ):
        monkeypatch.setattr(settings, name, None)
    resp = await client.get(URL)
    assert resp.status_code == 200
    assert resp.json() == {"support": False, "billing": False}


@pytest.mark.asyncio
async def test_billing_without_support(client, monkeypatch):
    enable_billing(monkeypatch)
    monkeypatch.setattr(settings, "ODOO_SUPPORT_API_KEY", None)
    resp = await client.get(URL)
    assert resp.json() == {"support": False, "billing": True}


@pytest.mark.asyncio
async def test_support_without_billing(client, monkeypatch):
    monkeypatch.setattr(settings, "ODOO_URL", "https://odoo.test")
    monkeypatch.setattr(settings, "ODOO_DB", "test")
    monkeypatch.setattr(settings, "ODOO_SUPPORT_API_KEY", "key")
    monkeypatch.setattr(settings, "ODOO_SUPPORT_TEAM_ID", 1)
    monkeypatch.setattr(settings, "BILLING_ENABLED", False)
    resp = await client.get(URL)
    assert resp.json() == {"support": True, "billing": False}
