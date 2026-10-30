import hmac
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, status
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from core.accounts import report_suspension
from core.core.config import settings
from core.crud.crud_billing_terms import apply_terms
from core.crud.crud_organization import organization as crud_organization
from core.crud.crud_user import user as crud_user
from core.db.models.organization import Organization
from core.deps.billing import require_billing_enabled
from core.endpoints.deps import get_db
from core.schemas.email import EmailTemplateContent
from core.schemas.entitlement import BillingTermsPush, EntitlementPush, TrialStage
from core.utils.email import send_email, user_language
from core.utils.i18n import language
from core.utils.i18n import trans as _


def require_webhook_secret(
    x_webhook_secret: str | None = Header(default=None),
) -> None:
    """The shared secret the billing system (or a worker task) sends, compared
    in constant time."""
    expected = settings.BILLING_WEBHOOK_SECRET or ""
    if not x_webhook_secret or not hmac.compare_digest(
        x_webhook_secret.encode(), expected.encode()
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="bad secret"
        )


# Billing off (self-hosted): the webhooks do not exist (404).
router = APIRouter(
    dependencies=[Depends(require_billing_enabled), Depends(require_webhook_secret)]
)


async def _locked_organization(db: AsyncSession, org_id: UUID) -> Organization:
    """The organization, row-locked: concurrent pushes and trial calls take
    turns, so the stale and idempotency checks below cannot race."""
    organization = (
        await db.execute(
            select(Organization)
            .where(col(Organization.id) == org_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    if organization is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="org not found"
        )
    return organization


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


@router.post("/billing/entitlement", response_class=JSONResponse)
async def billing_entitlement(
    *,
    db: AsyncSession = Depends(get_db),
    payload: EntitlementPush,
) -> dict:
    organization = await _locked_organization(db, payload.organization_id)
    if organization.deleted_at is not None:
        # A deleted organization stays deleted, whatever the billing system
        # still believes.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="org is deleted"
        )
    if (
        payload.as_of is not None
        and organization.entitlement_as_of is not None
        and payload.as_of < organization.entitlement_as_of
    ):
        # A delayed or retried push must not undo a newer one.
        return {"status": "stale"}

    crud_organization.apply_entitlement(
        organization=organization,
        entitlement=payload.entitlement(),
        reset_usage=payload.reset_usage,
    )
    await db.commit()
    # The accounts provider shows the state every time, not only on a
    # conversion: a missed report heals with the next push (it writes only what
    # changed). A converted organization's people leave the trial campaign.
    report_suspension(organization)
    return {"status": "ok"}


@router.post("/billing/terms", response_class=JSONResponse)
async def billing_terms(
    *,
    db: AsyncSession = Depends(get_db),
    payload: BillingTermsPush,
) -> dict:
    """The billing system's terms: the trial new organizations start with and
    the credit rates. Running trials keep what they started with."""
    if not await apply_terms(db, payload):
        return {"status": "stale"}
    return {"status": "ok"}


@router.post("/trial", response_class=JSONResponse)
async def trial_lifecycle(
    *,
    db: AsyncSession = Depends(get_db),
    payload: TrialStage,
) -> dict:
    """GOAT-managed trial lifecycle, driven by the trial_expiry task.

    stage=expiring -> warning email only; stage=expired -> suspend + email.
    The org stays on_trial either way — conversion (an entitlement push from
    a real subscription) is what ends the trial.

    Idempotent: the task may repeat a call or arrive after a conversion, a
    suspension or a deletion, and then nothing happens ({"status": "noop"}).
    """
    stage = payload.stage
    organization = await _locked_organization(db, payload.organization_id)
    active_trial = (
        organization.on_trial
        and not organization.suspended
        and organization.deleted_at is None
    )
    if stage == "expired":
        renewal = organization.plan_renewal_date
        if not (active_trial and renewal is not None and renewal <= _utcnow()):
            return {"status": "noop"}
        organization.suspended = True
        await db.commit()
        report_suspension(organization)
    elif not active_trial:
        return {"status": "noop"}

    # With the accounts sync on, the provider's trial campaign sends the
    # reminders; GOAT sends only the account email that the organization is
    # suspended.
    if stage == "expiring" and settings.accounts_sync_enabled:
        return {"status": "ok", "stage": stage}
    contact = await crud_user.get(db=db, id=organization.contact_user_id)
    if contact and contact.email:
        lang = await user_language(db, contact.id)
        with language(lang):
            if stage == "expiring":
                email_content = EmailTemplateContent(
                    artwork_url=f"{settings.email_artwork_url}/img/email/subscription_about_to_end.png",
                    title=_("Your GOAT trial ends soon"),
                    message=_(
                        "Your organization's projects and data stay as they are. Get in touch with us to keep using GOAT after the trial."
                    ),
                    action_label=(
                        _("Get in touch") if settings.EMAIL_CONTACT_URL else None
                    ),
                    action_url=settings.EMAIL_CONTACT_URL,
                )
                subject = _("GOAT - Your trial ends soon")
            else:
                email_content = EmailTemplateContent(
                    artwork_url=f"{settings.email_artwork_url}/img/email/organization_suspended.png",
                    title=_("Your GOAT trial has ended"),
                    message=_(
                        "Your organization's projects and data are kept. Get in touch with us to continue with GOAT."
                    ),
                    action_label=(
                        _("Get in touch") if settings.EMAIL_CONTACT_URL else None
                    ),
                    action_url=settings.EMAIL_CONTACT_URL,
                )
                subject = _("GOAT - Your trial has ended")
            send_email(
                email_to=contact.email,
                subject=subject,
                environment=email_content.model_dump(),
            )

    return {"status": "ok", "stage": stage}
