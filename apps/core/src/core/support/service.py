"""Support tickets for GOAT users: identity, visibility, unread, limits.

Odoo holds every ticket; this service decides who may see and do what,
resolves GOAT users to Odoo contacts (looked up on read, created only on
write) and keeps the per-user read markers. See the support tickets spec.

A user is matched to a contact by email only when the request's token vouches
for the stored email (GOAT stores a changed profile email before it is
verified). A colleague is matched by the contact id GOAT stored for them. One
without is added only when Keycloak (not the request) vouches for their email:
`emailVerified` and the same address as the stored one. They get the existing
Odoo contact of that email, else a new one. A colleague whose email is not
verified is refused: their GOAT email may be anyone's, and Odoo would email
that address about the ticket.
"""

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from uuid import UUID

from core.support.errors import (
    SupportCompanyRefused,
    SupportEmailNotVerified,
    SupportForbidden,
    SupportInvalid,
    SupportRateLimited,
    SupportRejected,
    SupportStaffEmail,
    SupportUnavailable,
    TicketNotFound,
)
from core.support.provider import SupportProvider
from core.support.store import SupportStore
from core.support.text import clean_subject, plain_text_to_html, technical_block
from core.support.throttle import RateLimiter, TTLCache
from core.support.types import (
    AttachmentMeta,
    Category,
    EmailProof,
    Impact,
    Member,
    NewTicket,
    Rating,
    SupportUser,
    Ticket,
    TicketDetail,
    TicketQuery,
    UploadedFile,
)

# Keycloak's user representation by user id; `{}` when unknown or unreachable.
KeycloakUser = Callable[[str], Awaitable[dict[str, Any]]]

Scope = Literal["mine", "org"]
State = Literal["open", "closed"]
# The header summary (every page load) is built from lists cached per user for
# LIST_TTL. The cache is per pod: a write on one pod cannot drop another pod's
# entries. So the lists the user opens are always read fresh from Odoo (and
# refresh this pod's cache), which keeps "open" and "closed" consistent whichever
# pod answers; only the badge may lag behind on another pod for up to LIST_TTL.
LIST_TTL = 60.0
# Open tickets a user may have as the customer; a new one waits until one is closed.
MAX_OPEN_TICKETS = 25
# Replies on tickets closed this recently still count as unread (header badge).
CLOSED_UNREAD_DAYS = 14
NO_CONTACT_TTL = 600.0
# How long a stored contact id counts as still existing in the ticket system.
CONTACT_CHECK_TTL = 600.0
# How long what Keycloak says about a colleague's email is remembered.
KEYCLOAK_VERDICT_TTL = 600.0
# What can go wrong in the ticket system once a ticket exists; the request then
# still succeeds and names the files that did not make it.
_AFTER_CREATE_ERRORS = (SupportUnavailable, SupportRejected, LookupError)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class TicketListItem:
    ticket: Ticket
    unread: bool
    needs_my_reply: bool


@dataclass(frozen=True)
class Summary:
    needs_reply: int
    unread: int


@dataclass(frozen=True)
class TicketView:
    detail: TicketDetail
    me_contact_id: int | None
    on_ticket: bool
    can_manage_people: bool
    my_rating: Rating | None = None


@dataclass(frozen=True)
class NewTicketInput:
    subject: str
    description: str
    category: Category
    impact: Impact | None
    request_id: str
    colleague_ids: tuple[UUID, ...]
    technical: dict[str, str]
    files: tuple[UploadedFile, ...]


@dataclass(frozen=True)
class WriteResult:
    ref: str
    message_id: int | None
    failed_files: tuple[str, ...]


# `SupportService.list` shadows the builtin inside the class body, so annotations
# there use these module-level aliases instead of `list[...]`.
Tickets = list[Ticket]
Items = list[TicketListItem]
Members = list[Member]


class SupportService:
    def __init__(
        self,
        provider: SupportProvider,
        store: SupportStore,
        *,
        cache: TTLCache,
        ticket_limiter: RateLimiter,
        reply_limiter: RateLimiter,
        email_proof: EmailProof,
        keycloak_user: KeycloakUser | None = None,
        status_limiter: RateLimiter | None = None,
        read_limiter: RateLimiter | None = None,
    ) -> None:
        """The limiters are per user; the optional ones are off when not given."""
        self._provider = provider
        self._store = store
        self._cache = cache
        self._ticket_limiter = ticket_limiter
        self._reply_limiter = reply_limiter
        self._email_proof = email_proof
        self._keycloak_user = keycloak_user
        self._status_limiter = status_limiter
        self._read_limiter = read_limiter

    def _limit(self, limiter: RateLimiter | None, key: tuple[object, ...]) -> None:
        if limiter is not None and not limiter.hit(key):
            raise SupportRateLimited()

    # ----------------------------------------------------------------- identity
    def _may_link_by_email(self, user: SupportUser) -> bool:
        return self._email_proof.covers(user.email)

    @staticmethod
    def _no_contact_key(user: SupportUser) -> tuple[object, ...]:
        # Not under (user.id, ...): writes invalidate that prefix all the time.
        return ("no_contact", user.id, user.email.strip().lower())

    async def _save_contact(self, user_id: UUID, contact: int) -> None:
        await self._store.save_contact_id(user_id, contact)
        self._cache.invalidate(("no_contact", user_id))
        self._cache.set(("contact_ok", user_id, contact), True, CONTACT_CHECK_TTL)
        self._changed(user_id)  # their lists now come from that contact

    def _changed(self, user_id: UUID) -> None:
        """After a change by or for this user: drop their cached lists on this pod.

        Other participants, and this user on other pods, see it once their
        entries expire (LIST_TTL).
        """
        self._cache.invalidate((user_id,))

    async def _with_live_contact(self, user: SupportUser) -> SupportUser:
        """The user, minus a stored contact id that no longer exists.

        A contact can be deleted, archived or merged away in the ticket system
        (the merge wizard deletes the merged contact). Checked at most once per
        CONTACT_CHECK_TTL per user and id. Only a successful answer that lacks
        the id clears it; an error keeps it and is not cached, so the next
        request asks again.
        """
        stored = user.contact_id
        if not stored:
            return user
        key = ("contact_ok", user.id, stored)
        if self._cache.get(key):
            return user
        if self._cache.get(("contact_gone", user.id, stored)):
            # already unlinked earlier in this request (the caller holds a
            # stale user): never clear the id that has been linked since
            current = (await self._store.load_user(user.id)).contact_id
            return replace(user, contact_id=None if current == stored else current)
        try:
            alive = await self._provider.contacts_exist([stored])
        except (SupportUnavailable, SupportRejected):
            return user
        if stored in alive:
            self._cache.set(key, True, CONTACT_CHECK_TTL)
            return user
        logger.warning(
            "support: contact %s of user %s no longer exists; unlinking it",
            stored,
            user.id,
        )
        await self._store.clear_contact_id(user.id)
        self._cache.set(("contact_gone", user.id, stored), True, CONTACT_CHECK_TTL)
        self._changed(user.id)  # lists built on the dead contact
        return replace(user, contact_id=None)

    async def _contact_for_read(self, user: SupportUser) -> int | None:
        """The user's contact: the stored one, else found by a verified email."""
        user = await self._with_live_contact(user)
        if user.contact_id:
            return user.contact_id
        if not self._may_link_by_email(user):
            return None
        if self._cache.get(self._no_contact_key(user)):
            return None
        company = await self._store.org_company_id(user.org_id) if user.org_id else None
        found = await self._provider.find_contacts_by_email(
            [user.email], prefer_company_id=company
        )
        contact = found.get(user.email.strip().lower())
        if contact:
            await self._save_contact(user.id, contact)
        else:
            self._cache.set(self._no_contact_key(user), True, NO_CONTACT_TTL)
        return contact

    def _check_can_get_contact(self, user: SupportUser) -> None:
        if not user.contact_id and not self._may_link_by_email(user):
            raise SupportEmailNotVerified()

    async def _contact_for_write(self, user: SupportUser) -> int:
        user = await self._with_live_contact(user)  # before the email gate
        self._check_can_get_contact(user)
        contact = await self._contact_for_read(user)
        if contact:
            return contact
        try:
            contact = await self._create_contact(
                user.name, user.email, user.lang, user.org_id
            )
        except SupportStaffEmail:
            raise SupportInvalid("staff_email") from None
        await self._save_contact(user.id, contact)
        return contact

    async def _create_contact(
        self, name: str, email: str, lang: Literal["en", "de"], org_id: UUID | None
    ) -> int:
        """A new contact, under the org's company when the ticket system accepts it.

        A company the server action refuses (one of ours, or with staff in it)
        is a setup problem of that org: logged, and the contact is created
        without a company, so its users can still file tickets.
        """
        company = await self._store.org_company_id(org_id) if org_id else None
        try:
            return await self._provider.create_contact(
                name=name, email=email, lang=lang, company_id=company
            )
        except SupportCompanyRefused:
            if company is None:
                raise
            logger.warning(
                "support: organization %s links to Odoo company %s, which the "
                "bridge refuses as a parent; creating the contact without it",
                org_id,
                company,
            )
        return await self._provider.create_contact(
            name=name, email=email, lang=lang, company_id=None
        )

    async def _member_contacts(
        self, user: SupportUser, *, create_for: tuple[UUID, ...] = ()
    ) -> dict[UUID, int]:
        """Stored contact ids of the user's org members.

        Members named in `create_for` who have none need an email Keycloak
        verified that is the stored one; they are linked to the existing Odoo
        contact of that email, else get a new contact with it. Any of them
        without a verified email refuses the whole call before anything is
        written (`colleague_email_not_verified`). The caller is skipped (they
        get their contact through `_contact_for_write`). The stored contacts of
        `create_for` members are checked first (one batch, cached like the
        user's own): a contact deleted, archived or merged away in the ticket
        system is unlinked and replaced by a new one, as for a member without.
        """
        if not user.org_id:
            if create_for:
                raise SupportForbidden()
            return {}
        members = await self._store.org_members(user.org_id)
        by_id = {m.user_id: m for m in members}
        if any(uid not in by_id for uid in create_for):
            raise SupportForbidden()
        contacts = {m.user_id: m.contact_id for m in members if m.contact_id}
        await self._drop_dead_colleague_contacts(user, create_for, contacts)
        missing = [
            by_id[uid]
            for uid in dict.fromkeys(create_for)
            if uid not in contacts and uid != user.id
        ]
        if missing:
            verified = await self._verified_colleague_emails(missing)
            if len(verified) < len(missing):
                raise SupportInvalid("colleague_email_not_verified")
            linked = await self._link_verified_colleagues(user, verified)
            contacts.update(linked)
            for m in missing:
                if m.user_id in linked:
                    continue
                member_user = await self._store.load_user(m.user_id)
                try:
                    cid = await self._create_contact(
                        m.name, verified[m.user_id], member_user.lang, user.org_id
                    )
                except SupportStaffEmail:
                    # staff follow tickets in the ticket system itself
                    raise SupportInvalid("colleague_is_staff") from None
                await self._save_contact(m.user_id, cid)
                contacts[m.user_id] = cid
        return contacts

    async def _keycloak_verified_email(self, user_id: UUID) -> str | None:
        """The lower-cased email Keycloak has verified for the user, else None.

        Keycloak's answer is cached per user (verified or not). A lookup that
        gave nothing (`{}`: AUTH off, admin client unconfigured, user missing
        or Keycloak unreachable) is not cached, so the next request asks again.
        """
        if self._keycloak_user is None:
            return None
        key = ("keycloak_email", user_id)
        cached = self._cache.get(key)
        if cached is not None:
            return cached or None
        try:
            kc_user = await self._keycloak_user(str(user_id))
        except Exception:
            logger.warning(
                "support: keycloak lookup failed for colleague %s",
                user_id,
                exc_info=True,
            )
            kc_user = {}
        if not kc_user:
            logger.info(
                "support: no keycloak data for colleague %s (AUTH off, Keycloak "
                "unreachable or not configured); not linking by email",
                user_id,
            )
            return None
        email = kc_user.get("email")
        verified = (
            email.strip().lower()
            if kc_user.get("emailVerified") is True
            and isinstance(email, str)
            and email.strip()
            else ""
        )
        self._cache.set(key, verified, KEYCLOAK_VERDICT_TTL)
        return verified or None

    async def _verified_colleague_emails(
        self, members: list[Member]
    ) -> dict[UUID, str]:
        """The members whose stored (GOAT) email Keycloak verified, with that email.

        The stored email must be the verified one: a profile email can be
        changed before it is verified.
        """
        emails: dict[UUID, str] = {}
        for m in members:
            verified = await self._keycloak_verified_email(m.user_id)
            if verified and verified == m.email.strip().lower():
                emails[m.user_id] = verified
        return emails

    async def _link_verified_colleagues(
        self, user: SupportUser, emails: dict[UUID, str]
    ) -> dict[UUID, int]:
        """Existing Odoo contacts for members by their verified email.

        Staff and bridge partners are already excluded by the lookup. Members
        without a match are left to the caller, who creates a new contact.
        """
        if not emails:
            return {}
        company = await self._store.org_company_id(user.org_id) if user.org_id else None
        found = await self._provider.find_contacts_by_email(
            list(dict.fromkeys(emails.values())), prefer_company_id=company
        )
        linked: dict[UUID, int] = {}
        for uid, email in emails.items():
            if contact := found.get(email):
                await self._save_contact(uid, contact)
                linked[uid] = contact
        return linked

    async def _drop_dead_colleague_contacts(
        self,
        user: SupportUser,
        create_for: tuple[UUID, ...],
        contacts: dict[UUID, int],
    ) -> None:
        """Unlink the stored contacts of `create_for` members that no longer exist.

        Removes them from `contacts` too, so the caller creates new ones. An
        error of the check propagates: following a dead contact would fail
        in the ticket system anyway.
        """
        unchecked = {
            uid: contacts[uid]
            for uid in dict.fromkeys(create_for)
            if uid != user.id
            and uid in contacts
            and not self._cache.get(("contact_ok", uid, contacts[uid]))
        }
        if not unchecked:
            return
        alive = await self._provider.contacts_exist(list(unchecked.values()))
        for uid, cid in unchecked.items():
            if cid in alive:
                self._cache.set(("contact_ok", uid, cid), True, CONTACT_CHECK_TTL)
                continue
            logger.warning(
                "support: contact %s of colleague %s no longer exists; unlinking it",
                cid,
                uid,
            )
            await self._store.clear_contact_id(uid)
            self._cache.set(("contact_gone", uid, cid), True, CONTACT_CHECK_TTL)
            self._changed(uid)
            del contacts[uid]

    # --------------------------------------------------------------- visibility
    @staticmethod
    def _on_ticket(
        detail_or_ticket: TicketDetail | Ticket,
        contact: int | None,
        followers: tuple[int, ...] = (),
    ) -> bool:
        ticket = (
            detail_or_ticket.ticket
            if isinstance(detail_or_ticket, TicketDetail)
            else detail_or_ticket
        )
        return contact is not None and (
            ticket.customer_contact_id == contact or contact in followers
        )

    @staticmethod
    def _can_manage(user: SupportUser, ticket: Ticket, contact: int | None) -> bool:
        """Org admins manage people only on tickets of their own org."""
        admin_of_ticket_org = (
            user.is_org_admin
            and user.org_id is not None
            and ticket.org_id == str(user.org_id)
        )
        return admin_of_ticket_org or (
            contact is not None and ticket.customer_contact_id == contact
        )

    async def _visible(
        self, user: SupportUser, ref: str
    ) -> tuple[TicketDetail, int | None, bool]:
        # Each ticket read costs several Odoo calls, before visibility is known.
        self._limit(self._read_limiter, (user.id, "read"))
        detail = await self._provider.get_ticket(ref)
        if detail is None:
            raise TicketNotFound()
        contact = await self._contact_for_read(user)
        follower_ids = tuple(f.contact_id for f in detail.followers)
        on_ticket = self._on_ticket(detail, contact, follower_ids)
        t = detail.ticket
        if not on_ticket and user.is_org_admin and user.org_id:
            if t.org_id is None and t.customer_contact_id is not None:
                members = await self._member_contacts(user)
                if t.customer_contact_id in members.values():
                    await self._provider.stamp_org([t.id], str(user.org_id))
                    detail = await self._provider.get_ticket(ref) or detail
            if detail.ticket.org_id != str(user.org_id):
                raise TicketNotFound()
        elif not on_ticket:
            raise TicketNotFound()
        return detail, contact, on_ticket

    # --------------------------------------------------------------------- list
    async def _tickets(
        self,
        user: SupportUser,
        scope: Scope,
        open_: bool | None,
        request_id: str | None,
    ) -> tuple[Tickets, int | None]:
        contact = await self._contact_for_read(user)
        if scope == "org":
            if not (user.is_org_admin and user.org_id):
                raise SupportForbidden()
            members = await self._member_contacts(user)
            customer_ids = tuple(
                sorted(set(members.values()) | ({contact} if contact else set()))
            )
            tickets = await self._provider.list_tickets(
                TicketQuery(customer_ids, contact, str(user.org_id), open_, request_id)
            )
            org = str(user.org_id)
            kept: Tickets = []
            unstamped: list[int] = []
            for t in tickets:
                if t.org_id == org or (contact and t.customer_contact_id == contact):
                    kept.append(t)
                elif t.org_id is None and t.customer_contact_id in customer_ids:
                    unstamped.append(t.id)
                    kept.append(replace(t, org_id=org))
                # else: stamped with another org, or unstamped and only followed
            if unstamped:
                await self._provider.stamp_org(unstamped, org)
            return kept, contact
        if contact is None:
            return [], None
        tickets = await self._provider.list_tickets(
            TicketQuery((contact,), contact, None, open_, request_id)
        )
        # Spec §4.3(a): the user's own email tickets join their org on first sight.
        own_unstamped = [
            t.id
            for t in tickets
            if t.org_id is None and t.customer_contact_id == contact
        ]
        if own_unstamped and user.org_id:
            await self._provider.stamp_org(own_unstamped, str(user.org_id))
        return tickets, contact

    async def list(
        self,
        user_id: UUID,
        scope: Scope,
        state: State,
        q: str = "",
        request_id: str | None = None,
    ) -> Items:
        user = await self._store.load_user(user_id)
        if scope == "org" and not (user.is_org_admin and user.org_id):
            raise SupportForbidden()  # before the cache: a revoked admin gets nothing
        # not from the cache: see LIST_TTL
        self._limit(self._read_limiter, (user.id, "read"))
        if request_id:
            items = await self._compute(user, scope, state, request_id)
        else:
            items = await self._items(user, scope, state, fresh=True)
        needle = q.strip().lower()
        if needle:
            items = [
                i
                for i in items
                if needle
                in f"{i.ticket.subject} #{i.ticket.ref} {i.ticket.customer_name or ''}".lower()
            ]
        return sorted(
            items,
            key=lambda i: (not i.needs_my_reply, -i.ticket.updated_at.timestamp()),
        )

    async def _items(
        self, user: SupportUser, scope: Scope, state: State, *, fresh: bool = False
    ) -> Items:
        """The list from the per-user cache, or from Odoo after LIST_TTL or when
        `fresh` (which refreshes the cache too).

        Keyed by the contact as well: a link made outside this service changes
        what the lists hold.
        """
        key = (user.id, "list", scope, state, user.contact_id)
        hit = None if fresh else self._cache.get(key)
        if hit is not None:
            return list(hit)
        items = await self._compute(user, scope, state, None)
        self._cache.set(key, items, LIST_TTL)
        return list(items)

    async def _compute(
        self, user: SupportUser, scope: Scope, state: State, request_id: str | None
    ) -> Items:
        await self._ensure_seeded(user)
        tickets, contact = await self._tickets(user, scope, state == "open", request_id)
        return await self._with_unread(user.id, tickets, contact, scope)

    async def _ensure_seeded(self, user: SupportUser) -> None:
        """First sight of a contact: its tickets so far, open or closed, count as read.

        Seeded per contact, not per user: the header polls before many users
        have a contact, and the contact they get linked to later may bring a
        history of email tickets. So nothing is seeded while there is no
        contact, and a user linked to another contact (relinked after a merge,
        or found by email later) is seeded again for it. The store records the
        contact the markers were seeded for; the earlier per-user marker (0)
        names no contact and so counts as "not seeded yet".

        Runs before any marker is written (list and get both call it), so the
        order in which the user first touches the feature does not matter.
        """
        contact = await self._contact_for_read(user)
        if contact is None or await self._store.seeded_contact(user.id) == contact:
            return
        tickets, _ = await self._tickets(user, "mine", None, None)
        seed = {t.id: t.latest_message_id for t in tickets if t.latest_message_id}
        await self._store.set_read_markers(user.id, seed)
        await self._store.set_seeded_contact(user.id, contact)

    async def _with_unread(
        self, user_id: UUID, tickets: Tickets, contact: int | None, scope: Scope
    ) -> Items:
        ids = [t.id for t in tickets]
        markers = await self._store.read_markers(user_id, ids)
        items = []
        for t in tickets:
            seen = markers.get(t.id)
            if t.latest_message_id is None:
                unread = False
            elif seen is None:
                unread = t.latest_message_is_agent
            else:
                unread = t.latest_message_id > seen
            # In "mine" every ticket is the user's (customer or follower); in "org"
            # only the ones they opened count as waiting for *them*.
            on_me = scope == "mine" or (
                contact is not None and t.customer_contact_id == contact
            )
            items.append(TicketListItem(t, unread, t.status == "waiting" and on_me))
        return items

    async def summary(self, user_id: UUID) -> Summary:
        """Header counts, computed from the open and closed lists.

        Both lists come from the per-user cache, so repeats within LIST_TTL
        cost no Odoo call. There is no cache of its own: the lists' already
        decides when to ask Odoo. `needs_reply` is open-only; `unread` also
        covers tickets closed within CLOSED_UNREAD_DAYS, so a reply and a
        "Solved" set a minute later still show.
        """
        user = await self._store.load_user(user_id)
        open_items = await self._items(user, "mine", "open")
        closed_items = await self._items(user, "mine", "closed")
        cutoff = datetime.now(UTC) - timedelta(days=CLOSED_UNREAD_DAYS)
        unread = [i for i in open_items if i.unread] + [
            i for i in closed_items if i.unread and self._closed_since(i, cutoff)
        ]
        return Summary(
            needs_reply=sum(1 for i in open_items if i.needs_my_reply),
            unread=len(unread),
        )

    @staticmethod
    def _closed_since(item: TicketListItem, cutoff: datetime) -> bool:
        t = item.ticket
        last = max(d for d in (t.closed_at, t.updated_at) if d is not None)
        return last >= cutoff

    # --------------------------------------------------------------------- read
    async def get(self, user_id: UUID, ref: str) -> TicketView:
        user = await self._store.load_user(user_id)
        detail, contact, on_ticket = await self._visible(user, ref)
        await self._ensure_seeded(user)
        latest = detail.ticket.latest_message_id
        if latest:
            tid = detail.ticket.id
            seen = (await self._store.read_markers(user_id, [tid])).get(tid)
            await self._store.set_read_markers(user_id, {tid: latest})
            if seen is None or seen < latest:
                self._changed(user_id)  # their unread state moved
        # Odoo subscribes the ticket's customer automatically; they are the ticket's
        # owner (shown separately, never removable), not one of the people added to it.
        hidden = {detail.ticket.customer_contact_id, await self._bridge()}
        customer_side = tuple(
            f
            for f in detail.followers
            if not f.is_internal and f.contact_id not in hidden
        )
        return TicketView(
            detail=replace(detail, followers=customer_side),
            me_contact_id=contact,
            on_ticket=on_ticket,
            can_manage_people=self._can_manage(user, detail.ticket, contact),
            my_rating=await self._my_rating(detail.ticket, contact, on_ticket),
        )

    async def _my_rating(
        self, ticket: Ticket, contact: int | None, on_ticket: bool
    ) -> Rating | None:
        """What this user rated the solved ticket, so the page does not ask again.

        Only participants can rate, so only they are looked up. It only decides
        whether the form or the thanks shows: a failure reads as "not rated".
        """
        if ticket.status != "solved" or contact is None or not on_ticket:
            return None
        try:
            return await self._provider.my_rating(ticket.id, contact)
        except (SupportUnavailable, SupportRejected) as exc:
            logger.warning(
                "support: reading the rating of %s failed: %r", ticket.ref, exc
            )
            return None

    async def _bridge(self) -> int | None:
        """The bridge's own contact: never shown or handled as a person."""
        return await self._provider.bridge_contact_id()

    async def my_contact_id(self, user_id: UUID) -> int | None:
        return (await self._store.load_user(user_id)).contact_id

    async def colleagues(self, user_id: UUID) -> Members:
        user = await self._store.load_user(user_id)
        if not user.org_id:
            return []
        return [
            m
            for m in await self._store.org_members(user.org_id)
            if m.user_id != user.id
        ]

    # -------------------------------------------------------------------- write
    async def create(self, user_id: UUID, data: NewTicketInput) -> WriteResult:
        user = await self._store.load_user(user_id)
        # Validate first, so a rejected request writes nothing and costs no token.
        if not data.request_id or not data.request_id.strip():
            raise SupportInvalid("missing_request_id")
        if not data.description.strip():
            raise SupportInvalid("empty_description")
        subject = clean_subject(data.subject)
        if len(subject) < 3:
            raise SupportInvalid("subject_too_short")
        await self._check_colleagues(user, data.colleague_ids)
        existing, _ = await self._tickets(user, "mine", None, data.request_id)
        if existing:
            # A retry of a create that went through: whether its files made it
            # is unknown here, so they are reported as not attached.
            return WriteResult(
                ref=existing[0].ref,
                message_id=None,
                failed_files=tuple(f.name for f in data.files),
            )
        self._check_can_get_contact(user)
        await self._check_open_tickets(user)
        # A burst guard behind the open-ticket limit: parallel requests, and
        # opening and resolving tickets in a loop.
        if not self._ticket_limiter.hit((user_id, "ticket")):
            raise SupportRateLimited()
        contact = await self._contact_for_write(user)
        colleague_contacts = await self._member_contacts(
            user, create_for=data.colleague_ids
        )
        ticket = await self._provider.create_ticket(
            NewTicket(
                subject=subject,
                description_html=plain_text_to_html(data.description)
                + technical_block(data.technical),
                category=data.category,
                impact=data.impact,
                customer_contact_id=contact,
                org_id=str(user.org_id) if user.org_id else None,
                user_id=str(user.id),
                request_id=data.request_id,
            )
        )
        add = [
            colleague_contacts[uid]
            for uid in data.colleague_ids
            if uid in colleague_contacts and colleague_contacts[uid] != contact
        ]
        # The ticket exists from here on: a failure below must not fail the
        # request (a retry would only find the ticket by its request id).
        self._changed(user_id)
        if add:
            try:
                await self._provider.add_followers(ticket.id, add)
            except _AFTER_CREATE_ERRORS as exc:
                logger.warning(
                    "support: adding colleagues to ticket %s failed: %r",
                    ticket.ref,
                    exc,
                )
        message_id: int | None = None
        failed: tuple[str, ...] = ()
        if data.files:
            try:
                post = await self._provider.post_message(
                    ticket.id, contact, "", data.files
                )
                message_id, failed = post.message_id, post.failed_files
            except _AFTER_CREATE_ERRORS as exc:
                logger.warning(
                    "support: posting the files of ticket %s failed: %r",
                    ticket.ref,
                    exc,
                )
                failed = tuple(f.name for f in data.files)
        return WriteResult(ref=ticket.ref, message_id=message_id, failed_files=failed)

    async def _check_open_tickets(self, user: SupportUser) -> None:
        """At most MAX_OPEN_TICKETS open tickets with the user as the customer.

        Counted from the cached "mine, open" list (own writes drop it), so the
        same for every pod; tickets the user only follows do not count.
        """
        contact = await self._contact_for_read(user)
        if not contact:
            return
        mine = await self._items(user, "mine", "open", fresh=True)
        open_own = sum(
            1
            for i in mine
            if i.ticket.customer_contact_id == contact and i.ticket.is_open
        )
        if open_own >= MAX_OPEN_TICKETS:
            raise SupportInvalid("too_many_open_tickets")

    async def _check_colleagues(
        self, user: SupportUser, colleague_ids: tuple[UUID, ...]
    ) -> None:
        if not colleague_ids:
            return
        if not user.org_id:
            raise SupportForbidden()
        members = {m.user_id: m for m in await self._store.org_members(user.org_id)}
        if any(uid not in members for uid in colleague_ids):
            raise SupportForbidden()
        # Before anything is written or counted (_member_contacts checks again,
        # also for stored contacts that turn out to be gone).
        without = [
            members[uid]
            for uid in dict.fromkeys(colleague_ids)
            if uid != user.id and not members[uid].contact_id
        ]
        if len(await self._verified_colleague_emails(without)) < len(without):
            raise SupportInvalid("colleague_email_not_verified")

    async def reply(
        self, user_id: UUID, ref: str, text: str, files: tuple[UploadedFile, ...]
    ) -> WriteResult:
        if not text.strip() and not files:
            raise SupportInvalid("empty_reply")
        user = await self._store.load_user(user_id)
        detail, _, on_ticket = await self._visible(user, ref)
        self._check_can_get_contact(user)
        if not self._reply_limiter.hit((user_id, "reply")):
            raise SupportRateLimited()
        contact = await self._contact_for_write(user)
        if not on_ticket:
            await self._provider.add_followers(detail.ticket.id, [contact])
        post = await self._provider.post_message(detail.ticket.id, contact, text, files)
        if detail.ticket.status in ("waiting", "solved", "cancelled"):
            await self._provider.set_status(detail.ticket.id, "in_progress")
        self._changed(user_id)
        return WriteResult(
            ref=ref, message_id=post.message_id, failed_files=post.failed_files
        )

    async def resolve(self, user_id: UUID, ref: str) -> None:
        user = await self._store.load_user(user_id)
        detail, _, _ = await self._visible(user, ref)
        if not detail.ticket.is_open:
            raise SupportInvalid("already_closed")
        # Every stage change emails the followers.
        self._limit(self._status_limiter, (user_id, "status"))
        await self._provider.set_status(detail.ticket.id, "solved")
        self._changed(user_id)

    async def reopen(self, user_id: UUID, ref: str) -> None:
        user = await self._store.load_user(user_id)
        detail, _, _ = await self._visible(user, ref)
        if detail.ticket.is_open:
            raise SupportInvalid("already_open")
        self._limit(self._status_limiter, (user_id, "status"))
        await self._provider.set_status(detail.ticket.id, "in_progress")
        self._changed(user_id)

    async def update_followers(
        self,
        user_id: UUID,
        ref: str,
        add_user_ids: tuple[UUID, ...],
        remove_contact_ids: tuple[int, ...],
    ) -> None:
        user = await self._store.load_user(user_id)
        detail, contact, _ = await self._visible(user, ref)
        manage = self._can_manage(user, detail.ticket, contact)
        customer_side = {
            f.contact_id for f in detail.followers if not f.is_internal
        } - {await self._bridge()}
        for cid in remove_contact_ids:
            if cid not in customer_side or cid == detail.ticket.customer_contact_id:
                raise SupportForbidden()
            if cid != contact and not manage:
                raise SupportForbidden()
        if add_user_ids and not manage:
            raise SupportForbidden()
        add: list[int] = []
        if add_user_ids:
            contacts = await self._member_contacts(user, create_for=add_user_ids)
            add = [contacts[uid] for uid in add_user_ids if uid in contacts]
            if add:
                await self._provider.add_followers(detail.ticket.id, add)
        if remove_contact_ids:
            await self._provider.remove_followers(
                detail.ticket.id, list(remove_contact_ids)
            )
        self._changed(user_id)

    async def rate(self, user_id: UUID, ref: str, rating: Rating, comment: str) -> None:
        user = await self._store.load_user(user_id)
        detail, _, on_ticket = await self._visible(user, ref)
        if not on_ticket:
            raise SupportForbidden()
        if detail.ticket.status != "solved":
            raise SupportInvalid("not_solved")
        contact = await self._contact_for_write(user)
        await self._provider.rate(
            detail.ticket.id, contact, rating, comment.strip()[:2000]
        )
        self._changed(user_id)

    async def download(
        self, user_id: UUID, ref: str, attachment_id: int
    ) -> tuple[AttachmentMeta, bytes]:
        user = await self._store.load_user(user_id)
        detail, _, _ = await self._visible(user, ref)
        if attachment_id not in detail.visible_attachment_ids:
            raise TicketNotFound()
        return await self._provider.download(attachment_id)
