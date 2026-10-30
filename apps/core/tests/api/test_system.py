from uuid import UUID

import pytest
from core.core.config import settings
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


@pytest.mark.asyncio
async def test_health(client: AsyncClient):
    response = await client.get(
        "/api/healthz",
    )

    assert response.status_code == 200
    assert response.json() == {"ping": "pong!"}


@pytest.mark.asyncio
async def test_a_first_settings_save_starts_from_the_defaults(
    client: AsyncClient, db_session: AsyncSession, fixture_create_user: UUID
) -> None:
    """A user with no settings row yet can save settings: the defaults fill
    what the request leaves out (it used to fail with 422 on spotlight_seen)."""
    await db_session.execute(
        text(f"DELETE FROM {settings.SCHEMA}.system_setting WHERE user_id = :u"),
        {"u": fixture_create_user},
    )
    await db_session.commit()

    saved = await client.put(
        f"{settings.API_V2_STR}/system/settings",
        json={"preferred_language": "en", "client_theme": "light", "unit": "metric"},
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["spotlight_seen"] == []

    read = await client.get(f"{settings.API_V2_STR}/system/settings")
    assert read.json()["preferred_language"] == "en"
    assert read.json()["client_theme"] == "light"


def test_reading_ones_own_settings_skips_the_organization_check() -> None:
    """A member of a suspended organization still reads their own settings, so its
    suspended page shows in their language: the token is verified, the
    organization not checked. Changing them stays checked."""
    from core.deps.auth import auth_z, user_token
    from core.endpoints.v2.system import router

    def calls(method: str) -> set:
        route = next(
            r for r in router.routes if r.path == "/settings" and method in r.methods
        )
        return {d.call for d in route.dependant.dependencies}

    assert user_token in calls("GET") and auth_z not in calls("GET")
    assert auth_z in calls("PUT")


@pytest.mark.asyncio
async def test_a_new_user_reads_goats_default_settings(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Right after sign-up, before any workspace page provisioned the user, the
    settings are readable, in GOAT's default language, instead of failing (409):
    the onboarding pages showed in English for every new user."""
    from core.crud.base import CRUDBase
    from core.db.models.user import User

    user_id = settings.DEFAULT_USER_ID
    if await db_session.get(User, user_id) is not None:
        await CRUDBase(User).delete(db_session, id=user_id)
    try:
        read = await client.get(f"{settings.API_V2_STR}/system/settings")
        assert read.status_code == 200, read.text
        assert read.json()["preferred_language"] == "de"
    finally:
        db_session.expire_all()
        if await db_session.get(User, user_id) is not None:
            await CRUDBase(User).delete(db_session, id=user_id)


@pytest.mark.asyncio
async def test_a_language_change_goes_to_keycloak(
    client: AsyncClient, fixture_create_user: UUID, monkeypatch: pytest.MonkeyPatch
) -> None:
    from core.endpoints.v2 import system

    written: list[tuple[str, str]] = []
    monkeypatch.setattr(
        system, "report_locale", lambda u, lang: written.append((u, lang))
    )
    saved = await client.put(
        f"{settings.API_V2_STR}/system/settings", json={"preferred_language": "en"}
    )
    assert saved.status_code == 200, saved.text
    assert written == [(str(fixture_create_user), "en")]


def test_the_browsers_preferred_language_wins() -> None:
    from core.endpoints.v2.system import _initial_language

    assert _initial_language({}, "en;q=0.1, de;q=0.9") == "de"
    assert _initial_language({}, "fr-FR, en-GB;q=0.8, de;q=0.5") == "en"
    assert _initial_language({"locale": "de"}, "en") == "de"


@pytest.mark.asyncio
async def test_a_new_user_starts_in_the_browsers_language(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Keycloak keeps no language for the user (no claim): the browser's decides,
    and Keycloak gets it too."""
    from core.crud.base import CRUDBase
    from core.db.models.user import User
    from core.endpoints.v2 import system

    written: list[tuple[str, str]] = []
    monkeypatch.setattr(
        system, "report_locale", lambda u, lang: written.append((u, lang))
    )
    user_id = settings.DEFAULT_USER_ID
    if await db_session.get(User, user_id) is not None:
        await CRUDBase(User).delete(db_session, id=user_id)
    try:
        read = await client.get(
            f"{settings.API_V2_STR}/system/settings",
            headers={"Accept-Language": "en-GB,en;q=0.9"},
        )
        assert read.status_code == 200, read.text
        assert read.json()["preferred_language"] == "en"
        assert written == [(str(user_id), "en")]
    finally:
        db_session.expire_all()
        if await db_session.get(User, user_id) is not None:
            await CRUDBase(User).delete(db_session, id=user_id)
