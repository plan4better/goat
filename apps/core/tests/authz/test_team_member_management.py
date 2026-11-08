"""Only a team's owner manages its members; a member may leave on their own.

Adding and removing members has its own resources (``read-team``), so the
decision is the handler's: the caller must own the team to add anyone or to
remove someone else, the added user must belong to the team's organization,
and the owner cannot remove themselves (the team would have no owner left).
"""

import base64
import json
from collections.abc import Awaitable, Callable
from typing import Any
from uuid import UUID, uuid4

import pytest
from core.core.config import settings
from core.db.models.organization import Organization
from core.db.models.user import User
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

S = settings.SCHEMA
TEAMS = f"{settings.API_V2_STR}/teams"


def _as(user_id: UUID) -> dict[str, str]:
    """Headers acting as `user_id`: with AUTH=False the claims are read unverified."""

    def segment(payload: dict[str, Any]) -> str:
        raw = json.dumps(payload).encode()
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

    token = (
        f"{segment({'alg': 'none', 'typ': 'JWT'})}.{segment({'sub': str(user_id)})}.sig"
    )
    return {"Authorization": f"Bearer {token}"}


async def _members(db: AsyncSession, team_id: str) -> set[UUID]:
    rows = await db.execute(
        text(f"SELECT user_id FROM {S}.user_team WHERE team_id = :t"), {"t": team_id}
    )
    return set(rows.scalars())


@pytest.fixture
async def team_setup(
    client: AsyncClient,
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_org: Callable[[], Awaitable[Organization]],
    make_user: Callable[..., Awaitable[User]],
) -> dict[str, Any]:
    # `roles` seeds the role table the team handlers look the owner role up in.
    org, other_org = await make_org(), await make_org()
    owner, member, colleague = (
        await make_user(org.id),
        await make_user(org.id),
        await make_user(org.id),
    )
    outsider = await make_user(other_org.id)
    ids = {
        "owner": owner.id,
        "member": member.id,
        "colleague": colleague.id,
        "outsider": outsider.id,
    }
    await db_session.commit()

    created = await client.post(
        TEAMS, json={"name": "Planning"}, headers=_as(ids["owner"])
    )
    assert created.status_code == 200, created.text
    team_id = created.json()["id"]
    added = await client.post(
        f"{TEAMS}/{team_id}/users/{ids['member']}", headers=_as(ids["owner"])
    )
    assert added.status_code == 200, added.text
    return {"team": team_id, **ids}


@pytest.mark.asyncio
async def test_only_the_owner_adds_members(
    client: AsyncClient, db_session: AsyncSession, team_setup: dict[str, Any]
) -> None:
    team = team_setup["team"]
    by_member = await client.post(
        f"{TEAMS}/{team}/users/{team_setup['colleague']}",
        headers=_as(team_setup["member"]),
    )
    assert by_member.status_code == 403, by_member.text
    by_colleague_for_self = await client.post(
        f"{TEAMS}/{team}/users/{team_setup['colleague']}",
        headers=_as(team_setup["colleague"]),
    )
    assert by_colleague_for_self.status_code == 403, by_colleague_for_self.text
    assert team_setup["colleague"] not in await _members(db_session, team)

    by_owner = await client.post(
        f"{TEAMS}/{team}/users/{team_setup['colleague']}",
        headers=_as(team_setup["owner"]),
    )
    assert by_owner.status_code == 200, by_owner.text
    assert team_setup["colleague"] in await _members(db_session, team)


@pytest.mark.asyncio
async def test_adding_someone_without_a_name_answers_the_member(
    client: AsyncClient, db_session: AsyncSession, team_setup: dict[str, Any]
) -> None:
    """An invitee who never entered a name is added like anyone else, and the
    answer is the member as `GET .../members` lists them (the user shape
    refused the missing names with a 500 after the member was already in)."""
    team = team_setup["team"]
    owner = (await db_session.get(User, team_setup["owner"])).organization_id
    nameless = User(
        id=uuid4(),
        email=f"nameless-{uuid4().hex[:8]}@goat.test",
        firstname=None,
        lastname=None,
        avatar=None,
        organization_id=owner,
    )
    db_session.add(nameless)
    await db_session.commit()

    added = await client.post(
        f"{TEAMS}/{team}/users/{nameless.id}", headers=_as(team_setup["owner"])
    )
    assert added.status_code == 200, added.text
    assert added.json() == {
        "id": str(nameless.id),
        "firstname": None,
        "lastname": None,
        "email": nameless.email,
        "role": "team-member",
        "avatar": None,
        "invitation_status": "accepted",
    }
    members = await client.get(
        f"{TEAMS}/{team}/members", headers=_as(team_setup["owner"])
    )
    assert members.status_code == 200, members.text
    assert added.json() in members.json()


@pytest.mark.asyncio
async def test_a_user_of_another_organization_cannot_be_added(
    client: AsyncClient, db_session: AsyncSession, team_setup: dict[str, Any]
) -> None:
    team = team_setup["team"]
    response = await client.post(
        f"{TEAMS}/{team}/users/{team_setup['outsider']}",
        headers=_as(team_setup["owner"]),
    )
    assert response.status_code == 400, response.text
    assert team_setup["outsider"] not in await _members(db_session, team)


@pytest.mark.asyncio
async def test_a_member_leaves_but_does_not_remove_others(
    client: AsyncClient, db_session: AsyncSession, team_setup: dict[str, Any]
) -> None:
    team = team_setup["team"]
    removes_owner = await client.delete(
        f"{TEAMS}/{team}/users/{team_setup['owner']}",
        headers=_as(team_setup["member"]),
    )
    assert removes_owner.status_code == 403, removes_owner.text
    assert team_setup["owner"] in await _members(db_session, team)

    leaves = await client.delete(
        f"{TEAMS}/{team}/users/{team_setup['member']}",
        headers=_as(team_setup["member"]),
    )
    assert leaves.status_code == 200, leaves.text
    assert team_setup["member"] not in await _members(db_session, team)


@pytest.mark.asyncio
async def test_the_owner_removes_members_but_not_themselves(
    client: AsyncClient, db_session: AsyncSession, team_setup: dict[str, Any]
) -> None:
    team = team_setup["team"]
    removes_self = await client.delete(
        f"{TEAMS}/{team}/users/{team_setup['owner']}",
        headers=_as(team_setup["owner"]),
    )
    assert removes_self.status_code == 400, removes_self.text
    # Since B7 the owner hands the team over instead of deleting it.
    assert removes_self.json()["detail"] == (
        "The team's owner cannot leave the team; make another member the owner first."
    )
    assert team_setup["owner"] in await _members(db_session, team)

    removes_member = await client.delete(
        f"{TEAMS}/{team}/users/{team_setup['member']}",
        headers=_as(team_setup["owner"]),
    )
    assert removes_member.status_code == 200, removes_member.text
    assert team_setup["member"] not in await _members(db_session, team)


async def _give_org_role(db: AsyncSession, user_id: UUID, role_id: UUID) -> None:
    await db.execute(
        text(f"INSERT INTO {S}.user_role (user_id, role_id) VALUES (:u, :r)"),
        {"u": user_id, "r": role_id},
    )
    await db.commit()


@pytest.mark.asyncio
async def test_only_the_owner_or_an_org_admin_renames_or_deletes_a_team(
    client: AsyncClient,
    db_session: AsyncSession,
    roles: dict[str, UUID],
    team_setup: dict[str, Any],
) -> None:
    """An organization editor who does not own the team may neither rename
    nor delete it; the team's owner and the organization's admins may."""
    team = team_setup["team"]
    editor, admin = team_setup["colleague"], team_setup["member"]
    await _give_org_role(db_session, editor, roles["organization-editor"])
    await _give_org_role(db_session, admin, roles["organization-admin"])

    renamed_by_editor = await client.patch(
        f"{TEAMS}/{team}/profile", json={"name": "Taken"}, headers=_as(editor)
    )
    assert renamed_by_editor.status_code == 403, renamed_by_editor.text
    deleted_by_editor = await client.delete(f"{TEAMS}/{team}", headers=_as(editor))
    assert deleted_by_editor.status_code == 403, deleted_by_editor.text

    renamed_by_owner = await client.patch(
        f"{TEAMS}/{team}/profile",
        json={"name": "Planning 2"},
        headers=_as(team_setup["owner"]),
    )
    assert renamed_by_owner.status_code == 200, renamed_by_owner.text
    renamed_by_admin = await client.patch(
        f"{TEAMS}/{team}/profile", json={"name": "Planning 3"}, headers=_as(admin)
    )
    assert renamed_by_admin.status_code == 200, renamed_by_admin.text

    deleted_by_admin = await client.delete(f"{TEAMS}/{team}", headers=_as(admin))
    assert deleted_by_admin.status_code == 200, deleted_by_admin.text
