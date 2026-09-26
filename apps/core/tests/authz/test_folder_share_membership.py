"""POST /folder/{id}/share may only name a grantee inside the caller's organization."""

from collections.abc import Awaitable, Callable
from typing import Any
from uuid import UUID, uuid4

import pytest
from core.core.config import settings
from core.db.models.organization import Organization
from core.db.models.team import Team
from core.db.models.user import User
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

S = settings.SCHEMA


async def _grants(db: AsyncSession, folder_id: str) -> list[Any]:
    return list(
        (
            await db.execute(
                text(
                    f"SELECT grantee_type, grantee_id::text FROM {S}.resource_grant "
                    f"WHERE resource_type = 'folder' AND resource_id = :r ORDER BY 1,2"
                ),
                {"r": folder_id},
            )
        ).all()
    )


@pytest.mark.asyncio
async def test_folder_share_refuses_a_grantee_outside_the_callers_organization(
    client: AsyncClient,
    db_session: AsyncSession,
    roles: dict[str, UUID],
    fixture_create_user: UUID,
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_team: Callable[..., Awaitable[Team]],
) -> None:
    """Same class as S4, on the folder path.

    `authz.require(folder, delete)` settles the CALLER's right to share the
    folder and says nothing about who the grantee is, so without a membership
    check a folder owner in org A could hand org B editor on the folder and
    everything under it.
    """
    me = fixture_create_user
    mine = await make_org()
    theirs = await make_org()
    await db_session.execute(
        text(f'UPDATE {S}."user" SET organization_id = :o WHERE id = :u'),
        {"o": mine.id, "u": me},
    )
    colleague = await make_user(mine.id)
    my_team = await make_team(colleague, org=mine)
    outsider = await make_user(theirs.id)
    foreign_team = await make_team(outsider, org=theirs)
    await db_session.commit()

    created = await client.post(
        f"{settings.API_V2_STR}/folder", json={"name": "shared"}
    )
    assert created.status_code in (200, 201), created.text
    fid = created.json()["id"]

    refused = await client.post(
        f"{settings.API_V2_STR}/folder/{fid}/share",
        json={
            "grantee_type": "team",
            "grantee_id": str(foreign_team.id),
            "role": "folder-editor",
        },
    )
    assert refused.status_code == 403, refused.text
    assert await _grants(db_session, fid) == []

    refused = await client.post(
        f"{settings.API_V2_STR}/folder/{fid}/share",
        json={
            "grantee_type": "organization",
            "grantee_id": str(theirs.id),
            "role": "folder-viewer",
        },
    )
    assert refused.status_code == 403, refused.text
    assert await _grants(db_session, fid) == []

    # A grantee id that names nothing is refused the same way.
    refused = await client.post(
        f"{settings.API_V2_STR}/folder/{fid}/share",
        json={
            "grantee_type": "team",
            "grantee_id": str(uuid4()),
            "role": "folder-viewer",
        },
    )
    assert refused.status_code == 403, refused.text
    assert await _grants(db_session, fid) == []

    # A team inside the caller's own organization still goes through.
    ok = await client.post(
        f"{settings.API_V2_STR}/folder/{fid}/share",
        json={
            "grantee_type": "team",
            "grantee_id": str(my_team.id),
            "role": "folder-editor",
        },
    )
    assert ok.status_code == 200, ok.text
    assert await _grants(db_session, fid) == [("team", str(my_team.id))]


@pytest.mark.asyncio
async def test_folder_shares_with_the_organization_and_a_team_together(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_team: Callable[..., Awaitable[Team]],
) -> None:
    """A folder carries a grant per grantee, like a layer or a project: the
    whole organization can read it while one team edits it."""
    me = fixture_create_user
    mine = await make_org()
    await db_session.execute(
        text(f'UPDATE {S}."user" SET organization_id = :o WHERE id = :u'),
        {"o": mine.id, "u": me},
    )
    colleague = await make_user(mine.id)
    planners = await make_team(colleague, org=mine)
    reviewers = await make_team(colleague, org=mine)
    await db_session.commit()

    created = await client.post(
        f"{settings.API_V2_STR}/folder", json={"name": "shared"}
    )
    assert created.status_code in (200, 201), created.text
    fid = created.json()["id"]

    for grantee_type, grantee_id, role in (
        ("organization", mine.id, "folder-viewer"),
        ("team", planners.id, "folder-editor"),
        ("team", reviewers.id, "folder-viewer"),
    ):
        r = await client.post(
            f"{settings.API_V2_STR}/folder/{fid}/share",
            json={
                "grantee_type": grantee_type,
                "grantee_id": str(grantee_id),
                "role": role,
            },
        )
        assert r.status_code == 200, r.text

    assert await _grants(db_session, fid) == sorted(
        [
            ("organization", str(mine.id)),
            ("team", str(planners.id)),
            ("team", str(reviewers.id)),
        ]
    )
