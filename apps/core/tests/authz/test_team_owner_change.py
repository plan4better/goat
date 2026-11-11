"""A team gets a new owner (B7, decision 11).

The team's owner hands the team over, and an owner or admin of the
organization names an owner for a team whose owner has left. The new owner
must be in the team and hold Bearbeiter or higher in the organization; any
other owner stays in the team as a member. Every link of the team changes in
one UPDATE, and only while the new owner is still in the team.
"""

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any
from uuid import UUID

import pytest
from core.core.config import settings
from core.crud.crud_team import team as crud_team
from core.db.models.organization import Organization
from core.db.models.user import User
from core.endpoints.deps import session_manager
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession
from tests.utils import as_user, give_org_role

S = settings.SCHEMA
TEAMS = f"{settings.API_V2_STR}/teams"


async def _team_roles(db: AsyncSession, team_id: str) -> dict[UUID, str]:
    rows = await db.execute(
        text(
            f"SELECT ut.user_id, r.name FROM {S}.user_team ut "
            f"JOIN {S}.role r ON r.id = ut.role_id WHERE ut.team_id = :t"
        ),
        {"t": team_id},
    )
    return {user_id: role for user_id, role in rows.all()}


async def _denial(
    db: AsyncSession, user_id: UUID, pattern: str, path: str, method: str
) -> str:
    """Why authorization() refused, or "" when it allowed the request."""
    try:
        await db.execute(
            text(f"SELECT {S}.authorization(:u, :res, :path, :m)"),
            {"u": user_id, "res": pattern, "path": path, "m": method},
        )
    except DBAPIError as error:
        await db.rollback()
        return str(error.orig)
    return ""


@pytest.fixture
async def team(
    client: AsyncClient,
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_org: Callable[[], Awaitable[Organization]],
    make_user: Callable[..., Awaitable[User]],
) -> dict[str, Any]:
    org = await make_org()
    cast = {
        "owner": "organization-editor",  # creates the team
        "editor_member": "organization-editor",  # in the team
        "viewer_member": "organization-viewer",  # in the team
        "plain_member": "organization-editor",  # in the team, acts as a non-owner
        "admin": "organization-admin",  # in no team
        "outside_editor": "organization-editor",  # in no team
        "non_member": "organization-editor",  # in no team, as a candidate
        "other_owner": "organization-editor",  # owns "Elsewhere"
    }
    users = {name: await make_user(org.id) for name in cast}
    await db_session.commit()
    for name, role in cast.items():
        await give_org_role(db_session, users[name].id, roles[role])
    ids: dict[str, Any] = {name: user.id for name, user in users.items()}

    created = await client.post(
        TEAMS, json={"name": "Handover"}, headers=as_user(ids["owner"])
    )
    assert created.status_code == 200, created.text
    ids["team"] = created.json()["id"]
    for name in ("editor_member", "viewer_member", "plain_member"):
        added = await client.post(
            f"{TEAMS}/{ids['team']}/users/{ids[name]}", headers=as_user(ids["owner"])
        )
        assert added.status_code == 200, added.text

    # A second team, which no handover of "Handover" may touch.
    other = await client.post(
        TEAMS, json={"name": "Elsewhere"}, headers=as_user(ids["other_owner"])
    )
    assert other.status_code == 200, other.text
    ids["other_team"] = other.json()["id"]
    added = await client.post(
        f"{TEAMS}/{ids['other_team']}/users/{ids['editor_member']}",
        headers=as_user(ids["other_owner"]),
    )
    assert added.status_code == 200, added.text
    return ids


async def _name_owner(client: AsyncClient, team: dict[str, Any], who: str, new: str):
    return await client.put(
        f"{TEAMS}/{team['team']}/owner",
        json={"user_id": str(team[new])},
        headers=as_user(team[who]),
    )


@pytest.mark.asyncio
async def test_the_owner_hands_the_team_over_and_stays_a_member(
    client: AsyncClient, db_session: AsyncSession, team: dict[str, Any]
) -> None:
    answer = await _name_owner(client, team, "owner", "editor_member")
    assert answer.status_code == 200, answer.text
    by_id = {member["id"]: member["role"] for member in answer.json()}
    assert by_id[str(team["editor_member"])] == "team-owner"
    assert by_id[str(team["owner"])] == "team-member"

    stored = await _team_roles(db_session, team["team"])
    assert stored[team["editor_member"]] == "team-owner"
    assert stored[team["owner"]] == "team-member"
    assert list(stored.values()).count("team-owner") == 1

    # The other team, where the new owner is a member, keeps its owner.
    assert await _team_roles(db_session, team["other_team"]) == {
        team["other_owner"]: "team-owner",
        team["editor_member"]: "team-member",
    }


@pytest.mark.asyncio
async def test_an_admin_names_an_owner_for_a_team_whose_owner_left(
    client: AsyncClient, db_session: AsyncSession, team: dict[str, Any]
) -> None:
    # The owner left the organization: their link to the team is gone.
    await db_session.execute(
        text(f"DELETE FROM {S}.user_team WHERE team_id = :t AND user_id = :u"),
        {"t": team["team"], "u": team["owner"]},
    )
    await db_session.commit()
    assert "team-owner" not in (await _team_roles(db_session, team["team"])).values()

    answer = await _name_owner(client, team, "admin", "editor_member")
    assert answer.status_code == 200, answer.text
    stored = await _team_roles(db_session, team["team"])
    assert stored[team["editor_member"]] == "team-owner"
    assert list(stored.values()).count("team-owner") == 1


@pytest.mark.asyncio
async def test_a_viewer_or_someone_outside_the_team_cannot_become_owner(
    client: AsyncClient, db_session: AsyncSession, team: dict[str, Any]
) -> None:
    viewer = await _name_owner(client, team, "owner", "viewer_member")
    assert viewer.status_code == 400, viewer.text
    assert viewer.json()["detail"] == "A viewer cannot own a team"

    outsider = await _name_owner(client, team, "owner", "non_member")
    assert outsider.status_code == 400, outsider.text
    assert outsider.json()["detail"] == "Only a member of the team can become its owner"

    assert (await _team_roles(db_session, team["team"]))[team["owner"]] == "team-owner"


@pytest.mark.asyncio
async def test_only_the_owner_or_an_admin_names_the_owner(
    client: AsyncClient, db_session: AsyncSession, team: dict[str, Any]
) -> None:
    for who in ("plain_member", "outside_editor"):
        refused = await _name_owner(client, team, who, "editor_member")
        assert refused.status_code == 403, (who, refused.text)
    stored = await _team_roles(db_session, team["team"])
    assert stored[team["owner"]] == "team-owner"
    assert stored[team["editor_member"]] == "team-member"


@pytest.mark.asyncio
async def test_naming_the_current_owner_changes_nothing(
    client: AsyncClient, db_session: AsyncSession, team: dict[str, Any]
) -> None:
    before = await _team_roles(db_session, team["team"])
    answer = await _name_owner(client, team, "owner", "owner")
    assert answer.status_code == 200, answer.text
    assert await _team_roles(db_session, team["team"]) == before


@pytest.mark.asyncio
async def test_the_route_needs_update_team(
    db_session: AsyncSession, team: dict[str, Any]
) -> None:
    pattern = "teams/{team_id}/owner"
    path = f"teams/{team['team']}/owner"
    reason = await _denial(db_session, team["viewer_member"], pattern, path, "PUT")
    assert "User does not have the needed permissions" in reason
    assert await _denial(db_session, team["plain_member"], pattern, path, "PUT") == ""


@pytest.mark.asyncio
async def test_a_team_with_two_owners_ends_with_one(
    client: AsyncClient, db_session: AsyncSession, team: dict[str, Any]
) -> None:
    """Any other owner becomes a member, not only the one the caller saw."""
    await db_session.execute(
        text(
            f"UPDATE {S}.user_team SET role_id = "
            f"(SELECT id FROM {S}.role WHERE name = 'team-owner') "
            "WHERE team_id = :t AND user_id = :u"
        ),
        {"t": team["team"], "u": team["editor_member"]},
    )
    await db_session.commit()

    answer = await _name_owner(client, team, "owner", "plain_member")
    assert answer.status_code == 200, answer.text
    stored = await _team_roles(db_session, team["team"])
    assert [user for user, role in stored.items() if role == "team-owner"] == [
        team["plain_member"]
    ]


@pytest.mark.asyncio
async def test_a_member_removed_after_the_check_is_not_made_owner(
    client: AsyncClient,
    db_session: AsyncSession,
    team: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The candidate leaves between the handler's membership check and the
    UPDATE: 409, and the owner stays the owner."""
    check = crud_team.get_member_role
    candidate = str(team["editor_member"])

    async def check_then_remove(*, db: AsyncSession, team_id: str, user_id: str):
        role = await check(db=db, team_id=team_id, user_id=user_id)
        if str(user_id) == candidate:
            await db_session.execute(
                text(f"DELETE FROM {S}.user_team WHERE team_id = :t AND user_id = :u"),
                {"t": team_id, "u": candidate},
            )
            await db_session.commit()
        return role

    monkeypatch.setattr(crud_team, "get_member_role", check_then_remove)
    before = await _team_roles(db_session, team["team"])

    answer = await _name_owner(client, team, "owner", "editor_member")
    assert answer.status_code == 409, answer.text
    del before[team["editor_member"]]
    assert await _team_roles(db_session, team["team"]) == before


@pytest.mark.asyncio
async def test_two_handovers_at_the_same_moment_leave_one_owner(
    db_session: AsyncSession, team: dict[str, Any]
) -> None:
    """A second handover that starts while the first is still writing waits
    for it and then re-reads every row of the team, so exactly one owner
    remains (the last writer's), never two."""
    team_id = team["team"]
    async with session_manager.session() as second_db:
        second_pid = (await second_db.execute(text("SELECT pg_backend_pid()"))).scalar()
        async with session_manager.transaction() as first:
            # The first handover, to editor_member, not committed yet.
            await first.execute(
                text(
                    f"UPDATE {S}.user_team SET role_id = (SELECT id FROM {S}.role "
                    "WHERE name = CASE WHEN user_id = :x THEN 'team-owner' "
                    "ELSE 'team-member' END) WHERE team_id = :t"
                ),
                {"t": team_id, "x": team["editor_member"]},
            )
            second = asyncio.create_task(
                crud_team.change_owner(
                    db=second_db, team_id=team_id, user_id=str(team["plain_member"])
                )
            )
            for _ in range(200):
                waiting = (
                    await db_session.execute(
                        text(
                            "SELECT wait_event_type FROM pg_stat_activity "
                            "WHERE pid = :pid"
                        ),
                        {"pid": second_pid},
                    )
                ).scalar()
                if waiting == "Lock":
                    break
                await asyncio.sleep(0.05)
            else:
                pytest.fail("the second handover never waited for the first")
        # The first handover commits as its block ends; the second goes on.
        await asyncio.wait_for(second, timeout=10)

    stored = await _team_roles(db_session, team_id)
    assert [user for user, role in stored.items() if role == "team-owner"] == [
        team["plain_member"]
    ]
