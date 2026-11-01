import pytest
from core.core.config import settings
from core.db.models.credit_usage import CreditUsage
from tests.billing import enable_billing
from tests.utils import org_with_default_user


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


async def _add_rows(db_session, org, user, rows):
    for r in rows:
        db_session.add(CreditUsage(organization_id=org.id, **r))
    await db_session.commit()


@pytest.mark.asyncio
async def test_usage_lists_rows_newest_first(client, db_session):
    org, user = await org_with_default_user(db_session)
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
    org, user = await org_with_default_user(db_session)
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

    org, user = await org_with_default_user(db_session)
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


@pytest.mark.asyncio
async def test_storage_by_layer_pages_live_layers_and_sums_the_trash(
    client, db_session
):
    """The overview shows the largest layers a page at a time; trashed layers
    are not listed but still use storage until they are purged. The default
    user keeps the layers of earlier tests, so counts are read as changes."""
    from datetime import UTC, datetime

    from core.db.models.folder import Folder
    from core.db.models.layer import Layer
    from sqlalchemy import delete

    org, user = await org_with_default_user(db_session)
    url = f"{settings.API_V2_STR}/credits/storage-by-layer"
    before = (await client.get(url, params={"limit": 100})).json()
    folder = Folder(user_id=user.id, name="test-folder-storage-pages")
    db_session.add(folder)
    await db_session.flush()
    mb = 1_048_576
    # Larger than any layer another test adds (the column holds 32-bit sizes), so these lead.
    live = [("pg-a", 5), ("pg-b", 4), ("pg-c", 3), ("pg-d", 2), ("pg-e", 1)]
    trashed = [("pg-old-1", 7), ("pg-old-2", 3)]
    layers = [
        Layer(
            user_id=user.id,
            folder_id=folder.id,
            name=name,
            type="feature",
            size=1_500_000_000 + size * mb,
        )
        for name, size in live
    ] + [
        Layer(
            user_id=user.id,
            folder_id=folder.id,
            name=name,
            type="feature",
            size=size * mb,
            deleted_at=datetime.now(UTC),
        )
        for name, size in trashed
    ]
    db_session.add_all(layers)
    await db_session.commit()
    try:
        first = (await client.get(url, params={"limit": 2})).json()
        assert [r["name"] for r in first["rows"]] == ["pg-a", "pg-b"]
        assert first["total"] == before["total"] + 5
        assert first["trash"]["count"] == before["trash"]["count"] + 2
        assert round(first["trash"]["size_mb"] - before["trash"]["size_mb"], 6) == 10.0
        rest = (await client.get(url, params={"limit": 1, "offset": 4})).json()
        assert [r["name"] for r in rest["rows"]] == ["pg-e"]
        # Ten by default, never a trashed layer.
        default = (await client.get(url)).json()
        names = [r["name"] for r in default["rows"]]
        assert len(names) == min(10, first["total"])
        assert names[:5] == ["pg-a", "pg-b", "pg-c", "pg-d", "pg-e"]
        assert not {"pg-old-1", "pg-old-2"} & {
            r["name"]
            for r in (await client.get(url, params={"limit": 100})).json()["rows"]
        }
        for limit, offset in [(0, 0), (101, 0), (10, -1)]:
            refused = await client.get(url, params={"limit": limit, "offset": offset})
            assert refused.status_code == 422, (limit, offset)
    finally:
        await db_session.execute(
            delete(Layer).where(Layer.id.in_([layer.id for layer in layers]))
        )
        await db_session.commit()


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

    org, user = await org_with_default_user(db_session)
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

    org, user = await org_with_default_user(db_session)
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

    org, user = await org_with_default_user(db_session)
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

    org, user = await org_with_default_user(db_session)
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


def _ai_row(user, steps, credits, created_at=None, **payload):
    from datetime import datetime
    from uuid import uuid4

    return {
        "user_id": user.id,
        "category": "ai",
        "action": "assistant_answer",
        "unit": steps,
        "unit_type": "steps",
        "rate": credits,
        "cost": credits,
        "payload": {"run_id": str(uuid4()), "conversation_id": "secret", **payload},
        "created_at": created_at or datetime.now(),
    }


@pytest.mark.asyncio
async def test_ai_answers_are_counted_apart_from_the_credits(client, db_session):
    from datetime import datetime, timedelta

    org, user = await org_with_default_user(db_session)
    now = datetime.now()
    earlier = now.replace(day=1) - timedelta(days=3)  # last month
    await _add_rows(
        db_session,
        org,
        user,
        [
            _ledger_row(user, 2, now),
            _ledger_row(user, 20, now, "egress"),
            _ai_row(user, 4, 1, now),
            _ai_row(user, 12, 2, now),
            _ai_row(user, 25, 3, earlier),
        ],
    )
    api = f"{settings.API_V2_STR}/credits"

    def by_key(body):
        return {r["key"]: r for r in body["rows"]}

    since = {"since": (now - timedelta(days=90)).isoformat()}
    # The budget: compute and traffic only.
    categories = by_key(
        (
            await client.get(
                f"{api}/breakdown", params={"group_by": "category", **since}
            )
        ).json()
    )
    assert set(categories) == {"compute", "egress"}

    # Per tool: the tools and one row for the assistant, marked as AI credits.
    tools = by_key(
        (
            await client.get(f"{api}/breakdown", params={"group_by": "tool", **since})
        ).json()
    )
    assert tools["buffer"]["category"] == "compute"
    assert tools["assistant"]["category"] == "ai"
    assert (tools["assistant"]["count"], tools["assistant"]["credits"]) == (3, 6)
    assert tools["assistant"]["units"] == 41  # steps

    members = (
        await client.get(f"{api}/breakdown", params={"group_by": "member", **since})
    ).json()["rows"]
    [me] = [r for r in members if r["key"] == str(user.id)]
    assert (me["credits"], me["compute"], me["traffic"]) == (22, 2, 20)
    assert (me["ai_answers"], me["ai_credits"]) == (3, 6)

    months = by_key((await client.get(f"{api}/breakdown?group_by=month")).json())
    this_month = months[now.strftime("%Y-%m")]
    assert (this_month["credits"], this_month["count"]) == (22, 2)
    assert (this_month["ai_answers"], this_month["ai_credits"]) == (2, 3)
    last_month = months[earlier.strftime("%Y-%m")]
    assert (last_month["credits"], last_month["units"], last_month["count"]) == (
        0,
        0,
        0,
    )
    assert (last_month["ai_answers"], last_month["ai_credits"]) == (1, 3)

    workflows = (
        await client.get(f"{api}/breakdown", params={"group_by": "workflow", **since})
    ).json()["rows"]
    assert workflows == []


@pytest.mark.asyncio
async def test_a_member_who_only_asks_the_assistant_has_no_credits(client, db_session):
    org, user = await org_with_default_user(db_session)
    await _add_rows(db_session, org, user, [_ai_row(user, 3, 1)])
    rows = (
        await client.get(f"{settings.API_V2_STR}/credits/breakdown?group_by=member")
    ).json()["rows"]
    assert [(r["credits"], r["ai_answers"], r["ai_credits"]) for r in rows] == [
        (0, 1, 1)
    ]


@pytest.mark.asyncio
async def test_the_ledger_lists_ai_answers_without_their_payload(client, db_session):
    org, user = await org_with_default_user(db_session)
    await _add_rows(db_session, org, user, [_ai_row(user, 14, 2, model="m")])
    [item] = (await client.get(f"{settings.API_V2_STR}/credits/usage")).json()["items"]
    assert (item["category"], item["action"], item["unit_type"]) == (
        "ai",
        "assistant_answer",
        "steps",
    )
    assert (item["unit"], item["cost"]) == (14, 2)
    assert "payload" not in item
    assert "secret" not in str(item)


def _at(moment: str):
    from datetime import datetime

    return datetime.fromisoformat(moment)


@pytest.mark.asyncio
async def test_breakdown_until_is_exclusive_and_since_inclusive(client, db_session):
    org, user = await org_with_default_user(db_session)
    await _add_rows(
        db_session,
        org,
        user,
        [
            _ledger_row(user, 1, _at("2026-10-01T23:59:59")),
            _ledger_row(user, 2, _at("2026-10-02T00:00:00")),  # since: in
            _ledger_row(user, 8, _at("2026-10-02T12:00:00")),
            _ledger_row(user, 4, _at("2026-10-03T00:00:00")),  # until: out
        ],
    )
    window = {"since": "2026-10-02T00:00:00Z", "until": "2026-10-03T00:00:00Z"}
    r = await client.get(
        f"{settings.API_V2_STR}/credits/breakdown",
        params={"group_by": "day", **window},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert [(x["key"], x["credits"], x["compute"]) for x in body["rows"]] == [
        ("2026-10-02", 10.0, 10.0)
    ]
    assert (body["since"], body["until"]) == (
        "2026-10-02T00:00:00",
        "2026-10-03T00:00:00",
    )
    assert body["total"] == 1

    # The ledger takes the same window.
    usage = (
        await client.get(f"{settings.API_V2_STR}/credits/usage", params=window)
    ).json()
    assert usage["total"] == 2
    assert sorted(i["cost"] for i in usage["items"]) == [2, 8]


@pytest.mark.asyncio
async def test_breakdown_by_day_runs_oldest_first_from_the_period_start(
    client, db_session
):
    from datetime import datetime, timedelta

    org, user = await org_with_default_user(db_session)
    org.credits_reset_at = datetime.now() + timedelta(days=10)
    await db_session.commit()
    now = datetime.now()
    await _add_rows(
        db_session,
        org,
        user,
        [
            _ledger_row(user, 9, now - timedelta(days=60)),  # an earlier period
            _ledger_row(user, 1, now - timedelta(days=2)),
            _ledger_row(user, 2, now - timedelta(days=2), "egress"),
            _ai_row(user, 4, 3, now - timedelta(days=2)),
            _ledger_row(user, 4, now - timedelta(days=1)),
        ],
    )
    rows = (
        await client.get(f"{settings.API_V2_STR}/credits/breakdown?group_by=day")
    ).json()["rows"]
    two_days_ago = (now - timedelta(days=2)).strftime("%Y-%m-%d")
    yesterday = (now - timedelta(days=1)).strftime("%Y-%m-%d")
    assert [r["key"] for r in rows] == [two_days_ago, yesterday]
    first = rows[0]
    assert (first["compute"], first["traffic"], first["credits"], first["count"]) == (
        1,
        2,
        3,
        2,
    )
    assert (first["ai_answers"], first["ai_credits"]) == (1, 3)
    assert (rows[1]["compute"], rows[1]["traffic"]) == (4, 0)


async def _workflows(db_session, user, names):
    """A project "Plan" with one workflow per name."""
    from uuid import uuid4

    from core.db.models.folder import Folder
    from core.db.models.project import Project
    from core.db.models.workflow import Workflow

    folder = Folder(user_id=user.id, name=f"wf-{uuid4().hex[:6]}")
    db_session.add(folder)
    await db_session.flush()
    project = Project(id=uuid4(), user_id=user.id, folder_id=folder.id, name="Plan")
    db_session.add(project)
    await db_session.flush()
    flows = [Workflow(project_id=project.id, name=name, config={}) for name in names]
    db_session.add_all(flows)
    await db_session.commit()
    return project, flows


def _run_row(user, cost, workflow_id, run, created_at=None):
    from datetime import datetime

    return _ledger_row(
        user,
        cost,
        created_at or datetime.now(),
        workflow_id=str(workflow_id),
        workflow_run_id=run,
    )


@pytest.mark.asyncio
async def test_breakdown_by_workflow_names_it_and_pages(client, db_session):
    from uuid import uuid4

    org, user = await org_with_default_user(db_session)
    project, (big, middle, small) = await _workflows(
        db_session, user, ["Big", "Middle", "Small"]
    )
    gone = uuid4()  # a workflow deleted since it ran
    await _add_rows(
        db_session,
        org,
        user,
        [
            _run_row(user, 2, big.id, "r1", _at("2026-10-01T12:00:00")),
            _run_row(user, 3, big.id, "r2", _at("2026-10-05T12:00:00")),
            _run_row(user, 3, middle.id, "r3"),
            _run_row(user, 1, small.id, "r4"),
            _run_row(user, 0.5, gone, "r5"),
        ],
    )
    url = f"{settings.API_V2_STR}/credits/breakdown"
    everything = {"group_by": "workflow", "since": "2000-01-01T00:00:00Z"}
    r = await client.get(url, params={**everything, "limit": 2, "offset": 0})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 4
    assert [x["name"] for x in body["rows"]] == ["Big", "Middle"]
    first = body["rows"][0]
    assert (first["key"], first["project_id"], first["project_name"]) == (
        str(big.id),
        str(project.id),
        "Plan",
    )
    assert (first["credits"], first["runs"], first["count"]) == (5, 2, 2)
    assert first["last_run"].startswith("2026-10-05T12:00:00")

    r2 = await client.get(url, params={**everything, "limit": 2, "offset": 2})
    rest = r2.json()
    assert rest["total"] == 4
    assert [(x["key"], x["name"]) for x in rest["rows"]] == [
        (str(small.id), "Small"),
        (str(gone), None),  # the deleted workflow keeps its row, without a name
    ]
    assert rest["rows"][1]["project_name"] is None

    # Without a limit every row comes back, as for the older callers.
    all_rows = (await client.get(url, params=everything)).json()
    assert (all_rows["total"], len(all_rows["rows"])) == (4, 4)

    by_runs = (
        await client.get(url, params={**everything, "sort": "runs", "dir": "desc"})
    ).json()["rows"]
    assert by_runs[0]["name"] == "Big"
    by_last_run = (
        await client.get(url, params={**everything, "sort": "last_run", "dir": "asc"})
    ).json()["rows"]
    assert by_last_run[0]["name"] == "Big"  # its last run is the oldest


@pytest.mark.asyncio
async def test_breakdown_search_matches_wildcards_literally(client, db_session):
    org, user = await org_with_default_user(db_session)
    names = ["Kitas 50%", "Kitas 500", "Lots_1", "Lotsx1", "C:\\data", "C:data"]
    _, flows = await _workflows(db_session, user, names)
    await _add_rows(
        db_session,
        org,
        user,
        [_run_row(user, 1, w.id, f"r{i}") for i, w in enumerate(flows)],
    )

    async def found(q):
        r = await client.get(
            f"{settings.API_V2_STR}/credits/breakdown",
            params={"group_by": "workflow", "q": q, "since": "2000-01-01T00:00:00Z"},
        )
        assert r.status_code == 200, r.text
        return sorted(x["name"] for x in r.json()["rows"])

    assert await found("50%") == ["Kitas 50%"]
    assert await found("s_1") == ["Lots_1"]
    assert await found("\\") == ["C:\\data"]
    assert await found("kitas") == ["Kitas 50%", "Kitas 500"]  # any case
    too_long = await client.get(
        f"{settings.API_V2_STR}/credits/breakdown",
        params={"group_by": "workflow", "q": "x" * 101},
    )
    assert too_long.status_code == 422


@pytest.mark.asyncio
async def test_breakdown_blank_search_is_no_search(client, db_session):
    org, user = await org_with_default_user(db_session)
    _, flows = await _workflows(db_session, user, ["North", "South Side"])
    await _add_rows(
        db_session,
        org,
        user,
        [_run_row(user, 1, w.id, f"r{i}") for i, w in enumerate(flows)],
    )
    url = f"{settings.API_V2_STR}/credits/breakdown"
    everything = {"group_by": "workflow", "since": "2000-01-01T00:00:00Z"}
    plain = (await client.get(url, params=everything)).json()
    blank = (await client.get(url, params={**everything, "q": "  "})).json()
    assert sorted(x["name"] for x in blank["rows"]) == ["North", "South Side"]
    assert blank["rows"] == plain["rows"] and blank["total"] == plain["total"]
    padded = (await client.get(url, params={**everything, "q": " north "})).json()
    assert [x["name"] for x in padded["rows"]] == ["North"]


@pytest.mark.asyncio
async def test_breakdown_by_layer_names_it_and_its_owner(client, db_session):
    """A layer's requests are those its egress rows counted (request_count of
    traffic_rollup); a row without the count is one request."""
    from uuid import uuid4

    from core.db.models.folder import Folder
    from core.db.models.layer import Layer

    org, user = await org_with_default_user(db_session)
    folder = Folder(user_id=user.id, name="test-folder-traffic")
    db_session.add(folder)
    await db_session.flush()
    layer = Layer(user_id=user.id, folder_id=folder.id, name="Roads", type="feature")
    db_session.add(layer)
    await db_session.commit()
    gone = uuid4()
    await _add_rows(
        db_session,
        org,
        user,
        [
            _ledger_row(
                user,
                5,
                _at("2026-10-01T12:00:00"),
                "egress",
                layer_id=str(layer.id),
                request_count=40,
            ),
            _ledger_row(
                user,
                2,
                _at("2026-10-02T12:00:00"),
                "egress",
                layer_id=str(layer.id),
                request_count=2,
            ),
            _ledger_row(
                user, 1, _at("2026-10-03T12:00:00"), "egress", layer_id=str(layer.id)
            ),
            _ledger_row(
                user,
                0.5,
                _at("2026-10-02T12:00:00"),
                "egress",
                layer_id=str(gone),
                request_count=100,
            ),
        ],
    )
    url = f"{settings.API_V2_STR}/credits/breakdown"
    everything = {"group_by": "layer", "since": "2000-01-01T00:00:00Z"}
    rows = (await client.get(url, params=everything)).json()["rows"]
    assert [(r["key"], r["name"], r["owner"]) for r in rows] == [
        (str(layer.id), "Roads", "Rep Orter"),
        (str(gone), None, None),
    ]
    roads = rows[0]
    assert (roads["owner_id"], roads["credits"]) == (str(user.id), 8)
    assert (roads["requests"], roads["count"]) == (43, 3)  # 40 + 2 + 1; 3 charges
    assert isinstance(roads["requests"], int)
    by_requests = (
        await client.get(url, params={**everything, "sort": "requests"})
    ).json()["rows"]
    assert [(r["key"], r["requests"]) for r in by_requests] == [
        (str(gone), 100),
        (str(layer.id), 43),
    ]
    by_name = (
        await client.get(url, params={**everything, "q": "road", "sort": "name"})
    ).json()
    assert [r["name"] for r in by_name["rows"]] == ["Roads"]


@pytest.mark.asyncio
async def test_breakdown_sort_by_name_ascending(client, db_session):
    from uuid import uuid4

    from core.db.models.user import User

    org, user = await org_with_default_user(db_session)
    uid = uuid4()
    anna = User(
        id=uid,
        email=f"anna-{uid.hex[:8]}@goat.test",
        firstname="Anna",
        lastname="Weber",
        avatar="",
        organization_id=org.id,
    )
    db_session.add(anna)
    await db_session.commit()
    now = _at("2026-10-02T12:00:00")
    await _add_rows(
        db_session,
        org,
        user,
        [_ledger_row(user, 5, now), _ledger_row(anna, 1, now)],
    )
    url = f"{settings.API_V2_STR}/credits/breakdown"
    member = {"group_by": "member", "since": "2000-01-01T00:00:00Z"}

    async def names(**params):
        r = await client.get(url, params={**member, **params})
        assert r.status_code == 200, r.text
        return [x["name"] for x in r.json()["rows"]]

    assert await names() == ["Rep Orter", "Anna Weber"]  # most credits first
    assert await names(sort="name", dir="asc") == ["Anna Weber", "Rep Orter"]
    assert await names(sort="name", dir="desc") == ["Rep Orter", "Anna Weber"]
    assert await names(q="weber") == ["Anna Weber"]
    page = (await client.get(url, params={**member, "limit": 1, "offset": 1})).json()
    assert (page["total"], [x["name"] for x in page["rows"]]) == (2, ["Anna Weber"])

    for bad in (
        {"sort": "bogus"},
        {"sort": "runs"},  # a workflow's key, not a member's
        {"sort": "name", "dir": "sideways"},
        {"limit": 0},
        {"limit": 101},
        {"offset": -1},
    ):
        r = await client.get(url, params={**member, **bad})
        assert r.status_code == 422, bad
    r = await client.get(url, params={"group_by": "day", "sort": "credits"})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_breakdown_by_period_follows_the_reset_day(client, db_session):
    from datetime import datetime

    org, user = await org_with_default_user(db_session)
    org.credits_reset_at = datetime(2026, 11, 30)
    await db_session.commit()
    await _add_rows(
        db_session,
        org,
        user,
        [
            _ledger_row(user, 1, _at("2026-10-15T12:00:00")),
            _ledger_row(user, 2, _at("2026-10-31T12:00:00")),
            _ledger_row(user, 4, _at("2026-11-05T12:00:00")),
            _ai_row(user, 3, 2, _at("2026-11-05T12:00:00")),
        ],
    )
    r = await client.get(
        f"{settings.API_V2_STR}/credits/breakdown", params={"group_by": "period"}
    )
    assert r.status_code == 200, r.text
    body = r.json()
    rows = body["rows"]
    assert [(x["key"], x["until"], x["credits"]) for x in rows] == [
        ("2026-10-30", None, 6.0),
        ("2026-09-30", "2026-10-30", 1.0),
    ]
    assert (rows[0]["count"], rows[0]["ai_answers"], rows[0]["ai_credits"]) == (
        2,
        1,
        2,
    )
    assert (body["since"], body["total"]) == (None, 2)
    older = (
        await client.get(
            f"{settings.API_V2_STR}/credits/breakdown",
            params={"group_by": "period", "limit": 1, "offset": 1},
        )
    ).json()
    assert (older["total"], [x["key"] for x in older["rows"]]) == (2, ["2026-09-30"])


def test_period_bounds_of_a_trial_and_of_calendar_months():
    from datetime import date, datetime
    from types import SimpleNamespace

    from core.endpoints.v2.credits import _period_bounds

    trial = SimpleNamespace(
        on_trial=True, created_at=datetime(2026, 10, 3, 9), credits_reset_at=None
    )
    assert _period_bounds(trial, date(2026, 11, 20)) == (date(2026, 10, 3), None)
    months = SimpleNamespace(on_trial=False, credits_reset_at=None)
    assert _period_bounds(months, date(2026, 10, 15)) == (
        date(2026, 10, 1),
        date(2026, 11, 1),
    )
    assert _period_bounds(months, date(2026, 12, 31)) == (
        date(2026, 12, 1),
        date(2027, 1, 1),
    )
    reset = SimpleNamespace(on_trial=False, credits_reset_at=datetime(2026, 3, 31))
    assert _period_bounds(reset, date(2026, 3, 1)) == (date(2026, 2, 28), None)
    assert _period_bounds(reset, date(2026, 2, 27)) == (
        date(2026, 1, 28),
        date(2026, 2, 28),
    )


@pytest.mark.asyncio
async def test_usage_export_is_csv_of_the_range(client, db_session):
    from datetime import UTC, datetime

    org, user = await org_with_default_user(db_session)
    await _add_rows(
        db_session,
        org,
        user,
        [
            _ledger_row(user, 1, _at("2026-10-01T12:00:00")),
            _ledger_row(user, 2.5, _at("2026-10-03T12:00:00")),
            _ai_row(user, 14, 2, _at("2026-10-03T13:00:00")),
        ],
    )
    url = f"{settings.API_V2_STR}/credits/usage/export"
    before = datetime.now(UTC).date()
    r = await client.get(
        url, params={"kind": "credits", "since": "2026-10-02T00:00:00Z"}
    )
    after = datetime.now(UTC).date()
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/csv")
    assert "charset=utf-8" in r.headers["content-type"]
    lines = r.text.strip().splitlines()
    assert lines[0] == "date,member,category,action,unit,unit_type,credits"
    assert len(lines) == 2 and "buffer" in lines[1]
    assert lines[1].split(",")[:3] == ["2026-10-03T12:00:00Z", "Rep Orter", "compute"]
    # No until: up to today, the UTC day of the request (it may pass midnight).
    assert r.headers["content-disposition"] in {
        f'attachment; filename="goat-usage-credits-2026-10-02-{day.isoformat()}.csv"'
        for day in (before, after)
    }
    assert "secret" not in r.text  # never an AI answer's payload

    # The name ends with the last day the file holds: until is exclusive.
    ai = await client.get(
        url,
        params={
            "kind": "ai",
            "since": "2026-10-01T00:00:00Z",
            "until": "2026-11-01T00:00:00Z",
        },
    )
    assert ai.headers["content-disposition"] == (
        'attachment; filename="goat-usage-ai-2026-10-01-2026-10-31.csv"'
    )
    assert ai.text.strip().splitlines() == [
        "date,member,steps,ai_credits",
        "2026-10-03T13:00:00Z,Rep Orter,14,2",
    ]
    assert "secret" not in ai.text

    bad = await client.get(url, params={"kind": "everything"})
    assert bad.status_code == 422


@pytest.mark.asyncio
async def test_dates_outside_2000_to_2100_are_refused(client, db_session):
    await org_with_default_user(db_session)
    base = f"{settings.API_V2_STR}/credits"
    for route in ("/breakdown", "/usage", "/usage/export"):
        for bad in [
            {"until": "0001-01-01"},  # the day before cannot be named
            {"since": "0001-01-01T00:00:00+05:00"},  # not even in UTC
            {"since": "1999-12-31T23:59:59Z"},
            {"until": "2100-01-01T00:00:01Z"},
            {"since": "9999-12-31T23:59:59-05:00"},
        ]:
            r = await client.get(f"{base}{route}", params=bad)
            assert r.status_code == 422, (route, bad, r.status_code, r.text)
        ok = await client.get(
            f"{base}{route}",
            params={"since": "2000-01-01T00:00:00Z", "until": "2100-01-01T00:00:00Z"},
        )
        assert ok.status_code == 200, (route, ok.text)


@pytest.mark.asyncio
async def test_usage_export_refuses_a_window_that_ends_before_it_starts(
    client, db_session
):
    await org_with_default_user(db_session)
    url = f"{settings.API_V2_STR}/credits/usage/export"
    for since, until in [
        ("2026-10-02T00:00:00Z", "2026-10-01T00:00:00Z"),
        ("2026-10-02T00:00:00Z", "2026-10-02T00:00:00Z"),
    ]:
        r = await client.get(url, params={"since": since, "until": until})
        assert r.status_code == 422, (since, until, r.text)
    one_day = await client.get(
        url, params={"since": "2026-10-02T00:00:00Z", "until": "2026-10-03T00:00:00Z"}
    )
    assert one_day.status_code == 200
    assert one_day.headers["content-disposition"] == (
        'attachment; filename="goat-usage-credits-2026-10-02-2026-10-02.csv"'
    )


@pytest.mark.asyncio
async def test_usage_export_reads_the_ledger_in_batches(
    client, db_session, monkeypatch
):
    from core.endpoints.v2 import credits

    monkeypatch.setattr(credits, "_CSV_BATCH", 2)
    org, user = await org_with_default_user(db_session)
    await _add_rows(
        db_session,
        org,
        user,
        [_ledger_row(user, n, _at(f"2026-10-0{n}T12:00:00")) for n in (5, 1, 4, 2, 3)],
    )
    r = await client.get(f"{settings.API_V2_STR}/credits/usage/export")
    assert r.status_code == 200, r.text
    lines = r.text.strip().splitlines()[1:]
    assert [line.split(",")[0][:10] for line in lines] == [
        f"2026-10-0{n}" for n in (1, 2, 3, 4, 5)
    ]  # oldest first, every batch once


@pytest.mark.asyncio
async def test_usage_export_keeps_a_formula_like_name_as_text(client, db_session):
    org, user = await org_with_default_user(db_session)
    user.firstname = "=HYPERLINK(1)"
    await db_session.commit()
    try:
        await _add_rows(
            db_session, org, user, [_ledger_row(user, 1, _at("2026-10-01T12:00:00"))]
        )
        r = await client.get(f"{settings.API_V2_STR}/credits/usage/export")
        [line] = r.text.strip().splitlines()[1:]
        assert line.split(",")[1] == "'=HYPERLINK(1) Orter"
        assert line.endswith(",1")  # numbers, negative ones too, stay numbers
    finally:
        user.firstname = "Rep"
        await db_session.commit()


@pytest.mark.asyncio
async def test_a_browser_may_read_the_exports_file_name(client, db_session):
    """The web app downloads the export cross-origin and names the file from
    Content-Disposition, which CORS hides unless it is exposed."""
    await org_with_default_user(db_session)
    r = await client.get(
        f"{settings.API_V2_STR}/credits/usage/export",
        headers={"Origin": "http://example.test"},
    )
    assert r.status_code == 200, r.text
    exposed = r.headers.get("access-control-expose-headers", "")
    assert "content-disposition" in exposed.lower()
