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
    """The listing names every member's layers, so a plain member gets 403;
    the same for its export and the list of the organization's projects."""
    admin, editor = await _world(db_session, make_user, roles)
    viewer = await make_user(editor.organization_id)
    await give_org_role(db_session, viewer.id, roles["organization-viewer"])
    await db_session.commit()

    async def status(route: str, user_id: UUID) -> int:
        resp = await sweep_client().get(
            f"{API}/credits/{route}", headers=auth_on(user_id)
        )
        return resp.status_code

    for route in ("storage-by-layer", "storage-by-layer/export", "projects"):
        assert await status(route, admin.id) == 200, route
        assert await status(route, editor.id) == 403, route
        assert await status(route, viewer.id) == 403, route


@pytest.mark.asyncio
async def test_a_member_sees_only_their_own_ai_answers(
    db_session: AsyncSession,
    auth_on: Callable[..., dict[str, str]],
    make_user: Callable[..., Awaitable[User]],
    roles: dict[str, UUID],
) -> None:
    """The ledger's AI rows follow the same scope, and never carry what the
    answer was about (the payload stays in the database)."""
    from uuid import uuid4

    admin, editor = await _world(db_session, make_user, roles)
    for user, steps in ((admin, 3), (editor, 15)):
        db_session.add(
            CreditUsage(
                organization_id=admin.organization_id,
                user_id=user.id,
                category="ai",
                action="assistant_answer",
                unit=Decimal(steps),
                unit_type="steps",
                rate=Decimal(1),
                cost=Decimal(1),
                payload={"run_id": str(uuid4()), "conversation_id": "private"},
            )
        )
    await db_session.commit()

    own = await _usage(auth_on, editor.id)
    assert sorted((row["category"], row["unit"]) for row in own) == [
        ("ai", 15.0),
        ("compute", 120.0),
    ]
    assert all("payload" not in row for row in own)
    assert len(await _usage(auth_on, admin.id)) == 4

    resp = await sweep_client().get(
        f"{API}/credits/breakdown",
        headers=auth_on(editor.id),
        params={"group_by": "member"},
    )
    assert resp.status_code == 200, resp.text
    [row] = resp.json()["rows"]
    assert (row["key"], row["ai_answers"]) == (str(editor.id), 1)

    balance = await sweep_client().get(
        f"{API}/credits/balance", headers=auth_on(editor.id)
    )
    assert balance.status_code == 200, balance.text
    assert "used_ai_credits" in balance.json()  # the pool is everyone's


@pytest.mark.asyncio
async def test_a_members_export_holds_only_their_own_rows(
    db_session: AsyncSession,
    auth_on: Callable[..., dict[str, str]],
    make_user: Callable[..., Awaitable[User]],
    roles: dict[str, UUID],
) -> None:
    """The CSV export follows the ledger's scope: asking for another member's
    rows gives a plain member their own."""
    admin, editor = await _world(db_session, make_user, roles)

    async def export(user_id: UUID, **params: str) -> list[str]:
        resp = await sweep_client().get(
            f"{API}/credits/usage/export", headers=auth_on(user_id), params=params
        )
        assert resp.status_code == 200, resp.text
        header, *rows = resp.text.strip().splitlines()
        assert header == "date,member,category,action,unit,unit_type,credits"
        return [row.split(",")[4] for row in rows]  # the seconds

    assert await export(editor.id, member=str(admin.id)) == ["120"]
    assert await export(editor.id) == ["120"]
    assert sorted(await export(admin.id)) == ["120", "60"]
    assert await export(admin.id, member=str(editor.id)) == ["120"]
