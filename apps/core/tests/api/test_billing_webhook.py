from datetime import datetime, timedelta, timezone

import pytest
from core.core.config import settings
from tests.billing import enable_accounts_sync, enable_billing
from tests.utils import make_organization


@pytest.mark.asyncio
async def test_billing_entitlement_applies_and_resets(client, db_session, monkeypatch):
    enable_billing(monkeypatch)
    org = make_organization(total_credits=1000, used_credits=900)
    db_session.add(org)
    await db_session.commit()
    await db_session.refresh(org)

    resp = await client.post(
        f"{settings.API_V2_STR}/webhooks/billing/entitlement",
        headers={"X-Webhook-Secret": "shh"},
        json={
            "organization_id": str(org.id),
            "total_credits": 5000,
            "extras": ["white_label"],
            "plan_renewal_date": "2026-08-01T00:00:00",
            "reset_usage": True,
        },
    )
    assert resp.status_code == 200
    await db_session.refresh(org)
    assert float(org.total_credits) == 5000
    assert float(org.used_credits) == 0
    assert org.extras == ["white_label"]


@pytest.mark.asyncio
async def test_trial_webhook_expired_suspends(client, db_session, monkeypatch):
    enable_billing(monkeypatch)
    org = make_organization(
        on_trial=True, plan_renewal_date=datetime.now() - timedelta(hours=1)
    )
    db_session.add(org)
    await db_session.commit()
    await db_session.refresh(org)

    resp = await client.post(
        f"{settings.API_V2_STR}/webhooks/trial",
        headers={"X-Webhook-Secret": "shh"},
        json={"organization_id": str(org.id), "stage": "expired"},
    )
    assert resp.status_code == 200
    await db_session.refresh(org)
    assert org.suspended is True
    assert org.on_trial is True  # still a trial, just expired


@pytest.mark.asyncio
async def test_trial_webhook_expiring_does_not_suspend(client, db_session, monkeypatch):
    enable_billing(monkeypatch)
    org = make_organization(on_trial=True)
    db_session.add(org)
    await db_session.commit()
    await db_session.refresh(org)

    resp = await client.post(
        f"{settings.API_V2_STR}/webhooks/trial",
        headers={"X-Webhook-Secret": "shh"},
        json={"organization_id": str(org.id), "stage": "expiring"},
    )
    assert resp.status_code == 200
    await db_session.refresh(org)
    assert org.suspended is False


@pytest.mark.asyncio
async def test_trial_webhook_rejects_unknown_stage(client, monkeypatch):
    enable_billing(monkeypatch)
    resp = await client.post(
        f"{settings.API_V2_STR}/webhooks/trial",
        headers={"X-Webhook-Secret": "shh"},
        json={"organization_id": "x", "stage": "nonsense"},
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_billing_entitlement_bad_secret(client, monkeypatch):
    enable_billing(monkeypatch)
    resp = await client.post(
        f"{settings.API_V2_STR}/webhooks/billing/entitlement",
        headers={"X-Webhook-Secret": "wrong"},
        json={"organization_id": "x"},
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_webhooks_do_not_exist_without_billing(client, db_session, monkeypatch):
    # Self-hosted: billing is off, the routes answer 404 even with a secret.
    monkeypatch.setattr(settings, "BILLING_ENABLED", False)
    monkeypatch.setattr(settings, "BILLING_WEBHOOK_SECRET", "shh")
    org = make_organization(on_trial=True)
    db_session.add(org)
    await db_session.commit()

    for path, body in (
        ("/webhooks/billing/entitlement", {"organization_id": str(org.id)}),
        ("/webhooks/trial", {"organization_id": str(org.id), "stage": "expired"}),
    ):
        resp = await client.post(
            f"{settings.API_V2_STR}{path}",
            headers={"X-Webhook-Secret": "shh"},
            json=body,
        )
        assert resp.status_code == 404, path


@pytest.mark.asyncio
async def test_webhook_refuses_a_wrong_secret(client, db_session, monkeypatch):
    enable_billing(monkeypatch)
    org = make_organization(on_trial=True)
    db_session.add(org)
    await db_session.commit()

    resp = await client.post(
        f"{settings.API_V2_STR}/webhooks/trial",
        headers={"X-Webhook-Secret": "wrong"},
        json={"organization_id": str(org.id), "stage": "expired"},
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_conversion_starts_the_monthly_credit_period(
    client, db_session, monkeypatch
):
    from datetime import datetime, timedelta

    enable_billing(monkeypatch)
    org = make_organization(on_trial=True, total_credits=10000, used_credits=8000)
    db_session.add(org)
    await db_session.commit()
    await db_session.refresh(org)

    resp = await client.post(
        f"{settings.API_V2_STR}/webhooks/billing/entitlement",
        headers={"X-Webhook-Secret": "shh"},
        json={
            "organization_id": str(org.id),
            "on_trial": False,
            "total_credits": 25000,
            "plan_renewal_date": "2027-10-14T00:00:00",
            "reset_usage": False,
        },
    )
    assert resp.status_code == 200
    await db_session.refresh(org)
    assert org.on_trial is False
    assert float(org.used_credits) == 0
    # monthly, not with the yearly renewal
    assert (
        timedelta(days=27) < org.credits_reset_at - datetime.now() < timedelta(days=32)
    )


@pytest.mark.asyncio
async def test_a_trial_change_from_billing_starts_no_credit_period(
    client, db_session, monkeypatch
):
    enable_billing(monkeypatch)
    org = make_organization(on_trial=True, total_credits=10000, used_credits=300)
    db_session.add(org)
    await db_session.commit()

    resp = await client.post(
        f"{settings.API_V2_STR}/webhooks/billing/entitlement",
        headers={"X-Webhook-Secret": "shh"},
        json={
            "organization_id": str(org.id),
            "plan_renewal_date": "2026-12-01T23:59:59",
            "suspended": False,
            "reset_usage": False,
        },
    )
    assert resp.status_code == 200
    await db_session.refresh(org)
    assert org.on_trial is True
    assert org.credits_reset_at is None
    assert float(org.used_credits) == 300


@pytest.mark.asyncio
async def test_every_push_confirms_the_state_to_the_accounts_provider(
    client, db_session, monkeypatch
):
    from core.endpoints.v2 import webhooks

    enable_billing(monkeypatch)
    reported = []
    monkeypatch.setattr(webhooks, "report_suspension", reported.append)
    org = make_organization(on_trial=False, total_credits=25000)
    db_session.add(org)
    await db_session.commit()
    await db_session.refresh(org)

    resp = await client.post(
        f"{settings.API_V2_STR}/webhooks/billing/entitlement",
        headers={"X-Webhook-Secret": "shh"},
        json={"organization_id": str(org.id), "on_trial": False, "reset_usage": False},
    )
    assert resp.status_code == 200
    assert [o.id for o in reported] == [org.id]


URL = f"{settings.API_V2_STR}/webhooks/billing/entitlement"
TRIAL_URL = f"{settings.API_V2_STR}/webhooks/trial"
HEADERS = {"X-Webhook-Secret": "shh"}


async def _org(db_session, **values):
    org = make_organization(**values)
    db_session.add(org)
    await db_session.commit()
    await db_session.refresh(org)
    return org


async def _push(client, org_id, **body):
    return await client.post(
        URL, headers=HEADERS, json={"organization_id": str(org_id), **body}
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        {"suspended": "false"},  # a string is not a boolean
        {"on_trial": "false"},
        {"suspended": 0},
        {"suspended": None},
        {"reset_usage": "false"},
        {"total_credits": -1},
        {"total_credits": "10"},
        {"total_editors": -5},
        {"total_editors": 2.5},
        {"total_storage": float("inf")},
        {"extras": "white_label"},
        {"extras": [1, 2]},
        {"plan_renewal_date": "not a date"},
        {"plan_renewal_date": 1788000000},
        {"as_of": "yesterday"},
        {"plan": "pro"},  # unknown fields are refused
    ],
)
async def test_an_invalid_entitlement_is_refused_and_changes_nothing(
    client, db_session, monkeypatch, body
):
    enable_billing(monkeypatch)
    org = await _org(db_session, suspended=False, on_trial=True, total_credits=7)

    assert (await _push(client, org.id, **body)).status_code == 422

    await db_session.refresh(org)
    assert (org.suspended, org.on_trial, float(org.total_credits)) == (False, True, 7)


@pytest.mark.asyncio
async def test_a_malformed_organization_id_is_422_not_500(client, monkeypatch):
    enable_billing(monkeypatch)
    for org_id in ("x", None, 5):
        resp = await client.post(URL, headers=HEADERS, json={"organization_id": org_id})
        assert resp.status_code == 422, org_id
    resp = await client.post(TRIAL_URL, headers=HEADERS, json={"stage": "expired"})
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_an_unknown_organization_is_404(client, monkeypatch):
    enable_billing(monkeypatch)
    from uuid import uuid4

    assert (await _push(client, uuid4())).status_code == 404


@pytest.mark.asyncio
async def test_usage_is_kept_unless_the_push_says_reset(
    client, db_session, monkeypatch
):
    enable_billing(monkeypatch)
    org = await _org(db_session, used_credits=300)
    assert (await _push(client, org.id, total_credits=2000)).status_code == 200
    await db_session.refresh(org)
    assert float(org.used_credits) == 300

    assert (await _push(client, org.id, reset_usage=True)).status_code == 200
    await db_session.refresh(org)
    assert float(org.used_credits) == 0


@pytest.mark.asyncio
async def test_valid_types_are_applied(client, db_session, monkeypatch):
    enable_billing(monkeypatch)
    org = await _org(db_session, on_trial=True, suspended=True)
    resp = await _push(
        client,
        org.id,
        suspended=False,
        on_trial=False,
        total_credits=2500.5,
        total_storage=10240,
        total_projects=40,
        total_editors=5.0,
        total_viewers=None,
        extras=["white_label"],
    )
    assert resp.status_code == 200
    await db_session.refresh(org)
    assert (org.suspended, org.on_trial) == (False, False)
    assert float(org.total_credits) == 2500.5
    assert (org.total_projects, org.total_editors) == (40, 5)
    assert org.total_viewers is None  # null = unlimited
    assert org.extras == ["white_label"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "sent",
    [
        "2027-03-01T12:00:00",
        "2027-03-01T12:00:00Z",
        "2027-03-01T12:00:00+00:00",
        "2027-03-01T14:00:00+02:00",
        "2027-03-01T07:00:00-05:00",
    ],
)
async def test_the_renewal_is_stored_as_naive_utc(
    client, db_session, monkeypatch, sent
):
    enable_billing(monkeypatch)
    org = await _org(db_session)
    assert (await _push(client, org.id, plan_renewal_date=sent)).status_code == 200
    await db_session.refresh(org)
    assert org.plan_renewal_date == datetime(2027, 3, 1, 12, 0, 0)
    assert org.plan_renewal_date.tzinfo is None


@pytest.mark.asyncio
async def test_a_stale_push_is_ignored(client, db_session, monkeypatch):
    enable_billing(monkeypatch)
    reported = []
    from core.endpoints.v2 import webhooks

    monkeypatch.setattr(webhooks, "report_suspension", reported.append)
    org = await _org(db_session, total_credits=100)

    fresh = await _push(client, org.id, total_credits=500, as_of="2026-10-02T10:00:00Z")
    assert (fresh.status_code, fresh.json()) == (200, {"status": "ok"})
    await db_session.refresh(org)
    assert org.entitlement_as_of == datetime(2026, 10, 2, 10, 0, 0)

    stale = await _push(
        client, org.id, total_credits=1, suspended=True, as_of="2026-10-02T09:59:59Z"
    )
    assert (stale.status_code, stale.json()) == (200, {"status": "stale"})
    await db_session.refresh(org)
    assert float(org.total_credits) == 500
    assert org.suspended is False
    assert org.entitlement_as_of == datetime(2026, 10, 2, 10, 0, 0)
    assert len(reported) == 1  # nothing reported for the ignored one

    # the same time again (a retry) and a later one apply; no as_of always applies
    assert (
        await _push(client, org.id, total_credits=600, as_of="2026-10-02T10:00:00Z")
    ).json() == {"status": "ok"}
    offset_stale = await _push(
        client, org.id, total_credits=700, as_of="2026-10-02T11:59:59+02:00"
    )
    assert offset_stale.json() == {"status": "stale"}  # 09:59:59Z
    later = await _push(
        client, org.id, total_credits=750, as_of="2026-10-02T12:00:01+02:00"
    )
    assert later.json() == {"status": "ok"}
    assert (await _push(client, org.id, total_credits=800)).json() == {"status": "ok"}
    await db_session.refresh(org)
    assert float(org.total_credits) == 800
    assert org.entitlement_as_of == datetime(2026, 10, 2, 10, 0, 1)


@pytest.mark.asyncio
async def test_a_push_with_as_of_is_applied_to_an_org_without_one(
    client, db_session, monkeypatch
):
    enable_billing(monkeypatch)
    org = await _org(db_session)
    assert org.entitlement_as_of is None
    resp = await _push(client, org.id, total_credits=9, as_of="2026-01-01T00:00:00")
    assert resp.json() == {"status": "ok"}


@pytest.mark.asyncio
async def test_a_deleted_organization_stays_deleted(client, db_session, monkeypatch):
    enable_billing(monkeypatch)
    deleted = datetime(2026, 9, 1)
    org = await _org(db_session, suspended=True, deleted_at=deleted, total_credits=100)

    resp = await _push(client, org.id, suspended=False, total_credits=999)
    assert resp.status_code == 409
    await db_session.refresh(org)
    assert org.suspended is True
    assert float(org.total_credits) == 100
    assert org.deleted_at == deleted


@pytest.mark.asyncio
async def test_deleting_an_organization_marks_it_deleted(
    client, db_session, monkeypatch
):
    from core.crud import crud_organization as module
    from core.crud.crud_organization import organization as crud_org

    async def no_keycloak(user_id):
        return {}

    monkeypatch.setattr(module, "get_keycloak_user", no_keycloak)
    org = await _org(db_session)
    await crud_org.delete_organization(db=db_session, organization_obj=org)
    await db_session.refresh(org)
    assert org.suspended is True
    assert org.deleted_at is not None
    first = org.deleted_at
    await crud_org.delete_organization(db=db_session, organization_obj=org)
    assert org.deleted_at == first  # deleting again keeps the first time


async def _trial(client, org_id, stage):
    return await client.post(
        TRIAL_URL,
        headers=HEADERS,
        json={"organization_id": str(org_id), "stage": stage},
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "values",
    [
        {"on_trial": False},  # converted before the task ran
        {"suspended": True},  # already done: no second mail, no second report
        {"deleted_at": datetime(2026, 9, 1), "suspended": False},
        {"plan_renewal_date": datetime.now() + timedelta(days=3)},  # not over yet
        {"plan_renewal_date": None},
    ],
)
async def test_expired_does_nothing_unless_the_trial_is_really_over(
    client, db_session, monkeypatch, values
):
    from core.endpoints.v2 import webhooks

    enable_billing(monkeypatch)
    mails, reports = [], []
    monkeypatch.setattr(webhooks, "send_email", lambda **kw: mails.append(kw))
    monkeypatch.setattr(webhooks, "report_suspension", reports.append)
    defaults = {
        "on_trial": True,
        "suspended": False,
        "plan_renewal_date": datetime.now() - timedelta(days=1),
    }
    org = await _org(db_session, **{**defaults, **values})
    before = (org.suspended, org.on_trial, org.deleted_at)

    resp = await _trial(client, org.id, "expired")

    assert (resp.status_code, resp.json()) == (200, {"status": "noop"})
    await db_session.refresh(org)
    assert (org.suspended, org.on_trial, org.deleted_at) == before
    assert mails == [] and reports == []


@pytest.mark.asyncio
async def test_expired_suspends_once_and_reports(client, db_session, monkeypatch):
    from core.endpoints.v2 import webhooks

    enable_billing(monkeypatch)
    reports = []
    monkeypatch.setattr(webhooks, "report_suspension", reports.append)
    renewal = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(seconds=1)
    org = await _org(db_session, on_trial=True, plan_renewal_date=renewal)

    first = await _trial(client, org.id, "expired")
    again = await _trial(client, org.id, "expired")

    assert first.json()["status"] == "ok"
    assert again.json() == {"status": "noop"}
    assert [o.id for o in reports] == [org.id]
    await db_session.refresh(org)
    assert org.suspended is True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "values",
    [{"on_trial": False}, {"suspended": True}, {"deleted_at": datetime(2026, 9, 1)}],
)
async def test_expiring_is_sent_only_to_an_active_trial(
    client, db_session, monkeypatch, values
):
    from core.endpoints.v2 import webhooks

    enable_billing(monkeypatch)
    monkeypatch.setattr(settings, "ODOO_ACCOUNTS_API_KEY", None)  # GOAT's own mail
    mails = []
    monkeypatch.setattr(webhooks, "send_email", lambda **kw: mails.append(kw))
    org = await _org(db_session, **{"on_trial": True, **values})

    resp = await _trial(client, org.id, "expiring")

    assert resp.json() == {"status": "noop"}
    assert mails == []


@pytest.mark.asyncio
async def test_expiring_reaches_an_active_trial(client, db_session, monkeypatch):
    enable_accounts_sync(monkeypatch)  # the provider's campaign mails
    org = await _org(db_session, on_trial=True)
    resp = await _trial(client, org.id, "expiring")
    assert resp.json() == {"status": "ok", "stage": "expiring"}
