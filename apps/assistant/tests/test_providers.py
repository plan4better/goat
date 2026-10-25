"""Connections → Pydantic AI models (spec §4.2)."""

import asyncio
import json
import os
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx2
import pytest
import requests
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from mistralai.client.utils.retries import BackoffStrategy, RetryConfig
from pydantic import SecretStr
from pydantic_ai import Agent
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.models.mistral import MistralModel
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.models.openrouter import OpenRouterModel
from pydantic_ai.models.test import TestModel

from assistant.config import AssistantSettings
from assistant.llm import capabilities, providers
from assistant.llm.capabilities import capabilities_for, is_tested
from assistant.llm.endpoints import EndpointNotAllowed, EndpointPolicy
from assistant.llm.providers import (
    ConnectionInvalid,
    Target,
    credential_hint,
    default_target,
    normalize_connection,
    normalize_credentials,
    open_models,
)

STRICT = EndpointPolicy()
OWN = UUID(int=500)


def _target(provider: str, **fields: object) -> Target:
    return Target(connection_id=OWN, provider=provider, **fields)  # type: ignore[arg-type]


def _service_account(token_uri: str = "https://oauth2.googleapis.com/token") -> str:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    return json.dumps(
        {
            "type": "service_account",
            "project_id": "goat-test",
            "private_key_id": "0123456789abcdef",
            "private_key": pem,
            "client_email": "goat@goat-test.iam.gserviceaccount.com",
            "token_uri": token_uri,
        }
    )


# -- connection fields -----------------------------------------------------


@pytest.mark.parametrize(
    ("provider", "fields", "bad_field"),
    [
        (
            "openai_compatible",
            {"base_url": None, "region": None, "model": "m"},
            "base_url",
        ),
        (
            "azure_openai",
            {"base_url": "https://r.openai.azure.com", "region": None, "model": "m"},
            "base_url",
        ),
        (
            "openai",
            {
                "base_url": "https://gateway.example.org/v1",
                "region": None,
                "model": "gpt-4.1",
            },
            "base_url",
        ),
        (
            "bedrock",
            {"base_url": None, "region": None, "model": "anthropic.claude-sonnet-4-5"},
            "region",
        ),
        (
            "bedrock",
            {
                "base_url": None,
                "region": "Frankfurt",
                "model": "anthropic.claude-sonnet-4-5",
            },
            "region",
        ),
        (
            "vertex",
            {"base_url": None, "region": "europe-west1", "model": "gemini-2.5-pro"},
            "model",
        ),
        (
            "anthropic",
            {"base_url": None, "region": "eu-central-1", "model": "claude-sonnet-4-5"},
            "region",
        ),
        (
            "openai",
            {"base_url": None, "region": None, "model": "bad model id"},
            "model",
        ),
    ],
)
def test_connection_fields_follow_the_provider(
    provider: str, fields: dict[str, str | None], bad_field: str
) -> None:
    with pytest.raises(ConnectionInvalid) as caught:
        normalize_connection(
            provider,
            fields["base_url"],
            fields["region"],
            str(fields["model"]),
            STRICT,
        )  # type: ignore[arg-type]
    assert caught.value.field == bad_field


def test_valid_connection_fields_are_normalized() -> None:
    compatible = normalize_connection(
        "openai_compatible", "https://LLM.example.org/v1/", None, " qwen3 ", STRICT
    )
    assert compatible.base_url == "https://llm.example.org/v1"
    assert compatible.model == "qwen3"
    bedrock = normalize_connection(
        "bedrock",
        None,
        "eu-central-1",
        "eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
        STRICT,
    )
    assert bedrock.region == "eu-central-1"
    # An inference profile ARN does not name its model, so it is not checked.
    arn = normalize_connection(
        "bedrock",
        None,
        "eu-central-1",
        "arn:aws:bedrock:eu-central-1:123456789012:inference-profile/eu.team-profile",
        STRICT,
    )
    assert arn.model.startswith("arn:aws:bedrock:")
    azure = normalize_connection(
        "azure_openai",
        "https://res.openai.azure.com/openai/v1/",
        None,
        "my-deployment",
        STRICT,
    )
    assert azure.base_url == "https://res.openai.azure.com/openai/v1"


def test_private_base_url_is_refused() -> None:
    with pytest.raises(EndpointNotAllowed):
        normalize_connection(
            "openai_compatible", "https://10.0.0.5/v1", None, "m", STRICT
        )


# -- credentials -------------------------------------------------------------


def test_credentials_follow_the_provider() -> None:
    assert normalize_credentials("openai", {"api_key": " sk-1 "}) == {"api_key": "sk-1"}
    assert normalize_credentials("openai_compatible", {"api_key": ""}) == {}
    with pytest.raises(ConnectionInvalid) as missing:
        normalize_credentials("openai", {})
    assert missing.value.field == "api_key"
    with pytest.raises(ConnectionInvalid) as half:
        normalize_credentials("bedrock", {"access_key_id": "AKIAEXAMPLE1234"})
    assert half.value.field == "secret_access_key"
    with pytest.raises(ConnectionInvalid) as unknown:
        normalize_credentials("openai", {"api_key": "sk-1", "password": "x"})
    assert unknown.value.field == "credentials"


@pytest.mark.parametrize(
    ("provider", "field", "value"),
    [
        ("openai", "api_key", "sk-1 2"),
        ("openai", "api_key", "sk-1\n2"),
        ("openai", "api_key", "sk-\u00e4"),
        ("openai_compatible", "api_key", "sk-1\x002"),
        ("bedrock", "access_key_id", "AKIA 1234"),
        ("bedrock", "secret_access_key", "abc\tdef"),
    ],
)
def test_keys_must_be_printable_ascii(provider: str, field: str, value: str) -> None:
    raw = {"access_key_id": "AKIAEXAMPLE1234", "secret_access_key": "secret-1234"}
    raw = raw if provider == "bedrock" else {}
    with pytest.raises(ConnectionInvalid) as invalid:
        normalize_credentials(provider, {**raw, field: value})  # type: ignore[arg-type]
    assert invalid.value.field == field
    assert value not in invalid.value.message


def test_service_account_key_is_checked() -> None:
    assert normalize_credentials("vertex", {"service_account_json": _service_account()})
    with pytest.raises(ConnectionInvalid) as not_json:
        normalize_credentials("vertex", {"service_account_json": '{"private_key": '})
    assert not_json.value.__cause__ is None and not_json.value.__suppress_context__
    # Without a token_uri google-auth would fail when the connection is opened.
    without_uri = json.loads(_service_account())
    del without_uri["token_uri"]
    with pytest.raises(ConnectionInvalid, match="token endpoint"):
        normalize_credentials(
            "vertex", {"service_account_json": json.dumps(without_uri)}
        )
    # A private key that does not parse is refused at save time, without the key in the message.
    broken = json.loads(_service_account())
    broken["private_key"] = (
        "-----BEGIN PRIVATE KEY-----\nsecret-key-material\n-----END PRIVATE KEY-----\n"
    )
    with pytest.raises(ConnectionInvalid) as bad_key:
        normalize_credentials("vertex", {"service_account_json": json.dumps(broken)})
    assert bad_key.value.field == "service_account_json"
    assert "secret-key-material" not in str(bad_key.value)
    assert bad_key.value.__cause__ is None and bad_key.value.__suppress_context__
    with pytest.raises(ConnectionInvalid, match="token endpoint"):
        normalize_credentials(
            "vertex",
            {
                "service_account_json": _service_account(
                    "https://evil.example.org/token"
                )
            },
        )


def test_credential_hint_shows_the_last_four_characters_only() -> None:
    assert credential_hint("openai", {"api_key": "sk-abcdefgh1234"}) == "1234"
    assert credential_hint("openai", {"api_key": "short"}) is None
    assert credential_hint("openai_compatible", {}) is None
    assert (
        credential_hint(
            "bedrock", {"access_key_id": "AKIAEXAMPLE9876", "secret_access_key": "s"}
        )
        == "9876"
    )
    assert (
        credential_hint("vertex", {"service_account_json": _service_account()})
        == "cdef"
    )


# -- models ---------------------------------------------------------------------


@pytest.mark.parametrize(
    ("target", "model_class", "base_url"),
    [
        (
            _target(
                "anthropic",
                model="claude-sonnet-4-5",
                credentials={"api_key": "sk-ant-org"},
            ),
            AnthropicModel,
            "https://api.anthropic.com",
        ),
        (
            _target("openai", model="gpt-4.1", credentials={"api_key": "sk-org"}),
            OpenAIChatModel,
            "https://api.openai.com/v1",
        ),
        (
            _target(
                "openai_compatible",
                model="qwen3",
                base_url="https://llm.example.org/v1",
            ),
            OpenAIChatModel,
            "https://llm.example.org/v1",
        ),
        (
            _target(
                "azure_openai",
                model="dep",
                base_url="https://res.openai.azure.com/openai/v1",
                credentials={"api_key": "az-org"},
            ),
            OpenAIChatModel,
            "https://res.openai.azure.com/openai/v1",
        ),
        (
            _target(
                "bedrock",
                model="eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
                region="eu-central-1",
                credentials={
                    "access_key_id": "AKIAEXAMPLE1234",
                    "secret_access_key": "secret",
                },
            ),
            AnthropicModel,
            "https://bedrock-runtime.eu-central-1.amazonaws.com",
        ),
        (
            _target(
                "vertex",
                model="claude-sonnet-4-5@20250929",
                region="europe-west1",
                credentials={"service_account_json": _service_account()},
            ),
            AnthropicModel,
            "https://europe-west1-aiplatform.googleapis.com/v1",
        ),
    ],
)
async def test_open_models_builds_each_provider(
    target: Target, model_class: type, base_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("AWS_BEARER_TOKEN_BEDROCK", raising=False)
    models = open_models(target, STRICT)
    try:
        assert isinstance(models.main, model_class)
        assert models.main.model_name == target.model
        assert models.main.base_url is not None
        assert models.main.base_url.rstrip("/") == base_url
    finally:
        await models.aclose()


async def test_mistral() -> None:
    models = open_models(
        _target(
            "mistral", model="mistral-large-latest", credentials={"api_key": "mi-org"}
        ),
        STRICT,
    )
    try:
        assert isinstance(models.main, MistralModel)
        assert models.main.model_name == "mistral-large-latest"
    finally:
        await models.aclose()
    assert all(client.is_closed for client in models.clients)


#: The instance's SDK configuration (GOAT AI's gateway), as an operator might set it.
INSTANCE_ENV = {
    "OPENAI_API_KEY": "sk-instance",
    "OPENAI_BASE_URL": "https://instance-gateway.example.org/v1",
    "OPENAI_ORG_ID": "org-instance",
    "OPENAI_PROJECT_ID": "proj-instance",
    "OPENAI_ADMIN_KEY": "sk-admin-instance",
    "OPENAI_CUSTOM_HEADERS": "Authorization: Bearer gateway-instance\nX-Instance-Secret: instance-secret",
    "ANTHROPIC_API_KEY": "sk-ant-instance",
    "ANTHROPIC_BASE_URL": "https://instance-gateway.example.org",
    "ANTHROPIC_CUSTOM_HEADERS": "Authorization: Bearer gateway-instance\nX-Instance-Secret: instance-secret",
    "AWS_BEARER_TOKEN_BEDROCK": "bedrock-instance",
    "HTTPS_PROXY": "http://proxy.example.org:3128",
}


def _chat_completion(request: httpx2.Request) -> httpx2.Response:
    return httpx2.Response(
        200,
        json={
            "id": "c1",
            "object": "chat.completion",
            "created": 0,
            "model": "qwen3",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "hello"},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        },
    )


def _anthropic_message(request: httpx2.Request) -> httpx2.Response:
    """A streamed Messages API answer (Pydantic AI streams Anthropic requests)."""
    events = [
        (
            "message_start",
            {
                "type": "message_start",
                "message": {
                    "id": "msg_1",
                    "type": "message",
                    "role": "assistant",
                    "model": "claude-sonnet-4-5",
                    "content": [],
                    "stop_reason": None,
                    "stop_sequence": None,
                    "usage": {"input_tokens": 1, "output_tokens": 0},
                },
            },
        ),
        (
            "content_block_start",
            {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "text", "text": ""},
            },
        ),
        (
            "content_block_delta",
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": "hello"},
            },
        ),
        ("content_block_stop", {"type": "content_block_stop", "index": 0}),
        (
            "message_delta",
            {
                "type": "message_delta",
                "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                "usage": {"output_tokens": 1},
            },
        ),
        ("message_stop", {"type": "message_stop"}),
    ]
    body = "".join(
        f"event: {name}\ndata: {json.dumps(data)}\n\n" for name, data in events
    )
    return httpx2.Response(
        200, content=body.encode(), headers={"content-type": "text/event-stream"}
    )


def _assert_only_the_org_credentials(
    request: httpx2.Request, header: str, value: str
) -> None:
    assert request.headers[header] == value
    for leaked in ("openai-organization", "openai-project", "x-instance-secret"):
        assert leaked not in request.headers, leaked
    assert "instance" not in request.headers.get("authorization", "")


async def test_org_connection_ignores_instance_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Review Focus 5: GOAT AI's keys, gateway headers, URLs and proxy in the
    environment never reach an organization's connection."""
    for name, value in INSTANCE_ENV.items():
        monkeypatch.setenv(name, value)

    openai = open_models(
        _target("openai", model="gpt-4.1", credentials={"api_key": "sk-org"}), STRICT
    )
    keyless = open_models(
        _target(
            "openai_compatible", model="qwen3", base_url="https://llm.example.org/v1"
        ),
        STRICT,
    )
    anthropic = open_models(
        _target(
            "anthropic",
            model="claude-sonnet-4-6",
            credentials={"api_key": "sk-ant-org"},
        ),
        STRICT,
    )
    try:
        assert openai.main.client.api_key == "sk-org"  # type: ignore[attr-defined]
        assert str(openai.main.base_url).rstrip("/") == "https://api.openai.com/v1"
        assert keyless.main.client.api_key == providers.NO_KEY  # type: ignore[attr-defined]
        assert anthropic.main.client.api_key == "sk-ant-org"  # type: ignore[attr-defined]
        assert str(anthropic.main.base_url).rstrip("/") == "https://api.anthropic.com"
    finally:
        for models in (openai, keyless, anthropic):
            await models.aclose()

    # End to end on mocked endpoints: only the organization's key goes to the organization's host.
    seen: list[httpx2.Request] = []

    def openai_endpoint(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        return _chat_completion(request)

    def anthropic_endpoint(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        return _anthropic_message(request)

    compatible = open_models(
        _target(
            "openai_compatible",
            model="qwen3",
            base_url="https://llm.example.org/v1",
            credentials={"api_key": "sk-org-compat"},
        ),
        STRICT,
        transport=httpx2.MockTransport(openai_endpoint),
    )
    claude = open_models(
        _target(
            "anthropic",
            model="claude-sonnet-4-6",
            credentials={"api_key": "sk-ant-org"},
        ),
        STRICT,
        transport=httpx2.MockTransport(anthropic_endpoint),
    )
    try:
        assert (await Agent(compatible.main).run("hi")).output == "hello"
        assert (await Agent(claude.main).run("hi")).output == "hello"
    finally:
        await compatible.aclose()
        await claude.aclose()
    assert seen[0].url.host == "llm.example.org"
    _assert_only_the_org_credentials(seen[0], "authorization", "Bearer sk-org-compat")
    assert seen[1].url.host == "api.anthropic.com"
    _assert_only_the_org_credentials(seen[1], "x-api-key", "sk-ant-org")
    # The instance's own configuration is untouched afterwards.
    assert os.environ["OPENAI_CUSTOM_HEADERS"] == INSTANCE_ENV["OPENAI_CUSTOM_HEADERS"]


async def test_own_bedrock_connection_ignores_the_instance_bedrock_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AWS_BEARER_TOKEN_BEDROCK", "bedrock-instance")
    models = open_models(
        _target(
            "bedrock",
            model="eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
            region="eu-central-1",
            credentials={
                "access_key_id": "AKIAEXAMPLE1234",
                "secret_access_key": "secret",
            },
        ),
        STRICT,
    )
    try:
        assert models.main.client.api_key is None  # type: ignore[attr-defined]
    finally:
        await models.aclose()


async def test_goat_ai_target_from_the_settings(settings: AssistantSettings) -> None:
    target = default_target(settings)
    assert target is not None
    assert (target.provider, target.model, target.connection_id) == (
        "test",
        "test",
        None,
    )
    models = open_models(target, STRICT)
    assert isinstance(models.main, TestModel)
    assert (
        default_target(settings.model_copy(update={"default_provider": "none"})) is None
    )
    configured = default_target(
        settings.model_copy(
            update={
                "default_provider": "openai",
                "default_model": "gpt-4.1",
                "default_api_key": SecretStr("sk-goat"),
            }
        )
    )
    assert configured is not None and configured.credentials == {"api_key": "sk-goat"}


def test_target_repr_never_shows_credentials() -> None:
    target = _target(
        "openai", model="gpt-4.1", credentials={"api_key": "sk-secret-1234"}
    )
    assert "sk-secret" not in repr(target)


# -- capabilities -------------------------------------------------------------


async def test_capabilities_come_from_the_model_profile() -> None:
    claude = open_models(
        _target(
            "anthropic",
            model="claude-sonnet-4-5",
            credentials={"api_key": "sk-ant-org"},
        ),
        STRICT,
    )
    local = open_models(
        _target(
            "openai_compatible",
            model="my-local-model",
            base_url="https://llm.example.org/v1",
        ),
        STRICT,
    )
    try:
        known = capabilities_for(claude.main, "claude-sonnet-4-5")
        unknown = capabilities_for(local.main, "my-local-model")
    finally:
        await claude.aclose()
        await local.aclose()
    assert known["vision"] is True
    assert isinstance(known["context_window"], int) and known["context_window"] > 0
    assert known["prompt_caching"] is True
    assert unknown["vision"] is None
    assert set(unknown) == {
        "vision",
        "context_window",
        "prompt_caching",
        "strict_schemas",
    }


def test_tested_models_list(monkeypatch: pytest.MonkeyPatch) -> None:
    assert is_tested("anthropic", "claude-sonnet-4-5") is False
    monkeypatch.setattr(
        capabilities, "TESTED_MODELS", frozenset({("anthropic", "claude-sonnet-4-5")})
    )
    assert is_tested("anthropic", "claude-sonnet-4-5") is True


async def test_only_own_connections_use_the_guarded_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    built: list[httpx2.AsyncClient] = []
    real = providers.guarded_client

    def recording(*args: Any, **kwargs: Any) -> httpx2.AsyncClient:
        built.append(real(*args, **kwargs))
        return built[-1]

    monkeypatch.setattr(providers, "guarded_client", recording)
    own = open_models(
        _target("openai", model="gpt-4.1", credentials={"api_key": "sk-org"}), STRICT
    )
    instance = open_models(
        Target(
            connection_id=None,
            provider="openai",
            model="gpt-4.1",
            credentials={"api_key": "sk-goat"},
        ),
        STRICT,
    )
    try:
        assert own.clients == built
        assert len(built) == 1 and instance.clients and instance.clients[0] not in built
    finally:
        await own.aclose()
        await instance.aclose()


# -- request-time reads of the instance environment ---------------------------


def _json_message(request: httpx2.Request) -> httpx2.Response:
    """A non-streamed Messages API answer, as Bedrock and Vertex AI return it."""
    return httpx2.Response(
        200,
        json={
            "id": "msg_1",
            "type": "message",
            "role": "assistant",
            "model": "claude-sonnet-4-6",
            "content": [{"type": "text", "text": "hello"}],
            "stop_reason": "end_turn",
            "stop_sequence": None,
            "usage": {"input_tokens": 1, "output_tokens": 1},
        },
    )


async def _send(models: providers.OpenModels) -> None:
    await models.main.client.messages.create(  # type: ignore[attr-defined]
        model=models.main.model_name,
        max_tokens=8,
        messages=[{"role": "user", "content": "hi"}],
    )


async def test_own_bedrock_requests_are_signed_without_the_instance_aws_profile(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AWS_PROFILE", "does-not-exist")
    monkeypatch.setenv("AWS_CONFIG_FILE", "/nonexistent/config")
    monkeypatch.setenv("AWS_SHARED_CREDENTIALS_FILE", "/nonexistent/credentials")
    seen: list[httpx2.Request] = []

    def endpoint(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        return _json_message(request)

    models = open_models(
        _target(
            "bedrock",
            model="eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
            region="eu-central-1",
            credentials={
                "access_key_id": "AKIAEXAMPLE1234",
                "secret_access_key": "secret",
            },
        ),
        STRICT,
        transport=httpx2.MockTransport(endpoint),
    )
    try:
        await _send(models)
    finally:
        await models.aclose()
    authorization = seen[0].headers["authorization"]
    assert authorization.startswith("AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE1234/")
    assert "/eu-central-1/bedrock/aws4_request" in authorization
    assert seen[0].url.host == "bedrock-runtime.eu-central-1.amazonaws.com"


async def test_own_vertex_token_exchange_ignores_the_instance_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name, value in {
        "HTTPS_PROXY": "http://proxy.example.org:3128",
        "REQUESTS_CA_BUNDLE": "/nonexistent/ca.pem",
        "ANTHROPIC_VERTEX_PROJECT_ID": "instance-project",
        "CLOUD_ML_REGION": "us-east5",
        "GOOGLE_CLOUD_PROJECT": "instance-project",
        "GOOGLE_APPLICATION_CREDENTIALS": "/nonexistent/key.json",
    }.items():
        monkeypatch.setenv(name, value)
    sessions: list[requests.Session] = []
    token_requests: list[str] = []

    def token_endpoint(
        self: requests.Session, method: str, url: str, **kwargs: Any
    ) -> requests.Response:
        sessions.append(self)
        token_requests.append(url)
        reply = requests.Response()
        reply.status_code = 200
        reply._content = json.dumps(
            {"access_token": "ya29.org", "expires_in": 3600, "token_type": "Bearer"}
        ).encode()
        return reply

    monkeypatch.setattr(requests.Session, "request", token_endpoint)
    seen: list[httpx2.Request] = []

    def endpoint(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        return _json_message(request)

    models = open_models(
        _target(
            "vertex",
            model="claude-sonnet-4-6",
            region="europe-west1",
            credentials={"service_account_json": _service_account()},
        ),
        STRICT,
        transport=httpx2.MockTransport(endpoint),
    )
    try:
        await _send(models)
    finally:
        await models.aclose()
    assert token_requests == ["https://oauth2.googleapis.com/token"]
    assert [session.trust_env for session in sessions] == [False]
    assert seen[0].url.host == "europe-west1-aiplatform.googleapis.com"
    assert "/projects/goat-test/locations/europe-west1/" in seen[0].url.path
    assert seen[0].headers["authorization"] == "Bearer ya29.org"


async def test_own_azure_ignores_the_instance_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name, value in {
        "OPENAI_API_VERSION": "2020-01-01",
        "OPENAI_API_KEY": "sk-instance",
        "AZURE_OPENAI_API_KEY": "az-instance",
        "AZURE_OPENAI_ENDPOINT": "https://instance.openai.azure.com",
        "AZURE_OPENAI_AD_TOKEN": "ad-instance",
        "AZURE_VOICELIVE_ENDPOINT": "https://instance.example.org",
        "AZURE_VOICELIVE_API_KEY": "vl-instance",
    }.items():
        monkeypatch.setenv(name, value)
    seen: list[httpx2.Request] = []

    def endpoint(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        return _chat_completion(request)

    models = open_models(
        _target(
            "azure_openai",
            model="deployment",
            base_url="https://res.openai.azure.com/openai/v1",
            credentials={"api_key": "az-org"},
        ),
        STRICT,
        transport=httpx2.MockTransport(endpoint),
    )
    try:
        assert models.main.client.max_retries == providers.SDK_RETRIES  # type: ignore[attr-defined]
        assert (await Agent(models.main).run("hi")).output == "hello"
    finally:
        await models.aclose()
    assert seen[0].url.host == "res.openai.azure.com"
    assert "api-version" not in seen[0].url.params
    assert seen[0].headers["authorization"] == "Bearer az-org"
    assert "api-key" not in seen[0].headers
    assert "instance" not in str(seen[0].headers)


async def test_own_mistral_ignores_the_instance_environment(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    token_file = tmp_path / "token"
    token_file.write_text("sa-instance")
    monkeypatch.setenv("MISTRAL_API_KEY", "mi-instance")
    monkeypatch.setenv("MISTRAL_SA_TOKEN_PATH", str(token_file))
    monkeypatch.setenv("MISTRAL_SERVER_URL", "https://instance.example.org")
    seen: list[httpx2.Request] = []

    def endpoint(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        return _chat_completion(request)

    models = open_models(
        _target(
            "mistral", model="mistral-large-latest", credentials={"api_key": "mi-org"}
        ),
        STRICT,
        transport=httpx2.MockTransport(endpoint),
    )
    try:
        assert (await Agent(models.main).run("hi")).output == "hello"
    finally:
        await models.aclose()
    assert seen[0].url.host == "api.mistral.ai"
    assert seen[0].headers["authorization"] == "Bearer mi-org"
    assert "instance" not in str(seen[0].headers)


async def test_mistral_retries_a_rate_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        providers,
        "MISTRAL_RETRY",
        RetryConfig("backoff", BackoffStrategy(1, 1, 1.0, 1000), False),
    )
    seen: list[httpx2.Request] = []

    def endpoint(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        if len(seen) == 1:
            return httpx2.Response(429, json={"message": "Rate limit exceeded"})
        return _chat_completion(request)

    models = open_models(
        _target(
            "mistral", model="mistral-large-latest", credentials={"api_key": "mi-org"}
        ),
        STRICT,
        transport=httpx2.MockTransport(endpoint),
    )
    try:
        assert (await Agent(models.main).run("hi")).output == "hello"
    finally:
        await models.aclose()
    assert len(seen) == 2


async def test_own_clients_without_a_key_never_use_the_instance_keys(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in (
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "MISTRAL_API_KEY",
        "AZURE_OPENAI_API_KEY",
        "OPENAI_API_KEY",
    ):
        monkeypatch.setenv(name, "instance-secret")
    seen: list[httpx2.Request] = []

    def endpoint(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        if request.url.host == "api.anthropic.com":
            return _anthropic_message(request)
        return _chat_completion(request)

    for provider, model in (
        ("anthropic", "claude-sonnet-4-6"),
        ("mistral", "mistral-large-latest"),
        ("openai", "gpt-4.1"),
    ):
        models = open_models(
            _target(provider, model=model, credentials={}),
            STRICT,
            transport=httpx2.MockTransport(endpoint),
        )
        try:
            await Agent(models.main).run("hi")
        finally:
            await models.aclose()
    assert [r.url.host for r in seen] == [
        "api.anthropic.com",
        "api.mistral.ai",
        "api.openai.com",
    ]
    assert seen[0].headers["x-api-key"] == providers.NO_KEY
    assert "authorization" not in seen[0].headers
    assert seen[1].headers["authorization"] == f"Bearer {providers.NO_KEY}"
    assert seen[2].headers["authorization"] == f"Bearer {providers.NO_KEY}"
    assert "instance-secret" not in str([r.headers for r in seen])
    # Hidden only while the clients are built.
    assert os.environ["ANTHROPIC_API_KEY"] == "instance-secret"


def test_vertex_token_refresh_trusts_the_instance_ca_bundle_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.example.org:3128")
    monkeypatch.delenv("SSL_CERT_FILE", raising=False)
    monkeypatch.delenv("REQUESTS_CA_BUNDLE", raising=False)
    sessions: list[requests.Session] = []
    verify: list[Any] = []

    def token_endpoint(
        self: requests.Session, method: str, url: str, **kwargs: Any
    ) -> requests.Response:
        sessions.append(self)
        verify.append(self.verify)
        reply = requests.Response()
        reply.status_code = 200
        reply._content = json.dumps(
            {"access_token": "ya29.org", "expires_in": 3600, "token_type": "Bearer"}
        ).encode()
        return reply

    monkeypatch.setattr(requests.Session, "request", token_endpoint)
    credentials = providers._DirectCredentials.from_service_account_info(  # type: ignore[no-untyped-call]
        json.loads(_service_account()), scopes=[providers.CLOUD_PLATFORM_SCOPE]
    )
    credentials.refresh(None)
    monkeypatch.setenv("REQUESTS_CA_BUNDLE", "/etc/ssl/requests-bundle.pem")
    credentials.refresh(None)
    monkeypatch.setenv("SSL_CERT_FILE", "/etc/ssl/instance-ca.pem")
    credentials.refresh(None)
    assert verify == [
        True,
        "/etc/ssl/requests-bundle.pem",
        "/etc/ssl/instance-ca.pem",
    ]
    # Proxies and netrc stay off.
    assert [session.trust_env for session in sessions] == [False] * 3


async def test_http_client_is_closed_when_a_model_cannot_be_built(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    built: list[httpx2.AsyncClient] = []
    real = providers.guarded_client

    def recording(*args: Any, **kwargs: Any) -> httpx2.AsyncClient:
        built.append(real(*args, **kwargs))
        return built[-1]

    def failing(*args: Any, **kwargs: Any) -> object:
        raise RuntimeError("cannot build")

    monkeypatch.setattr(providers, "guarded_client", recording)
    monkeypatch.setitem(providers._BUILDERS, "openai", failing)
    with pytest.raises(RuntimeError, match="cannot build"):
        open_models(
            _target("openai", model="gpt-4.1", credentials={"api_key": "k"}), STRICT
        )
    await asyncio.sleep(0)
    assert built and built[0].is_closed


# -- prompt caching -------------------------------------------------------------


@pytest.mark.parametrize(
    "target",
    [
        _target("anthropic", model="claude-x", credentials={"api_key": "k"}),
        _target(
            "bedrock",
            model="eu.anthropic.claude-x",
            region="eu-central-1",
            credentials={"access_key_id": "AKIAEXAMPLE1234", "secret_access_key": "s"},
        ),
        _target(
            "vertex",
            model="claude-x@1",
            region="europe-west1",
            credentials={"service_account_json": _service_account()},
        ),
    ],
)
async def test_claude_caches_instructions_tools_and_the_conversation(
    target: Target, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("AWS_BEARER_TOKEN_BEDROCK", raising=False)
    models = open_models(target, STRICT)
    try:
        assert models.main.settings == providers.CLAUDE_CACHE
    finally:
        await models.aclose()


async def test_an_openrouter_connection_uses_openrouters_cache_markers() -> None:
    models = open_models(
        _target(
            "openai_compatible",
            model="anthropic/claude-haiku-5.5",
            base_url="https://openrouter.ai/api/v1",
            credentials={"api_key": "sk-or"},
        ),
        STRICT,
    )
    try:
        assert isinstance(models.main, OpenRouterModel)
        assert models.main.settings == providers.OPENROUTER_CACHE
        assert models.main.base_url is not None
        assert models.main.base_url.rstrip("/") == "https://openrouter.ai/api/v1"
    finally:
        await models.aclose()


@pytest.mark.parametrize(
    ("provider", "base_url"),
    [
        ("openai", None),
        ("openai_compatible", "https://llm.example.org/v1"),
        # Only OpenRouter itself, not a host that merely starts with its name.
        ("openai_compatible", "https://openrouter.ai.example.org/v1"),
    ],
)
async def test_openai_style_endpoints_cache_by_themselves(
    provider: str, base_url: str | None
) -> None:
    models = open_models(
        _target(provider, model="m", base_url=base_url, credentials={"api_key": "k"}),
        STRICT,
    )
    try:
        assert type(models.main) is OpenAIChatModel
        assert not models.main.settings
    finally:
        await models.aclose()


async def test_an_openrouter_connection_can_pin_its_providers() -> None:
    """OpenRouter sends one model to many providers, at other prices and
    precisions; a connection can name the ones to use, in order."""
    models = open_models(
        _target(
            "openai_compatible",
            model="deepseek/deepseek-v4.1-flash",
            base_url="https://openrouter.ai/api/v1",
            credentials={"api_key": "sk-or"},
            provider_order=("DeepInfra", "Together"),
            allow_fallbacks=False,
        ),
        STRICT,
    )
    try:
        assert isinstance(models.main, OpenRouterModel)
        assert models.main.settings == {
            **providers.OPENROUTER_CACHE,
            "openrouter_provider": {
                "order": ["DeepInfra", "Together"],
                "allow_fallbacks": False,
            },
        }
    finally:
        await models.aclose()


def test_a_provider_order_is_trimmed_and_only_for_openrouter() -> None:
    fields = normalize_connection(
        "openai_compatible",
        "https://openrouter.ai/api/v1",
        None,
        "deepseek/deepseek-v4.1-flash",
        STRICT,
        provider_order=[" DeepInfra ", "", "DeepInfra", "Together"],
        allow_fallbacks=False,
    )
    assert (fields.provider_order, fields.allow_fallbacks) == (
        ("DeepInfra", "Together"),
        False,
    )
    with pytest.raises(ConnectionInvalid) as other_endpoint:
        normalize_connection(
            "openai_compatible",
            "https://llm.example.org/v1",
            None,
            "m",
            STRICT,
            provider_order=["DeepInfra"],
        )
    assert other_endpoint.value.field == "provider_order"
    with pytest.raises(ConnectionInvalid) as bad_name:
        normalize_connection(
            "openai_compatible",
            "https://openrouter.ai/api/v1",
            None,
            "m",
            STRICT,
            provider_order=["Deep;Infra"],
        )
    assert bad_name.value.field == "provider_order"
