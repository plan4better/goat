"""Test support for tools: recorded fake services and a scripted model.

Shipped with the package, like Pydantic AI's TestModel, so the unit tests and
the eval CLI (plan 5) share it. Nothing here opens a network connection.
"""

import base64
import json
import time
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from typing import Any
from uuid import UUID

import httpx
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    TextPart,
    ToolCallPart,
    UserPromptPart,
)
from pydantic_ai.models.function import (
    AgentInfo,
    DeltaToolCall,
    DeltaToolCalls,
    FunctionModel,
)

from assistant.context import NO_PAGE, PageContext
from assistant.llm.types import DataPolicy
from assistant.login import Login, StaticLogin
from assistant.prompt import NOTE_CLOSE, NOTE_OPEN
from assistant.repo import Repository
from assistant.surfaces import Locale
from assistant.tools.http import ServiceClients
from assistant.tools.runtime import EmitData, ToolEnv

Answer = httpx.Response | Callable[[httpx.Request], httpx.Response] | Any


class Recorder:
    """A ``MockTransport`` handler answering from ``{(method, path): answer}``.

    An answer is a response, a function of the request, or any JSON value
    (sent with 200). Unknown routes answer 599. Every request is recorded.
    """

    def __init__(self, routes: Mapping[tuple[str, str], Answer] | None = None) -> None:
        self.routes: dict[tuple[str, str], Answer] = dict(routes or {})
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        answer = self.routes.get((request.method, request.url.path))
        if answer is None:
            return httpx.Response(
                599, json={"detail": f"unexpected {request.method} {request.url.path}"}
            )
        if isinstance(answer, httpx.Response):
            return answer
        if callable(answer):
            response: httpx.Response = answer(request)
            return response
        return httpx.Response(200, json=answer)

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self)

    def paths(self) -> list[str]:
        return [request.url.path for request in self.requests]

    def bodies(self) -> list[Any]:
        return [
            json.loads(request.content) if request.content else None
            for request in self.requests
        ]


class RecordingTransport(httpx.AsyncBaseTransport):
    """Records requests on their way to another transport (e.g. an
    ``ASGITransport`` to a real catalog app)."""

    def __init__(self, inner: httpx.AsyncBaseTransport) -> None:
        self.inner = inner
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return await self.inner.handle_async_request(request)


Fake = Recorder | httpx.AsyncBaseTransport | None


def fake_clients(
    *,
    core: Fake = None,
    geoapi: Fake = None,
    processes: Fake = None,
    catalog: Fake = None,
    keycloak: Fake = None,
) -> ServiceClients:
    """Service clients on fakes; a service left out answers 599 to anything."""

    def client(name: str, fake: Fake) -> httpx.AsyncClient:
        if isinstance(fake, Recorder):
            transport: httpx.AsyncBaseTransport = fake.transport()
        elif fake is None:
            transport = Recorder().transport()
        else:
            transport = fake
        return httpx.AsyncClient(transport=transport, base_url=f"http://{name}")

    return ServiceClients(
        core=client("core", core),
        geoapi=client("geoapi", geoapi),
        processes=client("processes", processes),
        catalog=client("catalog", catalog),
        keycloak=client("keycloak", keycloak) if keycloak is not None else None,
    )


def signed_in(expires_in: float, user_id: UUID = UUID(int=1)) -> StaticLogin:
    """A login whose token, an unsigned JWT, expires ``expires_in`` seconds
    from now (has expired, when negative): for tools that read its expiry."""

    def segment(data: dict[str, Any]) -> str:
        return base64.urlsafe_b64encode(json.dumps(data).encode()).rstrip(b"=").decode()

    claims = {"sub": str(user_id), "exp": int(time.time() + expires_in)}
    return StaticLogin(f"{segment({'alg': 'none'})}.{segment(claims)}.unsigned")


def tool_env(
    services: ServiceClients,
    *,
    login: Login | None = None,
    user_id: UUID = UUID(int=1),
    data_policy: DataPolicy = "standard",
    page: PageContext = NO_PAGE,
    locale: Locale = "en",
    run_id: UUID | None = None,
    emit_data: EmitData | None = None,
    repo: Repository | None = None,
    extra_secrets: Sequence[str] = (),
) -> ToolEnv:
    return ToolEnv(
        services=services,
        login=login or StaticLogin(None),
        user_id=user_id,
        data_policy=data_policy,
        page=page,
        locale=locale,
        run_id=run_id,
        emit_data=emit_data,
        repo=repo,
        extra_secrets=extra_secrets,
    )


def stage_note(messages: Sequence[ModelMessage]) -> str | None:
    """The note on the run's stage that a model call's messages end with
    (``assistant.agent.StageNote``), without its tags; None for a call
    without one (a look-up step)."""
    last = messages[-1] if messages else None
    if not isinstance(last, ModelRequest) or not last.parts:
        return None
    part = last.parts[-1]
    opening, closing = f"{NOTE_OPEN}\n", f"\n{NOTE_CLOSE}"
    if (
        isinstance(part, UserPromptPart)
        and isinstance(part.content, str)
        and part.content.startswith(opening)
        and part.content.endswith(closing)
    ):
        return part.content[len(opening) : -len(closing)]
    return None


class ScriptedModel:
    """A model that makes the given tool calls in order, one per response, then
    answers. Records what it was shown. For single-turn tests: it counts the
    responses in the history to know where it is."""

    def __init__(
        self, calls: Sequence[tuple[str, dict[str, Any]]] = (), answer: str = "done"
    ) -> None:
        self.calls = list(calls)
        self.answer = answer
        self.infos: list[AgentInfo] = []
        self.requests: list[list[ModelMessage]] = []

    @property
    def model(self) -> FunctionModel:
        return FunctionModel(self._respond, stream_function=self._stream)

    def note(self, request: int = -1) -> str:
        """The GOAT note of the newest user message in one recorded request."""
        for message in reversed(self.requests[request]):
            for part in reversed(getattr(message, "parts", [])):
                if isinstance(part, UserPromptPart) and not isinstance(
                    part.content, str
                ):
                    for item in part.content:
                        if isinstance(item, str) and item.startswith("<goat-note>"):
                            return item
                    return ""
        return ""

    def stage_note(self, request: int = -1) -> str | None:
        """The note on the run's stage one recorded request ended with
        (``stage_note``)."""
        return stage_note(self.requests[request])

    def _step(self, messages: list[ModelMessage], info: AgentInfo) -> int:
        self.infos.append(info)
        self.requests.append(list(messages))
        return sum(isinstance(message, ModelResponse) for message in messages)

    def _respond(self, messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        step = self._step(messages, info)
        if step < len(self.calls):
            name, args = self.calls[step]
            return ModelResponse(
                parts=[
                    ToolCallPart(tool_name=name, args=args, tool_call_id=f"call-{step}")
                ]
            )
        return ModelResponse(parts=[TextPart(content=self.answer)])

    async def _stream(
        self, messages: list[ModelMessage], info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        step = self._step(messages, info)
        if step < len(self.calls):
            name, args = self.calls[step]
            yield {
                0: DeltaToolCall(
                    name=name, json_args=json.dumps(args), tool_call_id=f"call-{step}"
                )
            }
            return
        yield self.answer


class TurnModel:
    """A model scripted per user turn of a conversation: in turn ``n`` it
    makes ``turns[n]``'s tool calls in order, one per response, then gives
    that turn's answer. It finds its place from the history it is sent, so
    one instance serves every run of a conversation. Tool call ids are
    ``call-<turn>-<step>``."""

    def __init__(
        self, turns: Sequence[tuple[Sequence[tuple[str, dict[str, Any]]], str]]
    ) -> None:
        self.turns = [(list(calls), answer) for calls, answer in turns]
        self.infos: list[AgentInfo] = []
        self.requests: list[list[ModelMessage]] = []

    @property
    def model(self) -> FunctionModel:
        return FunctionModel(self._respond, stream_function=self._stream)

    def _place(
        self, messages: list[ModelMessage], info: AgentInfo
    ) -> tuple[list[tuple[str, dict[str, Any]]], str, int, int]:
        self.infos.append(info)
        self.requests.append(list(messages))
        starts = [
            index
            for index, message in enumerate(messages)
            if isinstance(message, ModelRequest)
            and any(isinstance(part, UserPromptPart) for part in message.parts)
        ]
        turn = max(len(starts) - 1, 0)
        latest = starts[-1] if starts else 0
        step = sum(isinstance(message, ModelResponse) for message in messages[latest:])
        calls, answer = self.turns[min(turn, len(self.turns) - 1)]
        return calls, answer, turn, step

    def _respond(self, messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        calls, answer, turn, step = self._place(messages, info)
        if step < len(calls):
            name, args = calls[step]
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        tool_name=name, args=args, tool_call_id=f"call-{turn}-{step}"
                    )
                ]
            )
        return ModelResponse(parts=[TextPart(content=answer)])

    async def _stream(
        self, messages: list[ModelMessage], info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        calls, answer, turn, step = self._place(messages, info)
        if step < len(calls):
            name, args = calls[step]
            yield {
                0: DeltaToolCall(
                    name=name,
                    json_args=json.dumps(args),
                    tool_call_id=f"call-{turn}-{step}",
                )
            }
            return
        yield answer
