from fastapi import APIRouter, Depends, Header, HTTPException, status
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from core.core.config import settings
from core.crud.crud_organization import organization as crud_organization
from core.crud.crud_user import user as crud_user
from core.endpoints.deps import get_db
from core.schemas.email import EmailTemplateContent
from core.utils.email import send_email
from core.utils.i18n import trans as _

router = APIRouter()


@router.post("/odoo/entitlement", response_class=JSONResponse)
async def odoo_entitlement(
    *,
    db: AsyncSession = Depends(get_db),
    payload: dict,
    x_webhook_secret: str | None = Header(default=None),
) -> dict:
    if (
        not settings.ODOO_WEBHOOK_SECRET
        or x_webhook_secret != settings.ODOO_WEBHOOK_SECRET
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="bad secret"
        )

    org_id = payload.get("organization_id")
    organization = await crud_organization.get(db=db, id=org_id) if org_id else None
    if organization is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="org not found"
        )

    raw_reset = payload.get("reset_usage", True)
    reset_usage = (
        raw_reset
        if isinstance(raw_reset, bool)
        else str(raw_reset).strip().lower() not in ("false", "0", "no", "")
    )
    crud_organization.apply_entitlement(
        organization=organization,
        entitlement=payload,
        reset_usage=reset_usage,
    )
    await db.commit()
    return {"status": "ok"}


@router.post("/trial", response_class=JSONResponse)
async def trial_lifecycle(
    *,
    db: AsyncSession = Depends(get_db),
    payload: dict,
    x_webhook_secret: str | None = Header(default=None),
) -> dict:
    """GOAT-managed trial lifecycle, driven by the trial_expiry task.

    stage=expiring -> warning email only; stage=expired -> suspend + email.
    The org stays on_trial either way — conversion (an entitlement push from
    a real subscription) is what ends the trial.
    """
    if (
        not settings.ODOO_WEBHOOK_SECRET
        or x_webhook_secret != settings.ODOO_WEBHOOK_SECRET
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="bad secret"
        )

    stage = payload.get("stage")
    if stage not in ("expiring", "expired"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="stage must be 'expiring' or 'expired'",
        )

    org_id = payload.get("organization_id")
    organization = await crud_organization.get(db=db, id=org_id) if org_id else None
    if organization is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="org not found"
        )

    if stage == "expired":
        organization.suspended = True
        await db.commit()

    contact = await crud_user.get(db=db, id=organization.contact_user_id)
    if contact and contact.email:
        if stage == "expiring":
            email_content = EmailTemplateContent(
                artwork_url=f"{settings.email_artwork_url}/img/email/subscription_about_to_end.png",
                title=_("Your trial is about to end"),
                message=_("Please reach out to us to continue using GOAT."),
                action_label=(_("Contact us") if settings.EMAIL_CONTACT_URL else None),
                action_url=settings.EMAIL_CONTACT_URL,
            )
            subject = _("GOAT - Your trial is about to end")
        else:
            email_content = EmailTemplateContent(
                artwork_url=f"{settings.email_artwork_url}/img/email/organization_suspended.png",
                title=_("Your trial has expired"),
                message=_("Please reach out to us to reactivate your account."),
                action_label=(_("Contact us") if settings.EMAIL_CONTACT_URL else None),
                action_url=settings.EMAIL_CONTACT_URL,
            )
            subject = _("GOAT - Your trial has expired")
        send_email(
            email_to=contact.email,
            subject=subject,
            environment=email_content.model_dump(),
        )

    return {"status": "ok", "stage": stage}
