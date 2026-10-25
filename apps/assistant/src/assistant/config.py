import json
import ssl
from typing import Annotated
from urllib.parse import urlsplit

from cryptography.fernet import Fernet, MultiFernet
from goatlib.api.root_path import normalize_root_path
from goatlib.auth import (
    AuthFlag,
    require_keycloak_url,
    require_own_client_allowed,
)
from goatlib.config.postgres import parse_transaction_pooler
from pydantic import (
    AliasChoices,
    Field,
    SecretStr,
    ValidationInfo,
    field_validator,
    model_validator,
)
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

from assistant.llm.types import PROVIDER_TYPES, DefaultProvider, ProviderType
from assistant.surfaces import Surface
from assistant.tls import ssl_context


class AssistantSettings(BaseSettings):
    """Settings of the assistant service.

    Fields without an alias read ``ASSISTANT_<NAME>`` (e.g.
    ``ASSISTANT_RUN_MAX_TOOL_CALLS``). Repo-wide values (``AUTH``,
    ``KEYCLOAK_SERVER_URL``, ``POSTGRES_*``, ``REDIS_URL``, ``ROOT_PATH``) read
    the bare variable, with an ``ASSISTANT_``-prefixed override, like catalog.
    """

    # hide_input_in_errors: a failed validator would otherwise print every raw
    # setting, including the API key and the Fernet keys, in the error text.
    model_config = SettingsConfigDict(
        env_prefix="ASSISTANT_", populate_by_name=True, hide_input_in_errors=True
    )

    root_path: str = Field(
        default="", validation_alias=AliasChoices("ASSISTANT_ROOT_PATH", "ROOT_PATH")
    )
    auth: AuthFlag = Field(
        default=True, validation_alias=AliasChoices("AUTH", "ASSISTANT_AUTH")
    )
    keycloak_server_url: str = Field(
        default="",
        validation_alias=AliasChoices(
            "ASSISTANT_KEYCLOAK_SERVER_URL", "KEYCLOAK_SERVER_URL"
        ),
    )
    realm_name: str = Field(
        default="p4b",
        validation_alias=AliasChoices("ASSISTANT_REALM_NAME", "REALM_NAME"),
    )
    #: Keycloak clients whose tokens the assistant accepts (the token's
    #: ``azp``), as core and the other services do; empty accepts every client.
    allowed_clients: str = Field(
        default="",
        validation_alias=AliasChoices(
            "ASSISTANT_AUTH_ALLOWED_CLIENTS", "AUTH_ALLOWED_CLIENTS"
        ),
    )
    default_user_id: str = Field(
        default="744e4fd1-685c-495c-8b02-efebce875359",
        validation_alias=AliasChoices("ASSISTANT_DEFAULT_USER_ID", "DEFAULT_USER_ID"),
    )
    cors_origins: list[str] = Field(
        default_factory=list,
        validation_alias=AliasChoices("ASSISTANT_CORS_ORIGINS", "CORS_ORIGINS"),
    )
    goat_ui_base_url: str = Field(
        default="http://localhost:3000",
        validation_alias=AliasChoices(
            "ASSISTANT_GOAT_UI_BASE_URL", "NEXT_PUBLIC_APP_URL"
        ),
    )

    postgres_server: str = Field(
        default="localhost",
        validation_alias=AliasChoices("ASSISTANT_POSTGRES_SERVER", "POSTGRES_SERVER"),
    )
    postgres_port: int = Field(
        default=5432,
        validation_alias=AliasChoices("ASSISTANT_POSTGRES_PORT", "POSTGRES_PORT"),
    )
    postgres_user: str = Field(
        default="postgres",
        validation_alias=AliasChoices("ASSISTANT_POSTGRES_USER", "POSTGRES_USER"),
    )
    postgres_password: str = Field(
        default="postgres",
        validation_alias=AliasChoices(
            "ASSISTANT_POSTGRES_PASSWORD", "POSTGRES_PASSWORD"
        ),
    )
    postgres_db: str = Field(
        default="goat",
        validation_alias=AliasChoices("ASSISTANT_POSTGRES_DB", "POSTGRES_DB"),
    )
    #: ``postgres_server`` is a pooler in transaction mode: the pool then
    #: caches no prepared statements (goatlib.config.postgres).
    postgres_transaction_pooler: bool = Field(
        default=False,
        validation_alias=AliasChoices(
            "ASSISTANT_POSTGRES_TRANSACTION_POOLER", "POSTGRES_TRANSACTION_POOLER"
        ),
    )
    #: Schema of the assistant tables (core's ``ASSISTANT_SCHEMA``).
    db_schema: str = "assistant"
    #: Core's data schema, read for a user's organization.
    customer_schema: str = Field(
        default="customer",
        validation_alias=AliasChoices("ASSISTANT_CUSTOMER_SCHEMA", "SCHEMA"),
    )
    #: ``memory://`` runs a single-replica in-process bus (tests, local dev without Redis).
    redis_url: str = Field(
        default="redis://localhost:6379/0",
        validation_alias=AliasChoices("ASSISTANT_REDIS_URL", "REDIS_URL"),
    )

    #: The built-in "GOAT AI" connection (spec §4.1). ``none`` switches it off;
    #: ``test`` runs Pydantic AI's test models, for tests and local development.
    default_provider: DefaultProvider = "none"
    #: GOAT AI's model ID. With ``test``: ``test`` (the default) or ``demo``
    #: (the slow streaming model of the spike page).
    default_model: str = ""
    #: Required for ``openai_compatible`` and ``azure_openai`` (the Azure v1
    #: endpoint); an optional gateway for ``anthropic``, ``openai``, ``mistral``.
    default_base_url: str = ""
    #: Required for ``anthropic``, ``openai``, ``mistral``, ``azure_openai``;
    #: optional for ``openai_compatible``; a Bedrock API key for ``bedrock``.
    #: Bedrock without a key and Vertex AI use the SDKs' standard credential
    #: chains (AWS credentials, Google application default credentials).
    default_api_key: SecretStr = SecretStr("")
    #: AWS region (``bedrock``) or Google Cloud location (``vertex``).
    default_region: str = ""
    #: Whether organizations may add their own connections (§4.1). Needs
    #: ``secrets_key``; without it own connections are unavailable.
    allow_org_connections: bool = True
    #: Provider types organizations may use, comma-separated in the environment.
    allowed_providers: Annotated[list[ProviderType], NoDecode] = Field(
        default_factory=lambda: list(PROVIDER_TYPES)
    )
    #: Lets organization connections reach private, loopback, link-local and
    #: internal addresses, and use plain http. Off on SaaS; a self-hosting
    #: operator decides (§4.1).
    allow_private_endpoints: bool = False
    #: Fernet keys for stored credentials, comma-separated, newest first (§4.4).
    #: Rotation: put the new key first, then ``python -m assistant.llm.vault rotate``.
    secrets_key: SecretStr = SecretStr("")

    #: Tool calls per answer. Reading a finished workflow run's result may
    #: take up to ``RESULT_READS`` + 1 more (``assistant.budget``).
    run_max_tool_calls: int = 30
    #: Tokens per answer, input and output; tokens read from the provider's
    #: cache count at a tenth (``assistant.budget.CACHE_READ_WEIGHT``).
    run_max_tokens: int = 200_000
    run_max_seconds: int = 900
    #: How long in all an answer may take that waits for a workflow run
    #: (``assistant.clock.AnswerClock``); the run itself goes on after it.
    run_wait_max_seconds: int = Field(default=1800, ge=1)
    user_max_concurrent_runs: int = 3
    #: A running run's lease; a replica renews it while the run is alive.
    lease_seconds: int = 30
    lease_heartbeat_seconds: int = 10

    #: Base URLs of the services the tools call (spec §7.5), without an API
    #: prefix: the tools add ``/api/v2`` (core) and ``/stac`` (catalog). Inside a
    #: deployment these are the services' internal addresses.
    core_url: str = "http://localhost:8000"
    geoapi_url: str = "http://localhost:8100"
    processes_url: str = Field(
        default="http://localhost:8300",
        validation_alias=AliasChoices("ASSISTANT_PROCESSES_URL", "GOAT_PROCESSES_URL"),
    )
    catalog_url: str = "http://localhost:8400"
    #: Per request a tool makes to one of the services.
    tool_timeout_seconds: float = 30.0

    #: Kill switch per surface (spec §4.1, §6.3): a run sent from one of these
    #: pages is refused. Comma-separated or a JSON list in the environment.
    disabled_surfaces: Annotated[list[Surface], NoDecode] = Field(default_factory=list)

    #: The MCP endpoint at ``/mcp`` (spec §9.1), moved from the catalog service.
    enable_mcp: bool = True
    #: Host headers the MCP transport accepts (DNS-rebinding protection). ``*``
    #: (the default) switches the check off, also next to other entries; name
    #: the real ingress host in production. An empty value means the default.
    mcp_allowed_hosts: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["*"]
    )
    mcp_audit_retention_days: int = Field(
        default=30,
        ge=1,
        description=(
            "Days the audit rows of tool calls made over MCP are kept. They belong "
            "to no conversation, so the run sweeper deletes them after this. "
            "In-app calls are deleted with their conversation."
        ),
    )

    #: The web app's Keycloak client. A detached run refreshes the user's token
    #: with it (spec §6.5 fallback): a refresh token can only be refreshed by
    #: the client it was issued to. Same values as the print worker uses.
    web_client_id: str = Field(
        default="",
        validation_alias=AliasChoices("ASSISTANT_WEB_CLIENT_ID", "KEYCLOAK_CLIENT_ID"),
    )
    web_client_secret: SecretStr = Field(
        default=SecretStr(""),
        validation_alias=AliasChoices(
            "ASSISTANT_WEB_CLIENT_SECRET", "KEYCLOAK_CLIENT_SECRET"
        ),
    )
    #: Keycloak standard token exchange (RFC 8693) instead of the refresh
    #: fallback. Needs Keycloak >= 26.2 and the assistant's own confidential
    #: client below (spec §6.5, §15).
    token_exchange_enabled: bool = False
    keycloak_client_id: str = ""
    keycloak_client_secret: SecretStr = SecretStr("")

    #: A PEM file of CA certificates trusted in addition to the system CAs by
    #: every outbound client (model providers, the tools' services, Keycloak).
    #: The same variable core reads, with the usual ``ASSISTANT_`` override.
    goat_ca_bundle: str | None = Field(
        default=None,
        validation_alias=AliasChoices("ASSISTANT_GOAT_CA_BUNDLE", "GOAT_CA_BUNDLE"),
    )

    @field_validator("goat_ca_bundle", mode="before")
    @classmethod
    def _empty_ca_bundle_is_unset(cls, value: object) -> object:
        # Compose passes `GOAT_CA_BUNDLE: ${GOAT_CA_BUNDLE:-}` on every install.
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator("goat_ca_bundle")
    @classmethod
    def _check_ca_bundle(cls, value: str | None) -> str | None:
        """A bundle that cannot be loaded stops the start instead of failing
        each request later."""
        if value is None:
            return None
        try:
            ssl_context(value)
        except (OSError, ssl.SSLError) as exc:
            raise ValueError(
                f"GOAT_CA_BUNDLE: {value} cannot be loaded as a PEM file of CA "
                f"certificates ({exc})"
            ) from None
        return value

    @field_validator("root_path", mode="before")
    @classmethod
    def _normalize_root_path(cls, value: str | None) -> str:
        normalized: str = normalize_root_path(value)
        return normalized

    @field_validator("postgres_transaction_pooler", mode="before")
    @classmethod
    def _parse_transaction_pooler(cls, value: object) -> bool:
        return bool(parse_transaction_pooler(value))

    @model_validator(mode="after")
    def _require_keycloak(self) -> "AssistantSettings":
        require_keycloak_url(self.auth, self.keycloak_server_url)
        # The web app's client signs users in: a list without it refuses everyone.
        require_own_client_allowed(self.auth, self.allowed_clients, self.web_client_id)
        return self

    @model_validator(mode="after")
    def _default_cors_to_goat_ui(self) -> "AssistantSettings":
        if not self.cors_origins:
            self.cors_origins = [self.goat_ui_base_url.rstrip("/")]
        return self

    @field_validator(
        "allowed_providers", "disabled_surfaces", "mcp_allowed_hosts", mode="before"
    )
    @classmethod
    def _split_list(cls, value: object) -> object:
        """List settings take a comma-separated string or a JSON list."""
        if isinstance(value, str):
            if value.lstrip().startswith("["):
                return json.loads(value)
            return [item.strip() for item in value.split(",") if item.strip()]
        return value

    @field_validator("mcp_allowed_hosts")
    @classmethod
    def _empty_hosts_mean_the_default(cls, value: list[str]) -> list[str]:
        # ``ASSISTANT_MCP_ALLOWED_HOSTS=""`` would otherwise enable the check
        # with no host allowed, and every request would be refused with 421.
        return value or ["*"]

    @field_validator("core_url", "geoapi_url", "processes_url", "catalog_url")
    @classmethod
    def _check_service_url(cls, value: str, info: ValidationInfo) -> str:
        """A base URL the tools can build requests on. A path prefix is fine
        (a gateway may serve a service under one); a query or fragment is not."""
        parts = urlsplit(value)
        if (
            parts.scheme not in ("http", "https")
            or not parts.netloc
            or "?" in value
            or "#" in value
        ):
            # Static text: the value itself is not echoed.
            raise ValueError(
                f"ASSISTANT_{(info.field_name or '').upper()} must be an http(s) URL "
                "such as http://core:8000"
            )
        return value

    @model_validator(mode="after")
    def _check_token_exchange(self) -> "AssistantSettings":
        if self.token_exchange_enabled and not (
            self.keycloak_client_id and self.keycloak_client_secret.get_secret_value()
        ):
            raise ValueError(
                "ASSISTANT_KEYCLOAK_CLIENT_ID and ASSISTANT_KEYCLOAK_CLIENT_SECRET are "
                "required when ASSISTANT_TOKEN_EXCHANGE_ENABLED=true"
            )
        return self

    @model_validator(mode="after")
    def _check_default_connection(self) -> "AssistantSettings":
        provider = self.default_provider
        if provider == "none":
            return self
        if provider == "test":
            self.default_model = self.default_model or "test"
            if self.default_model not in ("test", "demo"):
                raise ValueError(
                    "ASSISTANT_DEFAULT_MODEL must be 'test' or 'demo' when "
                    "ASSISTANT_DEFAULT_PROVIDER=test"
                )
            return self
        if not self.default_model:
            raise ValueError(
                f"ASSISTANT_DEFAULT_MODEL is required when ASSISTANT_DEFAULT_PROVIDER={provider}"
            )
        if (
            provider in ("openai_compatible", "azure_openai")
            and not self.default_base_url
        ):
            raise ValueError(
                f"ASSISTANT_DEFAULT_BASE_URL is required when ASSISTANT_DEFAULT_PROVIDER={provider}"
            )
        if provider in ("bedrock", "vertex") and self.default_base_url:
            # Their endpoints follow from the region (spec §4.2, decision P4).
            raise ValueError(
                f"ASSISTANT_DEFAULT_BASE_URL is not used with ASSISTANT_DEFAULT_PROVIDER={provider}; "
                "set ASSISTANT_DEFAULT_REGION"
            )
        if provider == "azure_openai" and not urlsplit(
            self.default_base_url
        ).path.rstrip("/").endswith("/v1"):
            raise ValueError(
                "ASSISTANT_DEFAULT_BASE_URL must be the Azure v1 endpoint, ending in /openai/v1"
            )
        if provider in ("bedrock", "vertex") and not self.default_region:
            raise ValueError(
                f"ASSISTANT_DEFAULT_REGION is required when ASSISTANT_DEFAULT_PROVIDER={provider}"
            )
        if (
            provider in ("anthropic", "openai", "mistral", "azure_openai")
            and not self.default_api_key.get_secret_value()
        ):
            raise ValueError(
                f"ASSISTANT_DEFAULT_API_KEY is required when ASSISTANT_DEFAULT_PROVIDER={provider}"
            )
        return self

    @model_validator(mode="after")
    def _check_secrets_key(self) -> "AssistantSettings":
        raw = self.secrets_key.get_secret_value()
        # A variable that is set but holds no key (only commas or whitespace) is
        # malformed; an unset or empty one means "not set".
        if raw:
            keys = self.secrets_keys()
            try:
                if not keys:
                    raise ValueError("no key")
                MultiFernet([Fernet(key.encode()) for key in keys])
            except ValueError:
                # Static message, no chained cause: neither may carry key material.
                raise ValueError(
                    "ASSISTANT_SECRETS_KEY must be one or more Fernet keys, comma-separated"
                ) from None
        return self

    def secrets_keys(self) -> list[str]:
        """The configured Fernet keys, newest first."""
        raw = self.secrets_key.get_secret_value()
        return [key.strip() for key in raw.split(",") if key.strip()]
