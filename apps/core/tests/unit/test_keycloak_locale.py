"""The user's language goes from GOAT to Keycloak (attribute ``locale``), and a
new user's GOAT language starts from Keycloak's or the browser's."""

from unittest.mock import MagicMock

import pytest
from core.deps import keycloak as keycloak_deps
from core.endpoints.v2.system import _initial_language
from keycloak.exceptions import KeycloakPutError


@pytest.mark.parametrize(
    ("token", "accept_language", "expected"),
    [
        ({"locale": "en"}, "de-DE,de;q=0.9", "en"),  # Keycloak's choice first
        ({}, "de-DE,de;q=0.9,en;q=0.8", "de"),
        ({}, "fr-FR,fr;q=0.9,en-US;q=0.8", "en"),  # first GOAT language
        ({"locale": "fr"}, None, "de"),  # GOAT's default
        ({}, "", "de"),
    ],
)
def test_a_new_users_language(token, accept_language, expected) -> None:
    assert _initial_language(token, accept_language) == expected


@pytest.fixture
def admin(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    client = MagicMock()
    client.get_user.return_value = {
        "id": "u1",
        "email": "anna@stadt-beispiel.de",
        "firstName": "Anna",
        "lastName": "Keller",
        "attributes": {"terms_and_conditions": ["2026-10-25T08:41:00Z"]},
    }

    async def keycloak_admin() -> MagicMock:
        return client

    monkeypatch.setattr(keycloak_deps.settings, "AUTH", True)
    monkeypatch.setattr(keycloak_deps, "keycloak_admin", keycloak_admin)
    return client


@pytest.mark.asyncio
async def test_the_locale_is_added_and_the_rest_of_the_user_kept(admin) -> None:
    """The whole user goes back: an update without the names cleared them."""
    assert await keycloak_deps.set_user_locale("u1", "en") is True
    admin.update_user.assert_called_once_with(
        user_id="u1",
        payload={
            "id": "u1",
            "email": "anna@stadt-beispiel.de",
            "firstName": "Anna",
            "lastName": "Keller",
            "attributes": {
                "terms_and_conditions": ["2026-10-25T08:41:00Z"],
                "locale": ["en"],
            },
        },
    )


@pytest.mark.asyncio
async def test_an_unchanged_locale_is_not_written(admin) -> None:
    admin.get_user.return_value = {"attributes": {"locale": ["de"]}}
    assert await keycloak_deps.set_user_locale("u1", "de") is True
    admin.update_user.assert_not_called()


@pytest.mark.asyncio
async def test_a_failing_keycloak_only_logs(admin) -> None:
    admin.update_user.side_effect = KeycloakPutError(
        "no manage-users", response_code=403
    )
    assert await keycloak_deps.set_user_locale("u1", "en") is False


@pytest.mark.asyncio
async def test_without_an_admin_client_nothing_happens(monkeypatch) -> None:
    async def none() -> None:
        return None

    monkeypatch.setattr(keycloak_deps.settings, "AUTH", True)
    monkeypatch.setattr(keycloak_deps, "keycloak_admin", none)
    assert await keycloak_deps.set_user_locale("u1", "en") is False
