import pytest
from core.core.config import settings
from core.db.models.credit_usage import CreditUsage
from core.db.models.user import User
from tests.billing import enable_billing
from tests.utils import make_organization


@pytest.fixture(autouse=True)
def billing_on(monkeypatch: pytest.MonkeyPatch) -> None:
    enable_billing(monkeypatch)


@pytest.fixture(autouse=True)
def as_admin(monkeypatch: pytest.MonkeyPatch) -> None:
    """These tests read the organization's totals, as its admins do; who sees
    what is tested in tests/authz/test_credit_usage_scope.py."""
    from core.endpoints.v2 import credits

    async def admin(db, user_id):
        return True

    monkeypatch.setattr(credits, "_is_admin", admin)


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


def _ledger_row(user, cost, created_at, category="compute", **payload):
    return {
        "user_id": user.id,
        "category": category,
        "action": "buffer",
        "unit": 6,
        "unit_type": "seconds",
        "rate": 10,
        "cost": cost,
        "payload": payload,
        "created_at": created_at,
    }


@pytest.mark.asyncio
async def test_breakdown_counts_from_the_start_of_the_credit_period(client, db_session):
    from datetime import datetime, timedelta

    org, user = await _org_with_default_user(db_session)
    reset = datetime.now() + timedelta(days=10)
    org.credits_reset_at = reset
    await db_session.commit()
    await _add_rows(
        db_session,
        org,
        user,
        [
            _ledger_row(user, 1, datetime.now() - timedelta(days=60)),  # last periods
            _ledger_row(user, 2, datetime.now() - timedelta(days=5)),  # this one
        ],
    )

    def credits_of(body):
        return {r["key"]: round(r["credits"], 2) for r in body["rows"]}

    api = f"{settings.API_V2_STR}/credits"
    balance = (await client.get(f"{api}/balance")).json()
    assert balance["period_start"] is not None
    assert datetime.fromisoformat(balance["period_start"]) < datetime.now()

    default = (await client.get(f"{api}/breakdown?group_by=category")).json()
    assert credits_of(default) == {"compute": 2.0}
    assert default["since"] == balance["period_start"]

    since = (datetime.now() - timedelta(days=90)).isoformat()
    explicit = (
        await client.get(
            f"{api}/breakdown", params={"group_by": "category", "since": since}
        )
    ).json()
    assert credits_of(explicit) == {"compute": 3.0}

    # the monthly history is the point of group_by=month: no default bound
    months = (await client.get(f"{api}/breakdown?group_by=month")).json()
    assert round(sum(r["credits"] for r in months["rows"]), 2) == 3.0


@pytest.mark.asyncio
async def test_a_trials_usage_counts_from_its_start(client, db_session):
    from datetime import datetime, timedelta

    org, user = await _org_with_default_user(db_session)
    org.on_trial = True
    org.created_at = datetime.now() - timedelta(days=3)
    await db_session.commit()
    await _add_rows(
        db_session,
        org,
        user,
        [
            _ledger_row(user, 5, datetime.now() - timedelta(days=10)),
            _ledger_row(user, 1, datetime.now() - timedelta(days=1)),
        ],
    )
    api = f"{settings.API_V2_STR}/credits"
    balance = (await client.get(f"{api}/balance")).json()
    assert balance["period_start"] == org.created_at.isoformat()
    body = (await client.get(f"{api}/breakdown?group_by=category")).json()
    assert [round(r["credits"], 2) for r in body["rows"]] == [1.0]


@pytest.mark.asyncio
async def test_without_a_period_the_whole_ledger_counts(client, db_session):
    from datetime import datetime, timedelta

    org, user = await _org_with_default_user(db_session)
    await _add_rows(
        db_session,
        org,
        user,
        [_ledger_row(user, 4, datetime.now() - timedelta(days=400))],
    )
    api = f"{settings.API_V2_STR}/credits"
    assert (await client.get(f"{api}/balance")).json()["period_start"] is None
    body = (await client.get(f"{api}/breakdown?group_by=category")).json()
    assert [round(r["credits"], 2) for r in body["rows"]] == [4.0]


@pytest.mark.asyncio
async def test_a_compute_job_is_charged_once_but_other_categories_repeat(
    db_session,
):
    from datetime import datetime

    from sqlalchemy.exc import IntegrityError

    org, user = await _org_with_default_user(db_session)
    now = datetime.now()
    await _add_rows(
        db_session,
        org,
        user,
        [
            _ledger_row(user, 1, now, job_id="job-1"),
            _ledger_row(user, 1, now, job_id="job-2"),
            # egress is per request, not per job: the same id may repeat
            _ledger_row(user, 1, now, "egress", job_id="job-1"),
            _ledger_row(user, 1, now, "egress", job_id="job-1"),
            # a compute row without a job id (no key) is not constrained
            _ledger_row(user, 1, now),
            _ledger_row(user, 1, now),
        ],
    )
    db_session.add(
        CreditUsage(organization_id=org.id, **_ledger_row(user, 1, now, job_id="job-1"))
    )
    with pytest.raises(IntegrityError, match="uq_credit_usage_compute_job"):
        await db_session.commit()
    await db_session.rollback()


def test_sub_month_inverts_add_month():
    from datetime import datetime

    from core.crud.crud_organization import add_month, sub_month

    assert sub_month(datetime(2026, 3, 15, 8, 30)) == datetime(2026, 2, 15, 8, 30)
    assert sub_month(datetime(2026, 1, 15)) == datetime(2025, 12, 15)
    # a month's end: the previous month's last day when it is shorter
    assert sub_month(datetime(2026, 3, 31)) == datetime(2026, 2, 28)
    assert sub_month(datetime(2028, 3, 31)) == datetime(2028, 2, 29)
    assert sub_month(datetime(2026, 2, 28)) == datetime(2026, 1, 28)
    for day in (datetime(2026, 5, 31), datetime(2026, 12, 10), datetime(2027, 1, 30)):
        assert sub_month(add_month(day)).day <= day.day
