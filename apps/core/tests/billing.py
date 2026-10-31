"""Billing switched on for a test: the switch and the webhook secret. The
trial's terms and the credit rates come from the billing system (or core's
defaults until it pushes them), not from settings."""

import pytest
from core.core.config import settings

WEBHOOK_SECRET = "shh"

# A push of the billing system's terms (POST /webhooks/billing/terms).
TERMS_PUSH = {
    "trial": {
        "days": 14,
        "credits": 500,
        "storage_mb": 1000,
        "projects": 20,
        "editors": 3,
        "viewers": 4,
    },
    "credit_rates": {"compute": 12, "egress": 25, "ai": 2},
}


def enable_billing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "BILLING_ENABLED", True)
    monkeypatch.setattr(settings, "BILLING_WEBHOOK_SECRET", WEBHOOK_SECRET)


def enable_accounts_sync(monkeypatch: pytest.MonkeyPatch) -> None:
    """Billing plus the Odoo connection and the accounts bridge's key."""
    enable_billing(monkeypatch)
    monkeypatch.setattr(settings, "ODOO_URL", "https://odoo.test")
    monkeypatch.setattr(settings, "ODOO_DB", "test")
    monkeypatch.setattr(settings, "ODOO_ACCOUNTS_API_KEY", "key")
