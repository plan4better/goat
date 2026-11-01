"""Test connection (spec §4.3): authentication, a streamed answer, one tool call."""

import asyncio
import base64
import ipaddress
import json
import logging
from collections.abc import AsyncIterator
from urllib.parse import quote
from uuid import UUID

import httpcore2
import httpx2
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from google.auth.exceptions import RefreshError, TransportError
from pydantic_ai.exceptions import ModelAPIError, ModelHTTPError, UsageLimitExceeded
from pydantic_ai.messages import ModelMessage
from pydantic_ai.models.function import (
    AgentInfo,
    DeltaToolCall,
    DeltaToolCalls,
    FunctionModel,
)
from pydantic_ai.models.test import TestModel

from assistant.llm import probe as probe_module
from assistant.llm import providers
from assistant.llm.endpoints import (
    BlockedEndpoint,
    EndpointPolicy,
    GuardedTransport,
    IPAddress,
)
from assistant.llm.failures import (
    admin_message,
    classify_failure,
    redact,
    secrets_of,
    user_message,
)
from assistant.llm.probe import probe_model, probe_target
from assistant.llm.providers import Target

STRICT = EndpointPolicy()
TARGET = Target(
    connection_id=UUID(int=500),
    provider="openai_compatible",
    model="own-model",
    base_url="https://llm.example.org/v1",
    credentials={"api_key": "sk-good"},
)


# -- classification --------------------------------------------------------------


def test_http_statuses() -> None:
    kinds = {
        status: classify_failure(ModelHTTPError(status, "m")).kind  # type: ignore[union-attr]
        for status in (401, 403, 429, 503, 400)
    }
    assert kinds == {
        401: "rejected",
        403: "rejected",
        429: "busy",
        503: "unreachable",
        400: "error",
    }


def test_blocked_endpoint_inside_the_sdk_error_chain() -> None:
    blocked = BlockedEndpoint(
        "llm.example.org resolves to 10.0.0.5, which is a private or internal address."
    )
    connect = httpx2.ConnectError("blocked")
    connect.__cause__ = blocked
    error = ModelAPIError("own-model", "Connection error.")
    error.__cause__ = connect
    failure = classify_failure(error)
    assert failure is not None and failure.kind == "blocked"
    assert "10.0.0.5" in admin_message(failure)


def test_connection_errors_and_other_errors() -> None:
    failure = classify_failure(ModelAPIError("own-model", "Connection error."))
    assert failure is not None and failure.kind == "unreachable"
    assert classify_failure(ValueError("no")) is None
    assert classify_failure(UsageLimitExceeded("limit")) is None
    assert classify_failure(TimeoutError()) is None
    # A tool's own HTTP error is not a provider failure: no ModelAPIError on top.
    assert classify_failure(httpx2.ConnectError("refused")) is None
    assert classify_failure(httpcore2.ConnectError("refused")) is None


def test_member_messages_carry_no_details() -> None:
    rejected = classify_failure(
        ModelHTTPError(401, "m", body={"error": "key sk-123 invalid"})
    )
    assert rejected is not None
    assert user_message(rejected, own=True) == "AI is unavailable right now."
    assert "sk-123" not in user_message(rejected, own=True)
    down = classify_failure(ModelHTTPError(502, "m"))
    assert down is not None
    assert (
        user_message(down, own=True)
        == "Your organization's AI provider isn't reachable right now."
    )
    assert user_message(down, own=False) == "GOAT AI isn't reachable right now."
    assert (
        admin_message(rejected) == "The provider rejected the credentials (HTTP 401)."
    )


# -- probe on test models ----------------------------------------------------------


async def test_a_model_with_tool_calling_passes() -> None:
    result = await probe_model(TestModel(custom_output_text="done"), "test")
    assert result.ok is True and result.error is None
    assert result.capabilities["tool_calling"] is True
    assert result.capabilities["streaming"] is True


async def test_a_model_that_never_calls_the_tool_fails() -> None:
    async def text_only(
        messages: list[ModelMessage], info: AgentInfo
    ) -> AsyncIterator[str]:
        yield "done"

    result = await probe_model(FunctionModel(stream_function=text_only), "plain-model")
    assert result.ok is False
    assert result.error is not None and "tool calling" in result.error


async def test_a_rejected_key_fails_with_the_reason() -> None:
    async def rejecting(
        messages: list[ModelMessage], info: AgentInfo
    ) -> AsyncIterator[str]:
        raise ModelHTTPError(401, "own-model", {"error": "invalid key"})
        yield ""  # an async generator

    result = await probe_model(FunctionModel(stream_function=rejecting), "own-model")
    assert result == type(result)(
        ok=False,
        error="The provider rejected the credentials (HTTP 401).",
        capabilities={},
    )


async def test_a_model_that_keeps_calling_tools_fails() -> None:
    async def looping(
        messages: list[ModelMessage], info: AgentInfo
    ) -> AsyncIterator[DeltaToolCalls]:
        yield {0: DeltaToolCall(name="probe_echo", json_args='{"value": "goat"}')}

    result = await probe_model(FunctionModel(stream_function=looping), "own-model")
    assert (
        result.ok is False
        and result.error is not None
        and "did not finish" in result.error
    )


# -- probe over a mocked OpenAI compatible endpoint ---------------------------------


def _chunk(delta: dict[str, object], finish: str | None = None) -> str:
    body = {
        "id": "c1",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "own-model",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }
    return f"data: {json.dumps(body)}\n\n"


def _openai_endpoint(request: httpx2.Request) -> httpx2.Response:
    """Streams a probe_echo call first, then a text answer once the tool result is back."""
    if request.headers.get("authorization") != "Bearer sk-good":
        return httpx2.Response(401, json={"error": {"message": "Incorrect API key"}})
    body = json.loads(request.content)
    assert body["stream"] is True
    if not any(message.get("role") == "tool" for message in body["messages"]):
        call = {
            "index": 0,
            "id": "call_1",
            "type": "function",
            "function": {"name": "probe_echo", "arguments": '{"value": "goat"}'},
        }
        sse = _chunk({"role": "assistant", "tool_calls": [call]}) + _chunk(
            {}, "tool_calls"
        )
    else:
        sse = (
            _chunk({"role": "assistant", "content": "do"})
            + _chunk({"content": "ne"})
            + _chunk({}, "stop")
        )
    return httpx2.Response(
        200,
        content=(sse + "data: [DONE]\n\n").encode(),
        headers={"content-type": "text/event-stream"},
    )


async def test_probe_over_an_openai_compatible_endpoint() -> None:
    result = await probe_target(
        TARGET, STRICT, transport=httpx2.MockTransport(_openai_endpoint)
    )
    assert result.ok is True, result.error
    assert result.capabilities["tool_calling"] is True


async def test_probe_reports_a_wrong_key() -> None:
    wrong = Target(**{**TARGET.__dict__, "credentials": {"api_key": "sk-wrong"}})
    result = await probe_target(
        wrong, STRICT, transport=httpx2.MockTransport(_openai_endpoint)
    )
    assert result.ok is False
    assert result.error == "The provider rejected the credentials (HTTP 401)."


def test_redact_replaces_credential_values() -> None:
    assert (
        redact("bad key sk-good-1234 for org", ["sk-good-1234", "ab"])
        == "bad key … for org"
    )


async def test_probe_never_reports_the_key() -> None:
    def echoing(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(
            400, json={"error": {"message": "Key sk-good is not valid for this model"}}
        )

    result = await probe_target(TARGET, STRICT, transport=httpx2.MockTransport(echoing))
    assert result.ok is False and result.error is not None
    assert "sk-good" not in result.error and "…" in result.error


async def test_probe_reports_a_blocked_endpoint() -> None:
    async def private(host: str, port: int) -> list[IPAddress]:
        return [ipaddress.ip_address("10.0.0.5")]

    transport = GuardedTransport(
        STRICT, resolver=private, inner_backend=httpcore2.AsyncMockBackend([])
    )
    result = await probe_target(TARGET, STRICT, transport=transport)
    assert result.ok is False
    assert (
        result.error is not None
        and "not allowed" in result.error
        and "10.0.0.5" in result.error
    )


# -- credentials never reach an error text ----------------------------------------

#: Contains characters that repr, JSON and URL encoding all change.
TRICKY_KEY = 'sk-a"b\\c-Zy98/xw76+EfGh5432=='


def _forms(key: str) -> list[str]:
    return [
        key,
        repr(key)[1:-1],
        json.dumps(key)[1:-1],
        quote(key, safe=""),
        base64.b64encode(key.encode()).decode(),
        base64.urlsafe_b64encode(key.encode()).decode(),
        key[3:14],  # a partial run of 11 characters
    ]


def _service_account() -> str:
    pem = (
        rsa.generate_private_key(public_exponent=65537, key_size=2048)
        .private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        .decode()
    )
    return json.dumps(
        {
            "type": "service_account",
            "project_id": "goat-test",
            "private_key_id": "0123456789abcdef0123",
            "private_key": pem,
            "client_email": "goat@goat-test.iam.gserviceaccount.com",
            "token_uri": "https://oauth2.googleapis.com/token",
        }
    )


def test_transport_errors_report_only_the_class() -> None:
    link = httpx2.ConnectError(f"Illegal header value b'Bearer {TRICKY_KEY}'")
    error = ModelAPIError("own-model", "Connection error.")
    error.__cause__ = link
    failure = classify_failure(error, [TRICKY_KEY])
    assert failure is not None and failure.status is None
    assert admin_message(failure) == "The provider could not be reached (ConnectError)."


async def test_probe_never_reports_a_header_echoed_by_the_transport() -> None:
    def failing(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.LocalProtocolError(
            f"Illegal header value {('Bearer ' + TRICKY_KEY).encode()!r}"
        )

    target = Target(**{**TARGET.__dict__, "credentials": {"api_key": TRICKY_KEY}})
    result = await probe_target(target, STRICT, transport=httpx2.MockTransport(failing))
    assert result.ok is False and result.error is not None
    assert result.error.startswith("The provider could not be reached (")
    assert "Illegal" not in result.error and "Bearer" not in result.error


@pytest.mark.parametrize("form", _forms(TRICKY_KEY))
async def test_probe_never_reports_an_encoded_or_partial_key(form: str) -> None:
    def echoing(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(400, json={"error": {"message": f"Bad key {form} here"}})

    target = Target(**{**TARGET.__dict__, "credentials": {"api_key": TRICKY_KEY}})
    result = await probe_target(target, STRICT, transport=httpx2.MockTransport(echoing))
    assert result.ok is False and result.error is not None
    assert form not in result.error and "…" in result.error


def test_redaction_happens_before_the_excerpt_is_cut() -> None:
    key = "sk-live-0123456789abcdefghijklmnop"
    failure = classify_failure(
        ModelHTTPError(400, "m", body="x" * 290 + key + " trailing"), [key]
    )
    assert failure is not None
    assert failure.detail.startswith("x" * 290 + "…")
    assert "sk-" not in failure.detail and "live" not in failure.detail


def test_a_huge_body_is_masked_and_cut() -> None:
    key = "sk-live-0123456789abcdefghijklmnop"
    failure = classify_failure(
        ModelHTTPError(500 - 100, "m", body=key + "y" * 100_000), [key]
    )
    assert (
        failure is not None
        and len(failure.detail) <= 300
        and "sk-" not in failure.detail
    )


def test_redact_masks_runs_of_long_secrets_only() -> None:
    assert redact("see 0123456789 abc", ["0123456789abcdef"]) == "see … abc"
    # Below 12 characters only the whole value is masked.
    assert redact("see 01234567 abc", ["0123456789a"]) == "see 01234567 abc"
    assert redact("see 0123456789a abc", ["0123456789a"]) == "see … abc"


def test_redact_covers_a_bedrock_key_pair() -> None:
    target = Target(
        connection_id=UUID(int=501),
        provider="bedrock",
        model="m",
        region="eu-central-1",
        credentials={
            "access_key_id": "AKIAIOSFODNN7EXAMPLE",
            "secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        },
    )
    secrets = secrets_of(target)
    for value in target.credentials.values():
        for form in _forms(value):
            text = redact(f"denied: {form}.", secrets)
            assert form not in text and "…" in text


def test_redact_covers_a_vertex_key_file() -> None:
    raw = _service_account()
    info = json.loads(raw)
    target = Target(
        connection_id=UUID(int=502),
        provider="vertex",
        model="m",
        region="us-east5",
        credentials={"service_account_json": raw},
    )
    secrets = secrets_of(target)
    lines = [
        line
        for line in info["private_key"].splitlines()
        if not line.startswith("-----")
    ]
    pieces = [info["private_key"], info["private_key_id"], info["client_email"], *lines]
    for piece in pieces:
        for form in _forms(piece):
            assert form not in redact(f"failed with {form}.", secrets)
    assert "MIIE" not in redact(f"token request {raw}", secrets)


async def test_a_probe_that_times_out_says_so() -> None:
    async def silent(
        messages: list[ModelMessage], info: AgentInfo
    ) -> AsyncIterator[str]:
        await asyncio.sleep(3600)
        yield ""

    result = await probe_model(
        FunctionModel(stream_function=silent), "slow", timeout=0.2
    )
    assert result.ok is False and result.error == "The provider did not answer in time."


async def test_invalid_tool_calls_are_reported_without_a_traceback(
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def broken(
        messages: list[ModelMessage], info: AgentInfo
    ) -> AsyncIterator[DeltaToolCalls]:
        yield {0: DeltaToolCall(name="probe_echo", json_args="{}")}

    result = await probe_model(FunctionModel(stream_function=broken), "own-model")
    assert result.ok is False and result.error is not None
    assert result.error.startswith("The model did not complete the tool call.")
    assert "tool calling" in result.error
    assert "The connection test failed" not in caplog.text


async def test_an_unclassified_error_is_logged_without_the_key(
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def failing(
        messages: list[ModelMessage], info: AgentInfo
    ) -> AsyncIterator[str]:
        raise RuntimeError(f"surprise with {TRICKY_KEY}")
        yield ""

    with caplog.at_level(logging.ERROR):
        result = await probe_model(
            FunctionModel(stream_function=failing), "own-model", secrets=[TRICKY_KEY]
        )
    assert (
        result.error == "The test failed unexpectedly. The service log has the details."
    )
    assert "surprise with" in caplog.text and "Zy98" not in caplog.text


async def test_probe_target_survives_models_that_cannot_be_built(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    def broken(*args: object, **kwargs: object) -> None:
        raise RuntimeError(f"cannot build with {TRICKY_KEY}")

    monkeypatch.setattr(probe_module, "open_models", broken)
    target = Target(**{**TARGET.__dict__, "credentials": {"api_key": TRICKY_KEY}})
    with caplog.at_level(logging.ERROR):
        result = await probe_target(target, STRICT)
    assert result.ok is False
    assert (
        result.error
        == "The connection settings could not be used. Check them and try again."
    )
    assert "Building the models" in caplog.text and "Zy98" not in caplog.text


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (
            RefreshError("invalid_grant: bad key"),
            "The provider rejected the credentials.",
        ),
        (
            TransportError("no route"),
            "The provider could not be reached (TransportError).",
        ),
    ],
)
async def test_vertex_token_errors_are_classified(
    monkeypatch: pytest.MonkeyPatch, error: Exception, expected: str
) -> None:
    def refuse(self: object, request: object) -> None:
        raise error

    monkeypatch.setattr(providers._DirectCredentials, "refresh", refuse)
    target = Target(
        connection_id=UUID(int=503),
        provider="vertex",
        model="own-claude-model",
        region="us-east5",
        credentials={"service_account_json": _service_account()},
    )
    result = await probe_target(
        target,
        STRICT,
        transport=httpx2.MockTransport(lambda request: httpx2.Response(500)),
    )
    assert result.ok is False and result.error == expected
