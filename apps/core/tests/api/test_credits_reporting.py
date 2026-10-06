import pytest
from core.core.config import settings
from core.db.models.credit_usage import CreditUsage
from core.db.models.user import User
from tests.utils import make_organization


async def _org_with_default_user(db_session):
    org = make_organization()
    db_session.add(org)
    await db_session.commit()
    await db_session.refresh(org)
    user = await db_session.get(User, settings.DEFAULT_USER_ID)
    if user is None:
        user = User(
            id=settings.DEFAULT_USER_ID,
            email="r@t.local",
            firstname="Rep",
            lastname="Orter",
            organization_id=org.id,
        )
        db_session.add(user)
    else:
        user.organization_id = org.id
        user.firstname = "Rep"
        user.lastname = "Orter"
    await db_session.commit()
    return org, user


async def _add_rows(db_session, org, user, rows):
    for r in rows:
        db_session.add(CreditUsage(organization_id=org.id, **r))
    await db_session.commit()


@pytest.mark.asyncio
async def test_usage_lists_rows_newest_first(client, db_session):
    org, user = await _org_with_default_user(db_session)
    await _add_rows(
        db_session,
        org,
        user,
        [
            {
                "user_id": user.id,
                "category": "compute",
                "action": "buffer",
                "unit": 4,
                "unit_type": "seconds",
                "rate": 10,
                "cost": 0.67,
                "payload": {},
            },
            {
                "user_id": None,
                "category": "egress",
                "action": "tiles",
                "unit": 1073741824,
                "unit_type": "bytes",
                "rate": 20,
                "cost": 20,
                "payload": {},
            },
        ],
    )
    resp = await client.get(f"{settings.API_V2_STR}/credits/usage?page=1&size=50")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    assert len(body["items"]) == 2
    # compute row carries the member name
    compute = [i for i in body["items"] if i["category"] == "compute"][0]
    assert compute["member"] == "Rep Orter"
    assert compute["action"] == "buffer"


@pytest.mark.asyncio
async def test_breakdown_by_tool_and_category(client, db_session):
    org, user = await _org_with_default_user(db_session)
    await _add_rows(
        db_session,
        org,
        user,
        [
            {
                "user_id": user.id,
                "category": "compute",
                "action": "buffer",
                "unit": 4,
                "unit_type": "seconds",
                "rate": 10,
                "cost": 0.67,
                "payload": {},
            },
            {
                "user_id": user.id,
                "category": "compute",
                "action": "buffer",
                "unit": 8,
                "unit_type": "seconds",
                "rate": 10,
                "cost": 1.33,
                "payload": {},
            },
            {
                "user_id": None,
                "category": "egress",
                "action": "tiles",
                "unit": 1073741824,
                "unit_type": "bytes",
                "rate": 20,
                "cost": 20,
                "payload": {},
            },
        ],
    )
    by_tool = (
        await client.get(f"{settings.API_V2_STR}/credits/breakdown?group_by=tool")
    ).json()
    buffer = [r for r in by_tool["rows"] if r["key"] == "buffer"][0]
    assert buffer["count"] == 2
    assert round(buffer["credits"], 2) == 2.0

    by_cat = (
        await client.get(f"{settings.API_V2_STR}/credits/breakdown?group_by=category")
    ).json()
    cats = {r["key"]: round(r["credits"], 2) for r in by_cat["rows"]}
    assert cats == {"compute": 2.0, "egress": 20.0}


@pytest.mark.asyncio
async def test_storage_by_layer_lists_largest_first(client, db_session):
    from core.db.models.folder import Folder
    from core.db.models.layer import Layer

    org, user = await _org_with_default_user(db_session)
    # create a folder for the layers (folder_id is NOT NULL on the layer table)
    folder = Folder(user_id=user.id, name="test-folder-storage")
    db_session.add(folder)
    await db_session.flush()
    # create two layers owned by the user, different sizes
    for name, size in [("small", 1_000_000), ("big", 9_000_000)]:
        db_session.add(
            Layer(
                user_id=user.id,
                folder_id=folder.id,
                name=name,
                type="feature",
                size=size,
            )
        )
    await db_session.commit()

    resp = await client.get(f"{settings.API_V2_STR}/credits/storage-by-layer")
    assert resp.status_code == 200
    rows = resp.json()["rows"]
    assert [r["name"] for r in rows[:2]] == ["big", "small"]  # largest first
    assert rows[0]["owner"] == "Rep Orter"
