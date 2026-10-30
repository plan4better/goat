"""Who may create an organization: `ALLOW_ORGANIZATION_CREATION`.

A user belongs to one organization. Someone who signs in before their
invitation exists would otherwise set up an organization of their own and
could no longer be invited. With the setting off, only superusers create
organizations; the API refuses everyone else, whatever the web app shows.
The web app asks `GET /users/me/organization-creation` which page to show.
"""

from collections.abc import Awaitable, Callable
from typing import Any
from uuid import UUID

import pytest
from core.core.config import Settings, settings
from core.db.models.user import User
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from tests.authz.route_world import API, sweep_client

S = settings.SCHEMA

NEW_ORGANIZATION = {
    "name": "Own organization",
    "type": "government",
    "region": "EU",
}


@pytest.fixture(autouse=True)
def no_billing(monkeypatch: pytest.MonkeyPatch) -> None:
    """Creating an organization starts a trial when billing is on."""
    monkeypatch.setattr(settings, "BILLING_ENABLED", False)


async def _organization_of(db: AsyncSession, user_id: UUID) -> Any:
    return (
        await db.execute(
            text(f"SELECT organization_id FROM {S}.user WHERE id = :id"),
            {"id": user_id},
        )
    ).scalar_one()


def test_creation_is_open_unless_switched_off() -> None:
    assert Settings.model_fields["ALLOW_ORGANIZATION_CREATION"].default is True


@pytest.mark.asyncio
async def test_anyone_creates_an_organization_by_default(
    db_session: AsyncSession,
    auth_on: Callable[..., dict[str, str]],
    make_user: Callable[..., Awaitable[User]],
) -> None:
    user_id = (await make_user(None)).id
    await db_session.commit()

    allowed = await sweep_client().get(
        f"{API}/users/me/organization-creation", headers=auth_on(user_id)
    )
    created = await sweep_client().post(
        f"{API}/organizations", headers=auth_on(user_id), json=NEW_ORGANIZATION
    )

    assert allowed.status_code == 200, allowed.text
    assert allowed.json() == {"allowed": True}
    assert created.status_code == 200, created.text
    db_session.expire_all()
    assert str(await _organization_of(db_session, user_id)) == created.json()["id"]


@pytest.mark.asyncio
async def test_switched_off_a_user_cannot_create_one(
    db_session: AsyncSession,
    auth_on: Callable[..., dict[str, str]],
    make_user: Callable[..., Awaitable[User]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "ALLOW_ORGANIZATION_CREATION", False)
    user_id = (await make_user(None)).id
    await db_session.commit()
    name = f"Refused {user_id}"

    allowed = await sweep_client().get(
        f"{API}/users/me/organization-creation", headers=auth_on(user_id)
    )
    created = await sweep_client().post(
        f"{API}/organizations",
        headers=auth_on(user_id),
        json={**NEW_ORGANIZATION, "name": name},
    )

    assert allowed.status_code == 200, allowed.text
    assert allowed.json() == {"allowed": False}
    assert created.status_code == 403, created.text
    db_session.expire_all()
    assert await _organization_of(db_session, user_id) is None
    assert (
        await db_session.execute(
            text(f"SELECT count(*) FROM {S}.organization WHERE name = :n"),
            {"n": name},
        )
    ).scalar_one() == 0


@pytest.mark.asyncio
async def test_switched_off_a_superuser_still_creates_one(
    db_session: AsyncSession,
    auth_on: Callable[..., dict[str, str]],
    make_user: Callable[..., Awaitable[User]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "ALLOW_ORGANIZATION_CREATION", False)
    user_id = (await make_user(None)).id
    await db_session.commit()
    headers = auth_on(user_id, roles=["superuser"])

    allowed = await sweep_client().get(
        f"{API}/users/me/organization-creation", headers=headers
    )
    created = await sweep_client().post(
        f"{API}/organizations", headers=headers, json=NEW_ORGANIZATION
    )

    assert allowed.json() == {"allowed": True}
    assert created.status_code == 200, created.text
    db_session.expire_all()
    assert str(await _organization_of(db_session, user_id)) == created.json()["id"]


@pytest.mark.asyncio
async def test_the_answer_needs_a_signed_in_caller(
    auth_on: Callable[..., dict[str, str]],
) -> None:
    response = await sweep_client().get(f"{API}/users/me/organization-creation")

    assert response.status_code == 401, response.text
