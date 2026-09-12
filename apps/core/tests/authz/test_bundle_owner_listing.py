"""`GET /bundle` keeps listing a bundle whose creator is gone.

`bundle.user_id` is "created by" and is set to NULL when the account is
removed (0004_spaces `_created_by_semantics`), so the owner join in the
listing is LEFT: the row still appears, with `owned_by` empty, the same shape
`GET /content` returns for an ownerless item.
"""

from __future__ import annotations

import base64
import json
from collections.abc import Awaitable, Callable
from typing import Any
from uuid import UUID

import pytest
from core.core.config import settings
from core.db.models._link_model import ResourceGrant
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


async def _list(client: AsyncClient, caller: UUID) -> list[dict[str, Any]]:
    r = await client.get(f"{settings.API_V2_STR}/bundle", headers=_bearer(caller))
    assert r.status_code == 200, r.text
    return [dict(row) for row in r.json()]


@pytest.mark.asyncio
async def test_offboarded_creators_bundle_still_lists_without_an_owner(
    client: AsyncClient,
    db_session: AsyncSession,
    authz_sql: None,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
) -> None:
    org = await make_org()
    creator = await make_user(org.id)
    caller = await make_user(org.id)
    folder = await make_folder(creator, "Bundles")
    bundle_id = UUID(
        str(
            (
                await db_session.execute(
                    text(
                        f"INSERT INTO {S}.bundle (id, name, user_id, folder_id, space_id, "
                        "bundle_type, updated_at) VALUES "
                        "(gen_random_uuid(), 'shared network', :u, :f, :s, "
                        "'street_network', now()) RETURNING id"
                    ),
                    {"u": creator.id, "f": folder.id, "s": folder.space_id},
                )
            ).scalar_one()
        )
    )
    # The caller reaches the bundle through an organization grant, not through
    # `user_id` — so the row stays in his listing once `user_id` is cleared.
    db_session.add(
        ResourceGrant(
            resource_type="bundle",
            resource_id=bundle_id,
            grantee_type="organization",
            grantee_id=org.id,
            role_id=roles["bundle-viewer"],
            granted_by=creator.id,
        )
    )
    await db_session.commit()

    with_owner = [
        b for b in await _list(client, caller.id) if b["id"] == str(bundle_id)
    ]
    assert len(with_owner) == 1, "the granted bundle is listed while its creator exists"
    assert with_owner[0]["owned_by"]["id"] == str(creator.id)

    # Offboarding the creator: `bundle.user_id` becomes NULL, the row stays.
    await db_session.execute(
        text(f"UPDATE {S}.bundle SET user_id = NULL WHERE id = :i"), {"i": bundle_id}
    )
    await db_session.commit()

    without_owner = [
        b for b in await _list(client, caller.id) if b["id"] == str(bundle_id)
    ]
    assert (
        len(without_owner) == 1
    ), "an ownerless bundle must not disappear from the listing"
    assert without_owner[0]["owned_by"] is None
