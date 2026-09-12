"""`DELETE /folder/{id}` and `DELETE /bundle/{id}` gate on the space rule
(`authz.require(..., "delete")` / `authorize_bundle(..., "owner")`), not on
who created the row: a space owner/admin can trash a teammate's folder or
bundle, a plain (rank-2) member cannot, and a bundle's creator only ever
holds editor rights in a team space — never owner — so they cannot delete or
share it themselves."""

from __future__ import annotations

import base64
import json
from collections.abc import Awaitable, Callable
from typing import cast
from uuid import UUID, uuid4

import pytest
from core.core.config import settings
from core.db.models.folder import Folder
from core.db.models.organization import Organization
from core.db.models.space import Space, SpaceKind
from core.db.models.team import Team
from core.db.models.user import User
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

S = settings.SCHEMA


def _unverified_bearer(user_id: UUID) -> str:
    """A JWT-shaped (but unsigned) bearer token carrying `sub`.

    `get_user_id` (endpoints/deps.py) reads `sub` via
    `jwt.get_unverified_claims` regardless of `AUTH`, so this is enough to
    make the test client act as a different caller under `AUTH=False`.
    """

    def _segment(payload: dict[str, str]) -> str:
        return (
            base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
        )

    return f"{_segment({'alg': 'none', 'typ': 'JWT'})}.{_segment({'sub': str(user_id)})}.sig"


async def _make_bundle(
    db_session: AsyncSession, *, creator: User, folder: Folder, space: Space
) -> UUID:
    return cast(
        UUID,
        (
            await db_session.execute(
                text(
                    f"INSERT INTO {S}.bundle (id, name, user_id, folder_id, space_id, "
                    "bundle_type, updated_at) VALUES "
                    "(gen_random_uuid(), 'b', :u, :f, :s, 'street_network', now()) "
                    "RETURNING id"
                ),
                {"u": creator.id, "f": folder.id, "s": space.id},
            )
        ).scalar_one(),
    )


@pytest.mark.asyncio
async def test_team_owner_can_delete_a_members_folder_and_bundle(
    client: AsyncClient,
    db_session: AsyncSession,
    roles: dict[str, UUID],
    fixture_create_user: UUID,
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_team: Callable[..., Awaitable[Team]],
    make_space: Callable[..., Awaitable[Space]],
) -> None:
    org = await make_org()
    member = await make_user(org.id)
    team = await make_team(member, org=org)
    # fixture_create_user (the default acting identity) is the team-owner.
    from core.db.models._link_model import UserTeamLink

    db_session.add(
        UserTeamLink(
            user_id=fixture_create_user,
            team_id=team.id,
            role_id=roles["team-owner"],
        )
    )
    space = await make_space(SpaceKind.team, team=team)  # default editor

    members_folder = Folder(
        id=uuid4(), user_id=member.id, space_id=space.id, name="member's folder"
    )
    bundle_folder = Folder(
        id=uuid4(), user_id=member.id, space_id=space.id, name="member's bundle folder"
    )
    db_session.add_all([members_folder, bundle_folder])
    await db_session.flush()
    bundle_id = await _make_bundle(
        db_session, creator=member, folder=bundle_folder, space=space
    )
    await db_session.commit()

    r = await client.delete(f"{settings.API_V2_STR}/folder/{members_folder.id}")
    assert r.status_code in (200, 204), r.text
    r = await client.delete(f"{settings.API_V2_STR}/bundle/{bundle_id}")
    assert r.status_code in (200, 204), r.text


@pytest.mark.asyncio
async def test_rank_two_member_cannot_delete_a_teammates_folder(
    client: AsyncClient,
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_team: Callable[..., Awaitable[Team]],
    make_space: Callable[..., Awaitable[Space]],
) -> None:
    org = await make_org()
    owner_of_content, plain_member = await make_user(org.id), await make_user(org.id)
    team = await make_team(owner_of_content, plain_member, org=org)
    space = await make_space(SpaceKind.team, team=team)  # default editor, rank 2

    teammates_folder = Folder(
        id=uuid4(),
        user_id=owner_of_content.id,
        space_id=space.id,
        name="not yours",
    )
    db_session.add(teammates_folder)
    await db_session.commit()

    r = await client.delete(
        f"{settings.API_V2_STR}/folder/{teammates_folder.id}",
        headers={"Authorization": f"Bearer {_unverified_bearer(plain_member.id)}"},
    )
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_bundle_creator_in_a_team_space_has_editor_not_owner_rights(
    client: AsyncClient,
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_team: Callable[..., Awaitable[Team]],
    make_space: Callable[..., Awaitable[Space]],
) -> None:
    org = await make_org()
    creator = await make_user(org.id)
    team = await make_team(creator, org=org)  # creator is a plain member, not owner
    space = await make_space(SpaceKind.team, team=team)

    folder = Folder(
        id=uuid4(), user_id=creator.id, space_id=space.id, name="creator's folder"
    )
    db_session.add(folder)
    await db_session.flush()
    bundle_id = await _make_bundle(
        db_session, creator=creator, folder=folder, space=space
    )
    await db_session.commit()

    headers = {"Authorization": f"Bearer {_unverified_bearer(creator.id)}"}
    r = await client.delete(
        f"{settings.API_V2_STR}/bundle/{bundle_id}", headers=headers
    )
    assert r.status_code == 403, r.text
    # Still holds ordinary editor rights (space default), just not owner.
    r = await client.get(f"{settings.API_V2_STR}/bundle/{bundle_id}", headers=headers)
    assert r.status_code == 200, r.text
