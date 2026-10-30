"""Who sees which credit usage: owners and admins see the whole organization and
may filter by member; everyone else sees only their own rows."""

from collections.abc import Awaitable, Callable
from decimal import Decimal
from uuid import UUID

import pytest
from core.db.models.credit_usage import CreditUsage
from core.db.models.user import User
from sqlalchemy.ext.asyncio import AsyncSession
from tests.authz.route_world import API, give_org_role, sweep_client
from tests.billing import enable_billing
from tests.utils import make_organization


@pytest.fixture(autouse=True)
def billing_on(monkeypatch: pytest.MonkeyPatch) -> None:
    enable_billing(monkeypatch)


async def _world(db_session, make_user, roles):
    org = make_organization()
    db_session.add(org)
    await db_session.flush()
    admin = await make_user(org.id)
    editor = await make_user(org.id)
    await give_org_role(db_session, admin.id, roles["organization-admin"])
    await give_org_role(db_session, editor.id, roles["organization-editor"])
    for user, seconds in ((admin, 60), (editor, 120)):
        db_session.add(
            CreditUsage(
                organization_id=org.id,
                user_id=user.id,
                category="compute",
                action="catchment_area_v2",
                unit=Decimal(seconds),
                unit_type="seconds",
                rate=Decimal(10),
                cost=Decimal(seconds) / 6,
            )
        )
    await db_session.commit()
    return admin, editor


async def _usage(auth_on, user_id: UUID, **params: str) -> list[dict]:
    resp = await sweep_client().get(
        f"{API}/credits/usage", headers=auth_on(user_id), params=params
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["items"]


@pytest.mark.asyncio
async def test_an_admin_sees_everyone_and_filters_by_member(
    db_session: AsyncSession,
    auth_on: Callable[..., dict[str, str]],
    make_user: Callable[..., Awaitable[User]],
    roles: dict[str, UUID],
) -> None:
    admin, editor = await _world(db_session, make_user, roles)
    assert len(await _usage(auth_on, admin.id)) == 2
    only_editor = await _usage(auth_on, admin.id, member=str(editor.id))
    assert [row["unit"] for row in only_editor] == [120.0]  # numbers, not strings


@pytest.mark.asyncio
async def test_a_member_sees_only_their_own_usage(
    db_session: AsyncSession,
    auth_on: Callable[..., dict[str, str]],
    make_user: Callable[..., Awaitable[User]],
    roles: dict[str, UUID],
) -> None:
    admin, editor = await _world(db_session, make_user, roles)
    own = await _usage(auth_on, editor.id)
    assert [row["unit"] for row in own] == [120.0]
    # asking for someone else changes nothing
    assert await _usage(auth_on, editor.id, member=str(admin.id)) == own


@pytest.mark.asyncio
async def test_breakdown_by_member_has_names(
    db_session: AsyncSession,
    auth_on: Callable[..., dict[str, str]],
    make_user: Callable[..., Awaitable[User]],
    roles: dict[str, UUID],
) -> None:
    admin, _ = await _world(db_session, make_user, roles)
    resp = await sweep_client().get(
        f"{API}/credits/breakdown",
        headers=auth_on(admin.id),
        params={"group_by": "member"},
    )
    assert resp.status_code == 200, resp.text
    rows = resp.json()["rows"]
    assert len(rows) == 2
    assert all(row["name"] == "Authz Test" for row in rows)


@pytest.mark.asyncio
async def test_storage_per_layer_is_for_owners_and_admins_only(
    db_session: AsyncSession,
    auth_on: Callable[..., dict[str, str]],
    make_user: Callable[..., Awaitable[User]],
    roles: dict[str, UUID],
) -> None:
    """The listing names every member's layers, so a plain member gets 403."""
    admin, editor = await _world(db_session, make_user, roles)
    viewer = await make_user(editor.organization_id)
    await give_org_role(db_session, viewer.id, roles["organization-viewer"])
    await db_session.commit()

    async def storage(user_id: UUID) -> int:
        resp = await sweep_client().get(
            f"{API}/credits/storage-by-layer", headers=auth_on(user_id)
        )
        return resp.status_code

    assert await storage(admin.id) == 200
    assert await storage(editor.id) == 403
    assert await storage(viewer.id) == 403
