from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest
from core.support.errors import (
    SupportEmailNotVerified,
    SupportForbidden,
    SupportInvalid,
    SupportRateLimited,
    SupportUnavailable,
    TicketNotFound,
)
from core.support.odoo_client import OdooRejected
from core.support.service import (
    KEYCLOAK_VERDICT_TTL,
    LIST_TTL,
    MAX_OPEN_TICKETS,
    KeycloakUser,
    NewTicketInput,
    SupportService,
)
from core.support.throttle import RateLimiter, TTLCache
from core.support.types import (
    AttachmentMeta,
    EmailProof,
    Follower,
    SupportUser,
    UploadedFile,
)

from .fakes import ORG, FakeProvider, MemoryStore, make_message, make_ticket

pytestmark = pytest.mark.unit


class FakeKeycloak:
    """Keycloak's user representation by user id; `{}` for an unknown id."""

    def __init__(self) -> None:
        self.users: dict[str, dict[str, Any]] = {}
        self.calls: list[str] = []

    def add(self, user_id: object, *, email: str, verified: object = True) -> None:
        self.users[str(user_id)] = {"email": email, "emailVerified": verified}

    async def __call__(self, user_id: str) -> dict[str, Any]:
        self.calls.append(user_id)
        return self.users.get(user_id, {})


class VerifiedKeycloak:
    """Keycloak that verified every user's stored email (the usual case)."""

    def __init__(self, store: MemoryStore) -> None:
        self._store = store

    async def __call__(self, user_id: str) -> dict[str, Any]:
        user = await self._store.load_user(UUID(user_id))
        return {"email": user.email, "emailVerified": True}


TRUSTED = EmailProof(verified_email=None, trust_stored=True)
UNVERIFIED = EmailProof(verified_email=None)


def _service(
    provider: FakeProvider,
    store: MemoryStore,
    *,
    tickets: int = 10,
    proof: EmailProof = TRUSTED,
    cache: TTLCache | None = None,
    keycloak: KeycloakUser | None = None,
) -> SupportService:
    return SupportService(
        provider,
        store,
        cache=cache or TTLCache(),
        ticket_limiter=RateLimiter(tickets, 3600),
        reply_limiter=RateLimiter(60, 3600),
        email_proof=proof,
        keycloak_user=keycloak or VerifiedKeycloak(store),
    )


def _input(**overrides: object) -> NewTicketInput:
    base = dict(
        subject="Heatmap empty",
        description="It is empty.\n\nWhy?",
        category="bug",
        impact="blocking",
        request_id="req-new",
        colleague_ids=(),
        technical={"GOAT version": "3.0.1"},
        files=(),
    )
    base.update(overrides)
    return NewTicketInput(**base)  # type: ignore[arg-type]


# ----------------------------------------------------------------- identity
async def test_reading_never_creates_a_contact() -> None:
    provider, store = FakeProvider(), MemoryStore()
    user = store.add_user(email="new@stadt.de")
    assert await _service(provider, store).list(user.id, "mine", "open") == []
    assert provider.created_contacts == []


async def test_first_write_creates_contact_under_the_org_company() -> None:
    provider, store = FakeProvider(), MemoryStore()
    store.companies[ORG] = 500
    user = store.add_user(email="new@stadt.de")
    result = await _service(provider, store).create(user.id, _input())
    assert provider.created_contacts == [
        {
            "name": "Marco Albrecht",
            "email": "new@stadt.de",
            "lang": "de",
            "company_id": 500,
        }
    ]
    assert (await store.load_user(user.id)).contact_id == provider.contacts[
        "new@stadt.de"
    ]
    assert result.ref == "00041"


async def test_existing_contact_is_linked_on_read() -> None:
    provider, store = FakeProvider(), MemoryStore()
    provider.contacts["marco@stadt.de"] = 100
    user = store.add_user(email="Marco@Stadt.de")
    provider.add(make_ticket())
    items = await _service(provider, store).list(user.id, "mine", "open")
    assert [i.ticket.ref for i in items] == ["00031"]
    assert (await store.load_user(user.id)).contact_id == 100


async def test_a_company_the_ticket_system_refuses_is_left_out_of_the_contact(
    caplog: pytest.LogCaptureFixture,
) -> None:
    provider, store = FakeProvider(), MemoryStore()
    store.companies[ORG] = 500
    provider.refused_companies.add(500)
    user = store.add_user(email="new@stadt.de")
    with caplog.at_level("WARNING"):
        await _service(provider, store).create(user.id, _input())
    assert [c["company_id"] for c in provider.created_contacts] == [None]
    assert str(ORG) in caplog.text and "500" in caplog.text


async def test_colleagues_get_a_contact_without_a_refused_company() -> None:
    provider, store = FakeProvider(), MemoryStore()
    store.companies[ORG] = 500
    provider.refused_companies.add(500)
    me = store.add_user(email="m@x.de", contact_id=100)
    anna = store.add_user(email="anna@x.de", name="Anna")
    await _service(provider, store).create(me.id, _input(colleague_ids=(anna.id,)))
    assert provider.created_contacts == [
        {"name": "Anna", "email": "anna@x.de", "lang": "de", "company_id": None}
    ]


# --------------------------------------------------------------- visibility
async def test_member_sees_own_and_followed_tickets_only() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    provider.add(make_ticket(id=31, ref="00031", customer_contact_id=100))
    provider.add(
        make_ticket(id=29, ref="00029", customer_contact_id=101),
        followers=(Follower(100, "Marco", False),),
    )
    provider.add(make_ticket(id=27, ref="00027", customer_contact_id=102))
    service = _service(provider, store)
    assert {i.ticket.ref for i in await service.list(me.id, "mine", "open")} == {
        "00031",
        "00029",
    }
    with pytest.raises(TicketNotFound):
        await service.get(me.id, "00027")
    with pytest.raises(SupportForbidden):
        await service.list(me.id, "org", "open")


async def test_member_list_stamps_own_email_tickets() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    provider.add(
        make_ticket(
            id=28,
            ref="00028",
            customer_contact_id=100,
            org_id=None,
            via="email",
            request_id=None,
        )
    )
    provider.add(
        make_ticket(id=27, ref="00027", customer_contact_id=101, org_id=None),
        followers=(Follower(100, "Marco", False),),
    )
    await _service(provider, store).list(me.id, "mine", "open")
    assert provider.stamped == [
        ((28,), str(ORG))
    ]  # followed-only ticket stays unstamped


async def test_admin_sees_unstamped_email_ticket_of_member() -> None:
    provider, store = FakeProvider(), MemoryStore()
    admin = store.add_user(email="admin@x.de", admin=True, contact_id=100)
    # Anna's contact is known to GOAT (e.g. she opened a ticket in GOAT once);
    # her email ticket was never stamped with the organization.
    store.add_user(email="anna@x.de", name="Anna Keller", contact_id=101)
    provider.add(
        make_ticket(
            id=29,
            ref="00029",
            customer_contact_id=101,
            org_id=None,
            via="email",
            request_id=None,
        )
    )
    service = _service(provider, store)
    items = await service.list(admin.id, "org", "open")
    assert [i.ticket.ref for i in items] == ["00029"]
    assert provider.stamped == [((29,), str(ORG))]
    view = await service.get(admin.id, "00029")
    assert not view.on_ticket and view.can_manage_people


async def test_other_orgs_tickets_stay_hidden_from_admins() -> None:
    provider, store = FakeProvider(), MemoryStore()
    admin = store.add_user(email="admin@x.de", admin=True, contact_id=100)
    provider.add(
        make_ticket(id=50, ref="00050", customer_contact_id=999, org_id=str(uuid4()))
    )
    with pytest.raises(TicketNotFound):
        await _service(provider, store).get(admin.id, "00050")


# ------------------------------------------------------------------- unread
async def test_first_list_seeds_markers_and_later_agent_reply_is_unread() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    provider.add(
        make_ticket(
            id=31, ref="00031", latest_message_id=70, latest_message_is_agent=True
        )
    )
    service = _service(provider, store)
    (first,) = await service.list(me.id, "mine", "open")
    assert not first.unread  # seeded on the first ever visit
    # A new email ticket arrives later, with an agent reply the user never saw in GOAT.
    provider.add(
        make_ticket(
            id=33, ref="00033", latest_message_id=80, latest_message_is_agent=True
        )
    )
    # …and an agent answers on the old one.
    provider.add(
        make_ticket(
            id=31, ref="00031", latest_message_id=75, latest_message_is_agent=True
        )
    )
    service._cache.invalidate((me.id,))  # noqa: SLF001 — skip the 30 s list cache
    unread = {i.ticket.ref: i.unread for i in await service.list(me.id, "mine", "open")}
    assert unread == {"00031": True, "00033": True}
    summary = await service.summary(me.id)
    assert summary.unread == 2


async def test_opening_a_ticket_marks_it_read() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    store.markers[me.id] = {0: 100, 31: 60}
    provider.add(
        make_ticket(latest_message_id=75),
        messages=(make_message(60, 100), make_message(75, 300, agent=True)),
    )
    await _service(provider, store).get(me.id, "00031")
    assert store.markers[me.id][31] == 75


async def test_needs_reply_counts_only_waiting_tickets_on_me() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    store.markers[me.id] = {0: 100}  # seeded for contact 100
    provider.add(make_ticket(id=30, ref="00030", status="waiting"))
    provider.add(make_ticket(id=31, ref="00031", status="in_progress"))
    assert (await _service(provider, store).summary(me.id)).needs_reply == 1


async def test_summary_follows_the_list_cache_not_its_own() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    store.markers[me.id] = {0: 100, 31: 60}
    provider.add(make_ticket(latest_message_id=60))
    clock = [0.0]
    service = _service(provider, store, cache=TTLCache(now=lambda: clock[0]))
    assert (await service.summary(me.id)).unread == 0
    provider.add(
        make_ticket(latest_message_id=75, latest_message_is_agent=True),
    )
    clock[0] = LIST_TTL - 1
    assert (await service.summary(me.id)).unread == 0  # still the cached list
    clock[0] = LIST_TTL + 1
    assert (await service.summary(me.id)).unread == 1  # no extra summary TTL


async def test_summary_counts_replies_on_recently_closed_tickets() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    store.markers[me.id] = {0: 100}  # seeded for contact 100
    now = datetime.now(UTC)
    recent = now - timedelta(days=13)
    old = now - timedelta(days=15)
    provider.add(
        make_ticket(
            id=31,
            ref="00031",
            status="solved",
            closed_at=recent,
            updated_at=recent,
            latest_message_id=70,
            latest_message_is_agent=True,
        )
    )
    provider.add(
        make_ticket(
            id=32,
            ref="00032",
            status="solved",
            closed_at=old,
            updated_at=old,
            latest_message_id=71,
            latest_message_is_agent=True,
        )
    )
    # closed without a close date: falls back to the last update
    provider.add(
        make_ticket(
            id=33,
            ref="00033",
            status="cancelled",
            closed_at=None,
            updated_at=recent,
            latest_message_id=72,
            latest_message_is_agent=True,
        )
    )
    # read ticket closed recently: not counted
    store.markers[me.id][34] = 73
    provider.add(
        make_ticket(
            id=34,
            ref="00034",
            status="solved",
            closed_at=recent,
            updated_at=recent,
            latest_message_id=73,
            latest_message_is_agent=True,
        )
    )
    summary = await _service(provider, store).summary(me.id)
    assert summary.unread == 2
    assert summary.needs_reply == 0  # open tickets only


async def test_closed_ticket_never_needs_a_reply() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    store.markers[me.id] = {0: 100}  # seeded for contact 100
    provider.add(
        make_ticket(
            status="solved", closed_at=datetime.now(UTC), updated_at=datetime.now(UTC)
        )
    )
    assert (await _service(provider, store).summary(me.id)).needs_reply == 0


# --------------------------------------------------------------- duplicates
async def test_create_with_known_request_id_returns_existing_ticket() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    provider.add(make_ticket(id=31, ref="00031", request_id="req-new", status="new"))
    result = await _service(provider, store).create(me.id, _input())
    assert result.ref == "00031"
    assert provider.created == []


# ------------------------------------------------------------------- create
async def test_create_escapes_description_adds_details_colleagues_and_files() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    anna = store.add_user(email="anna@x.de", name="Anna Keller")
    files = (
        UploadedFile("a.png", "image/png", b"1"),
        UploadedFile("broken.pdf", "application/pdf", b"2"),
    )
    result = await _service(provider, store).create(
        me.id, _input(description="<b>x</b>", colleague_ids=(anna.id,), files=files)
    )
    (new,) = provider.created
    assert new.description_html.startswith("<p>&lt;b&gt;x&lt;/b&gt;</p>")
    assert "<li>GOAT version: 3.0.1</li>" in new.description_html
    assert new.org_id == str(ORG) and new.user_id == str(me.id)
    assert provider.follower_changes == [("add", 41, (provider.contacts["anna@x.de"],))]
    assert provider.posts == [(41, 100, "", ("a.png", "broken.pdf"))]
    assert result.failed_files == ("broken.pdf",)


async def test_create_rejects_colleagues_from_another_org() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    stranger = store.add_user(email="s@y.de", org=uuid4())
    with pytest.raises(SupportForbidden):
        await _service(provider, store).create(
            me.id, _input(colleague_ids=(stranger.id,))
        )


async def test_ticket_rate_limit() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    service = _service(provider, store, tickets=1)
    await service.create(me.id, _input(request_id="a"))
    with pytest.raises(SupportRateLimited):
        await service.create(me.id, _input(request_id="b"))


# -------------------------------------------------------------------- reply
async def test_reply_reopens_waiting_and_admin_joins_first() -> None:
    provider, store = FakeProvider(), MemoryStore()
    admin = store.add_user(email="admin@x.de", admin=True, contact_id=200)
    provider.add(make_ticket(status="waiting", customer_contact_id=100))
    await _service(provider, store).reply(admin.id, "00031", "Answer", ())
    assert provider.follower_changes == [("add", 31, (200,))]
    assert provider.posts == [(31, 200, "Answer", ())]
    assert provider.statuses == [(31, "in_progress")]


async def test_empty_reply_without_files_is_invalid() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    provider.add(make_ticket())
    with pytest.raises(SupportInvalid):
        await _service(provider, store).reply(me.id, "00031", "   ", ())


# ------------------------------------------------------ followers & ratings
async def test_internal_followers_are_hidden_and_protected() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    provider.add(
        make_ticket(),
        followers=(Follower(26, "Majk", True), Follower(101, "Anna", False)),
    )
    service = _service(provider, store)
    view = await service.get(me.id, "00031")
    assert [f.contact_id for f in view.detail.followers] == [101]
    with pytest.raises(SupportForbidden):
        await service.update_followers(me.id, "00031", (), (26,))
    await service.update_followers(me.id, "00031", (), (101,))
    assert provider.follower_changes == [("remove", 31, (101,))]


async def test_ticket_customer_is_not_listed_as_a_follower() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=101)
    # Odoo auto-subscribes the ticket partner (100), so it appears among the followers.
    provider.add(
        make_ticket(),
        followers=(Follower(100, "Marco", False), Follower(101, "Anna", False)),
    )
    service = _service(provider, store)
    view = await service.get(me.id, "00031")
    assert [f.contact_id for f in view.detail.followers] == [101]
    with pytest.raises(SupportForbidden):
        await service.update_followers(me.id, "00031", (), (100,))


async def test_rating_only_when_solved() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    provider.add(make_ticket(status="in_progress"))
    service = _service(provider, store)
    with pytest.raises(SupportInvalid):
        await service.rate(me.id, "00031", "top", "")
    provider.add(make_ticket(status="solved"))
    await service.rate(me.id, "00031", "top", "Thanks")
    assert provider.ratings == [(31, 100, "top", "Thanks")]


async def test_my_rating_shows_on_a_solved_ticket_the_user_rated() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    provider.add(make_ticket(status="solved"))
    provider.my_ratings[(31, 100)] = "ok"
    view = await _service(provider, store).get(me.id, "00031")
    assert view.my_rating == "ok"
    assert provider.my_rating_calls == [(31, 100)]


async def test_my_rating_is_none_when_not_rated_yet() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    provider.add(make_ticket(status="solved"))
    view = await _service(provider, store).get(me.id, "00031")
    assert view.my_rating is None


async def test_my_rating_is_not_looked_up_before_the_ticket_is_solved() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    provider.add(make_ticket(status="in_progress"))
    provider.my_ratings[(31, 100)] = "top"
    view = await _service(provider, store).get(me.id, "00031")
    assert view.my_rating is None and provider.my_rating_calls == []


async def test_my_rating_is_not_looked_up_for_an_admin_not_on_the_ticket() -> None:
    provider, store = FakeProvider(), MemoryStore()
    admin = store.add_user(email="a@x.de", admin=True, contact_id=200)
    provider.add(make_ticket(status="solved"))
    provider.my_ratings[(31, 200)] = "top"
    view = await _service(provider, store).get(admin.id, "00031")
    assert not view.on_ticket
    assert view.my_rating is None and provider.my_rating_calls == []


@pytest.mark.parametrize(
    "error", [SupportUnavailable("down"), OdooRejected(403, "AccessError", "no")]
)
async def test_a_failed_rating_lookup_reads_as_not_rated(error: Exception) -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    provider.add(make_ticket(status="solved"))
    provider.my_rating_error = error
    view = await _service(provider, store).get(me.id, "00031")
    assert view.my_rating is None and view.detail.ticket.ref == "00031"


# ----------------------------------------------------------------- download
async def test_download_refuses_attachment_not_on_visible_message() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    att = AttachmentMeta(900, "map.png", "image/png", 3)
    provider.add(make_ticket(), messages=(make_message(60, 100, attachments=(att,)),))
    service = _service(provider, store)
    meta, data = await service.download(me.id, "00031", 900)
    assert data == b"PNG"
    with pytest.raises(TicketNotFound):
        await service.download(me.id, "00031", 901)  # e.g. an internal-note file


# ------------------------------------------------------------ fix round 1
async def test_admin_of_another_org_cannot_manage_people_on_a_foreign_ticket() -> None:
    provider, store = FakeProvider(), MemoryStore()
    org_b = uuid4()
    admin_b = store.add_user(email="b@y.de", admin=True, contact_id=100, org=org_b)
    colleague_b = store.add_user(email="c@y.de", contact_id=103, org=org_b)
    provider.add(
        make_ticket(customer_contact_id=101, org_id=str(ORG)),
        followers=(Follower(100, "B", False), Follower(102, "Anna", False)),
    )
    service = _service(provider, store)
    assert not (await service.get(admin_b.id, "00031")).can_manage_people
    with pytest.raises(SupportForbidden):
        await service.update_followers(admin_b.id, "00031", (colleague_b.id,), ())
    with pytest.raises(SupportForbidden):
        await service.update_followers(admin_b.id, "00031", (), (102,))
    assert provider.follower_changes == []


async def test_org_list_hides_member_tickets_stamped_with_another_org() -> None:
    provider, store = FakeProvider(), MemoryStore()
    admin = store.add_user(email="admin@x.de", admin=True, contact_id=100)
    store.add_user(email="anna@x.de", contact_id=101)
    provider.add(
        make_ticket(id=29, ref="00029", customer_contact_id=101, org_id=str(uuid4()))
    )
    provider.add(
        make_ticket(id=30, ref="00030", customer_contact_id=101, org_id=str(ORG))
    )
    items = await _service(provider, store).list(admin.id, "org", "open")
    assert [i.ticket.ref for i in items] == ["00030"]
    assert provider.stamped == []


async def test_opening_a_ticket_first_still_seeds_older_tickets_as_read() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    provider.add(
        make_ticket(
            id=31, ref="00031", latest_message_id=70, latest_message_is_agent=True
        )
    )
    provider.add(
        make_ticket(
            id=33, ref="00033", latest_message_id=80, latest_message_is_agent=True
        )
    )
    service = _service(provider, store)
    await service.get(me.id, "00031")  # e.g. a deep link, before any list
    unread = {i.ticket.ref: i.unread for i in await service.list(me.id, "mine", "open")}
    assert unread == {"00031": False, "00033": False}


async def test_nothing_is_seeded_while_the_user_has_no_contact() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de")
    service = _service(provider, store)
    await service.summary(me.id)  # the header polls before any contact exists
    assert store.markers.get(me.id, {}) == {}


async def test_email_tickets_of_a_contact_found_later_are_seeded_as_read() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de")
    service = _service(provider, store)
    await service.summary(me.id)
    # later the user's email turns up as a contact with a history of email tickets
    provider.contacts["m@x.de"] = 100
    provider.add(
        make_ticket(
            id=31, ref="00031", latest_message_id=70, latest_message_is_agent=True
        )
    )
    service._cache.invalidate((me.id,))  # noqa: SLF001 — skip the list cache
    service._cache.invalidate(("no_contact", me.id))  # noqa: SLF001
    (item,) = await service.list(me.id, "mine", "open")
    assert not item.unread
    assert store.markers[me.id] == {0: 100, 31: 70}


async def test_a_relinked_user_is_seeded_again_for_the_new_contact() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=5000)
    provider.add(make_ticket(id=31, ref="00031", customer_contact_id=5000))
    service = _service(provider, store)
    await service.list(me.id, "mine", "open")
    assert store.markers[me.id][0] == 5000
    # 5000 is merged into the older contact 100, which has an unread email ticket
    provider.dead_contacts.add(5000)
    provider.contacts["m@x.de"] = 100
    provider.add(
        make_ticket(
            id=29,
            ref="00029",
            customer_contact_id=100,
            latest_message_id=80,
            latest_message_is_agent=True,
        )
    )
    service._cache.invalidate((me.id,))  # noqa: SLF001
    service._cache.invalidate(("contact_ok", me.id))  # noqa: SLF001
    items = await service.list(me.id, "mine", "open")
    assert [(i.ticket.ref, i.unread) for i in items] == [("00029", False)]
    assert store.markers[me.id][0] == 100  # overwritten, although lower


async def test_users_marked_visited_before_they_had_a_contact_are_seeded() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    store.markers[me.id] = {0: 0}  # the earlier per-user "visited" marker
    provider.add(
        make_ticket(
            id=31, ref="00031", latest_message_id=70, latest_message_is_agent=True
        )
    )
    (item,) = await _service(provider, store).list(me.id, "mine", "open")
    assert not item.unread
    assert store.markers[me.id] == {0: 100, 31: 70}


async def test_seeded_users_are_not_seeded_again() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    store.markers[me.id] = {0: 100}
    provider.add(
        make_ticket(
            id=31, ref="00031", latest_message_id=70, latest_message_is_agent=True
        )
    )
    (item,) = await _service(provider, store).list(me.id, "mine", "open")
    assert item.unread
    assert store.markers[me.id] == {0: 100}


async def test_closed_tickets_are_seeded_as_read_too() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    provider.add(make_ticket(id=31, ref="00031", status="in_progress"))
    provider.add(
        make_ticket(
            id=32,
            ref="00032",
            status="solved",
            latest_message_id=90,
            latest_message_is_agent=True,
        )
    )
    service = _service(provider, store)
    await service.list(me.id, "mine", "open")  # first ever visit looks at open only
    (closed,) = await service.list(me.id, "mine", "closed")
    assert not closed.unread


async def test_create_needs_a_request_id() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    provider.add(make_ticket(id=31, ref="00031", request_id=None))
    for blank in ("", "  "):
        with pytest.raises(SupportInvalid):
            await _service(provider, store).create(me.id, _input(request_id=blank))
    assert provider.created == []


async def test_create_rejects_a_blank_description_before_any_write() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="new@x.de")  # no contact yet
    with pytest.raises(SupportInvalid) as exc:
        await _service(provider, store).create(me.id, _input(description=" \n\t "))
    assert exc.value.message == "empty_description"
    assert provider.created == [] and provider.created_contacts == []


async def test_rejected_create_writes_nothing_and_costs_no_token() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="new@x.de")  # no contact yet
    stranger = store.add_user(email="s@y.de", org=uuid4())
    service = _service(provider, store, tickets=1)
    with pytest.raises(SupportForbidden):
        await service.create(me.id, _input(colleague_ids=(stranger.id,)))
    with pytest.raises(SupportInvalid):
        await service.create(me.id, _input(subject="x"))
    assert provider.created_contacts == [] and provider.created == []
    await service.create(me.id, _input())  # the single token is still there


async def test_user_without_org_cannot_name_colleagues() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100, org=None)
    provider.add(make_ticket())
    service = _service(provider, store)
    with pytest.raises(SupportForbidden):
        await service.create(me.id, _input(colleague_ids=(uuid4(),)))
    with pytest.raises(SupportForbidden):
        await service.update_followers(me.id, "00031", (uuid4(),), ())
    assert provider.created == [] and provider.follower_changes == []


async def test_revoked_admin_does_not_get_the_cached_org_list() -> None:
    provider, store = FakeProvider(), MemoryStore()
    admin = store.add_user(email="admin@x.de", admin=True, contact_id=100)
    provider.add(make_ticket(customer_contact_id=100))
    service = _service(provider, store)
    assert len(await service.list(admin.id, "org", "open")) == 1
    store.users[admin.id] = replace(store.users[admin.id], is_org_admin=False)
    with pytest.raises(SupportForbidden):
        await service.list(admin.id, "org", "open")


async def test_org_admin_not_on_the_ticket_cannot_rate_but_can_resolve() -> None:
    provider, store = FakeProvider(), MemoryStore()
    admin = store.add_user(email="admin@x.de", admin=True, contact_id=100)
    provider.add(make_ticket(status="solved", customer_contact_id=101, org_id=str(ORG)))
    service = _service(provider, store)
    with pytest.raises(SupportForbidden):
        await service.rate(admin.id, "00031", "top", "")
    assert provider.ratings == []
    provider.add(
        make_ticket(status="in_progress", customer_contact_id=101, org_id=str(ORG))
    )
    await service.resolve(admin.id, "00031")
    assert provider.statuses == [(31, "solved")]


# ---------------------------------------------- final review: email proof
async def test_unverified_email_is_never_used_to_find_a_contact() -> None:
    provider, store = FakeProvider(), MemoryStore()
    provider.contacts["victim@x.de"] = 100
    provider.add(make_ticket(customer_contact_id=100))
    me = store.add_user(email="victim@x.de")  # changed in the profile, unverified
    service = _service(provider, store, proof=UNVERIFIED)
    assert await service.list(me.id, "mine", "open") == []
    assert (await service.summary(me.id)).unread == 0
    with pytest.raises(TicketNotFound):
        await service.get(me.id, "00031")
    assert provider.email_lookups == []
    assert (await store.load_user(me.id)).contact_id is None


async def test_unverified_email_cannot_write_and_costs_no_token() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="new@x.de")
    service = _service(provider, store, tickets=1, proof=UNVERIFIED)
    with pytest.raises(SupportEmailNotVerified):
        await service.create(me.id, _input())
    assert provider.created == [] and provider.created_contacts == []
    service._email_proof = TRUSTED  # noqa: SLF001 — the user verified the address
    await service.create(me.id, _input())  # the single token is still there


async def test_token_email_must_match_the_stored_email() -> None:
    provider, store = FakeProvider(), MemoryStore()
    provider.contacts["victim@x.de"] = 100
    provider.add(make_ticket(customer_contact_id=100))
    me = store.add_user(email="victim@x.de")
    # the token still carries the old, verified address
    old = EmailProof(verified_email="me@old.de")
    assert await _service(provider, store, proof=old).list(me.id, "mine", "open") == []
    with pytest.raises(SupportEmailNotVerified):
        await _service(provider, store, proof=old).create(me.id, _input())
    assert provider.email_lookups == []
    # once the new address is verified (token email == stored, any case) it links
    new = EmailProof(verified_email="Victim@X.de")
    items = await _service(provider, store, proof=new).list(me.id, "mine", "open")
    assert [i.ticket.ref for i in items] == ["00031"]
    assert (await store.load_user(me.id)).contact_id == 100


async def test_a_stored_contact_keeps_working_without_a_verified_email() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="changed@x.de", contact_id=100)
    provider.add(make_ticket(customer_contact_id=100))
    service = _service(provider, store, proof=UNVERIFIED)
    assert [i.ticket.ref for i in await service.list(me.id, "mine", "open")] == [
        "00031"
    ]
    await service.reply(me.id, "00031", "Still me", ())
    assert provider.posts == [(31, 100, "Still me", ())]
    assert provider.email_lookups == []


async def test_unverified_admin_without_contact_cannot_reply() -> None:
    provider, store = FakeProvider(), MemoryStore()
    admin = store.add_user(email="admin@x.de", admin=True)
    provider.add(make_ticket(customer_contact_id=101, org_id=str(ORG)))
    service = _service(provider, store, proof=UNVERIFIED)
    with pytest.raises(SupportEmailNotVerified):
        await service.reply(admin.id, "00031", "Hi", ())
    assert provider.posts == [] and provider.created_contacts == []


async def test_no_contact_answer_is_cached_for_ten_minutes() -> None:
    provider, store = FakeProvider(), MemoryStore()
    clock = [0.0]
    cache = TTLCache(now=lambda: clock[0])
    me = store.add_user(email="new@x.de")
    service = _service(provider, store, cache=cache)
    await service.list(me.id, "mine", "open")
    service._cache.invalidate((me.id,))  # noqa: SLF001 — skip the list cache
    await service.list(me.id, "mine", "closed")
    assert len(provider.email_lookups) == 1
    clock[0] += 601
    service._cache.invalidate((me.id,))  # noqa: SLF001
    await service.list(me.id, "mine", "open")
    assert len(provider.email_lookups) == 2


async def test_creating_a_contact_clears_the_no_contact_answer() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="new@x.de")
    service = _service(provider, store)
    await service.list(me.id, "mine", "open")
    assert service._cache.get(("no_contact", me.id, "new@x.de"))  # noqa: SLF001
    await service.create(me.id, _input())
    assert service._cache.get(("no_contact", me.id, "new@x.de")) is None  # noqa: SLF001


async def test_colleague_with_an_unverified_email_is_refused_and_nothing_written() -> (
    None
):
    provider, store, keycloak = FakeProvider(), MemoryStore(), FakeKeycloak()
    me = store.add_user(email="m@x.de", contact_id=100)
    # Anna's GOAT email may be anyone's: an Odoo contact with it exists, e.g. a
    # stranger's, and Odoo would email that address about the ticket
    provider.contacts["victim@customer.de"] = 101
    anna = store.add_user(email="victim@customer.de", name="Anna Keller")
    keycloak.add(anna.id, email="victim@customer.de", verified=False)
    service = _service(provider, store, keycloak=keycloak)
    with pytest.raises(SupportInvalid, match="colleague_email_not_verified"):
        await service.create(me.id, _input(colleague_ids=(anna.id,)))
    provider.add(make_ticket(customer_contact_id=100))
    with pytest.raises(SupportInvalid, match="colleague_email_not_verified"):
        await service.update_followers(me.id, "00031", (anna.id,), ())
    assert provider.created == [] and provider.created_contacts == []
    assert provider.email_lookups == [] and provider.follower_changes == []
    assert (await store.load_user(anna.id)).contact_id is None


async def test_adding_yourself_as_colleague_creates_no_contact() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    provider.add(make_ticket(customer_contact_id=100))
    await _service(provider, store, proof=UNVERIFIED).update_followers(
        me.id, "00031", (me.id,), ()
    )
    assert provider.created_contacts == []


async def test_org_list_uses_stored_contacts_only() -> None:
    provider, store = FakeProvider(), MemoryStore()
    admin = store.add_user(email="admin@x.de", admin=True, contact_id=100)
    store.add_user(email="anna@x.de", name="Anna Keller")  # no stored contact
    provider.contacts["anna@x.de"] = 101
    provider.add(make_ticket(id=29, ref="00029", customer_contact_id=101, org_id=None))
    service = _service(provider, store)
    assert await service.list(admin.id, "org", "open") == []
    with pytest.raises(TicketNotFound):
        await service.get(admin.id, "00029")
    assert provider.stamped == []
    assert all("anna@x.de" not in lookup for lookup in provider.email_lookups)


async def test_bridge_partner_is_never_a_follower() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    provider.add(
        make_ticket(),
        followers=(
            Follower(7, "GOAT Support Bot", False),
            Follower(101, "A", False),
        ),
    )
    service = _service(provider, store)
    view = await service.get(me.id, "00031")
    assert [f.contact_id for f in view.detail.followers] == [101]
    with pytest.raises(SupportForbidden):
        await service.update_followers(me.id, "00031", (), (7,))


# ------------------------------------------ final review: partial failures
async def test_files_and_colleagues_failing_after_create_do_not_fail_it() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    anna = store.add_user(email="anna@x.de", contact_id=101)

    async def down(*_: object, **__: object) -> None:
        raise SupportUnavailable("timeout")

    async def refused(*_: object, **__: object) -> None:
        raise OdooRejected(403, "odoo.exceptions.AccessError", "no")

    provider.add_followers = down  # type: ignore[method-assign]
    provider.post_message = refused  # type: ignore[method-assign]
    files = (UploadedFile("a.png", "image/png", b"1"), UploadedFile("b.pdf", "x", b"2"))
    result = await _service(provider, store).create(
        me.id, _input(colleague_ids=(anna.id,), files=files)
    )
    assert result.ref == "00041"
    assert result.message_id is None
    assert result.failed_files == ("a.png", "b.pdf")


async def test_missing_post_action_after_create_reports_the_files() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)

    async def missing(*_: object, **__: object) -> None:
        raise LookupError("server action not found")

    provider.post_message = missing  # type: ignore[method-assign]
    result = await _service(provider, store).create(
        me.id, _input(files=(UploadedFile("a.png", "image/png", b"1"),))
    )
    assert (result.ref, result.failed_files) == ("00041", ("a.png",))


async def test_retry_of_a_create_reports_its_files_as_not_attached() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    provider.add(make_ticket(id=31, ref="00031", request_id="req-new", status="new"))
    result = await _service(provider, store).create(
        me.id, _input(files=(UploadedFile("a.png", "image/png", b"1"),))
    )
    assert (result.ref, result.failed_files) == ("00031", ("a.png",))
    assert provider.posts == []


async def test_list_is_ordered_by_latest_activity() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    t0 = make_ticket().created_at
    provider.add(make_ticket(id=1, ref="00001", updated_at=t0))
    provider.add(make_ticket(id=2, ref="00002", updated_at=t0 + timedelta(hours=2)))
    provider.add(make_ticket(id=3, ref="00003", updated_at=t0 + timedelta(hours=1)))
    items = await _service(provider, store).list(me.id, "mine", "open")
    assert [i.ticket.ref for i in items] == ["00002", "00003", "00001"]


# ------------------------------------------- a stored contact that is gone
async def test_deleted_contact_is_cleared_and_relinked_by_the_verified_email(
    caplog: pytest.LogCaptureFixture,
) -> None:
    provider, store = FakeProvider(), MemoryStore()
    provider.dead_contacts = {100}  # merged away
    provider.contacts["marco@stadt.de"] = 200  # the surviving contact
    provider.add(make_ticket(customer_contact_id=200))
    me = store.add_user(email="marco@stadt.de", contact_id=100)
    with caplog.at_level("WARNING", logger="core.support.service"):
        items = await _service(provider, store).list(me.id, "mine", "open")
    assert [i.ticket.ref for i in items] == ["00031"]
    assert store.cleared == [me.id]  # cleared once, not again after the relink
    assert (await store.load_user(me.id)).contact_id == 200
    assert provider.email_lookups == [("marco@stadt.de",)]
    assert any("no longer exists" in r.message for r in caplog.records)


async def test_deleted_contact_without_a_verified_email_is_just_no_contact() -> None:
    provider, store = FakeProvider(), MemoryStore()
    provider.dead_contacts = {100}
    provider.contacts["marco@stadt.de"] = 200
    provider.add(make_ticket(customer_contact_id=200))
    me = store.add_user(email="marco@stadt.de", contact_id=100)
    service = _service(provider, store, proof=UNVERIFIED)
    assert await service.list(me.id, "mine", "open") == []
    assert (await store.load_user(me.id)).contact_id is None
    assert provider.email_lookups == []  # the email gate still applies
    with pytest.raises(SupportEmailNotVerified):
        await service.create(me.id, _input())
    assert provider.created == [] and provider.created_contacts == []


async def test_write_with_a_deleted_contact_uses_the_relinked_one() -> None:
    provider, store = FakeProvider(), MemoryStore()
    provider.dead_contacts = {100}
    provider.contacts["marco@stadt.de"] = 200
    provider.add(make_ticket(customer_contact_id=200))
    me = store.add_user(email="marco@stadt.de", contact_id=100)
    await _service(provider, store).reply(me.id, "00031", "Still me", ())
    assert provider.posts == [(31, 200, "Still me", ())]
    assert provider.created_contacts == []


async def test_deleted_contact_with_no_match_gets_a_new_one_on_write() -> None:
    provider, store = FakeProvider(), MemoryStore()
    provider.dead_contacts = {100}
    me = store.add_user(email="marco@stadt.de", contact_id=100)
    await _service(provider, store).create(me.id, _input())
    assert [c["email"] for c in provider.created_contacts] == ["marco@stadt.de"]
    assert (await store.load_user(me.id)).contact_id == provider.next_contact


@pytest.mark.parametrize(
    "error", [SupportUnavailable(), OdooRejected(403, "AccessError", "no")]
)
async def test_a_failed_check_never_clears_the_stored_contact(
    error: Exception,
) -> None:
    provider, store = FakeProvider(), MemoryStore()
    provider.contacts_exist_error = error
    provider.add(make_ticket(customer_contact_id=100))
    me = store.add_user(email="marco@stadt.de", contact_id=100)
    service = _service(provider, store)
    assert [i.ticket.ref for i in await service.list(me.id, "mine", "open")] == [
        "00031"
    ]
    assert store.cleared == []
    assert (await store.load_user(me.id)).contact_id == 100
    # an error is not remembered: the next request asks again, and now clears
    asked = len(provider.contact_checks)
    provider.contacts_exist_error = None
    provider.dead_contacts = {100}
    service._cache.invalidate((me.id,))  # noqa: SLF001 — skip the list cache
    await service.list(me.id, "mine", "open")
    assert len(provider.contact_checks) > asked
    assert store.cleared == [me.id]


async def test_the_contact_check_is_cached_for_ten_minutes() -> None:
    provider, store = FakeProvider(), MemoryStore()
    clock = [0.0]
    cache = TTLCache(now=lambda: clock[0])
    provider.add(make_ticket(customer_contact_id=100))
    me = store.add_user(email="marco@stadt.de", contact_id=100)
    service = _service(provider, store, cache=cache)
    await service.list(me.id, "mine", "open")
    await service.get(me.id, "00031")
    await service.reply(me.id, "00031", "Hi", ())
    service._cache.invalidate((me.id,))  # noqa: SLF001
    await service.list(me.id, "mine", "closed")
    assert provider.contact_checks == [(100,)]
    clock[0] += 601
    service._cache.invalidate((me.id,))  # noqa: SLF001
    await service.list(me.id, "mine", "open")
    assert provider.contact_checks == [(100,), (100,)]


async def test_a_contact_that_was_just_linked_is_not_checked_again() -> None:
    provider, store = FakeProvider(), MemoryStore()
    provider.contacts["marco@stadt.de"] = 100
    provider.add(make_ticket(customer_contact_id=100))
    me = store.add_user(email="marco@stadt.de")
    service = _service(provider, store)
    await service.list(me.id, "mine", "open")
    service._cache.invalidate((me.id,))  # noqa: SLF001
    await service.list(me.id, "mine", "closed")
    assert provider.contact_checks == []


# ------------------------------------- a colleague's stored contact that is gone
async def test_colleague_with_a_merged_contact_is_linked_again_when_added() -> None:
    provider, store = FakeProvider(), MemoryStore()
    store.companies[ORG] = 500
    me = store.add_user(email="m@x.de", contact_id=100)
    anna = store.add_user(email="anna@x.de", name="Anna Keller", contact_id=101)
    provider.dead_contacts = {101}  # merged away in Odoo
    provider.contacts["anna@x.de"] = 102  # the surviving one, of her verified email
    provider.add(make_ticket(customer_contact_id=100))
    await _service(provider, store).update_followers(me.id, "00031", (anna.id,), ())
    assert store.cleared == [anna.id]
    assert (await store.load_user(anna.id)).contact_id == 102
    assert provider.created_contacts == []
    assert provider.follower_changes == [("add", 31, (102,))]
    assert provider.email_lookups == [("anna@x.de",)]


async def test_colleagues_named_on_a_new_ticket_are_checked_in_one_batch() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    anna = store.add_user(email="anna@x.de", contact_id=101)
    ben = store.add_user(email="ben@x.de", contact_id=103)
    provider.dead_contacts = {103}
    service = _service(provider, store)
    await service.create(me.id, _input(colleague_ids=(anna.id, ben.id)))
    new_ben = (await store.load_user(ben.id)).contact_id
    assert (101, 103) in provider.contact_checks
    assert provider.follower_changes == [("add", 41, (101, new_ben))]
    # a live colleague contact is cached like the user's own
    checks = len(provider.contact_checks)
    await service.update_followers(me.id, "00041", (anna.id,), ())
    assert len(provider.contact_checks) == checks


async def test_a_failed_colleague_check_adds_nobody_and_clears_nothing() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    anna = store.add_user(email="anna@x.de", contact_id=101)
    provider.add(make_ticket(customer_contact_id=100))
    service = _service(provider, store)
    await service.get(me.id, "00031")  # caches the check of my own contact
    provider.contacts_exist_error = SupportUnavailable()
    with pytest.raises(SupportUnavailable):
        await service.update_followers(me.id, "00031", (anna.id,), ())
    assert provider.follower_changes == [] and store.cleared == []
    assert (await store.load_user(anna.id)).contact_id == 101


# ------------------------------------ a colleague without a contact: Keycloak
@dataclass
class Setup:
    provider: FakeProvider
    store: MemoryStore
    keycloak: FakeKeycloak
    service: SupportService
    me: SupportUser
    anna: SupportUser


def _colleague_setup(
    *, kc_email: str | None = "anna@x.de", verified: object = True
) -> Setup:
    provider, store, keycloak = FakeProvider(), MemoryStore(), FakeKeycloak()
    store.companies[ORG] = 500
    me = store.add_user(email="m@x.de", contact_id=100)
    anna = store.add_user(email="anna@x.de", name="Anna Keller")
    if kc_email is not None:
        keycloak.add(anna.id, email=kc_email, verified=verified)
    service = _service(provider, store, keycloak=keycloak)
    return Setup(provider, store, keycloak, service, me, anna)


async def test_colleague_with_a_stored_contact_needs_no_keycloak() -> None:
    provider, store, keycloak = FakeProvider(), MemoryStore(), FakeKeycloak()
    me = store.add_user(email="m@x.de", contact_id=100)
    anna = store.add_user(email="anna@x.de", contact_id=101)
    keycloak.add(anna.id, email="anna@x.de")
    await _service(provider, store, keycloak=keycloak).create(
        me.id, _input(colleague_ids=(anna.id,))
    )
    assert keycloak.calls == [] and provider.email_lookups == []
    assert provider.created_contacts == []
    assert provider.follower_changes == [("add", 41, (101,))]


async def test_verified_colleague_is_linked_to_the_existing_odoo_contact() -> None:
    c = _colleague_setup()
    provider, store, service, me, anna = c.provider, c.store, c.service, c.me, c.anna
    keycloak = c.keycloak
    provider.contacts["anna@x.de"] = 101  # already a customer in Odoo
    await service.create(me.id, _input(colleague_ids=(anna.id,)))
    assert provider.created_contacts == []
    assert provider.email_lookups == [("anna@x.de",)]
    assert (await store.load_user(anna.id)).contact_id == 101
    assert provider.follower_changes == [("add", 41, (101,))]
    assert keycloak.calls == [str(anna.id)]


async def test_keycloak_email_is_compared_case_insensitively() -> None:
    c = _colleague_setup(kc_email=" Anna@X.de ")
    provider, store, service, me, anna = c.provider, c.store, c.service, c.me, c.anna
    provider.contacts["anna@x.de"] = 101
    await service.create(me.id, _input(colleague_ids=(anna.id,)))
    assert provider.created_contacts == []
    assert (await store.load_user(anna.id)).contact_id == 101


async def _refused(c: Setup) -> None:
    c.provider.contacts["anna@x.de"] = 101
    with pytest.raises(SupportInvalid, match="colleague_email_not_verified"):
        await c.service.create(c.me.id, _input(colleague_ids=(c.anna.id,)))
    assert c.provider.email_lookups == [] and c.provider.created_contacts == []
    assert c.provider.created == []
    assert (await c.store.load_user(c.anna.id)).contact_id is None
    # refused before the ticket limit counted anything
    assert c.service._ticket_limiter.hit((c.me.id, "ticket"))  # noqa: SLF001
    assert len(c.service._ticket_limiter._hits[(c.me.id, "ticket")]) == 1  # noqa: SLF001


async def test_colleague_whose_goat_email_is_not_the_verified_one_is_refused() -> None:
    await _refused(_colleague_setup(kc_email="old@x.de"))


@pytest.mark.parametrize("verified", [False, None, "true", 1])
async def test_unverified_colleague_is_refused(verified: object) -> None:
    await _refused(_colleague_setup(verified=verified))


async def test_keycloak_without_an_answer_refuses_and_is_not_cached(
    caplog: pytest.LogCaptureFixture,
) -> None:
    c = _colleague_setup(kc_email=None)
    with caplog.at_level("INFO"):
        await _refused(c)
    assert "no keycloak data" in caplog.text
    assert c.service._cache.get(("keycloak_email", c.anna.id)) is None  # noqa: SLF001


async def test_a_raising_keycloak_lookup_refuses() -> None:
    c = _colleague_setup()

    async def broken(user_id: str) -> dict[str, Any]:
        raise ConnectionError("keycloak down")

    await _refused(replace(c, service=_service(c.provider, c.store, keycloak=broken)))


async def test_verified_colleague_without_an_odoo_match_gets_a_new_contact() -> None:
    c = _colleague_setup()
    provider, store, service, me, anna = c.provider, c.store, c.service, c.me, c.anna
    await service.create(me.id, _input(colleague_ids=(anna.id,)))
    assert provider.email_lookups == [("anna@x.de",)]
    assert [c["email"] for c in provider.created_contacts] == ["anna@x.de"]
    new_id = (await store.load_user(anna.id)).contact_id
    assert provider.follower_changes == [("add", 41, (new_id,))]


async def test_keycloak_verdict_is_cached_for_ten_minutes() -> None:
    clock = [0.0]
    provider, store, keycloak = FakeProvider(), MemoryStore(), FakeKeycloak()
    me = store.add_user(email="m@x.de", contact_id=100)
    anna = store.add_user(email="anna@x.de", name="Anna")
    keycloak.add(anna.id, email="anna@x.de", verified=False)
    service = _service(
        provider, store, cache=TTLCache(now=lambda: clock[0]), keycloak=keycloak
    )
    provider.add(make_ticket(customer_contact_id=100))
    for _ in range(2):
        with pytest.raises(SupportInvalid):
            await service.update_followers(me.id, "00031", (anna.id,), ())
    assert keycloak.calls == [str(anna.id)]
    clock[0] += KEYCLOAK_VERDICT_TTL + 1
    with pytest.raises(SupportInvalid):
        await service.update_followers(me.id, "00031", (anna.id,), ())
    assert keycloak.calls == [str(anna.id)] * 2


async def test_keycloak_is_asked_once_per_colleague_missing_a_contact() -> None:
    provider, store, keycloak = FakeProvider(), MemoryStore(), FakeKeycloak()
    me = store.add_user(email="m@x.de", contact_id=100)
    anna = store.add_user(email="anna@x.de", name="Anna")
    ben = store.add_user(email="ben@x.de", name="Ben")
    keycloak.add(anna.id, email="anna@x.de")
    keycloak.add(ben.id, email="ben@x.de")
    provider.contacts.update({"anna@x.de": 101, "ben@x.de": 102})
    await _service(provider, store, keycloak=keycloak).create(
        me.id, _input(colleague_ids=(anna.id, ben.id))
    )
    assert sorted(keycloak.calls) == sorted([str(anna.id), str(ben.id)])
    assert provider.email_lookups == [("anna@x.de", "ben@x.de")]  # one batch
    assert provider.created_contacts == []
    assert provider.follower_changes == [("add", 41, (101, 102))]


# ------------------------------------------------------------- shared limits
async def test_a_user_has_a_limited_number_of_open_tickets_of_their_own() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    for n in range(MAX_OPEN_TICKETS - 1):
        provider.add(
            make_ticket(id=100 + n, ref=f"{100 + n:05d}", customer_contact_id=100)
        )
    # followed only, and closed ones: not counted
    provider.add(make_ticket(id=300, ref="00300", customer_contact_id=555))
    provider.add(
        make_ticket(id=301, ref="00301", customer_contact_id=100, status="solved")
    )
    service = _service(provider, store, tickets=50)
    await service.create(me.id, _input(request_id="r1"))  # the last one allowed
    with pytest.raises(SupportInvalid, match="too_many_open_tickets"):
        await service.create(me.id, _input(request_id="r2"))
    assert len(provider.created) == 1


async def test_stage_changes_and_ticket_reads_are_limited() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    provider.add(make_ticket(customer_contact_id=100))
    service = SupportService(
        provider,
        store,
        cache=TTLCache(),
        ticket_limiter=RateLimiter(10, 3600),
        reply_limiter=RateLimiter(60, 3600),
        email_proof=TRUSTED,
        keycloak_user=VerifiedKeycloak(store),
        status_limiter=RateLimiter(2, 3600),
        read_limiter=RateLimiter(5, 300),
    )
    # the fake keeps the ticket open, so it can be resolved again
    await service.resolve(me.id, "00031")
    await service.resolve(me.id, "00031")
    with pytest.raises(SupportRateLimited):
        await service.resolve(me.id, "00031")
    assert len(provider.statuses) == 2
    # 3 ticket reads so far (one per action); the limit is 5
    await service.get(me.id, "00031")
    await service.get(me.id, "00031")
    with pytest.raises(SupportRateLimited):
        await service.get(me.id, "00031")


# ------------------------------------------------------------- staff emails
async def test_staff_cannot_open_tickets_from_goat_and_learn_why() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="lena@plan4better.example")
    provider.staff_emails = {"lena@plan4better.example"}
    with pytest.raises(SupportInvalid, match="staff_email"):
        await _service(provider, store).create(me.id, _input())
    assert provider.created == []


async def test_a_staff_colleague_is_refused_with_its_own_reason() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    cyrine = store.add_user(email="cyrine@plan4better.example", name="Cyrine")
    provider.staff_emails = {"cyrine@plan4better.example"}
    with pytest.raises(SupportInvalid, match="colleague_is_staff"):
        await _service(provider, store).create(
            me.id, _input(colleague_ids=(cyrine.id,))
        )
    assert provider.created == [] and provider.follower_changes == []


# ---------------------------------------------- lists across pods (own caches)
async def test_lists_are_read_fresh_and_only_the_summary_is_cached() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    provider.add(make_ticket(customer_contact_id=100))
    service = _service(provider, store)
    await service.list(me.id, "mine", "open")
    calls = provider.list_calls
    await service.list(me.id, "mine", "open")
    assert provider.list_calls == calls + 1  # opened lists always ask the ticket system
    calls = provider.list_calls
    await service.summary(me.id)
    await service.summary(me.id)
    # the summary reuses the lists: "open" from the fresh read above, "closed" once
    assert provider.list_calls == calls + 1


async def test_a_resolve_on_one_pod_shows_on_another_pods_lists() -> None:
    provider, store = FakeProvider(), MemoryStore()
    me = store.add_user(email="m@x.de", contact_id=100)
    provider.add(make_ticket(customer_contact_id=100))
    pod_a, pod_b = _service(provider, store), _service(provider, store)  # own caches
    assert [i.ticket.ref for i in await pod_b.list(me.id, "mine", "open")] == ["00031"]
    assert await pod_b.list(me.id, "mine", "closed") == []
    await pod_a.resolve(me.id, "00031")
    detail = provider.tickets["00031"]
    provider.tickets["00031"] = replace(
        detail, ticket=replace(detail.ticket, status="solved")
    )  # what Odoo now answers
    assert await pod_b.list(me.id, "mine", "open") == []
    assert [i.ticket.ref for i in await pod_b.list(me.id, "mine", "closed")] == [
        "00031"
    ]
