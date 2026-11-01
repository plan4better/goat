"""Outgoing email: SMTP settings, the SMTP session and the template branding.

The SMTP session is exercised through ``smtplib`` with its network calls
replaced, so the handling of ``ssl``/``starttls``/``none``, the login and the
TLS verification are part of what is tested.
"""

import datetime
import email as email_parser
import smtplib
import ssl
from dataclasses import dataclass, field
from email.message import Message
from pathlib import Path
from typing import Any

import pytest
from core.core.config import Settings
from core.utils import email as email_module
from core.utils.email import render_email_html, send_email
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

SMTP_ENV = [
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_SECURITY",
    "SMTP_TLS",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "SMTP_FROM",
    "EMAILS_FROM_NAME",
    "EMAIL_BRAND_NAME",
    "EMAIL_LOGO_URL",
    "EMAIL_CONTACT_URL",
    "EMAIL_PRIVACY_URL",
    "EMAIL_COMPANY_NAME",
    "EMAIL_COMPANY_URL",
]

SAAS_LOGO_URL = "https://assets.plan4better.de/img/logo/plan4better_standard.png"
SAAS_CONTACT_URL = "https://plan4better.de/kontakt/"
SAAS_PRIVACY_URL = "https://plan4better.de/privacy/"


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------


@pytest.fixture
def _settings_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in SMTP_ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("AUTH", "false")
    monkeypatch.setenv("POSTGRES_SERVER", "localhost")
    monkeypatch.setenv("POSTGRES_USER", "goat")
    monkeypatch.setenv("POSTGRES_PASSWORD", "goat")
    monkeypatch.setenv("POSTGRES_DB", "goat")


@pytest.mark.usefixtures("_settings_env")
def test_email_is_off_by_default() -> None:
    s = Settings()
    assert s.SMTP_HOST is None
    assert s.SMTP_PORT == 587
    assert s.SMTP_SECURITY == "starttls"
    assert s.SMTP_FROM is None
    assert s.EMAILS_FROM_NAME == "GOAT"
    assert s.EMAIL_BRAND_NAME == "GOAT"
    assert s.EMAIL_LOGO_URL is None
    assert s.EMAIL_CONTACT_URL is None
    assert s.EMAIL_PRIVACY_URL is None


@pytest.mark.usefixtures("_settings_env")
@pytest.mark.parametrize(
    ("smtp_tls", "security", "expected"),
    [
        ("False", None, "none"),
        ("True", None, "starttls"),
        ("False", "ssl", "ssl"),
        ("True", "none", "none"),
        (None, "ssl", "ssl"),
        (None, "", "starttls"),
        ("False", "", "none"),
    ],
)
def test_smtp_security_falls_back_to_smtp_tls(
    monkeypatch: pytest.MonkeyPatch,
    smtp_tls: str | None,
    security: str | None,
    expected: str,
) -> None:
    if smtp_tls is not None:
        monkeypatch.setenv("SMTP_TLS", smtp_tls)
    if security is not None:
        monkeypatch.setenv("SMTP_SECURITY", security)
    assert Settings().SMTP_SECURITY == expected


@pytest.mark.usefixtures("_settings_env")
def test_empty_optional_email_settings_read_as_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in (
        "SMTP_HOST",
        "SMTP_USER",
        "SMTP_PASSWORD",
        "SMTP_FROM",
        "EMAIL_LOGO_URL",
        "EMAIL_CONTACT_URL",
        "EMAIL_PRIVACY_URL",
    ):
        monkeypatch.setenv(name, "")
    s = Settings()
    assert s.SMTP_HOST is None
    assert s.SMTP_USER is None
    assert s.SMTP_PASSWORD is None
    assert s.SMTP_FROM is None
    assert s.EMAIL_LOGO_URL is None
    assert s.EMAIL_CONTACT_URL is None
    assert s.EMAIL_PRIVACY_URL is None


# ---------------------------------------------------------------------------
# SMTP session
# ---------------------------------------------------------------------------


@dataclass
class SmtpRecorder:
    connections: list[tuple[str, int, bool]] = field(default_factory=list)
    starttls: int = 0
    tls_contexts: list[ssl.SSLContext] = field(default_factory=list)
    logins: list[tuple[str, str]] = field(default_factory=list)
    mail_from: list[str] = field(default_factory=list)
    rcpt_to: list[str] = field(default_factory=list)
    data: list[bytes] = field(default_factory=list)

    def message(self) -> Message:
        assert len(self.data) == 1
        return email_parser.message_from_bytes(self.data[0])


@pytest.fixture
def smtp(monkeypatch: pytest.MonkeyPatch) -> SmtpRecorder:
    rec = SmtpRecorder()

    def connect(
        self: smtplib.SMTP, host: str = "localhost", port: int = 0, **_: Any
    ) -> tuple[int, bytes]:
        rec.connections.append((host, port, isinstance(self, smtplib.SMTP_SSL)))
        if isinstance(self, smtplib.SMTP_SSL):
            rec.tls_contexts.append(self.context)
        return 220, b"ready"

    def starttls(
        self: smtplib.SMTP, *_: Any, context: ssl.SSLContext | None = None, **__: Any
    ) -> tuple[int, bytes]:
        rec.starttls += 1
        assert context is not None
        rec.tls_contexts.append(context)
        return 220, b"go ahead"

    def login(self: smtplib.SMTP, user: str, password: str, **_: Any) -> None:
        rec.logins.append((user, password))

    def mail(self: smtplib.SMTP, sender: str, *_: Any) -> tuple[int, bytes]:
        rec.mail_from.append(sender)
        return 250, b"ok"

    def rcpt(self: smtplib.SMTP, recip: str, *_: Any) -> tuple[int, bytes]:
        rec.rcpt_to.append(recip)
        return 250, b"ok"

    def data(self: smtplib.SMTP, msg: bytes) -> tuple[int, bytes]:
        rec.data.append(msg)
        return 250, b"queued"

    def noop(self: smtplib.SMTP, *_: Any, **__: Any) -> None:
        return None

    monkeypatch.setattr(smtplib.SMTP, "connect", connect)
    monkeypatch.setattr(smtplib.SMTP, "starttls", starttls)
    monkeypatch.setattr(smtplib.SMTP, "login", login)
    monkeypatch.setattr(smtplib.SMTP, "mail", mail)
    monkeypatch.setattr(smtplib.SMTP, "rcpt", rcpt)
    monkeypatch.setattr(smtplib.SMTP, "data", data)
    monkeypatch.setattr(smtplib.SMTP, "ehlo_or_helo_if_needed", noop)
    monkeypatch.setattr(smtplib.SMTP, "quit", noop)
    monkeypatch.setattr(smtplib.SMTP, "close", noop)
    monkeypatch.setattr(smtplib.SMTP, "rset", noop)
    return rec


def _configure(monkeypatch: pytest.MonkeyPatch, **values: Any) -> None:
    defaults: dict[str, Any] = {
        "SMTP_HOST": "mail.example.org",
        "SMTP_PORT": 587,
        "SMTP_SECURITY": "starttls",
        "SMTP_USER": None,
        "SMTP_PASSWORD": None,
        "SMTP_FROM": None,
        "EMAILS_FROM_NAME": "GOAT",
        "EMAIL_BRAND_NAME": "GOAT",
        "EMAIL_LOGO_URL": None,
        "EMAIL_CONTACT_URL": None,
        "EMAIL_PRIVACY_URL": None,
        "EMAIL_COMPANY_NAME": None,
        "EMAIL_COMPANY_URL": None,
        "GOAT_CA_BUNDLE": None,
    }
    defaults.update(values)
    for name, value in defaults.items():
        monkeypatch.setattr(email_module.settings, name, value)


def _send() -> None:
    send_email(
        email_to="someone@example.org",
        subject="Hello",
        environment={"artwork_url": "", "title": "Title", "message": "Body"},
    )


def test_starttls_with_login(
    monkeypatch: pytest.MonkeyPatch, smtp: SmtpRecorder
) -> None:
    _configure(
        monkeypatch,
        SMTP_USER="mailer@example.org",
        SMTP_PASSWORD="secret",
        SMTP_FROM="no-reply@example.org",
    )
    _send()
    assert smtp.connections == [("mail.example.org", 587, False)]
    assert smtp.starttls == 1
    assert smtp.logins == [("mailer@example.org", "secret")]
    assert smtp.mail_from == ["no-reply@example.org"]
    assert smtp.rcpt_to == ["someone@example.org"]
    assert smtp.message()["From"] == "GOAT <no-reply@example.org>"


def test_ssl_opens_a_tls_socket_without_starttls(
    monkeypatch: pytest.MonkeyPatch, smtp: SmtpRecorder
) -> None:
    _configure(
        monkeypatch,
        SMTP_PORT=465,
        SMTP_SECURITY="ssl",
        SMTP_USER="mailer@example.org",
        SMTP_PASSWORD="secret",
    )
    _send()
    assert smtp.connections
    assert all(conn == ("mail.example.org", 465, True) for conn in smtp.connections)
    assert smtp.starttls == 0
    assert smtp.logins == [("mailer@example.org", "secret")]


def test_relay_without_login_or_tls(
    monkeypatch: pytest.MonkeyPatch, smtp: SmtpRecorder
) -> None:
    _configure(
        monkeypatch,
        SMTP_PORT=25,
        SMTP_SECURITY="none",
        SMTP_FROM="goat@intranet.example",
        EMAILS_FROM_NAME="City GIS",
    )
    _send()
    assert smtp.connections == [("mail.example.org", 25, False)]
    assert smtp.starttls == 0
    assert smtp.logins == []
    assert smtp.mail_from == ["goat@intranet.example"]
    assert smtp.message()["From"] == "City GIS <goat@intranet.example>"


def test_starttls_relay_without_login(
    monkeypatch: pytest.MonkeyPatch, smtp: SmtpRecorder
) -> None:
    _configure(monkeypatch, SMTP_FROM="goat@example.org")
    _send()
    assert smtp.starttls == 1
    assert smtp.logins == []


def test_sender_falls_back_to_smtp_user(
    monkeypatch: pytest.MonkeyPatch, smtp: SmtpRecorder
) -> None:
    _configure(monkeypatch, SMTP_USER="mailer@example.org", SMTP_PASSWORD="secret")
    _send()
    assert smtp.mail_from == ["mailer@example.org"]
    assert smtp.message()["From"] == "GOAT <mailer@example.org>"


def test_no_smtp_host_sends_nothing(
    monkeypatch: pytest.MonkeyPatch, smtp: SmtpRecorder
) -> None:
    _configure(monkeypatch, SMTP_HOST=None, SMTP_USER="mailer@example.org")
    _send()
    assert smtp.connections == []


def test_no_sender_address_logs_an_error_and_sends_nothing(
    monkeypatch: pytest.MonkeyPatch,
    smtp: SmtpRecorder,
    caplog: pytest.LogCaptureFixture,
) -> None:
    _configure(monkeypatch)
    with caplog.at_level("ERROR"):
        _send()
    assert smtp.connections == []
    assert any("SMTP_FROM" in r.getMessage() for r in caplog.records)


def test_sent_html_carries_the_rendered_template(
    monkeypatch: pytest.MonkeyPatch, smtp: SmtpRecorder
) -> None:
    _configure(monkeypatch, SMTP_FROM="goat@example.org")
    _send()
    parts = [p for p in smtp.message().walk() if p.get_content_type() == "text/html"]
    assert len(parts) == 1
    html = parts[0].get_payload(decode=True).decode()
    assert "Title" in html and "Body" in html
    assert "plan4better" not in html.lower()


# ---------------------------------------------------------------------------
# Template branding
# ---------------------------------------------------------------------------

_CONTENT = {
    "artwork_url": "",
    "title": "Title",
    "message": "Body",
    "action_label": "Join",
    "action_url": "https://goat.example.org/invite/1",
}


def test_default_template_is_plain_goat(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch)
    html = render_email_html(environment=_CONTENT)
    assert "plan4better" not in html.lower()
    assert "<img" not in html
    assert "GOAT" in html
    assert "twitter" not in html.lower() and "linkedin" not in html.lower()
    assert "https://goat.example.org/invite/1" in html


def test_template_with_hosted_branding(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(
        monkeypatch,
        EMAIL_BRAND_NAME="Plan4Better GmbH",
        EMAIL_LOGO_URL=SAAS_LOGO_URL,
        EMAIL_CONTACT_URL=SAAS_CONTACT_URL,
        EMAIL_PRIVACY_URL=SAAS_PRIVACY_URL,
    )
    html = render_email_html(environment=_CONTENT)
    assert f'src="{SAAS_LOGO_URL}"' in html
    assert f'href="{SAAS_CONTACT_URL}"' in html
    assert f'href="{SAAS_PRIVACY_URL}"' in html
    assert "Plan4Better GmbH" in html


def test_template_with_only_a_contact_link(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch, EMAIL_CONTACT_URL="https://gis.example.org/contact")
    html = render_email_html(environment=_CONTENT)
    assert 'href="https://gis.example.org/contact"' in html
    assert "Privacy" not in html


def test_root_relative_images_are_resolved_against_client_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure(monkeypatch, EMAIL_LOGO_URL="/assets/svg/goat-logo.svg")
    monkeypatch.setattr(email_module.settings, "CLIENT_URL", "https://goat.example.org")
    html = render_email_html(
        environment={**_CONTENT, "artwork_url": "/assets/img/email/x.png"}
    )
    assert 'src="https://goat.example.org/assets/svg/goat-logo.svg"' in html
    assert 'src="https://goat.example.org/assets/img/email/x.png"' in html


def test_email_artwork_defaults_to_client_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(email_module.settings, "STATIC_ASSETS_URL", None)
    monkeypatch.setattr(email_module.settings, "CLIENT_URL", "https://goat.example.org")
    assert email_module.settings.email_artwork_url == "https://goat.example.org/assets"
    monkeypatch.setattr(email_module.settings, "STATIC_ASSETS_URL", "https://cdn.x")
    assert email_module.settings.email_artwork_url == "https://cdn.x"


def _company_ca(tmp_path: Path) -> tuple[Path, str]:
    """A self-signed CA certificate in PEM and its common name."""
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Example Company CA")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    path = tmp_path / "company-ca.pem"
    path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return path, "Example Company CA"


def _ca_names(context: ssl.SSLContext) -> set[str]:
    return {
        value
        for cert in context.get_ca_certs()
        for rdn in cert["subject"]
        for key, value in rdn
        if key == "commonName"
    }


def test_the_relay_certificate_is_verified(
    monkeypatch: pytest.MonkeyPatch, smtp: SmtpRecorder
) -> None:
    _configure(monkeypatch, SMTP_FROM="no-reply@example.org")
    _send()
    [context] = smtp.tls_contexts
    assert context.verify_mode == ssl.CERT_REQUIRED
    assert context.check_hostname is True
    assert _ca_names(context)  # the public CAs


@pytest.mark.parametrize("security,port", [("starttls", 587), ("ssl", 465)])
def test_the_company_ca_is_trusted(
    monkeypatch: pytest.MonkeyPatch,
    smtp: SmtpRecorder,
    tmp_path: Path,
    security: str,
    port: int,
) -> None:
    bundle, ca_name = _company_ca(tmp_path)
    _configure(
        monkeypatch,
        SMTP_SECURITY=security,
        SMTP_PORT=port,
        SMTP_FROM="no-reply@example.org",
        GOAT_CA_BUNDLE=str(bundle),
    )
    _send()
    assert smtp.tls_contexts
    assert all(ca_name in _ca_names(ctx) for ctx in smtp.tls_contexts)
    assert smtp.rcpt_to == ["someone@example.org"]


def test_a_failed_send_is_logged_not_raised(
    monkeypatch: pytest.MonkeyPatch,
    smtp: SmtpRecorder,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    _configure(
        monkeypatch,
        SMTP_FROM="no-reply@example.org",
        GOAT_CA_BUNDLE=str(tmp_path / "missing.pem"),
    )
    _send()
    assert smtp.data == []
    assert "Sending email to someone@example.org failed" in caplog.text


# ---------------------------------------------------------------------------
# Language
# ---------------------------------------------------------------------------


def test_a_mail_is_built_in_the_recipients_language() -> None:
    from core.utils.i18n import current_locale, language
    from core.utils.i18n import trans as _

    before = current_locale()
    with language("de"):
        title = _("Your GOAT trial has ended")
        html = render_email_html({**_CONTENT, "title": title})
    assert title == "Ihr GOAT-Testzeitraum ist beendet"
    assert (
        "Sie erhalten diese E-Mail wegen Ihres GOAT-Kontos." in html
        and 'lang="de"' in html
    )
    with language("en"):
        html = render_email_html(_CONTENT)
    assert (
        "You receive this email because of your GOAT account." in html
        and 'lang="en"' in html
    )
    assert current_locale() == before


def test_user_input_in_a_mail_is_escaped() -> None:
    """Titles and messages carry organization names: markup in one stays text."""
    html = render_email_html(
        {**_CONTENT, "title": '<a href="https://evil.example">Confirm</a>'}
    )
    assert '<a href="https://evil.example">' not in html
    assert "&lt;a href=&#34;https://evil.example&#34;&gt;Confirm&lt;/a&gt;" in html
