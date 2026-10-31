"""The Odoo accounts provider: the server action's operations and arguments."""

from datetime import date
from typing import Any

import pytest
from core import odoo
from core.accounts.odoo_provider import OdooAccountsProvider
from core.accounts.provider import AccountsError

ACTION = "GOAT: accounts"


class FakeClient:
    def __init__(self, found: list[int] | None = None, error: Exception | None = None):
        self.found = [42] if found is None else found
        self.error = error
        self.calls: list[tuple[str, str, dict[str, Any]]] = []

    async def call(self, model: str, method: str, **kwargs: Any) -> Any:
        self.calls.append((model, method, kwargs))
        if self.error:
            raise self.error
        if method == "search":
            return self.found
        return {"goat_contact_id": 7, "goat_company_id": 9}


def _provider(client: FakeClient) -> OdooAccountsProvider:
    return OdooAccountsProvider(client, ACTION)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_sign_up_maps_the_language_to_odoos_code():
    client = FakeClient()
    contact_id = await _provider(client).sign_up(
        user_id="u", name="Anna", email="a@b.de", marketing_consent=True, language="de"
    )
    assert contact_id == 7
    _, _, run = client.calls[1]
    assert run["ids"] == [42]
    assert run["context"] == {
        "goat_op": "sign_up",
        "goat_user_id": "u",
        "goat_name": "Anna",
        "goat_email": "a@b.de",
        "goat_marketing_consent": True,
        "goat_lang": "de_DE",
    }


@pytest.mark.asyncio
async def test_sign_up_without_a_language_leaves_odoos_alone():
    client = FakeClient()
    await _provider(client).sign_up(
        user_id="u", name="A", email="a@b.de", marketing_consent=False, language=None
    )
    assert "goat_lang" not in client.calls[1][2]["context"]


@pytest.mark.asyncio
async def test_the_action_is_looked_up_once_by_name():
    client = FakeClient()
    provider = _provider(client)
    await provider.status(organization_id="o", suspended=False, on_trial=True)
    await provider.status(organization_id="o", suspended=True, on_trial=True)
    searches = [c for c in client.calls if c[1] == "search"]
    assert len(searches) == 1
    assert searches[0][2]["domain"] == [("name", "=", ACTION)]


@pytest.mark.asyncio
async def test_trial_and_join_return_the_company_id():
    provider = _provider(FakeClient())
    assert (
        await provider.start_trial(
            user_id="u",
            organization_id="o",
            organization_name="Stadt",
            trial_start=date(2026, 1, 1),
            trial_end=date(2026, 1, 31),
        )
        == 9
    )
    assert (
        await provider.join(
            user_id="u", organization_id="o", organization_name="Stadt", role="viewer"
        )
        == 9
    )


@pytest.mark.asyncio
async def test_a_missing_server_action_is_an_accounts_error():
    with pytest.raises(AccountsError, match="no server action"):
        await _provider(FakeClient(found=[])).status(
            organization_id="o", suspended=False, on_trial=False
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "error",
    [odoo.OdooUnavailable("down"), odoo.OdooRejected(403, "AccessError", "no")],
)
async def test_odoo_errors_become_accounts_errors(error):
    with pytest.raises(AccountsError):
        await _provider(FakeClient(error=error)).status(
            organization_id="o", suspended=False, on_trial=False
        )
