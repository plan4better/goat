import pytest
from core.core.config import Settings, settings


def test_credit_operational_settings():
    assert settings.MAX_TOOL_RUNTIME_SECONDS == 1800
    # None == unlimited for self-hosted
    assert settings.DEFAULT_QUOTA_CREDITS is None


@pytest.fixture(autouse=True)
def clean_environment(monkeypatch):
    """What a developer's shell exports must not decide these tests."""
    for name in (
        "BILLING_ENABLED",
        "BILLING_WEBHOOK_SECRET",
        "ODOO_URL",
        "ODOO_DB",
        "ODOO_ACCOUNTS_API_KEY",
        "ODOO_SUPPORT_API_KEY",
        "ODOO_SUPPORT_TEAM_ID",
    ):
        monkeypatch.delenv(name, raising=False)


def _settings(**values) -> Settings:
    return Settings(_env_file=None, AUTH=False, **values)  # type: ignore[call-arg]


def test_billing_off_needs_nothing():
    assert _settings().BILLING_ENABLED is False
    assert _settings(BILLING_ENABLED=False).billing_enabled is False


def test_billing_on_needs_the_webhook_secret():
    with pytest.raises(ValueError, match="BILLING_WEBHOOK_SECRET"):
        _settings(BILLING_ENABLED=True)
    with pytest.raises(ValueError, match="BILLING_WEBHOOK_SECRET"):
        _settings(BILLING_ENABLED=True, BILLING_WEBHOOK_SECRET="")


def test_billing_on_with_the_secret_is_enabled():
    on = _settings(BILLING_ENABLED=True, BILLING_WEBHOOK_SECRET="s")
    assert on.billing_enabled is True


def test_the_trial_and_rates_are_no_settings():
    # The billing system owns them (POST /webhooks/billing/terms).
    names = set(Settings.model_fields)
    assert not {n for n in names if n.startswith(("TRIAL_", "CREDIT_RATE_"))}


def test_an_empty_billing_switch_is_off(monkeypatch):
    monkeypatch.setenv("BILLING_ENABLED", "")
    assert _settings().billing_enabled is False


def test_billing_does_not_depend_on_odoo():
    on = _settings(BILLING_ENABLED=True, BILLING_WEBHOOK_SECRET="s")
    assert on.ODOO_URL is None and on.billing_enabled
    assert on.accounts_sync_enabled is False


def test_support_alone_leaves_billing_off():
    support = _settings(
        ODOO_URL="https://odoo.test",
        ODOO_DB="db",
        ODOO_SUPPORT_API_KEY="k",
        ODOO_SUPPORT_TEAM_ID=1,
    )
    assert support.support_enabled is True
    assert support.billing_enabled is False
    assert support.accounts_sync_enabled is False


def test_accounts_sync_needs_the_odoo_connection_and_its_key():
    base = {"BILLING_ENABLED": True, "BILLING_WEBHOOK_SECRET": "s"}
    assert _settings(**base).accounts_sync_enabled is False
    partial = _settings(**base, ODOO_URL="https://odoo.test", ODOO_DB="db")
    assert partial.accounts_sync_enabled is False
    full = _settings(
        **base,
        ODOO_URL="https://odoo.test",
        ODOO_DB="db",
        ODOO_ACCOUNTS_API_KEY="k",
    )
    assert full.accounts_sync_enabled is True
