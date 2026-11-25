"""Organization owners and admins manage every team of their organization (B1).

`GET /teams` keeps answering the caller's own teams, because the share
dialogs and Home read it. `scope=organization` lists every team of the
organization, for its owners and admins only. They read, rename, add and
remove members of a team they are not in, never remove its owner, and never
touch a team of another organization. A team's members are read by its own
members and by the owners and admins of its organization; everyone else gets
null, as for the team itself. AUTH is off here, so these are the handlers'
own checks.
"""

from collections.abc import Awaitable, Callable
from typing import Any
from uuid import UUID

import pytest
from core.core.config import settings
from core.db.models.organization import Organization
from core.db.models.user import User
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from tests.utils import as_user, give_org_role

S = settings.SCHEMA
TEAMS = f"{settings.API_V2_STR}/teams"


async def _members(db: AsyncSession, team_id: str) -> set[UUID]:
    rows = await db.execute(
        text(f"SELECT user_id FROM {S}.user_team WHERE team_id = :t"), {"t": team_id}
    )
    return set(rows.scalars())


@pytest.fixture
async def org_teams(
    client: AsyncClient,
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_org: Callable[[], Awaitable[Organization]],
    make_user: Callable[..., Awaitable[User]],
) -> dict[str, Any]:
    org, other_org = await make_org(), await make_org()
    cast = {
        "org_owner": (org, "organization-owner"),
        "admin": (org, "organization-admin"),  # in no team
        "team_owner": (org, "organization-editor"),  # creates "Planning"
        "member": (org, "organization-viewer"),  # in "Planning"
        "editor": (org, "organization-editor"),  # in no team
        "colleague": (org, "organization-editor"),  # in no team
        "outsider": (other_org, "organization-admin"),  # admin elsewhere
    }
    users = {name: await make_user(o.id) for name, (o, _) in cast.items()}
    await db_session.commit()
    for name, (_, role) in cast.items():
        await give_org_role(db_session, users[name].id, roles[role])
    ids: dict[str, Any] = {name: user.id for name, user in users.items()}

    created = await client.post(
        TEAMS, json={"name": "Planning"}, headers=as_user(ids["team_owner"])
    )
    assert created.status_code == 200, created.text
    ids["team"] = created.json()["id"]
    added = await client.post(
        f"{TEAMS}/{ids['team']}/users/{ids['member']}",
        headers=as_user(ids["team_owner"]),
    )
    assert added.status_code == 200, added.text
    foreign = await client.post(
        TEAMS, json={"name": "Elsewhere"}, headers=as_user(ids["outsider"])
    )
    assert foreign.status_code == 200, foreign.text
    ids["foreign_team"] = foreign.json()["id"]
    return ids


@pytest.mark.asyncio
async def test_an_admin_lists_every_team_of_the_organization(
    client: AsyncClient, org_teams: dict[str, Any]
) -> None:
    for who in ("admin", "org_owner"):
        listed = await client.get(
            TEAMS, params={"scope": "organization"}, headers=as_user(org_teams[who])
        )
        assert listed.status_code == 200, listed.text
        teams = {team["id"]: team for team in listed.json()}
        # The other organization's team never shows.
        assert set(teams) == {org_teams["team"]}, who
        planning = teams[org_teams["team"]]
        assert planning["role"] is None
        assert planning["member_count"] == 2
        preview = planning["members_preview"]
        assert [entry["role"] for entry in preview] == ["team-owner", "team-member"]
        assert preview[0]["id"] == str(org_teams["team_owner"])
        assert set(preview[0]) == {"id", "firstname", "lastname", "avatar", "role"}


@pytest.mark.asyncio
async def test_the_organization_scope_carries_the_callers_own_team_role(
    client: AsyncClient, org_teams: dict[str, Any]
) -> None:
    """A caller in a team gets their role in it, and null on the others."""
    planning, admin, org_owner = (
        org_teams["team"],
        org_teams["admin"],
        org_teams["org_owner"],
    )
    created = await client.post(
        TEAMS, json={"name": "Field work"}, headers=as_user(admin)
    )
    assert created.status_code == 200, created.text
    field_work = created.json()["id"]
    added = await client.post(
        f"{TEAMS}/{planning}/users/{org_owner}",
        headers=as_user(org_teams["team_owner"]),
    )
    assert added.status_code == 200, added.text

    expected = {
        admin: {planning: None, field_work: "team-owner"},
        org_owner: {planning: "team-member", field_work: None},
    }
    for who, roles in expected.items():
        listed = await client.get(
            TEAMS, params={"scope": "organization"}, headers=as_user(who)
        )
        assert listed.status_code == 200, listed.text
        # One row per team, whatever the caller's membership.
        assert len(listed.json()) == 2, listed.json()
        assert {team["id"]: team["role"] for team in listed.json()} == roles


@pytest.mark.asyncio
async def test_the_preview_shows_the_owner_then_three_by_name(
    client: AsyncClient, db_session: AsyncSession, org_teams: dict[str, Any]
) -> None:
    """At most four faces: the owner first (whatever their name), then by
    name without regard to case, the e-mail standing in for a missing name;
    `member_count` counts everyone."""
    team, team_owner = org_teams["team"], org_teams["team_owner"]
    names = {
        "team_owner": ("Zoe", "Zimmer"),
        "member": ("Bruno", "Berg"),
        "editor": ("Dora", "Dahl"),
        "colleague": ("anna", "Adler"),
        "org_owner": ("Carla", "Christ"),
        "admin": (None, None),  # sorts by e-mail, "authz-...@goat.test"
    }
    for who in ("editor", "colleague", "org_owner", "admin"):
        added = await client.post(
            f"{TEAMS}/{team}/users/{org_teams[who]}", headers=as_user(team_owner)
        )
        assert added.status_code == 200, added.text
    # Named after joining: adding a user without a name answers 500 today
    # (the route's response model wants strings), see task-3-report.md.
    for who, (first, last) in names.items():
        await db_session.execute(
            text(f"UPDATE {S}.user SET firstname = :f, lastname = :l WHERE id = :u"),
            {"f": first, "l": last, "u": org_teams[who]},
        )
    await db_session.commit()

    expected = [
        (org_teams["team_owner"], "Zoe", "Zimmer", "team-owner"),
        (org_teams["colleague"], "anna", "Adler", "team-member"),
        (org_teams["admin"], None, None, "team-member"),
        (org_teams["member"], "Bruno", "Berg", "team-member"),
    ]
    mine = (await client.get(TEAMS, headers=as_user(team_owner))).json()
    detail = (await client.get(f"{TEAMS}/{team}", headers=as_user(team_owner))).json()
    for answer in (mine[0], detail):
        assert answer["member_count"] == 6
        assert [
            (UUID(m["id"]), m["firstname"], m["lastname"], m["role"])
            for m in answer["members_preview"]
        ] == expected


@pytest.mark.asyncio
async def test_the_own_teams_answer_as_before_for_everyone(
    client: AsyncClient, org_teams: dict[str, Any]
) -> None:
    expected = {
        "org_owner": [],
        "admin": [],
        "editor": [],
        "team_owner": ["team-owner"],
        "member": ["team-member"],
    }
    for who, roles in expected.items():
        for params in ({}, {"scope": "mine"}):
            listed = await client.get(
                TEAMS, params=params, headers=as_user(org_teams[who])
            )
            assert listed.status_code == 200, listed.text
            assert [team["role"] for team in listed.json()] == roles, (who, params)
    mine = (await client.get(TEAMS, headers=as_user(org_teams["team_owner"]))).json()
    assert mine[0]["member_count"] == 2
    assert len(mine[0]["members_preview"]) == 2


@pytest.mark.asyncio
async def test_only_owners_and_admins_list_the_organization(
    client: AsyncClient, org_teams: dict[str, Any]
) -> None:
    for who in ("editor", "team_owner", "member"):
        refused = await client.get(
            TEAMS, params={"scope": "organization"}, headers=as_user(org_teams[who])
        )
        assert refused.status_code == 403, (who, refused.text)


@pytest.mark.asyncio
async def test_an_admin_reads_and_renames_a_team_they_are_not_in(
    client: AsyncClient, org_teams: dict[str, Any]
) -> None:
    team, admin = org_teams["team"], org_teams["admin"]
    read = await client.get(f"{TEAMS}/{team}", headers=as_user(admin))
    assert read.status_code == 200, read.text
    assert read.json()["name"] == "Planning"
    assert read.json()["role"] is None
    assert read.json()["member_count"] == 2
    # Everyone else outside the team still reads nothing.
    outside = await client.get(f"{TEAMS}/{team}", headers=as_user(org_teams["editor"]))
    assert outside.status_code == 200 and outside.json() is None

    renamed = await client.patch(
        f"{TEAMS}/{team}/profile",
        json={"name": "Planning North"},
        headers=as_user(admin),
    )
    assert renamed.status_code == 200, renamed.text
    stored = await client.get(f"{TEAMS}/{team}", headers=as_user(admin))
    assert stored.json()["name"] == "Planning North"


@pytest.mark.asyncio
async def test_an_admin_adds_and_removes_members_but_not_the_owner(
    client: AsyncClient, db_session: AsyncSession, org_teams: dict[str, Any]
) -> None:
    team, admin = org_teams["team"], org_teams["admin"]
    colleague, team_owner = org_teams["colleague"], org_teams["team_owner"]

    added = await client.post(
        f"{TEAMS}/{team}/users/{colleague}", headers=as_user(admin)
    )
    assert added.status_code == 200, added.text
    assert colleague in await _members(db_session, team)

    removed = await client.delete(
        f"{TEAMS}/{team}/users/{colleague}", headers=as_user(admin)
    )
    assert removed.status_code == 200, removed.text
    assert colleague not in await _members(db_session, team)

    owner_removed = await client.delete(
        f"{TEAMS}/{team}/users/{team_owner}", headers=as_user(admin)
    )
    assert owner_removed.status_code == 400, owner_removed.text
    assert (
        owner_removed.json()["detail"]
        == "The team's owner cannot be removed; delete the team instead"
    )
    assert team_owner in await _members(db_session, team)


@pytest.mark.asyncio
async def test_an_editor_outside_the_team_manages_nothing(
    client: AsyncClient, db_session: AsyncSession, org_teams: dict[str, Any]
) -> None:
    team, editor = org_teams["team"], org_teams["editor"]
    adds = await client.post(
        f"{TEAMS}/{team}/users/{org_teams['colleague']}", headers=as_user(editor)
    )
    assert adds.status_code == 403, adds.text
    removes = await client.delete(
        f"{TEAMS}/{team}/users/{org_teams['member']}", headers=as_user(editor)
    )
    assert removes.status_code == 403, removes.text
    renames = await client.patch(
        f"{TEAMS}/{team}/profile", json={"name": "Taken over"}, headers=as_user(editor)
    )
    assert renames.status_code == 403, renames.text
    # Leaving is for members: removing oneself from a team one is not in is
    # refused as before, not a silent success.
    leaves = await client.delete(
        f"{TEAMS}/{team}/users/{editor}", headers=as_user(editor)
    )
    assert leaves.status_code == 403, leaves.text
    assert await _members(db_session, team) == {
        org_teams["team_owner"],
        org_teams["member"],
    }


@pytest.mark.asyncio
async def test_an_admin_of_another_organization_never_manages_the_team(
    client: AsyncClient, db_session: AsyncSession, org_teams: dict[str, Any]
) -> None:
    team, outsider = org_teams["team"], org_teams["outsider"]
    read = await client.get(f"{TEAMS}/{team}", headers=as_user(outsider))
    assert read.status_code == 200 and read.json() is None
    for response in (
        await client.patch(
            f"{TEAMS}/{team}/profile",
            json={"name": "Hijacked"},
            headers=as_user(outsider),
        ),
        await client.post(
            f"{TEAMS}/{team}/users/{outsider}", headers=as_user(outsider)
        ),
        await client.delete(
            f"{TEAMS}/{team}/users/{org_teams['member']}", headers=as_user(outsider)
        ),
        await client.delete(
            f"{TEAMS}/{team}/users/{outsider}", headers=as_user(outsider)
        ),
        await client.delete(f"{TEAMS}/{team}", headers=as_user(outsider)),
    ):
        assert response.status_code == 403, response.text
    assert await _members(db_session, team) == {
        org_teams["team_owner"],
        org_teams["member"],
    }


@pytest.mark.asyncio
async def test_a_team_member_reads_the_members(
    client: AsyncClient, org_teams: dict[str, Any]
) -> None:
    for who in ("team_owner", "member"):
        listed = await client.get(
            f"{TEAMS}/{org_teams['team']}/members", headers=as_user(org_teams[who])
        )
        assert listed.status_code == 200, (who, listed.text)
        assert {member["id"] for member in listed.json()} == {
            str(org_teams["team_owner"]),
            str(org_teams["member"]),
        }, who


@pytest.mark.asyncio
async def test_an_admin_outside_the_team_reads_the_members(
    client: AsyncClient, org_teams: dict[str, Any]
) -> None:
    for who in ("admin", "org_owner"):
        listed = await client.get(
            f"{TEAMS}/{org_teams['team']}/members", headers=as_user(org_teams[who])
        )
        assert listed.status_code == 200, (who, listed.text)
        assert {member["id"] for member in listed.json()} == {
            str(org_teams["team_owner"]),
            str(org_teams["member"]),
        }, who


@pytest.mark.asyncio
async def test_a_plain_member_outside_the_team_reads_no_members(
    client: AsyncClient, org_teams: dict[str, Any]
) -> None:
    """The same answer as `GET /teams/{id}` for a team that is not theirs: null.
    Also for an admin of another organization (Review Focus 5)."""
    for who in ("editor", "outsider"):
        listed = await client.get(
            f"{TEAMS}/{org_teams['team']}/members", headers=as_user(org_teams[who])
        )
        assert listed.status_code == 200, (who, listed.text)
        assert listed.json() is None, who


@pytest.mark.asyncio
async def test_only_editors_and_up_create_a_team(
    client: AsyncClient, org_teams: dict[str, Any]
) -> None:
    """The handler's own check. The permission table says the same, but a
    database whose seed has not run yet still lets viewers through there."""
    refused = await client.post(
        TEAMS, json={"name": "Viewers"}, headers=as_user(org_teams["member"])
    )
    assert refused.status_code == 403, refused.text
    for name in ("editor", "admin", "org_owner"):
        created = await client.post(
            TEAMS, json={"name": f"Team of {name}"}, headers=as_user(org_teams[name])
        )
        assert created.status_code == 200, (name, created.text)
