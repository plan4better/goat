import asyncio
import json
from collections.abc import AsyncGenerator
from typing import Any, Literal, get_args
from uuid import UUID

import anyio
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SecretStr,
    ValidationError,
    field_validator,
)
from starlette.types import Receive, Scope, Send

from assistant.asks import CardAnswer
from assistant.auth import Principal, get_principal
from assistant.bus import events_channel
from assistant.config import AssistantSettings
from assistant.context import parse_context, project_of
from assistant.encoding.ai_sdk import (
    SSE_DONE,
    UI_MESSAGE_STREAM_HEADERS,
    AiSdkEncoder,
    sse,
)
from assistant.events import (
    EVENT_ADAPTER,
    RunEnded,
    RunEvent,
    RunStatus,
    to_ui_message,
)
from assistant.llm.resolution import AssistantUnavailable
from assistant.login import LoginFailed, make_login
from assistant.repo import (
    ACTIVE,
    ConversationBoundElsewhere,
    ConversationBusy,
    ConversationNotFound,
    Repository,
    UserRunLimit,
)
from assistant.runs.manager import (
    SHUTTING_DOWN,
    InvalidAnswer,
    ShuttingDown,
    SurfaceDisabled,
)
from assistant.services import AppServices
from assistant.surfaces import Locale
from assistant.undo import NothingToUndo, UndoRefused, UndoUnderWay, undo_run, undone

router = APIRouter(prefix="/conversations")

#: Comment frames keep idle proxies from closing a quiet stream. Module-level so
#: a test can shorten it (``monkeypatch.setattr(conversations, "KEEPALIVE_SECONDS", 0.1)``).
KEEPALIVE_SECONDS: float = 15

_END_STATUSES = get_args(RunStatus)


#: Request size limits. They bound what is stored in the database and sent to the
#: model, so one request cannot make a run arbitrarily large or expensive.
MAX_MESSAGE_CHARS = 32768
MAX_TITLE_CHARS = 200
MAX_ORIGIN_SURFACE_CHARS = 200
MAX_CONTEXT_BYTES = 16384
MAX_SEARCH_CHARS = 200


def _refusal(status: int, code: str, message: str, **extra: Any) -> HTTPException:
    """An error the web app recognises by ``code`` and shows in the UI language;
    ``message`` is the English text for logs and other clients."""
    return HTTPException(
        status_code=status, detail={"code": code, "message": message, **extra}
    )


NOT_READABLE = "The project does not exist or you cannot open it."
BOUND_ELSEWHERE = "This conversation belongs to another project."


class ConversationCreate(BaseModel):
    origin_surface: str = Field(max_length=MAX_ORIGIN_SURFACE_CHARS)
    project_id: UUID | None = None
    title: str | None = Field(default=None, max_length=MAX_TITLE_CHARS)


class RunMessage(BaseModel):
    #: The browser's message id. Accepted for the AI SDK's request shape and
    #: never stored: the server assigns its own ids.
    id: str | None = Field(default=None, max_length=200)
    text: str = Field(max_length=MAX_MESSAGE_CHARS)
    #: The answer to a card of this conversation (assistant.asks); the text
    #: lists the same answers for the transcript.
    answer: CardAnswer | None = None


class ConversationUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    #: A new title; null or blank clears it, so the history shows the first message.
    title: str | None = Field(default=None, max_length=MAX_TITLE_CHARS)
    #: Binds an unbound conversation to a project ("Open in project to review", spec §10).
    project_id: UUID | None = None


class RunCreate(BaseModel):
    message: RunMessage
    #: The page's context (spec §6.3), validated per surface (assistant.context)
    #: in the route; capped in size here as before.
    context: dict[str, Any] | None = None
    #: The user's interface language (spec §4.8).
    locale: Locale = "en"
    #: Spec §6.5 fallback: the user's refresh token, so a detached run outlives
    #: the access token. Held in memory for the run only.
    refresh_token: SecretStr | None = None

    @field_validator("context")
    @classmethod
    def _context_fits(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        if value is not None:
            size = len(json.dumps(value, ensure_ascii=False).encode("utf-8"))
            if size > MAX_CONTEXT_BYTES:
                raise ValueError(
                    f"context is larger than {MAX_CONTEXT_BYTES} bytes when serialized"
                )
        return value


def _services(request: Request) -> AppServices:
    services: AppServices = request.app.state.services
    return services


async def _owned(
    request: Request, conversation_id: UUID, principal: Principal
) -> dict[str, Any]:
    conversation = await _services(request).repo.get_conversation(
        conversation_id, principal.user_id
    )
    if conversation is None:
        raise _refusal(404, "conversation_not_found", "Conversation not found")
    return dict(conversation)


async def _bind(
    repo: Repository, conversation: dict[str, Any], user_id: UUID, project_id: UUID
) -> None:
    """Spec §10: an unbound conversation becomes bound the first time it is used
    in a project, and a bound one never moves to another project."""
    current = conversation["project_id"]
    if current == project_id:
        return
    if current is not None:
        raise _refusal(
            409, "conversation_bound", BOUND_ELSEWHERE, project_id=str(current)
        )
    readable, _ = await repo.project_access(project_id, user_id)
    if not readable:
        raise _refusal(403, "project_not_readable", NOT_READABLE)
    bound = await repo.bind_project(conversation["id"], user_id, project_id)
    if bound is None:
        # Deleted by another request since the ownership check.
        raise _refusal(404, "conversation_not_found", "Conversation not found")
    if bound != project_id:
        raise _refusal(
            409, "conversation_bound", BOUND_ELSEWHERE, project_id=str(bound)
        )
    conversation["project_id"] = project_id


ACCESS_LOST = "This conversation used data from a project you no longer have access to."


async def _project_access(
    repo: Repository, conversation: dict[str, Any], user_id: UUID
) -> tuple[bool, str | None]:
    """Whether the user can still open the conversation's project, and its name
    when they can. An unbound conversation is always accessible."""
    if conversation["project_id"] is None:
        return True, None
    return await repo.project_access(conversation["project_id"], user_id)


async def _require_access(
    repo: Repository, conversation: dict[str, Any], user_id: UUID
) -> None:
    """Spec §10: a bound conversation is continued only while the user can open
    its project."""
    readable, _ = await _project_access(repo, conversation, user_id)
    if not readable:
        raise _refusal(403, "project_access_lost", ACCESS_LOST)


def _bound_elsewhere(project_id: UUID | None) -> HTTPException:
    return _refusal(
        409,
        "conversation_bound",
        BOUND_ELSEWHERE,
        project_id=str(project_id) if project_id is not None else None,
    )


async def _check_target(
    repo: Repository,
    conversation: dict[str, Any],
    user_id: UUID,
    page_project: UUID | None,
) -> UUID | None:
    """Spec §10 before a run: continue a bound conversation only inside its
    project and only while the user can open it. Returns the project the
    conversation must be in once the run is recorded (``start_run``'s
    ``target``): the bound one, the page's project to bind an unbound one to,
    or None for a run without a project. The binding itself happens in the
    run's own transaction, so a refused run leaves none behind."""
    bound: UUID | None = conversation["project_id"]
    if bound is None:
        if page_project is not None:
            readable, _ = await repo.project_access(page_project, user_id)
            if not readable:
                raise _refusal(403, "project_not_readable", NOT_READABLE)
        return page_project
    await _require_access(repo, conversation, user_id)
    if page_project != bound:
        raise _bound_elsewhere(bound)
    return bound


def _without_answers(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """What a user who lost access still sees (spec §10): their own words, not
    the answers, tool results or the page context of their messages."""
    return [
        {
            **message,
            "parts": [p for p in message["parts"] if p.get("type") == "user_text"],
        }
        for message in messages
        if message["role"] == "user"
    ]


async def _stream_run(
    services: AppServices, run_id: UUID, after: int
) -> AsyncGenerator[str, None]:
    """Replay stored events after ``after``, then follow live ones, encoded for the AI SDK.

    Subscribes before reading the database, so no event falls between replay and
    live. Duplicates are dropped by sequence number; a gap in the live sequence
    (pub/sub is at-most-once) is filled from the database before going on. Every
    keep-alive tick also reads the database, so a final event that never arrived
    live (a failed publish) still ends the stream, and so does a run whose rows
    were deleted by another replica.
    """
    encoder = AiSdkEncoder()
    last_seq = after

    def encode(seq: int, event: RunEvent) -> list[str]:
        nonlocal last_seq
        last_seq = max(last_seq, seq)
        frames = [sse(chunk) for chunk in encoder.encode(event)]
        if isinstance(event, RunEnded):
            frames.append(SSE_DONE)
        return frames

    async def catch_up(before: int | None = None) -> tuple[list[str], bool]:
        """Frames for stored events after ``last_seq`` (and below ``before``),
        and whether the run's end was among them."""
        frames: list[str] = []
        for seq, event in await services.repo.list_events(run_id, after_seq=last_seq):
            if before is not None and seq >= before:
                break
            frames.extend(encode(seq, event))
            if isinstance(event, RunEnded):
                return frames, True
        return frames, False

    async with services.bus.subscribe(events_channel(run_id)) as live:
        frames, ended = await catch_up()
        for frame in frames:
            yield frame
        if ended:
            return
        iterator = live.__aiter__()
        # The pending `__anext__` is kept across keep-alive timeouts. Cancelling
        # it (as `wait_for` would) throws into the async generator and ends it,
        # after which the subscription yields nothing more.
        pending: asyncio.Future[dict[str, Any]] = asyncio.ensure_future(
            iterator.__anext__()
        )
        #: Consecutive ticks that found the run finished without a stored end. The
        #: first may just be the gap between `finish_run` and the final event's
        #: write, so the stream only gives up on the second.
        finished_ticks = 0
        try:
            while True:
                done, _ = await asyncio.wait({pending}, timeout=KEEPALIVE_SECONDS)
                if not done:
                    yield ": keep-alive\n\n"
                    frames, ended = await catch_up()
                    for frame in frames:
                        yield frame
                    if ended:
                        return
                    run = await services.repo.get_run(run_id)
                    if run is None:
                        # Deleted with its conversation: nothing more will come.
                        for frame in encode(last_seq + 1, RunEnded(status="cancelled")):
                            yield frame
                        return
                    finished_ticks = (
                        finished_ticks + 1 if run["status"] not in ACTIVE else 0
                    )
                    if finished_ticks >= 2:
                        status = run["status"]
                        # The run table keeps no code; the folded message does.
                        code = await services.repo.end_code_of(
                            run["assistant_message_id"]
                        )
                        end = RunEnded(
                            status=status if status in _END_STATUSES else "interrupted",
                            error=run["error"],
                            code=code,
                        )
                        for frame in encode(last_seq + 1, end):
                            yield frame
                        return
                    continue
                message = pending.result()
                pending = asyncio.ensure_future(iterator.__anext__())
                seq = int(message["seq"])
                if seq <= last_seq:
                    continue
                if seq > last_seq + 1:
                    # Missed live messages: the database has them all.
                    frames, ended = await catch_up(before=seq)
                    for frame in frames:
                        yield frame
                    if ended:
                        return
                event = EVENT_ADAPTER.validate_python(message["event"])
                for frame in encode(seq, event):
                    yield frame
                if isinstance(event, RunEnded):
                    return
        finally:
            pending.cancel()


class _ClosingStreamingResponse(StreamingResponse):
    """Closes the body generator when the response ends, however it ends.

    A client that disconnects while the server is writing a frame leaves the
    generator suspended at its ``yield``; without an explicit close its cleanup
    (the bus subscription) would wait for garbage collection.
    """

    def __init__(self, body: AsyncGenerator[str, None], **kwargs: Any) -> None:
        super().__init__(body, **kwargs)
        self._body = body

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            # Shielded: under a level-triggered cancellation every await in the
            # cleanup would otherwise raise again.
            with anyio.CancelScope(shield=True):
                await self._body.aclose()


def _sse_response(body: AsyncGenerator[str, None]) -> StreamingResponse:
    return _ClosingStreamingResponse(body, headers=UI_MESSAGE_STREAM_HEADERS)


@router.post("", status_code=201)
async def create_conversation(
    body: ConversationCreate,
    request: Request,
    principal: Principal = Depends(get_principal),
) -> dict[str, Any]:
    repo = _services(request).repo
    if body.project_id is not None:
        readable, _ = await repo.project_access(body.project_id, principal.user_id)
        if not readable:
            raise _refusal(403, "project_not_readable", NOT_READABLE)
    row = await repo.create_conversation(
        principal.user_id, body.origin_surface, body.project_id, body.title
    )
    return dict(row)


@router.get("")
async def list_conversations(
    request: Request,
    project_id: UUID | None = None,
    q: str | None = Query(default=None, max_length=MAX_SEARCH_CHARS),
    limit: int = Query(default=50, ge=1, le=200),
    principal: Principal = Depends(get_principal),
) -> list[dict[str, Any]]:
    return await _services(request).repo.list_conversation_summaries(
        principal.user_id, project_id, q, limit
    )


@router.patch("/{conversation_id}")
async def update_conversation(
    conversation_id: UUID,
    body: ConversationUpdate,
    request: Request,
    principal: Principal = Depends(get_principal),
) -> dict[str, Any]:
    conversation = await _owned(request, conversation_id, principal)
    repo = _services(request).repo
    if "project_id" in body.model_fields_set and body.project_id is not None:
        await _bind(repo, conversation, principal.user_id, body.project_id)
    if "title" in body.model_fields_set:
        title = (body.title or "").strip() or None
        await repo.update_title(conversation_id, principal.user_id, title)
    summary = await repo.conversation_summary(conversation_id, principal.user_id)
    if summary is None:
        # Deleted by another request in between.
        raise _refusal(404, "conversation_not_found", "Conversation not found")
    return summary


@router.get("/{conversation_id}")
async def get_conversation(
    conversation_id: UUID,
    request: Request,
    principal: Principal = Depends(get_principal),
) -> dict[str, Any]:
    conversation = await _owned(request, conversation_id, principal)
    repo = _services(request).repo
    readable, project_name = await _project_access(
        repo, conversation, principal.user_id
    )
    access = "ok" if readable else "lost"
    active = await repo.active_run(conversation_id)
    exclude = active["assistant_message_id"] if active else None
    messages = await repo.list_messages(conversation_id, exclude_message_id=exclude)
    if access == "lost":
        messages = _without_answers(messages)
    # One rule with the Undo itself: every edit it takes went back.
    records = (
        await repo.undo_records_by_answer(conversation_id) if access == "ok" else {}
    )
    undone_answers = {answer for answer, rows in records.items() if undone(rows)}
    return {
        "conversation": conversation,
        "active_run_id": str(active["id"]) if active and access == "ok" else None,
        "access": access,
        "project_name": project_name,
        "messages": [
            to_ui_message(
                str(m["id"]),
                m["role"],
                m["parts"],
                m["created_at"],
                # The run of an answer, for the dock's Undo of its edits.
                run_id=(
                    str(m["run_id"])
                    if m["role"] == "assistant" and m["run_id"] is not None
                    else None
                ),
                undone=m["id"] in undone_answers,
            )
            for m in messages
        ],
        # The user's own ratings, by answer id, so the buttons show their state.
        "feedback": await repo.feedback_in(conversation_id, principal.user_id),
    }


class FeedbackIn(BaseModel):
    """A rating of one answer; ``rating`` null removes it."""

    model_config = ConfigDict(extra="forbid")

    rating: Literal["up", "down"] | None
    comment: str | None = Field(default=None, max_length=500)


@router.put("/{conversation_id}/messages/{message_id}/feedback")
async def put_feedback(
    conversation_id: UUID,
    message_id: UUID,
    body: FeedbackIn,
    request: Request,
    principal: Principal = Depends(get_principal),
) -> dict[str, Any]:
    conversation = await _owned(request, conversation_id, principal)
    repo = _services(request).repo
    if not await repo.is_answer(conversation_id, message_id):
        raise _refusal(404, "answer_not_found", "Answer not found")
    if body.rating is None:
        await repo.clear_feedback(message_id, principal.user_id)
        return {"rating": None, "comment": None}
    comment = (body.comment or "").strip() or None
    await repo.set_feedback(
        message_id,
        principal.user_id,
        conversation.get("organization_id"),
        body.rating,
        comment,
    )
    return {"rating": body.rating, "comment": comment}


@router.delete("/{conversation_id}", status_code=204)
async def delete_conversation(
    conversation_id: UUID,
    request: Request,
    principal: Principal = Depends(get_principal),
) -> Response:
    await _owned(request, conversation_id, principal)
    services = _services(request)
    active = await services.repo.active_run(conversation_id)
    if active is not None:
        # Let a local run record its end before its rows disappear; a run on
        # another replica is cancelled through the control channel and logs
        # (does not raise) if its bookkeeping finds the rows gone.
        await services.runs.cancel(active["id"])
        await services.runs.wait(active["id"])
    await services.repo.delete_conversation(conversation_id, principal.user_id)
    return Response(status_code=204)


def _surface_disabled(surface: str) -> HTTPException:
    return HTTPException(
        status_code=403,
        detail={
            "code": "surface_disabled",
            "surface": surface,
            "message": "The assistant is switched off on this page.",
        },
    )


def _ai_unavailable(exc: AssistantUnavailable) -> HTTPException:
    return HTTPException(
        status_code=403 if exc.reason in ("disabled", "no_organization") else 503,
        detail={
            "code": "ai_unavailable",
            "reason": exc.reason,
            "message": "AI is unavailable.",
        },
    )


@router.post("/{conversation_id}/runs")
async def start_run(
    conversation_id: UUID,
    body: RunCreate,
    request: Request,
    principal: Principal = Depends(get_principal),
) -> StreamingResponse:
    conversation = await _owned(request, conversation_id, principal)
    try:
        page = parse_context(body.context)
    except ValidationError as exc:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "invalid_context",
                # Without the input: the page's values are not echoed back.
                "errors": exc.errors(
                    include_url=False, include_input=False, include_context=False
                ),
            },
        ) from exc
    services = _services(request)
    settings: AssistantSettings = request.app.state.settings
    # Before the login: a switched-off page must not cost a token request.
    # (The manager checks again, for callers other than this route.)
    if page.surface in settings.disabled_surfaces:
        raise _surface_disabled(page.surface)
    # Also before the login: an organization without AI is told so (never a
    # 401), and no token is exchanged for a run that cannot happen.
    try:
        resolution = await services.runs.resolver.resolve(principal.user_id)
    except AssistantUnavailable as exc:
        raise _ai_unavailable(exc) from exc
    # A database read, also before the login: a refused binding costs no token
    # exchange. Nothing is stored yet; begin_run binds or verifies the project
    # again in the run's transaction, for a binding made in between.
    target = await _check_target(
        services.repo, conversation, principal.user_id, project_of(page)
    )
    refresh = body.refresh_token.get_secret_value() if body.refresh_token else None
    try:
        login = await make_login(
            settings,
            principal,
            refresh,
            services.tools.keycloak if services.tools else None,
        )
    except LoginFailed as exc:
        raise HTTPException(
            status_code=401,
            detail={
                "code": "login_failed",
                "message": "Your sign-in could not be prepared for this answer. Sign in again.",
            },
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
    try:
        run_id, _ = await services.runs.start_run(
            conversation_id,
            principal.user_id,
            body.message.text,
            page,
            locale=body.locale,
            login=login,
            resolution=resolution,
            target=target,
            answer=body.message.answer,
        )
    except InvalidAnswer as exc:
        raise _refusal(422, "invalid_answer", str(exc)) from exc
    except ConversationBoundElsewhere as exc:
        raise _bound_elsewhere(exc.project_id) from exc
    except SurfaceDisabled as exc:
        raise _surface_disabled(exc.surface) from exc
    except ConversationBusy as exc:
        raise _refusal(
            409, "conversation_busy", "This conversation already has a running answer."
        ) from exc
    except UserRunLimit as exc:
        raise _refusal(
            429, "user_run_limit", "Too many answers are running at once."
        ) from exc
    except ConversationNotFound as exc:
        # Deleted between the ownership check and the run being recorded.
        raise _refusal(404, "conversation_not_found", "Conversation not found") from exc
    except ShuttingDown as exc:
        raise _refusal(503, "shutting_down", SHUTTING_DOWN) from exc
    except AssistantUnavailable as exc:
        raise _ai_unavailable(exc) from exc
    return _sse_response(_stream_run(services, run_id, after=0))


@router.get("/{conversation_id}/stream", response_model=None)
async def resume_stream(
    conversation_id: UUID,
    request: Request,
    after: int = Query(default=0, ge=0),
    run_id: UUID | None = None,
    principal: Principal = Depends(get_principal),
) -> StreamingResponse | Response:
    """Replay and follow a run. Without ``run_id``: the conversation's active run,
    or 204. With it: that run, finished or not, so a client that saw it running
    in ``GET /conversations/{id}`` still gets its answer if it ends in between."""
    conversation = await _owned(request, conversation_id, principal)
    repo = _services(request).repo
    await _require_access(repo, conversation, principal.user_id)
    if run_id is None:
        active = await repo.active_run(conversation_id)
        if active is None:
            return Response(status_code=204)
        run_id = active["id"]
    else:
        run = await repo.get_run(run_id)
        if run is None or run["conversation_id"] != conversation_id:
            raise _refusal(404, "run_not_found", "Run not found")
    return _sse_response(_stream_run(_services(request), run_id, after=after))


@router.post("/{conversation_id}/cancel")
async def cancel_run(
    conversation_id: UUID,
    request: Request,
    principal: Principal = Depends(get_principal),
) -> Response:
    await _owned(request, conversation_id, principal)
    services = _services(request)
    active = await services.repo.active_run(conversation_id)
    if active is None:
        return Response(status_code=204)
    await services.runs.cancel(active["id"])
    return Response(status_code=202)


class UndoIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    #: Saves on top of what the workflows hold now, after the user was asked
    #: about the changes made since the answer's edits.
    force: bool = False


CHANGED_SINCE = "The workflow was changed after this answer edited it."


@router.post("/{conversation_id}/runs/{run_id}/undo")
async def undo_answer(
    conversation_id: UUID,
    run_id: UUID,
    request: Request,
    body: UndoIn | None = None,
    principal: Principal = Depends(get_principal),
) -> dict[str, Any]:
    """Writes back what an answer's workflow edits replaced (``assistant.undo``),
    with the user's own sign-in. A workflow saved since the answer's edits is
    not written: the answer (409 ``changed_since``) names it, and ``force``
    saves on top of it."""
    conversation = await _owned(request, conversation_id, principal)
    services = _services(request)
    await _require_access(services.repo, conversation, principal.user_id)
    run = await services.repo.get_run(run_id)
    if run is None or run["conversation_id"] != conversation_id:
        raise _refusal(404, "run_not_found", "Run not found")
    if run["status"] in ACTIVE:
        raise _refusal(409, "run_active", "The answer is still running.")
    if services.tools is None:
        raise _refusal(503, "undo_unavailable", "Undo is not available here.")
    try:
        outcome = await undo_run(
            services.repo,
            services.tools,
            principal.token,
            run_id,
            force=body.force if body is not None else False,
        )
    except NothingToUndo as exc:
        if exc.undone:
            raise _refusal(
                409, "already_undone", "This answer's changes were undone already."
            ) from exc
        raise _refusal(404, "nothing_to_undo", "This answer changed nothing.") from exc
    except UndoUnderWay as exc:
        raise _refusal(
            409, "undo_in_progress", "This answer's changes are being undone right now."
        ) from exc
    except UndoRefused as exc:
        raise _refusal(exc.status, exc.code, exc.message) from exc
    restored = [
        {
            "workflow_id": item.workflow_id,
            "project_id": item.project_id,
            "revision": item.revision,
        }
        for item in outcome.restored
    ]
    if outcome.changed:
        raise _refusal(
            409,
            "changed_since",
            CHANGED_SINCE,
            workflows=[
                {
                    "workflow_id": item.workflow_id,
                    "project_id": item.project_id,
                    "revision": item.revision,
                    "updated_at": item.updated_at,
                    "updated_by": item.updated_by,
                    "between": item.between,
                }
                for item in outcome.changed
            ],
            undone=restored,
        )
    return {"workflows": restored}
