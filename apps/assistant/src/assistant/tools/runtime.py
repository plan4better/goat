"""One tool definition, two adapters (spec §3, §7).

A tool is a ``ToolSpec``: a typed async function with Pydantic input and output
models, and its metadata (surfaces, risk class, whether it returns data values,
whether MCP publishes it, the login scope an external client will need).

``execute`` is the single path every call takes, in-app and over MCP: validate
the arguments, run, apply the data policy, cap the size, write the audit row.
The adapters (``assistant.tools.toolset`` for Pydantic AI,
``assistant.mcp_server`` for MCP) only translate its two errors:
``InputInvalid`` (the model should fix the call) and ``ToolFailed`` (the call
is done and failed).
"""

import asyncio
import json
import logging
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import (
    Any,
    Generic,
    Literal,
    NoReturn,
    Protocol,
    TypeVar,
    runtime_checkable,
)
from uuid import UUID

from pydantic import BaseModel, ValidationError
from pydantic_ai.exceptions import ToolFailed

from assistant.asks import AskHistory
from assistant.clock import AnswerClock
from assistant.config import AssistantSettings
from assistant.context import PageContext
from assistant.llm import failures
from assistant.llm.types import DataPolicy
from assistant.login import Login, LoginFailed
from assistant.repo import Repository
from assistant.surfaces import Locale, Surface
from assistant.tools.http import Service, ServiceClients, call_service
from assistant.tools.policy import Withheld, apply_policy
from assistant.workflows.runs import ConversationRuns

logger = logging.getLogger(__name__)

Risk = Literal["read", "propose", "write"]


@runtime_checkable
class Creates(Protocol):
    """The result of a write tool: what it created, for its audit row
    (``{"kind": ..., "ids": [...], "project_id": ...}``)."""

    def created(self) -> dict[str, Any]: ...


@runtime_checkable
class Undoes(Protocol):
    """The result of a write tool that changed a document that exists: what
    takes the change back, for its audit row (the ``undo`` column), or None
    when it changed nothing."""

    def undo(self) -> dict[str, Any] | None: ...


class EmitData(Protocol):
    """Emits a data part into the run and returns its part id. ``part_id``
    names the part (an ask card is named by its card id); without it the part
    gets the run's next ``{message_id}:{n}``."""

    def __call__(
        self, name: str, data: dict[str, Any], *, part_id: str | None = None
    ) -> Awaitable[str]: ...


#: Mirrors the catalog MCP's cap: stays under the MCP transport's tool-result
#: limit even when a client counts the structured result and its text twice.
MAX_RESULT_BYTES = 450_000

_ARG_STRING_CHARS = 200
_ARG_LIST_ITEMS = 20
_ARG_DEPTH = 2
_ERROR_CHARS = 500


def _not_stopping() -> bool:
    return False


def client_secrets(settings: AssistantSettings) -> list[str]:
    """The Keycloak client secrets a token request carries, for masking in
    logs and audit rows next to the run's tokens (``Login.secrets``)."""
    values = (
        settings.web_client_secret.get_secret_value(),
        settings.keycloak_client_secret.get_secret_value(),
    )
    return [value for value in values if value]


@dataclass
class ToolEnv:
    """What a tool may use: the services, the user's login and the run's
    settings. Built once per run (or per MCP request)."""

    services: ServiceClients
    login: Login = field(repr=False)
    user_id: UUID
    data_policy: DataPolicy
    page: PageContext
    locale: Locale = "en"
    run_id: UUID | None = None
    #: Emits a data part (a proposal) into the run; None over MCP.
    emit_data: EmitData | None = None
    #: Where the audit rows go; None writes none (unit tests).
    repo: Repository | None = None
    #: Secrets beyond the login's tokens that must never reach a log or an
    #: audit row (``client_secrets(settings)``).
    extra_secrets: Sequence[str] = field(default=(), repr=False)
    #: The model's id of the call being executed; ``execute`` sets it on the
    #: copy of the environment each call gets. None outside a call.
    tool_call_id: str | None = None
    #: The conversation's cards and their answers, for tools that act only on
    #: what the user picked in a card (``assistant.asks.user_chose``).
    asks: AskHistory = field(default_factory=AskHistory)
    #: The answer's clock, for a tool that waits (a workflow run); None over
    #: MCP and in tests that give none.
    clock: AnswerClock | None = None
    #: What this conversation created and ran, for the run tools' permission;
    #: the tools add to it as they create and run.
    runs: ConversationRuns = field(default_factory=ConversationRuns)
    #: The workflows this answer created (the create tools add them): the
    #: step that answers may still run one (``assistant.tools.toolset``).
    workflows_created: set[str] = field(default_factory=set)
    #: The catalog datasets this answer's searches and records showed, their
    #: titles by id (``assistant.tools.catalog``): a card option that names
    #: one adds it (``assistant.asks.unadded_dataset``).
    catalog_titles: dict[str, str] = field(default_factory=dict)
    #: The catalog datasets this answer found picked in a card
    #: (``assistant.tools.workflows.catalog_picked``): a later check of the
    #: same dataset does not look its bundles up again.
    picked_datasets: set[str] = field(default_factory=set)
    #: Whether the service is shutting down, so a cancelled tool knows it was
    #: not the user's Stop (a workflow run then goes on).
    stopping: Callable[[], bool] = field(default=_not_stopping, repr=False)

    def secrets(self) -> list[str]:
        """Everything to mask in this run's errors, logs and audit rows."""
        return [*self.login.secrets(), *self.extra_secrets]

    async def bearer(self) -> str | None:
        try:
            return await self.login.bearer()
        except LoginFailed as exc:
            # The model can say this; the run itself goes on.
            raise ToolFailed(
                "The user's sign-in has expired. Ask them to sign in again."
            ) from exc

    async def call(
        self,
        service: Service,
        method: str,
        path: str,
        *,
        params: Mapping[str, object] | None = None,
        json_body: object | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> Any:
        return await call_service(
            self.services,
            service,
            method,
            path,
            bearer=await self.bearer(),
            params=params,
            json_body=json_body,
            headers=headers,
        )


In = TypeVar("In", bound=BaseModel)
Out = TypeVar("Out", bound=BaseModel)


@dataclass(frozen=True)
class ToolSpec(Generic[In, Out]):
    #: Namespaced, with a dot (``catalog.search``); sent as ``wire_name``.
    name: str
    description: str
    input_model: type[In]
    output_model: type[Out]
    run: Callable[[ToolEnv, In], Awaitable[BaseModel]]
    #: Where it is loaded (spec §6.3).
    surfaces: frozenset[Surface]
    #: The data policy applies (spec §4.7). Required: every tool says whether
    #: it returns data values, so none is exempt by omission.
    returns_data: bool
    #: Spec §8.1: read, propose (a card the user applies) or write (creates
    #: something new; a workflow run replaces a workflow's previous results,
    #: and a workflow edit changes a workflow; nothing else changes or
    #: deletes).
    risk: Risk = "read"
    #: Published over MCP (spec §9.1).
    mcp: bool = False
    #: Login scope an external MCP client will need (spec §9.2).
    scope: str = "goat:read"
    #: Set on a read tool, it runs once per answer: a later call in the same
    #: answer, whatever its arguments, gets the first call's result with this
    #: note instead of running (``assistant.tools.toolset``). ``ask_user``'s
    #: later card is refused with this note instead, since the first card's
    #: result names that card. Over MCP every call runs.
    once_per_answer: str | None = None
    #: Set on a tool that searches the catalog's text: whether its result (as
    #: ``execute`` returns it) found nothing. After ``FRUITLESS_SEARCHES`` such
    #: results in a row of these tools, later calls of them in the same answer
    #: do not run (``assistant.tools.toolset``). Over MCP every call runs.
    found_nothing: Callable[[dict[str, Any]], bool] | None = None
    #: Set on a write tool whose calls may repeat in later answers (a workflow
    #: run): a later answer runs it again instead of getting the first call's
    #: result, and a repeated call within one answer gets the first result
    #: with this note (``assistant.tools.toolset``).
    repeatable: str | None = None
    #: Set on a write tool: the read tools (wire names) whose results in the
    #: answer it can make stale (a workflow it edits). A call of it, however
    #: it ends, lets a later call of these run again instead of getting its
    #: earlier result (``assistant.tools.toolset``).
    invalidates: frozenset[str] = frozenset()
    #: Set on a tool whose result the answer reports before it asks: whether
    #: its result (as ``execute`` returns it) is one to report (a finished
    #: workflow run). After such a result, ``ask_user`` is refused in that
    #: answer until a later response of the model holds text
    #: (``assistant.tools.toolset``). Over MCP there is no card.
    report_first: Callable[[dict[str, Any]], bool] | None = None

    @property
    def wire_name(self) -> str:
        """OpenAI and Anthropic accept only ``[a-zA-Z0-9_-]`` in tool names."""
        return self.name.replace(".", "_")

    def json_schema(self) -> dict[str, Any]:
        """The arguments' JSON Schema as the model sees it, without the
        ``title`` pydantic gives every argument: the model reads the names and
        descriptions, and the titles only repeat the names on every call."""
        stripped: dict[str, Any] = _without_titles(self.input_model.model_json_schema())
        return stripped


#: Schema keywords whose value maps names to schemas: a key there is an
#: argument's or a definition's name (an argument may be called "title").
_NAMED_SCHEMAS = frozenset({"properties", "$defs", "definitions", "patternProperties"})


def _without_titles(schema: Any) -> Any:
    if isinstance(schema, list):
        return [_without_titles(item) for item in schema]
    if not isinstance(schema, dict):
        return schema
    return {
        key: (
            {name: _without_titles(sub) for name, sub in value.items()}
            if key in _NAMED_SCHEMAS and isinstance(value, dict)
            else _without_titles(value)
        )
        for key, value in schema.items()
        if not (key == "title" and isinstance(value, str))
    }


class ResultOverCap(ToolFailed):  # noqa: N818
    """A result larger than ``MAX_RESULT_BYTES``: not sent. ``size`` is its
    size in bytes, so a run can refuse the same call again without running it
    (``assistant.tools.toolset``)."""

    def __init__(self, size: int) -> None:
        super().__init__(
            "The result is too large to send. Narrow the request: fewer results, "
            "fewer fields or a filter."
        )
        self.size = size


class InputInvalid(Exception):  # noqa: N818
    """The arguments do not fit; the message tells the model how to fix them."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def _shorten(value: Any, depth: int) -> Any:
    if isinstance(value, str):
        return (
            value
            if len(value) <= _ARG_STRING_CHARS
            else value[:_ARG_STRING_CHARS] + "…"
        )
    if isinstance(value, Mapping):
        if depth >= _ARG_DEPTH:
            return "…"
        return {str(key): _shorten(item, depth + 1) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        items = [_shorten(item, depth + 1) for item in value[:_ARG_LIST_ITEMS]]
        if len(value) > _ARG_LIST_ITEMS:
            items.append(f"… {len(value) - _ARG_LIST_ITEMS} more")
        return items
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return str(value)[:_ARG_STRING_CHARS]


def summarize_args(args: Mapping[str, Any]) -> dict[str, Any]:
    """The arguments as the audit stores them: long strings and lists cut, deep
    structures elided."""
    return {str(key): _shorten(value, 0) for key, value in args.items()}


def _describe(exc: ValidationError) -> str:
    problems = []
    for error in exc.errors(
        include_url=False, include_input=False, include_context=False
    ):
        where = ".".join(str(part) for part in error["loc"]) or "arguments"
        problems.append(f"{where}: {error['msg']}")
    return "Invalid arguments: " + "; ".join(problems[:10])


async def execute(
    spec: ToolSpec[Any, Any],
    env: ToolEnv,
    raw_args: Mapping[str, Any],
    *,
    tool_call_id: str | None = None,
    check_result: Callable[[int], str | None] | None = None,
) -> dict[str, Any]:
    """``check_result``: called with the size of the result in bytes; a text
    it returns refuses the result with that text (a run's limits,
    ``assistant.tools.toolset``)."""
    started = time.monotonic()
    # Pessimistic until the success return: anything that escapes unclassified
    # (a BaseException, a failure inside a handler) is audited as an error.
    status = "error"
    error: str | None = "internal error"
    size = 0
    created: dict[str, Any] | None = None
    undo: dict[str, Any] | None = None
    try:
        try:
            args = spec.input_model.model_validate(dict(raw_args))
        except ValidationError as exc:
            raise InputInvalid(_describe(exc)) from exc
        # Each call its own copy: calls of one answer run concurrently.
        result = await spec.run(replace(env, tool_call_id=tool_call_id), args)
        # Recorded whatever happens next: what a write created exists even
        # when its result is then too large to send.
        if isinstance(result, Creates):
            try:
                created = result.created()
            except Exception:
                # What was created exists either way and the model must see
                # it: only the audit row goes without it.
                logger.exception("Reading what %s created failed", spec.wire_name)
        if isinstance(result, Undoes):
            try:
                undo = result.undo()
            except Exception:
                # The change is saved either way and the model must see it:
                # only its undo is lost.
                logger.exception("Reading the undo of %s failed", spec.wire_name)
        if spec.returns_data:
            result = apply_policy(env.data_policy, result)
        # exclude_none leaves out the typed models' fields that are None; null
        # values inside dict-shaped data (a STAC record, a feature's
        # properties) are kept, because there null is a value.
        payload: dict[str, Any] = result.model_dump(
            mode="json", by_alias=True, exclude_none=True
        )
        size = len(
            json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()
        )
        if size > MAX_RESULT_BYTES:
            raise ResultOverCap(size)
        if check_result is not None and (reason := check_result(size)) is not None:
            raise ToolFailed(reason)
        status, error = ("withheld" if isinstance(result, Withheld) else "ok"), None
        return payload
    except InputInvalid as exc:
        # Reaches the model (as a retry prompt) and MCP clients, and can quote a
        # service's answer: masked here, so no tool has to remember it.
        redacted = failures.redact(exc.message, env.secrets())
        status, error = "invalid", redacted
        if redacted != exc.message:
            raise InputInvalid(redacted) from exc
        raise
    except ToolFailed as exc:
        # The message reaches the model, the transcript and the run events, and
        # a service body can echo a token: masked here, for every path alike.
        redacted = failures.redact(exc.message, env.secrets())
        status, error = "error", redacted
        if redacted != exc.message:
            raise ToolFailed(redacted) from exc
        raise
    except asyncio.CancelledError:
        # The run was cancelled while the tool ran: recorded as such, not as ok.
        status, error = "error", "cancelled"
        raise
    except Exception as exc:
        # Never the bare traceback: a transport error chained from a tool's HTTP
        # call can quote the request, and with it the user's bearer token.
        logger.error(
            "Tool %s failed\n%s", spec.wire_name, failures.log_text(exc, env.secrets())
        )
        status, error = "error", "internal error"
        raise ToolFailed(
            "The tool failed unexpectedly. Try again or answer without it."
        ) from exc
    finally:
        await _audit(
            env,
            spec,
            raw_args,
            tool_call_id,
            size,
            started,
            status,
            error,
            created,
            undo,
        )


async def refuse(
    spec: ToolSpec[Any, Any],
    env: ToolEnv,
    raw_args: Mapping[str, Any],
    reason: str,
    *,
    tool_call_id: str | None = None,
    result_bytes: int = 0,
) -> NoReturn:
    """Refuses a call without running it (a run's limits,
    ``assistant.tools.toolset``): audited as a failed call whose error is
    ``reason``, which is also what the model reads. ``result_bytes``: the size
    of the result that was refused, when one was measured."""
    await _audit(
        env,
        spec,
        raw_args,
        tool_call_id,
        result_bytes,
        time.monotonic(),
        "error",
        reason,
        None,
        None,
    )
    raise ToolFailed(reason)


async def _audit(
    env: ToolEnv,
    spec: ToolSpec[Any, Any],
    raw_args: Mapping[str, Any],
    tool_call_id: str | None,
    size: int,
    started: float,
    status: str,
    error: str | None,
    created: dict[str, Any] | None,
    undo: dict[str, Any] | None,
) -> None:
    if env.repo is None:
        return
    try:
        # Shielded: a cancelled run still gets its audit row.
        await asyncio.shield(
            _insert(
                env,
                spec,
                raw_args,
                tool_call_id,
                size,
                started,
                status,
                error,
                created,
                undo,
            )
        )
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        # The audit must never take the answer down (a conversation deleted
        # mid-run removes the run row the audit row points to).
        logger.error(
            "Recording the call of %s failed\n%s",
            spec.wire_name,
            failures.log_text(exc, env.secrets()),
        )


async def _insert(
    env: ToolEnv,
    spec: ToolSpec[Any, Any],
    raw_args: Mapping[str, Any],
    tool_call_id: str | None,
    size: int,
    started: float,
    status: str,
    error: str | None,
    created: dict[str, Any] | None,
    undo: dict[str, Any] | None,
) -> None:
    assert env.repo is not None
    # Masked before the cut, so no prefix of a token is left at the end.
    text = failures.redact(error, env.secrets()) if error else None
    await env.repo.insert_tool_call(
        run_id=env.run_id,
        user_id=env.user_id,
        tool=spec.wire_name,
        tool_call_id=tool_call_id,
        args_summary=summarize_args(raw_args),
        result_bytes=size,
        duration_ms=int((time.monotonic() - started) * 1000),
        status=status,
        error=text[:_ERROR_CHARS] if text else None,
        created=created,
        undo=undo,
    )
