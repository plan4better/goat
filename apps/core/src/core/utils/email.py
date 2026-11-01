import contextlib
import logging
import smtplib
import ssl
from typing import Any, Dict

import certifi
import emails

from core.core.config import settings
from core.utils.i18n import active_jinja_env


def render_email_html(
    environment: Dict[str, Any],
    html_template: str = "email/template.html",
) -> str:
    template = active_jinja_env().get_template(html_template)
    # Mail clients fetch images from outside GOAT: root-relative paths are
    # resolved against CLIENT_URL.
    environment = dict(environment)
    if environment.get("artwork_url"):
        environment["artwork_url"] = settings.absolute_url(environment["artwork_url"])
    logo_url = settings.EMAIL_LOGO_URL
    return template.render(
        static_assets_url=settings.email_artwork_url,
        brand_name=settings.EMAIL_BRAND_NAME,
        brand_url=settings.CLIENT_URL,
        logo_url=settings.absolute_url(logo_url) if logo_url else None,
        contact_url=settings.EMAIL_CONTACT_URL,
        privacy_url=settings.EMAIL_PRIVACY_URL,
        company_name=settings.EMAIL_COMPANY_NAME,
        company_url=settings.EMAIL_COMPANY_URL,
        **environment,
    )


async def user_language(db: Any, user_id: Any) -> str:
    """The GOAT language of a mail's recipient (their setting), GOAT's default
    for someone without one."""
    from sqlalchemy import select

    from core.db.models.system_setting import SystemSetting
    from core.schemas.system_setting import default_system_settings

    setting = None
    if user_id:
        setting = (
            await db.execute(
                select(SystemSetting.preferred_language).where(
                    SystemSetting.user_id == user_id
                )
            )
        ).scalar_one_or_none()
    value = setting or default_system_settings.preferred_language
    return str(getattr(value, "value", value))


SMTP_TIMEOUT = 30  # seconds


def _tls_context() -> ssl.SSLContext:
    """Verifies the relay's certificate against the public CAs and the
    certificates in GOAT_CA_BUNDLE."""
    context = ssl.create_default_context(cafile=certifi.where())
    if settings.GOAT_CA_BUNDLE:
        context.load_verify_locations(cafile=settings.GOAT_CA_BUNDLE)
    return context


def _deliver(sender: str, email_to: str, message: str) -> None:
    host, port = settings.SMTP_HOST or "", settings.SMTP_PORT
    client: smtplib.SMTP
    if settings.SMTP_SECURITY == "ssl":
        client = smtplib.SMTP_SSL(
            host, port, timeout=SMTP_TIMEOUT, context=_tls_context()
        )
    else:
        client = smtplib.SMTP(host, port, timeout=SMTP_TIMEOUT)
    try:
        if settings.SMTP_SECURITY == "starttls":
            client.starttls(context=_tls_context())
        if settings.SMTP_USER:
            client.login(settings.SMTP_USER, settings.SMTP_PASSWORD or "")
        client.sendmail(sender, [email_to], message)
    finally:
        with contextlib.suppress(smtplib.SMTPException, OSError):
            client.quit()


def send_email(
    email_to: str,
    subject: str = "",
    html_template: str = "email/template.html",
    environment: Dict[str, Any] = {},
) -> None:
    if not settings.SMTP_HOST:
        logging.info(f"SMTP not configured, skipping email to {email_to}: {subject}")
        return
    sender = settings.smtp_sender
    if not sender:
        logging.error(
            f"SMTP_HOST is set but neither SMTP_FROM nor SMTP_USER is, "
            f"skipping email to {email_to}: {subject}"
        )
        return
    # One line: a subject carries organization names, never a header break.
    subject = " ".join(subject.split())
    message = emails.Message(
        subject=subject,
        html=render_email_html(environment, html_template),
        mail_from=(settings.EMAILS_FROM_NAME, sender),
        mail_to=email_to,
    )
    try:
        _deliver(sender, email_to, message.as_string())
    except (smtplib.SMTPException, ssl.SSLError, OSError):
        logging.exception(f"Sending email to {email_to} failed: {subject}")
        return
    logging.info(f"Sent email to {email_to}: {subject}")


email_content_config = {
    "activate_new_organization": {
        "url": f"{settings.API_URL}/organizations/activate?token=",
        "subject": {
            "en": "Activate your GOAT demo",
            "de": "Demo aktivieren",
        },
        "template_name": "activate_new_organization",
    },
    "subscription_trial_started": {
        "url": "",
        "subject": {
            "en": "Your GOAT demo is ready to use",
            "de": "Ihre GOAT Demo steht bereit",
        },
        "template_name": "subscription_trial_started",
    },
    "subscription_trial_expiring": {
        "url": "",
        "subject": {"en": "Demo expiring soon", "de": "Demo bald ablaufen"},
        "template_name": "subscription_trial_expiring",
    },
    "subscription_trial_expired": {
        "url": "",
        "subject": {"en": "Demo expired", "de": "Demo abgelaufen"},
        "template_name": "subscription_trial_expired",
    },
}
