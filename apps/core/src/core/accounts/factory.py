"""The accounts provider this deployment is configured for, or None."""

from core import odoo
from core.accounts.odoo_provider import (
    ACTION_NAME,
    ALLOWED_CALLS,
    OdooAccountsProvider,
)
from core.accounts.provider import AccountsProvider
from core.core.config import settings

_provider: AccountsProvider | None = None


def get_provider() -> AccountsProvider | None:
    """None while accounts sync is off (settings.accounts_sync_enabled). One
    provider per process: it keeps the client's connection pool, concurrency
    cap and circuit breaker, and the server action's id."""
    global _provider
    if not settings.accounts_sync_enabled:
        return None
    if _provider is None:
        assert settings.ODOO_URL and settings.ODOO_DB and settings.ODOO_ACCOUNTS_API_KEY
        _provider = OdooAccountsProvider(
            odoo.OdooClient(
                settings.ODOO_URL,
                settings.ODOO_DB,
                settings.ODOO_ACCOUNTS_API_KEY,
                allowed_calls=ALLOWED_CALLS,
                ca_bundle=settings.GOAT_CA_BUNDLE,
            ),
            ACTION_NAME,
        )
    return _provider
