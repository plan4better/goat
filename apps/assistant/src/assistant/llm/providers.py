"""Connections → Pydantic AI models (spec §4.2).

Organization connections never read the instance's environment: every SDK
client gets an explicit base URL, key and region, so GOAT AI's key, gateway or
proxy in the environment cannot leak into an organization's requests or steer
them, and every request goes through the endpoint guard. GOAT AI (the
instance's default connection) is the operator's own configuration and uses
the SDKs' standard credential chains for Bedrock and Vertex AI.

Two things the SDKs read at request time rather than at construction are
handled explicitly for organization keys:

- Bedrock requests are signed with ``botocore``'s SigV4 signer from the
  organization's own key pair, not through a ``boto3`` session, which would
  read the instance's ``AWS_PROFILE`` and config files.
- The Vertex AI token exchange goes through a ``requests`` session with
  ``trust_env`` off, so the instance's proxy and netrc are not used; the CA
  bundle variables and ``GOAT_CA_BUNDLE`` are applied explicitly. It only ever
  talks to Google's token endpoint (the key file check pins ``token_uri``).

Hiding the instance variables mutates ``os.environ`` synchronously on the
event-loop thread. Call ``open_models`` from that thread only, never from a
worker thread.

Bedrock and Vertex AI connections serve Claude models through the Anthropic
SDK's Bedrock and Vertex clients.
"""

import asyncio
import functools
import json
import os
import re
import ssl
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager, nullcontext
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID

import httpx2
import requests
from anthropic import AsyncAnthropic, AsyncAnthropicBedrock, AsyncAnthropicVertex
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials as AwsCredentials
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2 import service_account
from mistralai.client import Mistral
from mistralai.client.utils.retries import BackoffStrategy, RetryConfig
from openai import AsyncOpenAI
from pydantic_ai.models import Model
from pydantic_ai.models.anthropic import AnthropicModel, AnthropicModelSettings
from pydantic_ai.models.mistral import MistralModel
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.models.openrouter import OpenRouterModel, OpenRouterModelSettings
from pydantic_ai.providers.anthropic import AnthropicProvider
from pydantic_ai.providers.azure import AzureProvider
from pydantic_ai.providers.mistral import MistralProvider
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.providers.openrouter import OpenRouterProvider
from requests.adapters import HTTPAdapter

from assistant.config import AssistantSettings
from assistant.llm.endpoints import EndpointPolicy, guarded_client, validate_base_url
from assistant.llm.types import ProviderType
from assistant.tls import ssl_context

#: Model calls stream for minutes; connecting should not take long.
MODEL_HTTP_TIMEOUT = httpx2.Timeout(300.0, connect=10.0)
#: One retry for transient errors; the run's own limits bound the rest.
SDK_RETRIES = 1
#: Mistral's equivalent, on 429 and 5xx: backoff from half a second, given up
#: after twenty seconds so a run is not held up much longer than one retry.
MISTRAL_RETRY = RetryConfig(
    "backoff",
    BackoffStrategy(
        initial_interval=500, max_interval=8000, exponent=2.0, max_elapsed_time=20000
    ),
    retry_connection_errors=True,
)

ANTHROPIC_API_URL = "https://api.anthropic.com"
OPENAI_API_URL = "https://api.openai.com/v1"
MISTRAL_API_URL = "https://api.mistral.ai"
GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token"
CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform"
#: The OpenAI SDK needs a non-empty key; endpoints without authentication ignore it.
NO_KEY = "not-needed"

#: Variables the SDKs read at construction when an argument is not given. They
#: belong to the instance (GOAT AI): custom headers would replace an
#: organization's Authorization header, the OpenAI organization and project IDs
#: and the Bedrock token would travel to the organization's endpoint.
INSTANCE_SDK_ENV = (
    "OPENAI_ORG_ID",
    "OPENAI_PROJECT_ID",
    "OPENAI_ADMIN_KEY",
    "OPENAI_CUSTOM_HEADERS",
    "ANTHROPIC_CUSTOM_HEADERS",
    "AWS_BEARER_TOKEN_BEDROCK",
    # Instance API keys: an own connection without a key must send none rather
    # than the SDK's environment fallback (the instance's key).
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "MISTRAL_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "OPENAI_API_KEY",
)

#: Keys travel in HTTP headers and are masked in error texts by exact match, so
#: they must be printable ASCII without whitespace or control characters.
_PLAIN_KEY = re.compile(r"[\x21-\x7e]+")
_PLAIN_KEY_FIELDS = ("api_key", "access_key_id", "secret_access_key")

_MODEL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$")
#: A provider name as OpenRouter lists it, e.g. "DeepInfra" or "Sail Research".
_PROVIDER_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$")
#: The providers a connection may name in its order.
MAX_PROVIDER_ORDER = 8
_AWS_REGION = re.compile(r"^[a-z]{2}(-[a-z]+)+-\d{1,2}$")
_VERTEX_REGION = re.compile(r"^(global|[a-z]+-[a-z]+\d{1,2})$")

BEDROCK_ARN_PREFIX = "arn:aws:bedrock:"

NEEDS_BASE_URL: frozenset[str] = frozenset({"openai_compatible", "azure_openai"})
NEEDS_REGION: frozenset[str] = frozenset({"bedrock", "vertex"})
CLAUDE_ONLY: frozenset[str] = frozenset({"bedrock", "vertex"})

SECRET_FIELDS: dict[ProviderType, tuple[str, ...]] = {
    "anthropic": ("api_key",),
    "openai": ("api_key",),
    "mistral": ("api_key",),
    "azure_openai": ("api_key",),
    "openai_compatible": ("api_key",),
    "bedrock": ("access_key_id", "secret_access_key"),
    "vertex": ("service_account_json",),
}
_OPTIONAL_SECRETS: dict[str, frozenset[str]] = {
    "openai_compatible": frozenset({"api_key"})
}


class ConnectionInvalid(ValueError):  # noqa: N818
    """A connection field the provider cannot use; ``message`` is for admins."""

    def __init__(self, field: str, message: str) -> None:
        super().__init__(message)
        self.field = field
        self.message = message


@dataclass(frozen=True)
class ConnectionFields:
    provider: ProviderType
    base_url: str | None
    region: str | None
    model: str
    #: OpenRouter only: the providers to send the model to, in order (empty:
    #: OpenRouter chooses), and whether others may answer when those fail.
    provider_order: tuple[str, ...] = ()
    allow_fallbacks: bool = True


@dataclass(frozen=True)
class Target:
    """What a run talks to: GOAT AI (``connection_id`` None) or an own connection."""

    connection_id: UUID | None
    #: One of the provider types, or ``test`` (GOAT AI on Pydantic AI's test models).
    provider: str
    model: str
    base_url: str | None = None
    region: str | None = None
    credentials: Mapping[str, str] = field(default_factory=dict, repr=False)
    #: As in ``ConnectionFields``.
    provider_order: tuple[str, ...] = ()
    allow_fallbacks: bool = True

    @property
    def own(self) -> bool:
        return self.connection_id is not None


def normalize_connection(
    provider: ProviderType,
    base_url: str | None,
    region: str | None,
    model: str,
    policy: EndpointPolicy,
    *,
    provider_order: Sequence[str] = (),
    allow_fallbacks: bool = True,
) -> ConnectionFields:
    """Validate an own connection's fields for its provider type."""
    main = model.strip()
    if not _MODEL_ID.match(main):
        raise ConnectionInvalid("model", "Enter the model ID as the provider names it.")
    if (
        provider in CLAUDE_ONLY
        # An inference profile ARN does not name its model; the probe shows
        # whether it works.
        and not main.startswith(BEDROCK_ARN_PREFIX)
        and "claude" not in main.lower()
    ):
        raise ConnectionInvalid(
            "model", "Bedrock and Vertex AI connections support Claude models."
        )

    url = (base_url or "").strip() or None
    if provider in NEEDS_BASE_URL:
        if url is None:
            raise ConnectionInvalid("base_url", "This provider needs a base URL.")
        url = validate_base_url(url, policy)
        if provider == "azure_openai" and not urlsplit(url).path.endswith("/v1"):
            raise ConnectionInvalid(
                "base_url",
                "Use the v1 endpoint of the Azure resource, ending in /openai/v1.",
            )
    elif url is not None:
        raise ConnectionInvalid("base_url", "This provider does not take a base URL.")

    zone = (region or "").strip() or None
    if provider in NEEDS_REGION:
        pattern = _AWS_REGION if provider == "bedrock" else _VERTEX_REGION
        if zone is None or not pattern.match(zone):
            raise ConnectionInvalid(
                "region", "Enter a valid region, for example eu-central-1."
            )
    elif zone is not None:
        raise ConnectionInvalid("region", "This provider does not take a region.")

    order = tuple(
        dict.fromkeys(name.strip() for name in provider_order if name.strip())
    )
    if order and not _is_openrouter(url):
        raise ConnectionInvalid(
            "provider_order", "Only OpenRouter connections take a provider order."
        )
    if len(order) > MAX_PROVIDER_ORDER or not all(
        _PROVIDER_NAME.match(name) for name in order
    ):
        raise ConnectionInvalid(
            "provider_order",
            f"Name up to {MAX_PROVIDER_ORDER} providers as OpenRouter lists them.",
        )

    return ConnectionFields(
        provider=provider,
        base_url=url,
        region=zone,
        model=main,
        provider_order=order,
        allow_fallbacks=allow_fallbacks,
    )


def _check_service_account(raw: str) -> None:
    try:
        info = json.loads(raw)
    except ValueError:
        # `from None`: the decoder error would carry the pasted key text.
        raise ConnectionInvalid(
            "service_account_json", "Paste the complete JSON key file."
        ) from None
    required = ("project_id", "private_key", "client_email")
    if (
        not isinstance(info, dict)
        or info.get("type") != "service_account"
        or not all(isinstance(info.get(key), str) and info.get(key) for key in required)
    ):
        raise ConnectionInvalid(
            "service_account_json",
            "Paste the complete JSON key file of a service account.",
        )
    # google-auth requests tokens from the key file's token_uri; a key file
    # without one cannot be used either.
    if info.get("token_uri") != GOOGLE_TOKEN_URI:
        raise ConnectionInvalid(
            "service_account_json", "The key file must use Google's token endpoint."
        )
    # Parses the private key without any network access.
    try:
        service_account.Credentials.from_service_account_info(info)  # type: ignore[no-untyped-call]
    except Exception:
        # No `raise ... from exc` and no exception text: both can hold key material.
        raise ConnectionInvalid(
            "service_account_json", "The private key in the key file is not valid."
        ) from None


def normalize_credentials(
    provider: ProviderType, raw: Mapping[str, str]
) -> dict[str, str]:
    values = {
        key: value.strip()
        for key, value in raw.items()
        if isinstance(value, str) and value.strip()
    }
    allowed = SECRET_FIELDS[provider]
    unknown = sorted(set(values) - set(allowed))
    if unknown:
        raise ConnectionInvalid(
            "credentials", f"Unknown credential fields: {', '.join(unknown)}."
        )
    optional = _OPTIONAL_SECRETS.get(provider, frozenset())
    for name in allowed:
        if name not in values and name not in optional:
            raise ConnectionInvalid(name, "This field is required.")
    for name in _PLAIN_KEY_FIELDS:
        if name in values and not _PLAIN_KEY.fullmatch(values[name]):
            raise ConnectionInvalid(
                name,
                "The key may only contain printable ASCII characters, without spaces.",
            )
    if provider == "vertex":
        _check_service_account(values["service_account_json"])
    return values


def credential_hint(provider: str, credentials: Mapping[str, str]) -> str | None:
    """The last 4 characters of the identifying credential; None for short ones."""
    value: str | None
    if provider == "bedrock":
        value = credentials.get("access_key_id")
    elif provider == "vertex":
        try:
            value = json.loads(credentials.get("service_account_json", "{}")).get(
                "private_key_id"
            )
        except (ValueError, AttributeError):
            value = None
    else:
        value = credentials.get("api_key")
    if not value or len(value) < 8:
        return None
    return value[-4:]


def default_target(settings: AssistantSettings) -> Target | None:
    """GOAT AI, or None when the instance has no built-in connection."""
    if settings.default_provider == "none":
        return None
    credentials: dict[str, str] = {}
    key = settings.default_api_key.get_secret_value()
    if key:
        credentials["api_key"] = key
    return Target(
        connection_id=None,
        provider=settings.default_provider,
        model=settings.default_model,
        base_url=settings.default_base_url or None,
        region=settings.default_region or None,
        credentials=credentials,
    )


@dataclass
class OpenModels:
    main: Model
    #: HTTP clients created for these models; the SDKs do not close injected clients.
    clients: list[httpx2.AsyncClient] = field(default_factory=list)

    async def aclose(self) -> None:
        for client in self.clients:
            await client.aclose()


ModelOpener = Callable[[Target], OpenModels]


@contextmanager
def _without_instance_sdk_env() -> Iterator[None]:
    """Hide ``INSTANCE_SDK_ENV`` while an own connection's SDK clients are
    constructed. Construction is synchronous (nothing is awaited inside), so no
    other coroutine of the event loop runs while the variables are missing."""
    saved = {
        name: os.environ.pop(name) for name in INSTANCE_SDK_ENV if name in os.environ
    }
    try:
        yield
    finally:
        os.environ.update(saved)


#: Prompt caching. Every model call of an answer resends the instructions, the
#: tool definitions and everything said so far; a cached prefix is billed at a
#: fraction of the input price and answers sooner. OpenAI, Azure OpenAI and
#: DeepSeek cache by themselves. Claude (direct, Bedrock, Vertex, or through
#: OpenRouter) caches only behind explicit markers: after the fixed instructions
#: (the page note after them changes between messages), after the tool
#: definitions, and a moving one at the end of the conversation so far.
CLAUDE_CACHE = AnthropicModelSettings(
    anthropic_cache_instructions=True,
    anthropic_cache_tool_definitions=True,
    anthropic_cache=True,
)
#: The same through OpenRouter, which passes the markers on to the models that
#: need them and leaves the others alone.
OPENROUTER_CACHE = OpenRouterModelSettings(
    openrouter_cache_instructions=True,
    openrouter_cache_tool_definitions=True,
    openrouter_cache_messages=True,
)
OPENROUTER_HOST = "openrouter.ai"


def _is_openrouter(base_url: str | None) -> bool:
    host = (urlsplit(base_url or "").hostname or "").lower()
    return host == OPENROUTER_HOST or host.endswith("." + OPENROUTER_HOST)


def _anthropic(target: Target, model: str, client: httpx2.AsyncClient) -> Model:
    sdk = AsyncAnthropic(
        api_key=target.credentials.get("api_key") or NO_KEY,
        base_url=target.base_url or ANTHROPIC_API_URL,
        http_client=client,
        max_retries=SDK_RETRIES,
    )
    return AnthropicModel(
        model, provider=AnthropicProvider(anthropic_client=sdk), settings=CLAUDE_CACHE
    )


def _openai(target: Target, model: str, client: httpx2.AsyncClient) -> Model:
    sdk = AsyncOpenAI(
        api_key=target.credentials.get("api_key") or NO_KEY,
        base_url=target.base_url or OPENAI_API_URL,
        http_client=client,
        max_retries=SDK_RETRIES,
    )
    if _is_openrouter(target.base_url):
        settings = OPENROUTER_CACHE
        if target.provider_order:
            settings = OpenRouterModelSettings(
                **OPENROUTER_CACHE,
                openrouter_provider={
                    "order": list(target.provider_order),
                    "allow_fallbacks": target.allow_fallbacks,
                },
            )
        return OpenRouterModel(
            model, provider=OpenRouterProvider(openai_client=sdk), settings=settings
        )
    return OpenAIChatModel(model, provider=OpenAIProvider(openai_client=sdk))


def _azure(target: Target, model: str, client: httpx2.AsyncClient) -> Model:
    provider = AzureProvider(
        azure_endpoint=target.base_url,
        api_key=target.credentials.get("api_key"),
        http_client=client,
    )
    # AzureProvider takes no retry argument; it wraps the injected http_client
    # (so the endpoint guard applies) in its own SDK client.
    provider.client.max_retries = SDK_RETRIES
    return OpenAIChatModel(model, provider=provider)


def _mistral(target: Target, model: str, client: httpx2.AsyncClient) -> Model:
    # The Mistral SDK retries only when given a `retry_config`, and by elapsed
    # time rather than by count: without one, a rate limit (429) in the middle
    # of a run fails the answer.
    sdk = Mistral(
        api_key=target.credentials.get("api_key") or NO_KEY,
        server_url=target.base_url or MISTRAL_API_URL,
        async_client=client,
        retry_config=MISTRAL_RETRY,
    )
    return MistralModel(model, provider=MistralProvider(mistral_client=sdk))


class _KeyPairBedrock(AsyncAnthropicBedrock):
    """Signs with the key pair it was given, through botocore's signer alone.

    The SDK signs through a ``boto3`` session, which reads the instance's
    ``AWS_PROFILE`` and shared config files at request time even when a key
    pair is passed (a missing profile fails the request). Without a key pair
    (GOAT AI on the AWS credential chain) the SDK's own signing applies."""

    async def _prepare_request(self, request: httpx2.Request) -> None:
        if (
            self.api_key is not None
            or self.aws_access_key is None
            or self.aws_secret_key is None
        ):
            await super()._prepare_request(request)
            return
        body = request.read()
        headers = request.headers.copy()
        # A proxy may strip the connection header, so it is not signed.
        del headers["connection"]
        signed = AWSRequest(
            method=request.method.upper(),
            url=str(request.url),
            headers=headers,
            data=body,
        )
        SigV4Auth(
            AwsCredentials(
                self.aws_access_key, self.aws_secret_key, self.aws_session_token
            ),
            "bedrock",
            self.aws_region,
        ).add_auth(signed)
        request.headers.update(
            {
                key: value
                for key, value in dict(signed.prepare().headers).items()
                if value is not None
            }
        )


def _bedrock(target: Target, model: str, client: httpx2.AsyncClient) -> Model:
    region = target.region or ""
    sdk = _KeyPairBedrock(
        aws_access_key=target.credentials.get("access_key_id"),
        aws_secret_key=target.credentials.get("secret_access_key"),
        # GOAT AI may use a Bedrock API key; without keys the AWS credential chain applies.
        api_key=target.credentials.get("api_key"),
        aws_region=region,
        base_url=f"https://bedrock-runtime.{region}.amazonaws.com",
        http_client=client,
        max_retries=SDK_RETRIES,
    )
    return AnthropicModel(
        model, provider=AnthropicProvider(anthropic_client=sdk), settings=CLAUDE_CACHE
    )


class _CompanyCaAdapter(HTTPAdapter):
    """Verifies with the system CAs plus ``GOAT_CA_BUNDLE``. requests takes
    only a file as ``verify`` and loads it into this context, so whatever it
    would trust anyway is trusted in addition."""

    def __init__(self, ca_bundle: str) -> None:
        self._ca_bundle = ca_bundle
        super().__init__()

    def init_poolmanager(self, *args: Any, **kwargs: Any) -> None:
        context = ssl_context(self._ca_bundle)
        if not isinstance(context, ssl.SSLContext):
            raise ValueError("_CompanyCaAdapter needs a GOAT_CA_BUNDLE file")
        kwargs["ssl_context"] = context
        super().init_poolmanager(*args, **kwargs)


class _DirectCredentials(service_account.Credentials):
    """Service account credentials that refresh over a session which ignores
    the environment's proxy variables and netrc (the CA bundle is read
    explicitly). The
    SDK's refresh call passes a default ``requests`` session instead."""

    #: ``GOAT_CA_BUNDLE``, set by ``_vertex``.
    ca_bundle: str | None = None

    def refresh(self, request: Any) -> None:
        session = requests.Session()
        session.trust_env = False
        # `trust_env` off also drops the CA bundle variables; read them
        # explicitly so the token endpoint is verified against the same bundle
        # as the guarded httpx client, while proxies and netrc stay off.
        session.verify = (
            os.environ.get("SSL_CERT_FILE")
            or os.environ.get("REQUESTS_CA_BUNDLE")
            or True
        )
        if self.ca_bundle:
            session.mount("https://", _CompanyCaAdapter(self.ca_bundle))
        try:
            super().refresh(GoogleRequest(session=session))  # type: ignore[no-untyped-call]
        finally:
            session.close()


def _vertex(
    target: Target,
    model: str,
    client: httpx2.AsyncClient,
    *,
    ca_bundle: str | None = None,
) -> Model:
    region = target.region or ""
    base_url = (
        "https://aiplatform.googleapis.com/v1"
        if region == "global"
        else f"https://{region}-aiplatform.googleapis.com/v1"
    )
    key_file = target.credentials.get("service_account_json")
    if key_file:
        info: dict[str, Any] = json.loads(key_file)
        credentials = _DirectCredentials.from_service_account_info(  # type: ignore[no-untyped-call]
            info, scopes=[CLOUD_PLATFORM_SCOPE]
        )
        credentials.ca_bundle = ca_bundle
        sdk = AsyncAnthropicVertex(
            region=region,
            project_id=str(info["project_id"]),
            credentials=credentials,
            base_url=base_url,
            http_client=client,
            max_retries=SDK_RETRIES,
        )
    else:
        # GOAT AI: Google application default credentials and their project
        # (or ANTHROPIC_VERTEX_PROJECT_ID).
        sdk = AsyncAnthropicVertex(
            region=region,
            base_url=base_url,
            http_client=client,
            max_retries=SDK_RETRIES,
        )
    return AnthropicModel(
        model, provider=AnthropicProvider(anthropic_client=sdk), settings=CLAUDE_CACHE
    )


_BUILDERS: dict[str, Callable[[Target, str, httpx2.AsyncClient], Model]] = {
    "anthropic": _anthropic,
    "openai": _openai,
    "openai_compatible": _openai,
    "azure_openai": _azure,
    "mistral": _mistral,
    "bedrock": _bedrock,
    "vertex": _vertex,
}


_closing: set[asyncio.Task[None]] = set()


def _discard(client: httpx2.AsyncClient) -> None:
    """Close a client whose models could not be built. ``open_models`` is
    synchronous, so the close runs as a task on the running loop."""
    try:
        task = asyncio.get_running_loop().create_task(client.aclose())
    except RuntimeError:  # no loop: nothing was connected, nothing to release
        return
    _closing.add(task)
    task.add_done_callback(_closing.discard)


def open_models(
    target: Target,
    policy: EndpointPolicy,
    *,
    transport: httpx2.AsyncBaseTransport | None = None,
) -> OpenModels:
    """Build the model of a target, which answers and writes the titles.
    ``transport`` replaces the network in tests. Close the result with ``aclose``."""
    if target.provider == "test":
        # Imported here: the agent's tool layer imports this module (through
        # assistant.llm.failures), so a module-level import would be a cycle.
        from assistant.agent import dev_model

        return OpenModels(main=dev_model(target.model))
    if target.own:
        client = guarded_client(policy, timeout=MODEL_HTTP_TIMEOUT, transport=transport)
    else:
        client = httpx2.AsyncClient(
            timeout=MODEL_HTTP_TIMEOUT,
            follow_redirects=True,
            transport=transport,
            verify=ssl_context(policy.ca_bundle),
        )
    build = _BUILDERS[target.provider]
    if build is _vertex:
        # The token refresh runs outside the httpx client and needs the bundle too.
        build = functools.partial(_vertex, ca_bundle=policy.ca_bundle)
    try:
        with _without_instance_sdk_env() if target.own else nullcontext():
            main = build(target, target.model, client)
    except BaseException:
        _discard(client)
        raise
    return OpenModels(main=main, clients=[client])
