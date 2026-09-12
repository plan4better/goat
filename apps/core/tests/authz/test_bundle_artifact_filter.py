"""`GET /bundle?artifact_kind=` filters on the same rule the read reports.

Readiness has one definition — `artifact_state` over the artifact rows the
request already loads — so the listing and the DTO cannot disagree about the
same bundle. Respelled as SQL the rule loses what it cannot express: an
artifact row whose `storage_path` is present but empty points at no file, and
a `build_status` from another release is not something to route on, yet both
satisfy a `build_status = 'complete' AND storage_path IS NOT NULL` EXISTS.
"""

from __future__ import annotations

import base64
import json
from collections.abc import Awaitable, Callable
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

KIND = "street_network_graph"


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


async def _bundle_with_artifact(
    db: AsyncSession,
    *,
    owner: User,
    folder: Folder,
    name: str,
    layers_revision: int,
    build_status: str,
    revision: int | None,
    storage_path: str | None,
) -> UUID:
    bundle_id = UUID(
        str(
            (
                await db.execute(
                    text(
                        f"INSERT INTO {S}.bundle (id, name, user_id, folder_id, "
                        "space_id, bundle_type, status, layers_revision, "
                        "updated_at) VALUES (gen_random_uuid(), :n, :u, :f, :s, "
                        "'street_network', 'ready', :lr, now()) RETURNING id"
                    ),
                    {
                        "n": name,
                        "u": owner.id,
                        "f": folder.id,
                        "s": folder.space_id,
                        "lr": layers_revision,
                    },
                )
            ).scalar_one()
        )
    )
    await db.execute(
        text(
            f"INSERT INTO {S}.bundle_artifact (bundle_id, kind, build_status, "
            "storage_path, revision, updated_at) VALUES "
            "(:b, :k, :bs, :sp, :r, now())"
        ),
        {
            "b": bundle_id,
            "k": KIND,
            "bs": build_status,
            "sp": storage_path,
            "r": revision,
        },
    )
    return bundle_id


@pytest.mark.asyncio
async def test_the_filter_and_the_read_agree_on_readiness(
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

    ready = await _bundle_with_artifact(
        db_session,
        owner=owner,
        folder=folder,
        name="routable",
        layers_revision=4,
        build_status="complete",
        revision=4,
        storage_path="graph.bin",
    )
    # A finished build with nothing to point at, and one whose build status
    # this release does not know: `artifact_state` calls both `failed`.
    no_file = await _bundle_with_artifact(
        db_session,
        owner=owner,
        folder=folder,
        name="no file",
        layers_revision=4,
        build_status="complete",
        revision=4,
        storage_path="",
    )
    unknown_status = await _bundle_with_artifact(
        db_session,
        owner=owner,
        folder=folder,
        name="newer release",
        layers_revision=4,
        build_status="published",
        revision=4,
        storage_path="graph.bin",
    )
    await db_session.commit()

    async def _states(**params: str) -> dict[str, str]:
        response = await client.get(
            f"{settings.API_V2_STR}/bundle",
            params=params,
            headers=_bearer(owner.id),
        )
        assert response.status_code == 200, response.text
        return {
            row["id"]: next(
                (a["state"] for a in row["artifacts"] if a["kind"] == KIND), "none"
            )
            for row in response.json()
        }

    # Unfiltered: every bundle is listed, and each one says where its artifact
    # stands.
    unfiltered = await _states()
    assert unfiltered[str(ready)] == "ready"
    assert unfiltered[str(no_file)] == "failed"
    assert unfiltered[str(unknown_status)] == "failed"

    # Filtered: exactly the bundles the read calls ready — nothing the same
    # response would then report as failed.
    filtered = await _states(artifact_kind=KIND)
    assert set(filtered) == {str(ready)}, (
        "the artifact_kind filter must admit exactly what artifact_state calls "
        f"ready; got {filtered}"
    )

    # A kind nobody has built rules every bundle out.
    assert await _states(artifact_kind="pt_network_graph") == {}
