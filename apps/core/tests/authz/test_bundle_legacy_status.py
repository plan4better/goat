"""A row written by another release must not fail the whole bundle API.

`artifact_state` deliberately tolerates a `build_status` it does not know (it
counts as `failed`), and the `status` rename deliberately leaves legacy
`failed` bundles in the table, so the read DTO has to be able to carry both.
A strict enum on either would turn one such row — core deployed before the
migration runs, or a rollback — into a validation error that fails `GET
/bundle` for every bundle the caller has, and with it the bundle selector that
feeds the routing tool forms.
"""

from __future__ import annotations

import base64
import json
from collections.abc import Awaitable, Callable
from typing import Any
from uuid import UUID

import pytest
from core.core.config import settings
from core.db.models.folder import Folder
from core.db.models.organization import Organization
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


async def _insert_bundle(
    db: AsyncSession, *, owner: User, folder: Folder, status: str, revision: int
) -> UUID:
    return UUID(
        str(
            (
                await db.execute(
                    text(
                        f"INSERT INTO {S}.bundle (id, name, user_id, folder_id, "
                        "space_id, bundle_type, status, layers_revision, "
                        "updated_at) VALUES (gen_random_uuid(), 'legacy network', "
                        ":u, :f, :s, 'street_network', :st, :r, now()) RETURNING id"
                    ),
                    {
                        "u": owner.id,
                        "f": folder.id,
                        "s": folder.space_id,
                        "st": status,
                        "r": revision,
                    },
                )
            ).scalar_one()
        )
    )


@pytest.mark.asyncio
async def test_a_bundle_written_by_another_release_still_reads(
    client: AsyncClient,
    db_session: AsyncSession,
    authz_sql: None,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
) -> None:
    org = await make_org()
    owner = await make_user(org.id)
    folder = await make_folder(owner, "Bundles")

    # `failed` is no longer part of BundleStatus and `stale` was never part of
    # BundleArtifactBuildStatus — both are what an older/newer release wrote.
    legacy = await _insert_bundle(
        db_session, owner=owner, folder=folder, status="failed", revision=3
    )
    await db_session.execute(
        text(
            f"INSERT INTO {S}.bundle_artifact (bundle_id, kind, build_status, "
            "storage_path, revision, updated_at) VALUES "
            "(:b, 'street_network_graph', 'stale', 'graph.bin', 3, now())"
        ),
        {"b": legacy},
    )
    # A second, entirely healthy bundle: the point of the DTO being tolerant is
    # that one odd row cannot take the rest of the listing down with it.
    healthy = await _insert_bundle(
        db_session, owner=owner, folder=folder, status="ready", revision=1
    )
    await db_session.commit()

    listed = await client.get(
        f"{settings.API_V2_STR}/bundle", headers=_bearer(owner.id)
    )
    assert listed.status_code == 200, listed.text
    by_id: dict[str, dict[str, Any]] = {row["id"]: row for row in listed.json()}
    assert str(healthy) in by_id, "one unreadable row must not empty the listing"

    row = by_id[str(legacy)]
    assert row["status"] == "failed", "the stored value is reported as it stands"
    artifact = row["artifacts"][0]
    # Reported verbatim, and derived to the state `artifact_state` gives an
    # unknown build status: not something to route on.
    assert artifact["build_status"] == "stale"
    assert artifact["state"] == "failed"

    read = await client.get(
        f"{settings.API_V2_STR}/bundle/{legacy}", headers=_bearer(owner.id)
    )
    assert read.status_code == 200, read.text
    assert read.json()["artifacts"][0]["build_status"] == "stale"
