"""Adding a bundle to a project asks whether it holds anything.

`bundle.status` is about the import alone (see `BundleStatus`): a bundle
assembled through `POST /bundle` + `POST /bundle/{id}/layer` never runs an
import, so it stays `processing` for ever and gating on `ready` would refuse
it for ever. What the group actually needs is members — its membership is
locked, so an empty one can never be filled from the project side, and a
bundle whose import is still running has no member links yet.
"""

from __future__ import annotations

import base64
import json
from collections.abc import Awaitable, Callable
from uuid import UUID

import pytest
from core.core.config import settings
from core.db.models._link_model import BundleLayerLink
from core.db.models.folder import Folder
from core.db.models.layer import Layer
from core.db.models.organization import Organization
from core.db.models.project import Project
from core.db.models.user import User
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

S = settings.SCHEMA


def _bearer(user_id: UUID) -> dict[str, str]:
    """Authorization header making the test client act as `user_id`."""

    def _segment(payload: dict[str, str]) -> str:
        return (
            base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
        )

    token = (
        f"{_segment({'alg': 'none', 'typ': 'JWT'})}."
        f"{_segment({'sub': str(user_id)})}.sig"
    )
    return {"Authorization": f"Bearer {token}"}


async def _bundle(db: AsyncSession, *, owner: User, folder: Folder) -> UUID:
    """A bundle exactly as `POST /bundle` leaves it: status `processing`."""
    return UUID(
        str(
            (
                await db.execute(
                    text(
                        f"INSERT INTO {S}.bundle (id, name, user_id, folder_id, "
                        "space_id, bundle_type, status, updated_at) VALUES "
                        "(gen_random_uuid(), 'hand-built network', :u, :f, :s, "
                        "'street_network', 'processing', now()) RETURNING id"
                    ),
                    {"u": owner.id, "f": folder.id, "s": folder.space_id},
                )
            ).scalar_one()
        )
    )


@pytest.mark.asyncio
async def test_a_bundle_with_members_is_added_whatever_its_import_status(
    client: AsyncClient,
    db_session: AsyncSession,
    authz_sql: None,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
    make_project: Callable[..., Awaitable[Project]],
) -> None:
    org = await make_org()
    owner = await make_user(org.id)
    folder = await make_folder(owner, "Bundles")
    project = await make_project(owner, folder)
    bundle_id = await _bundle(db_session, owner=owner, folder=folder)
    edges = await make_layer(owner, folder)
    db_session.add(
        BundleLayerLink(bundle_id=bundle_id, layer_id=edges.id, role="edges")
    )
    await db_session.commit()

    response = await client.post(
        f"{settings.API_V2_STR}/project/{project.id}/bundle/{bundle_id}",
        headers=_bearer(owner.id),
    )
    assert response.status_code == 201, response.text
    assert response.json()["bundle_id"] == str(bundle_id)

    # The member layer landed in the group.
    in_group = (
        await db_session.execute(
            text(
                f"SELECT count(*) FROM {S}.layer_project lp "
                f"JOIN {S}.layer_project_group g ON g.id = lp.layer_project_group_id "
                "WHERE g.bundle_id = :b"
            ),
            {"b": bundle_id},
        )
    ).scalar_one()
    assert in_group == 1


@pytest.mark.asyncio
async def test_a_bundle_holding_nothing_is_refused(
    client: AsyncClient,
    db_session: AsyncSession,
    authz_sql: None,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_project: Callable[..., Awaitable[Project]],
) -> None:
    """The mid-import case: no member links yet, so there is nothing to place
    and the import's own attach would collide with the group left behind."""
    org = await make_org()
    owner = await make_user(org.id)
    folder = await make_folder(owner, "Bundles")
    project = await make_project(owner, folder)
    bundle_id = await _bundle(db_session, owner=owner, folder=folder)
    await db_session.commit()

    response = await client.post(
        f"{settings.API_V2_STR}/project/{project.id}/bundle/{bundle_id}",
        headers=_bearer(owner.id),
    )
    assert response.status_code == 409, response.text
    # And nothing was committed for it.
    groups = (
        await db_session.execute(
            text(f"SELECT count(*) FROM {S}.layer_project_group WHERE bundle_id = :b"),
            {"b": bundle_id},
        )
    ).scalar_one()
    assert groups == 0


@pytest.mark.asyncio
async def test_a_bundle_left_failed_by_an_older_release_is_refused(
    client: AsyncClient,
    db_session: AsyncSession,
    authz_sql: None,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
    make_project: Callable[..., Awaitable[Project]],
) -> None:
    """Members are not enough when the import that wrote them died part-way:
    a legacy `failed` row's layers are a half-finished ingest."""
    org = await make_org()
    owner = await make_user(org.id)
    folder = await make_folder(owner, "Bundles")
    project = await make_project(owner, folder)
    bundle_id = UUID(
        str(
            (
                await db_session.execute(
                    text(
                        f"INSERT INTO {S}.bundle (id, name, user_id, folder_id, "
                        "space_id, bundle_type, status, updated_at) VALUES "
                        "(gen_random_uuid(), 'half-imported network', :u, :f, :s, "
                        "'street_network', 'failed', now()) RETURNING id"
                    ),
                    {"u": owner.id, "f": folder.id, "s": folder.space_id},
                )
            ).scalar_one()
        )
    )
    edges = await make_layer(owner, folder)
    db_session.add(
        BundleLayerLink(bundle_id=bundle_id, layer_id=edges.id, role="edges")
    )
    await db_session.commit()

    response = await client.post(
        f"{settings.API_V2_STR}/project/{project.id}/bundle/{bundle_id}",
        headers=_bearer(owner.id),
    )
    assert response.status_code == 409, response.text
    # The refusal says the import failed — not that something is "not ready".
    assert "failed" in response.json()["detail"]
    groups = (
        await db_session.execute(
            text(f"SELECT count(*) FROM {S}.layer_project_group WHERE bundle_id = :b"),
            {"b": bundle_id},
        )
    ).scalar_one()
    assert groups == 0
