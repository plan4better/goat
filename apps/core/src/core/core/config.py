import os
from typing import Literal
from uuid import UUID

from goatlib.auth import AuthFlag, require_keycloak_url
from pydantic import PostgresDsn, ValidationInfo, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Member-less organization that owns the GOAT layout starters when login is
# on and GOAT_TEMPLATES_ORGANIZATION_ID is unset (see db/seed_templates.py).
GOAT_SYSTEM_ORGANIZATION_ID = UUID("60a70000-0000-4000-8000-000000000001")

# Path under which the web app serves the product artwork it ships.
WEB_ARTWORK_PATH = "/assets"
# Base URL of the artwork on the hosted GOAT CDN. Rows that carry a default
# thumbnail or avatar under it still count as carrying that default.
HOSTED_ARTWORK_URL = "https://assets.plan4better.de"


class Settings(BaseSettings):
    # ------------------------------------------------------------------
    # Application
    # ------------------------------------------------------------------
    PROJECT_NAME: str = "GOAT Core API"
    ENVIRONMENT: str = "dev"
    AUTH: AuthFlag = True
    TEST_MODE: bool = False
    API_V2_STR: str = "/api/v2"
    API_URL: str = "http://localhost:8000/api/v2"
    CLIENT_URL: str = "http://localhost:3000"
    MAX_FOLDER_COUNT: int = 100

    # ------------------------------------------------------------------
    # Database
    # ------------------------------------------------------------------
    POSTGRES_SERVER: str
    POSTGRES_USER: str
    POSTGRES_PASSWORD: str
    POSTGRES_DB: str
    POSTGRES_PORT: int = 5432
    # Connections each process keeps open, and how many more it may open
    # under load before requests wait for a free one.
    POSTGRES_POOL_SIZE: int = 5
    POSTGRES_MAX_OVERFLOW: int = 10
    ASYNC_SQLALCHEMY_DATABASE_URI: str | None = None

    @field_validator("ASYNC_SQLALCHEMY_DATABASE_URI", mode="after")
    @classmethod
    def assemble_async_db_connection(
        cls: type["Settings"], value: str | None, info: ValidationInfo
    ) -> str:
        if value:
            return value
        return str(
            PostgresDsn.build(
                scheme="postgresql+psycopg",
                username=info.data.get("POSTGRES_USER"),
                password=info.data.get("POSTGRES_PASSWORD"),
                host=info.data.get("POSTGRES_SERVER"),
                port=info.data.get("POSTGRES_PORT"),
                path=f"{info.data.get('POSTGRES_DB') or ''}",
            )
        )

    # ------------------------------------------------------------------
    # Schemas
    # ------------------------------------------------------------------
    SCHEMA: str = "customer"

    # ------------------------------------------------------------------
    # Auth / Keycloak
    # ------------------------------------------------------------------
    # Required when AUTH is on (see _require_keycloak).
    KEYCLOAK_SERVER_URL: str = ""
    REALM_NAME: str | None = "p4b"
    KEYCLOAK_CLIENT_ID: str | None = None
    KEYCLOAK_CLIENT_SECRET: str | None = None
    # With AUTH on: inviting an email that has no account in the realm creates
    # the Keycloak user and has Keycloak email a "set your password" link, for
    # realms where people cannot register themselves. The client above needs
    # the manage-users role and must accept CLIENT_URL as a redirect URI.
    KEYCLOAK_PROVISION_INVITED_USERS: bool = False
    # Default identity used when AUTH=False (local dev / self-hosted without
    # Keycloak). Requests without a bearer token act as this user; the user and
    # its organization are seeded by initial_data.
    DEFAULT_USER_ID: str = "744e4fd1-685c-495c-8b02-efebce875359"
    DEFAULT_USER_EMAIL: str = "admin@goat.local"
    DEFAULT_USER_FIRSTNAME: str = "GOAT"
    DEFAULT_USER_LASTNAME: str = "Admin"
    DEFAULT_ORGANIZATION_NAME: str = "GOAT"
    # The catalog mirror directory (mirror_items.parquet, written by goatlib
    # sync_catalog) — one of two subtrees core reads from the shared volume,
    # and it only ever reads. Deployments should mount just these subtrees,
    # read-only; user data on that volume is not core's business. The default
    # derives from DATA_DIR so a whole-volume mount keeps working unconfigured.
    CATALOG_DATA_DIR: str = os.path.join(os.getenv("DATA_DIR", "/app/data"), "catalog")
    # The geo database directory (a .mmdb written by goatlib sync_geoip), used
    # to open a new project near whoever created it. Read-only, like the
    # catalog mirror, and entirely optional: with no file here the lookup is
    # skipped and project creation falls back to the rungs below. A deployment
    # supplying its own database mounts it in here rather than configuring a
    # second path — any .mmdb in this directory is read.
    GEOIP_DATA_DIR: str = os.path.join(os.getenv("DATA_DIR", "/app/data"), "geoip")
    # The starting view for new projects, as a JSON object with the keys of
    # InitialViewState. Set it to pin a deployment to its own region — an
    # on-prem install serving one city. It is consulted after the creator's
    # own location, which in such a deployment answers nothing anyway: users
    # arrive from private addresses, and those are never geolocated. Unset on
    # hosted GOAT, where callers come from everywhere.
    DEFAULT_PROJECT_VIEW_STATE: str | None = None
    # Plan and quotas applied to organizations when no billing system is
    # configured (self-hosted deployments). With billing enabled these come
    # from the billing provider instead.
    DEFAULT_QUOTA_STORAGE_MB: int = 1048576
    DEFAULT_QUOTA_PROJECTS: int = 10000
    DEFAULT_QUOTA_EDITORS: int = 1000
    DEFAULT_QUOTA_VIEWERS: int = 1000
    # Credit metering. Conversion rates are NOT config — they are billing data
    # in the customer.credit_rate table (seeded in the migration; operator/Odoo
    # editable). Only operational knobs live here.
    MAX_TOOL_RUNTIME_SECONDS: int = 1800
    # Self-hosted credit allowance. None == unlimited (gate skipped).
    DEFAULT_QUOTA_CREDITS: float | None = None

    # ------------------------------------------------------------------
    # Templates (T11b): organization whose space owns the seeded GOAT
    # layout starters. When unset, the starters live in the default user's
    # personal space with AUTH off, and in the space of the system
    # organization (GOAT_SYSTEM_ORGANIZATION_ID) with AUTH on.
    # ------------------------------------------------------------------
    GOAT_TEMPLATES_ORGANIZATION_ID: UUID | None = None

    # ------------------------------------------------------------------
    # Object storage — data bucket (S3-compatible: AWS / Hetzner / MinIO)
    # ------------------------------------------------------------------
    S3_ACCESS_KEY_ID: str | None = None
    S3_SECRET_ACCESS_KEY: str | None = None
    S3_REGION: str | None = "eu-central-1"  # or "fsn1" for Hetzner
    S3_ENDPOINT_URL: str | None = None  # e.g. "https://s3.fsn1.de"; None for AWS
    S3_PUBLIC_ENDPOINT_URL: str | None = None  # e.g. "https://s3.plan4better.de"
    S3_PROVIDER: str | None = "aws"  # "aws" | "hetzner" | "minio"
    S3_FORCE_PATH_STYLE: bool = False  # needed for MinIO
    S3_BUCKET_PATH: str | None = ""  # set depending on ENVIRONMENT
    S3_BUCKET_NAME: str | None = "goat"
    MAX_UPLOAD_DATASET_FILE_SIZE: int = 5 * 1024 * 1024 * 1024  # 5 GB

    # ------------------------------------------------------------------
    # Object storage — assets bucket (avatars, documents)
    # ------------------------------------------------------------------
    # Credentials and region of the assets bucket, independent of the data
    # bucket's. Without ASSETS_S3_ENDPOINT_URL the bucket is on AWS.
    AWS_ACCESS_KEY_ID: str | None = None
    AWS_SECRET_ACCESS_KEY: str | None = None
    AWS_REGION: str | None = "eu-central-1"
    AWS_S3_ASSETS_BUCKET: str | None = "goat-assets"
    ASSETS_S3_ENDPOINT_URL: str | None = None
    ASSETS_S3_FORCE_PATH_STYLE: bool = False

    # ------------------------------------------------------------------
    # Assets / thumbnails
    # ------------------------------------------------------------------
    # Public base URL of the assets bucket: user uploads are served from
    # ``{ASSETS_URL}/{s3_key}``. Unset, a bucket on AWS is served from its own
    # public URL; a bucket behind ASSETS_S3_ENDPOINT_URL needs it set.
    ASSETS_URL: str | None = None
    # Base URL of the product artwork (email images, default thumbnails and
    # avatars), for a mirror or CDN. Unset, the artwork the web app ships is
    # used: stored values and URLs sent to the browser point at /assets on
    # whichever host serves GOAT, emails at {CLIENT_URL}/assets.
    STATIC_ASSETS_URL: str | None = None
    ASSETS_MAX_FILE_SIZE: int | None = 4194304
    DOCUMENTS_MAX_FILE_SIZE: int = 52428800  # 50 MiB
    # Unset, these default to artwork under artwork_url
    # (see _default_artwork).
    DEFAULT_PROJECT_THUMBNAIL: str | None = None
    DEFAULT_LAYER_THUMBNAIL: str | None = None

    # ------------------------------------------------------------------
    # Default avatars
    # ------------------------------------------------------------------
    USER_DEFAULT_AVATAR: str | None = None
    ORGANIZATION_DEFAULT_AVATAR: str | None = None

    @field_validator("STATIC_ASSETS_URL", mode="before")
    @classmethod
    def _empty_static_assets_url_is_unset(
        cls: type["Settings"], value: object
    ) -> object:
        return None if isinstance(value, str) and not value.strip() else value

    @field_validator("ASSETS_URL", "STATIC_ASSETS_URL", mode="after")
    @classmethod
    def _strip_trailing_slash(cls: type["Settings"], value: str | None) -> str | None:
        return value.rstrip("/") if value else value

    @property
    def artwork_url(self) -> str:
        """Base URL of the artwork in values stored in the database or sent
        to the browser: root-relative unless STATIC_ASSETS_URL is set, so it
        resolves on every host that serves GOAT."""
        return self.STATIC_ASSETS_URL or WEB_ARTWORK_PATH

    @property
    def email_artwork_url(self) -> str:
        """Base URL of the artwork in emails, which mail clients fetch and so
        must be absolute."""
        return self.STATIC_ASSETS_URL or self.absolute_url(WEB_ARTWORK_PATH)

    def absolute_url(self, url: str) -> str:
        """A root-relative path resolved against CLIENT_URL; anything else as
        it is."""
        if url.startswith("/") and not url.startswith("//"):
            return f"{self.CLIENT_URL.rstrip('/')}{url}"
        return url

    def _artwork_path(self, url: str) -> str | None:
        for base in (self.STATIC_ASSETS_URL, WEB_ARTWORK_PATH, HOSTED_ARTWORK_URL):
            if base and url.startswith(f"{base}/"):
                return url[len(base) :]
        return None

    def is_same_artwork(self, url: str | None, default: str | None) -> bool:
        """Whether ``url`` is the artwork ``default`` names, under any of the
        bases the artwork is or was stored with."""
        if not url or not default:
            return False
        if url == default:
            return True
        path = self._artwork_path(url)
        return path is not None and path == self._artwork_path(default)

    @model_validator(mode="after")
    def _default_assets_url(self) -> "Settings":
        if self.ASSETS_URL:
            return self
        if self.ASSETS_S3_ENDPOINT_URL:
            raise ValueError(
                "ASSETS_URL must be set to the public URL of the assets bucket "
                "when ASSETS_S3_ENDPOINT_URL is set"
            )
        self.ASSETS_URL = (
            f"https://{self.AWS_S3_ASSETS_BUCKET}.s3.{self.AWS_REGION}.amazonaws.com"
        )
        return self

    @model_validator(mode="after")
    def _default_artwork(self) -> "Settings":
        base = self.artwork_url
        if not self.DEFAULT_PROJECT_THUMBNAIL:
            self.DEFAULT_PROJECT_THUMBNAIL = f"{base}/img/goat_new_project_artwork.png"
        if not self.DEFAULT_LAYER_THUMBNAIL:
            self.DEFAULT_LAYER_THUMBNAIL = f"{base}/img/goat_new_dataset_thumbnail.png"
        if not self.USER_DEFAULT_AVATAR:
            self.USER_DEFAULT_AVATAR = f"{base}/img/no-user-thumb.jpg"
        if not self.ORGANIZATION_DEFAULT_AVATAR:
            self.ORGANIZATION_DEFAULT_AVATAR = f"{base}/img/no-org-thumb.jpg"
        return self

    # ------------------------------------------------------------------
    # Email / SMTP
    # ------------------------------------------------------------------
    # Email is sent only when SMTP_HOST is set. SMTP_USER/SMTP_PASSWORD are
    # optional: without them core sends through the server without logging
    # in (a relay). SMTP_SECURITY: "starttls" upgrades a plain connection
    # (usually port 587), "ssl" opens a TLS connection (usually 465), "none"
    # sends in plain text (e.g. an internal relay on 25). When SMTP_SECURITY
    # is unset, SMTP_TLS=False selects "none".
    SMTP_HOST: str | None = None
    SMTP_PORT: int = 587
    SMTP_SECURITY: Literal["starttls", "ssl", "none"] | None = None
    SMTP_TLS: bool | None = None
    SMTP_USER: str | None = None
    SMTP_PASSWORD: str | None = None
    # Sender address; SMTP_USER when unset.
    SMTP_FROM: str | None = None
    # Extra CA certificates (PEM) to trust, e.g. for an SMTP relay whose
    # certificate comes from a company CA; the public CAs are always trusted.
    GOAT_CA_BUNDLE: str | None = None
    EMAILS_FROM_NAME: str = "GOAT"

    # Email branding. Without a logo the brand name is shown as text; footer
    # links without a URL are left out.
    EMAIL_BRAND_NAME: str = "GOAT"
    EMAIL_LOGO_URL: str | None = None
    EMAIL_CONTACT_URL: str | None = None
    EMAIL_PRIVACY_URL: str | None = None

    @field_validator(
        "SMTP_HOST",
        "SMTP_SECURITY",
        "SMTP_TLS",
        "SMTP_USER",
        "SMTP_PASSWORD",
        "SMTP_FROM",
        "EMAIL_LOGO_URL",
        "EMAIL_CONTACT_URL",
        "EMAIL_PRIVACY_URL",
        mode="before",
    )
    @classmethod
    def _empty_is_unset(cls: type["Settings"], value: object) -> object:
        return None if isinstance(value, str) and not value.strip() else value

    @model_validator(mode="after")
    def _default_smtp_security(self) -> "Settings":
        if self.SMTP_SECURITY is None:
            self.SMTP_SECURITY = "none" if self.SMTP_TLS is False else "starttls"
        return self

    @property
    def smtp_sender(self) -> str | None:
        return self.SMTP_FROM or self.SMTP_USER

    # ------------------------------------------------------------------
    # Billing / Odoo
    # ------------------------------------------------------------------
    ODOO_WEBHOOK_SECRET: str | None = None

    # ------------------------------------------------------------------
    # Trial (SaaS signup). GOAT-managed: no billing record until sales
    # converts the org (docs/odoo-entitlement-contract.md). Self-hosted
    # deployments never start trials — orgs get DEFAULT_QUOTA_*.
    # ------------------------------------------------------------------
    TRIAL_DAYS: int = 14
    TRIAL_QUOTA_STORAGE_MB: float = 5120
    TRIAL_QUOTA_PROJECTS: int = 50
    TRIAL_QUOTA_EDITORS: int = 3
    TRIAL_QUOTA_VIEWERS: int = 2

    # ------------------------------------------------------------------
    # Processes service (OGC API - Processes front for Windmill). Core posts
    # here to run the background jobs it triggers (layer/bundle cleanup on
    # delete, bundle import, catalog materialize). GOAT_GEOAPI_HOST is the
    # former name — read as a fallback so existing deployments keep working.
    # ------------------------------------------------------------------
    GOAT_PROCESSES_URL: str | None = None
    GOAT_GEOAPI_HOST: str | None = None  # deprecated alias for GOAT_PROCESSES_URL

    @property
    def processes_url(self) -> str | None:
        return self.GOAT_PROCESSES_URL or self.GOAT_GEOAPI_HOST

    # ------------------------------------------------------------------
    # Custom domains (white label)
    # ------------------------------------------------------------------
    # Customers CNAME their domains at this hostname. It is itself a CNAME
    # pointing at the Caddy LoadBalancer's hostname, so the underlying LB can
    # be migrated without breaking customer DNS records. Empty turns the
    # custom-domain feature off.
    CUSTOM_DOMAIN_CNAME_TARGET: str = ""
    # Public resolvers used by white-label DNS reconciliation. We query these
    # directly instead of the pod's resolver so we see DNS the way customers do
    # — bypassing split-DNS setups. Comma-separated list of IPs.
    CUSTOM_DOMAIN_DNS_RESOLVERS: str = "1.1.1.1,8.8.8.8"

    @property
    def custom_domains_enabled(self) -> bool:
        return bool(self.CUSTOM_DOMAIN_CNAME_TARGET.strip())

    # ------------------------------------------------------------------
    # Plan4Better's Odoo (SaaS only; see core.odoo). The connection is
    # shared; each integration has its own key, from its own least-privilege
    # Odoo user, and is on only when the connection and its settings are set.
    # Self-hosted installs set none of them.
    # ------------------------------------------------------------------
    ODOO_URL: str | None = None
    ODOO_DB: str | None = None
    # Support tickets (Odoo Helpdesk), through the portal user "GOAT Support Bridge".
    ODOO_SUPPORT_API_KEY: str | None = None
    ODOO_SUPPORT_TEAM_ID: int | None = None
    ODOO_SUPPORT_POST_ACTION: str = "GOAT: post message as ticket participant"

    @field_validator(
        "ODOO_URL",
        "ODOO_DB",
        "ODOO_SUPPORT_API_KEY",
        "ODOO_SUPPORT_TEAM_ID",
        mode="before",
    )
    @classmethod
    def _odoo_empty_is_unset(cls: type["Settings"], value: object) -> object:
        return None if isinstance(value, str) and not value.strip() else value

    @property
    def support_enabled(self) -> bool:
        return all(
            (
                self.ODOO_URL,
                self.ODOO_DB,
                self.ODOO_SUPPORT_API_KEY,
                self.ODOO_SUPPORT_TEAM_ID,
            )
        )

    @model_validator(mode="after")
    def _require_keycloak(self) -> "Settings":
        require_keycloak_url(self.AUTH, self.KEYCLOAK_SERVER_URL)
        return self

    model_config = SettingsConfigDict(case_sensitive=True)


settings = Settings()
