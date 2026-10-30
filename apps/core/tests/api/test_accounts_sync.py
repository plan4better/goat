"""Sign-ups and trials reported through the accounts provider (Odoo's
goat_accounts module, a fake Odoo here)."""

import asyncio
import uuid
from datetime import datetime, timedelta
from typing import Any

import pytest
import pytest_asyncio
from core.accounts import factory, sync
from core.accounts.odoo_provider import ACTION_NAME, OdooAccountsProvider
from core.core.config import settings
from core.crud import crud_organization as crud_organization_module
from core.crud.crud_organization import organization as crud_organization
from core.db.models.organization import Organization
from core.db.models.user import User
from sqlalchemy import update
from tests.billing import enable_accounts_sync
from tests.utils import make_organization


class FakeOdoo:
    def __init__(self) -> None:
        self.ops: list[dict[str, Any]] = []

    async def call(self, model: str, method: str, **kwargs: Any) -> Any:
        if method == "search":
            return [42]
        context = kwargs["context"]
        self.ops.append(context)
        if context["goat_op"] == "sign_up":
            return {"goat_contact_id": 7}
        return {"goat_company_id": 9, "goat_contact_id": 7}


def _provider_on(monkeypatch: pytest.MonkeyPatch, client: Any) -> None:
    monkeypatch.setattr(
        factory,
        "_provider",
        OdooAccountsProvider(client, ACTION_NAME),
    )


@pytest.fixture
def odoo(monkeypatch: pytest.MonkeyPatch) -> FakeOdoo:
    enable_accounts_sync(monkeypatch)
    fake = FakeOdoo()
    _provider_on(monkeypatch, fake)
    sync._last_try.clear()
    return fake


async def _settle() -> None:
    while sync._tasks:
        await asyncio.gather(*list(sync._tasks))


async def _user(db_session, **values: Any) -> User:
    user = User(
        id=uuid.uuid4(),
        email=f"{uuid.uuid4().hex[:8]}@stadt-beispiel.de",
        firstname="Anna",
        lastname="Keller",
        **values,
    )
    db_session.add(user)
    await db_session.commit()
    return user


@pytest.mark.asyncio
async def test_a_verified_user_becomes_a_contact(db_session, odoo):
    user = await _user(db_session, newsletter_subscribe=True)
    sync.report_sign_up(user, {"email_verified": True})
    await _settle()

    (op,) = odoo.ops
    assert op["goat_op"] == "sign_up"
    assert op["goat_user_id"] == str(user.id)
    assert op["goat_name"] == "Anna Keller"
    assert op["goat_marketing_consent"] is True
    await db_session.refresh(user)
    assert user.odoo_contact_id == 7


@pytest.mark.asyncio
async def test_unverified_or_known_users_are_not_reported(db_session, odoo):
    unverified = await _user(db_session)
    known = await _user(db_session, odoo_contact_id=3)
    sync.report_sign_up(unverified, {"email_verified": False})
    sync.report_sign_up(known, {"email_verified": True})
    await _settle()
    assert odoo.ops == []


@pytest.mark.asyncio
async def test_a_user_is_tried_once_per_retry_window(db_session, odoo):
    user = await _user(db_session)
    sync.report_sign_up(user, {"email_verified": True})
    sync.report_sign_up(user, {"email_verified": True})
    await _settle()
    assert len(odoo.ops) == 1


@pytest.mark.asyncio
async def test_nothing_is_reported_without_the_bridge_key(
    db_session, odoo, monkeypatch
):
    monkeypatch.setattr(settings, "ODOO_ACCOUNTS_API_KEY", None)
    user = await _user(db_session)
    sync.report_sign_up(user, {"email_verified": True})
    await _settle()
    assert odoo.ops == []


@pytest.mark.asyncio
async def test_a_trial_starts_in_odoo_and_links_the_company(db_session, odoo):
    user = await _user(db_session)
    end = datetime.now() + timedelta(days=30)
    org = make_organization(on_trial=True, plan_renewal_date=end, name="Stadt Beispiel")
    db_session.add(org)
    await db_session.commit()

    sync.report_trial(org, user.id)
    await _settle()

    sign_up, trial = odoo.ops
    assert sign_up["goat_op"] == "sign_up"
    assert trial["goat_op"] == "start_trial"
    assert trial["goat_organization_id"] == str(org.id)
    assert trial["goat_organization_name"] == "Stadt Beispiel"
    assert trial["goat_trial_end"] == end.date().isoformat()
    await db_session.refresh(org)
    assert org.odoo_company_id == 9


@pytest.mark.asyncio
async def test_a_failing_odoo_never_reaches_the_caller(db_session, odoo, monkeypatch):
    async def down(*args: Any, **kwargs: Any) -> Any:
        from core.odoo import OdooUnavailable

        raise OdooUnavailable("down")

    monkeypatch.setattr(odoo, "call", down)
    user = await _user(db_session)
    sync.report_sign_up(user, {"email_verified": True})
    await _settle()  # logged, not raised
    await db_session.refresh(user)
    assert user.odoo_contact_id is None


@pytest.mark.asyncio
async def test_a_suspension_is_reported_to_odoo(db_session, odoo):
    org = make_organization(on_trial=True, suspended=True)
    db_session.add(org)
    await db_session.commit()

    sync.report_suspension(org)
    await _settle()

    (op,) = odoo.ops
    assert op == {
        "goat_op": "status",
        "goat_organization_id": str(org.id),
        "goat_suspended": True,
        "goat_on_trial": True,
    }


@pytest.mark.asyncio
async def test_a_deleted_organization_ends_its_trial_in_odoo(
    db_session, odoo, monkeypatch
):
    """Deleting the organization reports it off trial, so the provider's trial
    campaign stops mailing its people."""
    org = make_organization(on_trial=True, suspended=False)
    db_session.add(org)
    await db_session.commit()

    async def no_keycloak_user(_user_id: Any) -> dict:
        return {}

    monkeypatch.setattr(crud_organization_module, "get_keycloak_user", no_keycloak_user)
    await crud_organization.delete_organization(organization_obj=org, db=db_session)
    await _settle()

    (op,) = odoo.ops
    assert op["goat_op"] == "status"
    assert op["goat_suspended"] is True and op["goat_on_trial"] is False


@pytest.mark.asyncio
async def test_the_sign_up_language_reaches_odoo(db_session, odoo):
    user = await _user(db_session)
    sync.report_sign_up(user, {"email_verified": True, "locale": "de"})
    await _settle()
    assert odoo.ops[0]["goat_lang"] == "de_DE"


@pytest.mark.asyncio
async def test_without_a_choice_odoo_gets_goats_default_language(db_session, odoo):
    user = await _user(db_session)
    sync.report_sign_up(user, {"email_verified": True})
    await _settle()
    assert odoo.ops[0]["goat_lang"] == "de_DE"


@pytest.mark.asyncio
async def test_later_reports_leave_the_language_alone(db_session, odoo):
    user = await _user(db_session, odoo_contact_id=7)
    org = make_organization(
        on_trial=True, plan_renewal_date=datetime.now() + timedelta(days=30)
    )
    db_session.add(org)
    await db_session.commit()
    sync.report_trial(org, user.id)
    await _settle()
    assert "goat_lang" not in odoo.ops[0]


@pytest.mark.asyncio
async def test_a_language_change_in_goat_reaches_odoo(db_session, odoo):
    known = await _user(db_session, odoo_contact_id=7)
    unknown = await _user(db_session)
    sync.report_language(known.id, "en")
    sync.report_language(unknown.id, "en")
    await _settle()
    (op,) = odoo.ops
    assert op["goat_user_id"] == str(known.id)
    assert op["goat_lang"] == "en_US"


@pytest_asyncio.fixture(autouse=True)
async def no_flagged_leftovers(db_session):
    """The retry scans every flagged organization: start each test without
    the ones earlier tests left behind."""
    await db_session.execute(
        update(Organization)
        .where(Organization.odoo_sync_pending)
        .values(odoo_sync_pending=False)
    )
    await db_session.commit()


class Down:
    """Odoo failing every call, the way a down or refusing server does."""

    def __init__(self, error: Exception) -> None:
        self.error = error

    async def call(self, *args: Any, **kwargs: Any) -> Any:
        raise self.error


async def _pending(db_session, org) -> bool:
    await db_session.refresh(org)
    return org.odoo_sync_pending


def _failing(monkeypatch, error: Exception | None = None) -> None:
    from core.odoo import OdooUnavailable

    _provider_on(monkeypatch, Down(error or OdooUnavailable("down")))


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["down", "refused", "bug"])
async def test_a_lost_report_marks_the_organization_pending(
    db_session, odoo, monkeypatch, failure
):
    from core.odoo import OdooRejected, OdooUnavailable

    error = {
        "down": OdooUnavailable("down"),
        "refused": OdooRejected(403, "AccessError", "no"),
        "bug": RuntimeError("boom"),
    }[failure]
    user = await _user(db_session)
    org = make_organization(
        on_trial=True, plan_renewal_date=datetime.now() + timedelta(days=30)
    )
    db_session.add(org)
    await db_session.commit()
    _failing(monkeypatch, error)

    for report in (
        lambda: sync.report_trial(org, user.id),
        lambda: sync.report_suspension(org),
        lambda: sync.report_join(user.id, org, "editor"),
    ):
        org.odoo_sync_pending = False
        await db_session.commit()
        report()
        await _settle()
        assert await _pending(db_session, org) is True


@pytest.mark.asyncio
async def test_a_report_that_arrives_clears_the_mark(db_session, odoo):
    org = make_organization(on_trial=True, odoo_sync_pending=True)
    db_session.add(org)
    await db_session.commit()

    sync.report_suspension(org)
    await _settle()

    assert await _pending(db_session, org) is False


@pytest.mark.asyncio
async def test_an_unflagged_organization_stays_unflagged_on_success(db_session, odoo):
    org = make_organization(on_trial=True)
    db_session.add(org)
    await db_session.commit()
    sync.report_suspension(org)
    await _settle()
    assert await _pending(db_session, org) is False


@pytest.mark.asyncio
async def test_the_retry_re_reports_everything_odoo_missed(db_session, odoo):
    owner = await _user(db_session)
    member = await _user(db_session)
    known = await _user(db_session, odoo_contact_id=3)
    org = make_organization(
        on_trial=True,
        suspended=True,
        plan_renewal_date=datetime.now() - timedelta(days=1),
        name="Stadt Beispiel",
        contact_user_id=owner.id,
        odoo_sync_pending=True,
    )
    db_session.add(org)
    await db_session.commit()
    for user in (owner, member, known):
        user.organization_id = org.id
    await db_session.commit()
    other = make_organization(on_trial=True)  # not flagged: left alone
    db_session.add(other)
    await db_session.commit()

    assert await sync.retry_pending() == 1

    ops = [(o["goat_op"], o.get("goat_user_id")) for o in odoo.ops]
    assert ("start_trial", str(owner.id)) in ops
    status = [o for o in odoo.ops if o["goat_op"] == "status"]
    assert status == [
        {
            "goat_op": "status",
            "goat_organization_id": str(org.id),
            "goat_suspended": True,
            "goat_on_trial": True,
        }
    ]
    joined = {u for op, u in ops if op == "join"}
    assert joined <= {str(owner.id), str(member.id)}  # never the known one
    assert str(member.id) in joined
    assert all(o.get("goat_organization_id") != str(other.id) for o in odoo.ops)
    await db_session.refresh(org)
    assert org.odoo_sync_pending is False
    assert org.odoo_company_id == 9


@pytest.mark.asyncio
async def test_the_retry_skips_the_trial_when_odoo_knows_the_company(db_session, odoo):
    org = make_organization(
        on_trial=True,
        odoo_company_id=5,
        plan_renewal_date=datetime.now() + timedelta(days=5),
        odoo_sync_pending=True,
    )
    db_session.add(org)
    await db_session.commit()

    await sync.retry_pending()

    assert [o["goat_op"] for o in odoo.ops] == ["status"]


@pytest.mark.asyncio
async def test_a_failing_retry_keeps_the_mark_and_carries_on(
    db_session, odoo, monkeypatch
):
    first = make_organization(on_trial=False, odoo_sync_pending=True)
    second = make_organization(on_trial=False, odoo_sync_pending=True)
    db_session.add_all([first, second])
    await db_session.commit()
    ok = odoo.call

    async def refuse_first(model, method, **kwargs):
        if kwargs.get("context", {}).get("goat_organization_id") == str(first.id):
            raise RuntimeError("boom")
        return await ok(model, method, **kwargs)

    monkeypatch.setattr(odoo, "call", refuse_first)

    assert await sync.retry_pending() == 1

    assert await _pending(db_session, first) is True
    assert await _pending(db_session, second) is False


@pytest.mark.asyncio
async def test_the_retry_loop_survives_failures_and_stops_when_cancelled(
    monkeypatch,
):
    calls = []

    async def broken() -> int:
        calls.append(1)
        raise RuntimeError("database gone")

    monkeypatch.setattr(sync, "retry_pending", broken)
    monkeypatch.setattr(sync, "RETRY_SECONDS", 0)
    loop = asyncio.create_task(sync.retry_loop())
    while len(calls) < 3:
        await asyncio.sleep(0)
    assert not loop.done()  # still alive after failing
    loop.cancel()
    with pytest.raises(asyncio.CancelledError):
        await loop


def test_the_retry_interval_is_ten_minutes():
    assert sync.RETRY_SECONDS == 600
