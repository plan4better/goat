import asyncio
import logging
import time
from collections.abc import Coroutine
from datetime import date, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import select, update

from core.accounts.factory import get_provider
from core.accounts.provider import AccountsError, AccountsProvider, Language
from core.core.config import settings
from core.db.models._link_model import UserRoleLink
from core.db.models.organization import Organization
from core.db.models.role import Role
from core.db.models.system_setting import SystemSetting
from core.db.models.user import User
from core.db.session import session_manager
from core.schemas.system_setting import default_system_settings

logger = logging.getLogger(__name__)

LANGUAGES: tuple[Language, ...] = ("de", "en")
RETRY_SECONDS = 600

_tasks: set[asyncio.Task[None]] = set()
_last_try: dict[UUID, float] = {}


def _provider() -> AccountsProvider:
    provider = get_provider()
    if provider is None:  # the report_* entry points check the switch first
        raise AccountsError("accounts sync is not configured")
    return provider


def _in_background(work: Coroutine[Any, Any, None], org_id: UUID | None = None) -> None:
    """Run after the caller's request; failures are logged, never raised.

    With `org_id` the outcome is kept on the organization (the column is still
    called odoo_sync_pending, read it as "accounts sync pending"): a report
    that did not arrive is re-sent by `retry_loop`."""

    async def guarded() -> None:
        failed = True
        try:
            await work
            failed = False
        except AccountsError as exc:
            logger.warning("accounts sync: provider refused or is down: %s", exc)
        except Exception:  # noqa: BLE001 - the sync must never break GOAT
            logger.exception("accounts sync failed")
        if org_id is not None:
            await _mark_pending(org_id, failed)

    task = asyncio.get_running_loop().create_task(guarded())
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


async def _mark_pending(org_id: UUID, pending: bool) -> None:
    """Flag (or unflag) the organization for the retry loop; own session, the
    caller's is long closed. Clearing touches a row only if it is flagged."""
    try:
        async with session_manager.session() as session:
            statement = update(Organization).where(Organization.id == org_id)
            if not pending:
                statement = statement.where(Organization.odoo_sync_pending)
            await session.execute(statement.values(odoo_sync_pending=pending))
            await session.commit()
    except Exception:  # noqa: BLE001 - bookkeeping must not break the sync
        logger.exception("accounts sync: cannot update the pending flag")


def _goat_language(value: object) -> Language | None:
    """'de', 'de-DE' or 'de_DE' -> 'de'; None when GOAT has no such language."""
    code = str(value or "").strip().lower().replace("-", "_").split("_")[0]
    return next((language for language in LANGUAGES if language == code), None)


async def _language(session: Any, user_id: UUID, hint: str | None) -> Language | None:
    """The person's language for the provider's mails, the one GOAT shows them: chosen
    on the sign-up page (Keycloak's `locale` claim), else their GOAT setting,
    else GOAT's default."""
    if _goat_language(hint):
        return _goat_language(hint)
    setting = (
        await session.execute(
            select(SystemSetting.preferred_language).where(
                SystemSetting.user_id == user_id
            )
        )
    ).scalar_one_or_none()
    return _goat_language(getattr(setting, "value", setting)) or _goat_language(
        default_system_settings.preferred_language.value
    )


async def _sign_up(user_id: UUID, locale: str | None = None) -> int | None:
    """Report the user; returns their contact id at the provider. The language
    goes along the first time and when a locale is given (sign-up page, a
    change in GOAT's settings); later reports leave the provider's alone."""
    async with session_manager.session() as session:
        user = await session.get(User, user_id)
        if user is None:
            return None
        name = " ".join(p for p in (user.firstname, user.lastname) if p) or user.email
        lang = (
            None
            if user.odoo_contact_id and locale is None
            else await _language(session, user.id, locale)
        )
        logger.info(
            "accounts sync: reporting user %s, language %s", user.id, lang or "-"
        )
        contact_id = await _provider().sign_up(
            user_id=str(user.id),
            name=name,
            email=user.email,
            marketing_consent=bool(user.newsletter_subscribe),
            language=lang,
        )
        if contact_id and user.odoo_contact_id != contact_id:
            user.odoo_contact_id = int(contact_id)
            await session.commit()
        return contact_id


def report_sign_up(user: User, token: dict) -> None:
    """On a request of a user the provider does not know yet, with a verified email."""
    if (
        not settings.accounts_sync_enabled
        or user.odoo_contact_id
        or not token.get("email_verified")
    ):
        return
    assert user.id is not None
    now = time.monotonic()
    if now - _last_try.get(user.id, -RETRY_SECONDS) < RETRY_SECONDS:
        return
    _last_try[user.id] = now

    locale = token.get("locale")

    async def work() -> None:
        await _sign_up(user.id, locale)

    _in_background(work())


def report_language(user_id: UUID, language: object) -> None:
    """The user changed GOAT's language: the provider's mails follow, once it
    knows the user (the sign-up report itself needs a verified email)."""
    locale = str(getattr(language, "value", language) or "")
    if not settings.accounts_sync_enabled or not _goat_language(locale):
        return

    async def work() -> None:
        async with session_manager.session() as session:
            user = await session.get(User, user_id)
            known = user is not None and user.odoo_contact_id
        if known:
            await _sign_up(user_id, locale)

    _in_background(work())


async def _start_trial(org_id: UUID, name: str, end: datetime, owner_id: UUID) -> None:
    await _sign_up(owner_id)  # newsletter consent comes with the organization form
    company_id = await _provider().start_trial(
        user_id=str(owner_id),
        organization_id=str(org_id),
        organization_name=name,
        trial_start=date.today(),
        trial_end=end.date(),
    )
    await _store_company(org_id, company_id)


async def _status(org_id: UUID, suspended: bool, on_trial: bool) -> None:
    await _provider().status(
        organization_id=str(org_id), suspended=suspended, on_trial=on_trial
    )


async def _join(user_id: UUID, org_id: UUID, name: str, role: str) -> None:
    if await _sign_up(user_id) is None:
        return
    company_id = await _provider().join(
        user_id=str(user_id),
        organization_id=str(org_id),
        organization_name=name,
        role=role if role in ("owner", "admin", "editor", "viewer") else "editor",
    )
    await _store_company(org_id, company_id)


def report_trial(organization: Organization, owner_id: UUID) -> None:
    """The owner created an organization that starts a trial."""
    if not settings.accounts_sync_enabled or not organization.on_trial:
        return
    org_id, name = organization.id, organization.name
    end = organization.plan_renewal_date
    if end is None:
        return

    _in_background(_start_trial(org_id, name, end, owner_id), org_id)


def report_suspension(organization: Organization) -> None:
    """GOAT changed the organization's state itself: suspended or reactivated
    (its trial ended), converted from trial to subscription, or deleted. The
    provider shows it on the company, without sending it back; the people of
    an organization no longer on trial leave the trial campaign."""
    if not settings.accounts_sync_enabled:
        return
    org_id = organization.id
    suspended, on_trial = bool(organization.suspended), _on_trial(organization)

    _in_background(_status(org_id, suspended, on_trial), org_id)


def _on_trial(organization: Organization) -> bool:
    """On trial as the provider sees it: a deleted organization's trial is over,
    so its people get no more trial mails."""
    return bool(organization.on_trial) and organization.deleted_at is None


def report_join(user_id: UUID, organization: Organization, role: str) -> None:
    """An invited member joined an organization the provider knows."""
    if not settings.accounts_sync_enabled:
        return
    org_id, name = organization.id, organization.name

    _in_background(_join(user_id, org_id, name, role), org_id)


# --- Retry of lost reports --------------------------------------------------

RETRY_BATCH = 50
MEMBERS_PER_RUN = 200


async def _retry_organization(org_id: UUID) -> bool:
    """Re-send everything the provider may have missed for one flagged
    organization. The operations are idempotent. True when all of it went through."""
    async with session_manager.session() as session:
        organization = await session.get(Organization, org_id)
        if organization is None:
            return True
        name, owner_id = organization.name, organization.contact_user_id
        end = organization.plan_renewal_date
        suspended = bool(organization.suspended)
        on_trial = _on_trial(organization)
        needs_trial = on_trial and organization.odoo_company_id is None

    if needs_trial and end is not None:
        await _start_trial(org_id, name, end, owner_id)
    await _status(org_id, suspended, on_trial)

    async with session_manager.session() as session:
        members = (
            await session.execute(
                select(User.id, Role.name)
                .outerjoin(UserRoleLink, UserRoleLink.user_id == User.id)
                .outerjoin(
                    Role,
                    (Role.id == UserRoleLink.role_id)
                    & Role.name.like("organization-%"),
                )
                .where(User.organization_id == org_id, User.odoo_contact_id.is_(None))
                .limit(MEMBERS_PER_RUN)
            )
        ).all()
    for user_id, role_name in dict(members).items():
        await _join(
            user_id, org_id, name, (role_name or "").removeprefix("organization-")
        )
    return True


async def retry_pending() -> int:
    """One pass over the organizations whose report failed; returns how
    many are done. Replicas may run it at the same time: the operations are
    idempotent, so that only costs a duplicate call."""
    async with session_manager.session() as session:
        org_ids = (
            (
                await session.execute(
                    select(Organization.id)
                    .where(Organization.odoo_sync_pending)
                    .limit(RETRY_BATCH)
                )
            )
            .scalars()
            .all()
        )
    done = 0
    for org_id in org_ids:
        try:
            await _retry_organization(org_id)
        except AccountsError as exc:
            logger.warning("accounts sync retry: provider refused or is down: %s", exc)
            continue
        except Exception:  # noqa: BLE001 - one organization must not stop the rest
            logger.exception("accounts sync retry failed for %s", org_id)
            continue
        await _mark_pending(org_id, False)
        done += 1
    return done


async def retry_loop() -> None:
    """Re-report lost reports every RETRY_SECONDS, until cancelled."""
    while True:
        await asyncio.sleep(RETRY_SECONDS)
        try:
            await retry_pending()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - the loop must outlive any failure
            logger.exception("accounts sync retry loop failed")


async def _store_company(org_id: UUID, company_id: Any) -> None:
    if not company_id:
        return
    async with session_manager.session() as session:
        organization = await session.get(Organization, org_id)
        if organization is not None and organization.odoo_company_id != int(company_id):
            organization.odoo_company_id = int(company_id)
            await session.commit()
