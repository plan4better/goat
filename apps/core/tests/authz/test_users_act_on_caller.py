"""Account and organization routes act as the caller, whatever the query says.

`/users/profile`, `/users/organization`, `DELETE /users` and the organization
routes (create, profile, delete, invitations) used to take an optional
`user_id` that replaced the token's subject, so a signed-in user could act as
someone else: read or change another user's profile (an email change hands
over the account through a password reset), delete their Keycloak account,
or create an organization owned by them. The web app never sends that
parameter; each route now acts as the token's subject only.

The organization's owner cannot delete their account at all while the
organization exists (spec R1): it would be left with nobody to delete it or
hand it over. Everyone else can.

Keycloak is replaced by a recorder, so these tests never reach a real one.
"""

from collections.abc import Awaitable, Callable
from typing import Any
from uuid import UUID

import pytest
from core.core.config import settings
from core.crud.crud_organization import organization as crud_organization
from core.db.models.organization import Organization
from core.db.models.user import User
from core.utils.i18n import language, trans
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from tests.authz.route_world import API, give_org_role, sweep_client
from tests.utils import as_user

S = settings.SCHEMA
OWNER_KEEPS_ACCOUNT = (
    "The organization owner cannot delete their account while the "
    "organization exists."
)


class _RecordingKeycloak:
    """Stands in for the Keycloak admin client and records whose account
    each call targets."""

    def __init__(self) -> None:
        self.updated: list[str] = []
        self.deleted: list[str] = []

    def update_user(self, user_id: str, payload: dict[str, Any]) -> None:
        self.updated.append(str(user_id))

    def delete_user(self, user_id: str) -> None:
        self.deleted.append(str(user_id))


@pytest.fixture
def keycloak(monkeypatch: pytest.MonkeyPatch) -> _RecordingKeycloak:
    import core.endpoints.v2.users as users_endpoints

    recorder = _RecordingKeycloak()

    async def admin() -> _RecordingKeycloak:
        return recorder

    async def keycloak_user(user_id: Any) -> dict[str, Any]:
        return {"enabled": True, "totp": False}

    monkeypatch.setattr(users_endpoints, "keycloak_admin", admin)
    monkeypatch.setattr(users_endpoints, "get_keycloak_user", keycloak_user)
    return recorder


@pytest.fixture
async def people(
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_org: Callable[[], Awaitable[Organization]],
    make_user: Callable[..., Awaitable[User]],
) -> dict[str, User]:
    org, other_org = await make_org(), await make_org()
    victim = await make_user(org.id)
    attacker = await make_user(other_org.id)
    await give_org_role(db_session, victim.id, roles["organization-owner"])
    # An admin: an owner cannot delete their own account (the tests below).
    await give_org_role(db_session, attacker.id, roles["organization-admin"])
    await db_session.commit()
    return {"victim": victim, "attacker": attacker}


async def _column(db: AsyncSession, column: str, user_id: UUID) -> Any:
    return (
        await db.execute(
            text(f"SELECT {column} FROM {S}.user WHERE id = :id"), {"id": user_id}
        )
    ).scalar_one()


@pytest.mark.asyncio
async def test_reads_return_the_callers_own_account(
    auth_on: Callable[..., dict[str, str]],
    keycloak: _RecordingKeycloak,
    people: dict[str, User],
) -> None:
    victim, attacker = people["victim"], people["attacker"]
    client = sweep_client()
    params = {"user_id": str(victim.id)}
    headers = auth_on(attacker.id)

    profile = await client.get(f"{API}/users/profile", params=params, headers=headers)
    assert profile.status_code == 200, profile.text
    assert profile.json()["email"] == attacker.email

    organization = await client.get(
        f"{API}/users/organization", params=params, headers=headers
    )
    assert organization.status_code == 200, organization.text
    assert organization.json()["id"] == str(attacker.organization_id)


@pytest.mark.asyncio
async def test_writes_change_only_the_callers_own_account(
    db_session: AsyncSession,
    auth_on: Callable[..., dict[str, str]],
    keycloak: _RecordingKeycloak,
    people: dict[str, User],
) -> None:
    # Plain ids up front: the rows are expired below, and reading an expired
    # attribute outside the session's own await would fail.
    victim_id, attacker_id = people["victim"].id, people["attacker"].id
    victim_avatar = await _column(db_session, "avatar", victim_id)
    client = sweep_client()
    params = {"user_id": str(victim_id)}
    headers = auth_on(attacker_id)

    update = await client.patch(
        f"{API}/users/profile",
        params=params,
        headers=headers,
        json={"firstname": "Changed", "avatar": "https://example.org/a.png"},
    )
    assert update.status_code == 200, update.text
    assert keycloak.updated == [str(attacker_id)]
    db_session.expire_all()
    assert await _column(db_session, "avatar", victim_id) == victim_avatar
    assert (
        await _column(db_session, "avatar", attacker_id) == "https://example.org/a.png"
    )

    delete = await client.delete(f"{API}/users", params=params, headers=headers)
    assert delete.status_code == 204, delete.text
    assert keycloak.deleted == [str(attacker_id)]


@pytest.mark.asyncio
async def test_an_organization_is_never_created_for_someone_else(
    db_session: AsyncSession,
    auth_on: Callable[..., dict[str, str]],
    keycloak: _RecordingKeycloak,
    make_user: Callable[..., Awaitable[User]],
    people: dict[str, User],
) -> None:
    """A user without an organization, which a new signup is, cannot be made
    the owner of an organization someone else creates."""
    newcomer_id = (await make_user(None)).id
    attacker_id = people["attacker"].id
    await db_session.commit()

    created = await sweep_client().post(
        f"{API}/organizations",
        params={"user_id": str(newcomer_id)},
        headers=auth_on(attacker_id),
        json={
            "name": "Not yours",
            "department": "Planning",
            "industry": "urban_planning",
            "location": "Munich",
            "type": "government",
            "use_case": "site_analysis_and_design_decision_support",
            "region": "EU",
        },
    )
    # The caller already has an organization, so creating one is refused...
    assert created.status_code == 400, created.text
    # ...and the newcomer named in the query is left without one.
    db_session.expire_all()
    assert await _column(db_session, "organization_id", newcomer_id) is None


@pytest.mark.asyncio
async def test_the_owner_cannot_delete_their_account(
    auth_on: Callable[..., dict[str, str]],
    keycloak: _RecordingKeycloak,
    people: dict[str, User],
) -> None:
    owner_id = people["victim"].id

    delete = await sweep_client().delete(f"{API}/users", headers=auth_on(owner_id))
    assert delete.status_code == 409, delete.text
    assert delete.json()["detail"] == OWNER_KEEPS_ACCOUNT
    assert keycloak.deleted == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "role", ["organization-admin", "organization-editor", "organization-viewer"]
)
async def test_every_other_member_deletes_their_account(
    role: str,
    db_session: AsyncSession,
    auth_on: Callable[..., dict[str, str]],
    keycloak: _RecordingKeycloak,
    roles: dict[str, UUID],
    make_org: Callable[[], Awaitable[Organization]],
    make_user: Callable[..., Awaitable[User]],
) -> None:
    member_id = (await make_user((await make_org()).id)).id
    await give_org_role(db_session, member_id, roles[role])
    await db_session.commit()

    delete = await sweep_client().delete(f"{API}/users", headers=auth_on(member_id))
    assert delete.status_code == 204, delete.text
    assert keycloak.deleted == [str(member_id)]


@pytest.mark.asyncio
async def test_a_former_owner_deletes_their_account_once_the_organization_is_gone(
    client: AsyncClient,
    db_session: AsyncSession,
    keycloak: _RecordingKeycloak,
    roles: dict[str, UUID],
    make_org: Callable[[], Awaitable[Organization]],
    make_user: Callable[..., Awaitable[User]],
) -> None:
    """The way the refusal names: once the organization is deleted for good
    (`delete_permanently`, which leaves its last member without an
    organization or a role), the handler lets its former owner delete their
    account. AUTH is off here: with it on, `authorization()` refuses
    `DELETE /users` to a user without an organization role (`manage-user`
    comes only with one), so this path is the handler's alone for now."""
    org_id = (await make_org()).id
    owner_id = (await make_user(org_id)).id
    await give_org_role(db_session, owner_id, roles["organization-owner"])
    await db_session.commit()

    refused = await client.delete(f"{API}/users", headers=as_user(owner_id))
    assert refused.status_code == 409, refused.text

    gone = await crud_organization.delete_permanently(organization_id=org_id)
    assert gone is not None and gone.user_id == owner_id

    deleted = await client.delete(f"{API}/users", headers=as_user(owner_id))
    assert deleted.status_code == 204, deleted.text
    assert keycloak.deleted == [str(owner_id)]


@pytest.mark.unit
def test_the_owner_refusal_has_a_german_text() -> None:
    with language("de"):
        assert trans(OWNER_KEEPS_ACCOUNT) == (
            "Als Eigentümer können Sie Ihr Konto erst löschen, wenn die "
            "Organisation gelöscht ist."
        )
