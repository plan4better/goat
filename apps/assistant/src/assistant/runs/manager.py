"""Detached agent runs (spec §6.1).

A run is an asyncio task in the replica that accepted it. Every event is
written to ``run_event`` (durable) and published on the bus (live). The task
holds a lease; a replica that dies stops renewing it, and any replica's sweeper
then ends the run as ``interrupted``. Cancel goes to the owning replica through
the control channel when the run is not local.

A run ends exactly once: ``Repository.finish_run`` is a compare-and-set, and
only the caller that won it emits the final ``RunEnded``.
"""

import asyncio
import logging
from collections.abc import AsyncIterator, Callable, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID

import asyncpg
from pydantic import ValidationError
from pydantic_ai import Agent
from pydantic_ai.exceptions import UsageLimitExceeded
from pydantic_ai.messages import (
    AgentStreamEvent,
    ModelMessage,
    ModelMessagesTypeAdapter,
    ModelRequest,
    ModelResponse,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.models import Model
from pydantic_ai.usage import RunUsage
from pydantic_core import to_jsonable_python

from assistant.agent import PartIds, RunDeps, build_agent
from assistant.asks import AskHistory, CardAnswer, answer_lines, answer_problem
from assistant.budget import RunBudget
from assistant.bus import CONTROL_CHANNEL, EventBus, events_channel
from assistant.clock import AnswerClock
from assistant.config import AssistantSettings
from assistant.context import NO_PAGE, PageContext, dump_context, parse_context
from assistant.events import (
    EVENT_ADAPTER,
    RunEnded,
    RunErrorCode,
    RunEvent,
    RunStarted,
    RunStatus,
    ToolCalled,
    ToolReturned,
    UsageReported,
    fold_parts,
)
from assistant.history import SHOWN_TOOLS
from assistant.llm.endpoints import EndpointPolicy
from assistant.llm.failures import (
    ProviderFailure,
    admin_message,
    classify_failure,
    failure_code,
    log_text,
    redact,
    secrets_of,
    user_message,
)
from assistant.llm.providers import ModelOpener, OpenModels, Target, open_models
from assistant.llm.resolution import ModelResolver, Resolution
from assistant.login import Login, StaticLogin
from assistant.org_repo import OrgSettingsRepository
from assistant.prompt import render_note, with_note
from assistant.repo import ACTIVE, Repository
from assistant.runs.titles import generate_title
from assistant.runs.translate import EventTranslator
from assistant.runs.turn import run_turn
from assistant.surfaces import Locale, Surface
from assistant.tools.http import ServiceClients
from assistant.tools.runtime import ToolEnv, client_secrets
from assistant.tools.toolset import earlier_writes
from assistant.workflows.runs import ConversationRuns

logger = logging.getLogger(__name__)

AgentFactory = Callable[[Model], Agent[RunDeps, str]]

#: Shown in the conversation when GOAT AI answers instead of the organization's
#: provider (spec §4.6: fallback only when the admin enabled it, never silent).
FALLBACK_CAVEAT = (
    "Your organization's AI provider is unavailable. This answer uses GOAT AI, "
    "so this request was processed by GOAT AI's model provider."
)

#: A title is a nicety; a slow model must not hold the task open.
TITLE_TIMEOUT_SECONDS = 30.0

SHUTTING_DOWN = "The assistant is shutting down."


class ShuttingDown(RuntimeError):  # noqa: N818
    """Raised by ``start_run`` once ``stop()`` has begun."""

    def __init__(self) -> None:
        super().__init__(SHUTTING_DOWN)


class SurfaceDisabled(Exception):  # noqa: N818
    """The page's surface is switched off (``ASSISTANT_DISABLED_SURFACES``)."""

    def __init__(self, surface: Surface) -> None:
        super().__init__(surface)
        self.surface = surface


class InvalidAnswer(ValueError):  # noqa: N818
    """The answer does not fit a card of the conversation; nothing is stored."""


def _answered(asks: AskHistory, answer: CardAnswer) -> tuple[AskHistory, str]:
    """The conversation's cards and answers with ``answer`` added, and the
    answer as the model reads it. Raises ``InvalidAnswer``."""
    card = asks.cards.get(answer.card_id)
    if card is None:
        raise InvalidAnswer("There is no such card in this conversation.")
    if answer.card_id in asks.answers:
        raise InvalidAnswer("This card was answered already.")
    problem = answer_problem(card, answer)
    if problem is not None:
        raise InvalidAnswer(f"The answer does not fit the card: {problem}.")
    return asks.with_answer(answer), answer_lines(card, answer)


@dataclass(frozen=True)
class RunSetup:
    """What a run takes from its request besides the text. Held by the run's
    task only, and only until the run's end is recorded; the login never goes
    further (spec §6.5)."""

    page: PageContext
    locale: Locale
    note: str
    login: Login = field(repr=False)
    #: The user's answer to a card, as the model reads it; empty without one.
    answer: str = ""
    #: The conversation's cards and answers, this message's included.
    asks: AskHistory = field(default_factory=AskHistory)
    #: The first result of each write call in this conversation, by call key
    #: (assistant.tools.toolset.earlier_writes).
    earlier_writes: Mapping[str, dict[str, Any]] = field(default_factory=dict)
    #: What the conversation created and ran (assistant.workflows.runs).
    runs: ConversationRuns = field(default_factory=ConversationRuns)

    @classmethod
    def default(cls) -> "RunSetup":
        return cls(NO_PAGE, "en", render_note(NO_PAGE, None, "en"), StaticLogin(None))


async def _emit_nothing(event: RunEvent) -> None:
    """A finished run's deps emit here: the run's emitter is not kept."""


def _stored_context(raw: dict[str, Any] | None) -> PageContext | None:
    """The previous message's context; one stored by an older shape is ignored."""
    if raw is None:
        return None
    try:
        return parse_context(raw)
    except ValidationError:
        return None


class ProviderFailed(Exception):  # noqa: N818
    """The provider of the run's last target failed; carries what to report."""

    def __init__(self, failure: ProviderFailure, target: Target) -> None:
        super().__init__(failure.kind)
        self.failure = failure
        self.target = target


#: Pause before the control listener resubscribes after its subscription broke.
CONTROL_RESUBSCRIBE_DELAY = 1.0

#: Attempts to record the sweeper's final event when a live owner keeps taking
#: the sequence number the sweeper just read.
SWEEP_EMIT_ATTEMPTS = 3


class _Emitter:
    """Assigns sequence numbers and writes each event to the database and the bus.

    Pydantic AI runs tool functions on their own task, so a tool's ``emit_data``
    and the consumer loop's translated events arrive concurrently. The lock
    makes "take the next seq, insert, publish" one step, so sequence numbers
    reach the database and the bus in order and a subscriber never drops an
    event because a higher seq overtook it.
    """

    def __init__(
        self, repo: Repository, bus: EventBus, run_id: UUID, first_seq: int = 1
    ) -> None:
        self._repo = repo
        self._bus = bus
        self._run_id = run_id
        self._seq = first_seq - 1
        self._lock = asyncio.Lock()
        self.events: list[RunEvent] = []

    async def __call__(self, event: RunEvent) -> None:
        # The sequence number and the in-memory list advance only once the row is
        # stored: an insert that is cancelled or fails neither folds an unstored
        # event into the message nor leaves a gap in the numbering.
        async with self._lock:
            seq = self._seq + 1
            try:
                await self._repo.append_event(self._run_id, seq, event)
            except asyncpg.UniqueViolationError:
                # Another writer (the sweeper) holds this number. Skip it so the
                # next event does not collide again.
                self._seq = seq
                raise
            self._seq = seq
            self.events.append(event)
            await self._bus.publish(
                events_channel(self._run_id),
                {
                    "seq": seq,
                    "event": EVENT_ADAPTER.dump_python(event, mode="json"),
                },
            )


def _assistant_text(events: list[RunEvent]) -> str:
    """The answer text recorded so far, folded from the run's events."""
    return "".join(
        str(part["text"]) for part in fold_parts(events) if part.get("type") == "text"
    )


def usage_event(provider: str, model: str, usage: RunUsage) -> UsageReported:
    return UsageReported(
        provider=provider,
        model=model,
        input_tokens=usage.input_tokens,
        output_tokens=usage.output_tokens,
        cache_read_tokens=usage.cache_read_tokens,
        cache_write_tokens=usage.cache_write_tokens,
    )


def _partial_history(text: str, events: list[RunEvent]) -> list[dict[str, Any]]:
    """Model history for a turn that did not succeed: the user's prompt, the
    finished calls whose results the user was shown (a card, a created
    workflow), and whatever answer text was streamed, so the next turn still
    sees the exchange: an answer to the card, a workflow not to create twice."""
    messages: list[ModelRequest | ModelResponse] = [
        ModelRequest(parts=[UserPromptPart(content=text)])
    ]
    shown = {
        event.tool_call_id: event
        for event in events
        if isinstance(event, ToolCalled) and event.tool_name in SHOWN_TOOLS
    }
    for event in events:
        if isinstance(event, ToolReturned) and event.tool_call_id in shown:
            call = shown[event.tool_call_id]
            messages.append(
                ModelResponse(
                    parts=[
                        ToolCallPart(
                            tool_name=call.tool_name,
                            args=call.args,
                            tool_call_id=call.tool_call_id,
                        )
                    ]
                )
            )
            messages.append(
                ModelRequest(
                    parts=[
                        ToolReturnPart(
                            tool_name=call.tool_name,
                            content=event.output,
                            tool_call_id=call.tool_call_id,
                        )
                    ]
                )
            )
    answer = _assistant_text(events)
    if answer:
        messages.append(ModelResponse(parts=[TextPart(content=answer)]))
    history: list[dict[str, Any]] = to_jsonable_python(messages)
    return history


class RunManager:
    def __init__(
        self,
        repo: Repository,
        bus: EventBus,
        settings: AssistantSettings,
        owner: str,
        agent_factory: AgentFactory = build_agent,
        resolver: ModelResolver | None = None,
        opener: ModelOpener | None = None,
        tool_services: ServiceClients | None = None,
    ) -> None:
        self.repo = repo
        self.bus = bus
        self.settings = settings
        self.owner = owner
        self.agent_factory = agent_factory
        self.resolver = resolver or ModelResolver(
            OrgSettingsRepository(repo.db), settings
        )
        self.policy = EndpointPolicy.from_settings(settings)
        #: Builds the models of a target; tests replace it to avoid any network.
        self.opener: ModelOpener = opener or self._open_models
        #: The clients tools call; None runs offer no GOAT tools (the run
        #: machinery's own tests). The app always passes them.
        self.tool_services = tool_services
        self._tasks: dict[UUID, asyncio.Task[None]] = {}
        #: Runs whose agent part is over and whose end is being recorded. Cancelling
        #: them again would abort the bookkeeping, so cancel requests skip them.
        self._ending: set[UUID] = set()
        #: Runs whose lease was lost (ended elsewhere) and that are cancelled
        #: here for it: like a shutdown, not the user's Stop, so a workflow
        #: run they started goes on (``ToolEnv.stopping``).
        self._lost: set[UUID] = set()
        self._background: list[asyncio.Task[None]] = []
        self._stopping = False

    # -- lifecycle -----------------------------------------------------------

    async def start(self) -> None:
        listening = asyncio.Event()
        listener = asyncio.create_task(self._listen_control(listening))
        ready = asyncio.create_task(listening.wait())
        self._background.append(listener)
        # A listener that dies before it subscribes must not leave start() hanging.
        await asyncio.wait({listener, ready}, return_when=asyncio.FIRST_COMPLETED)
        if listener.done():
            ready.cancel()
            listener.result()
        self._background.append(asyncio.create_task(self._sweep_forever()))

    async def stop(self) -> None:
        self._stopping = True
        for task in self._background:
            task.cancel()
        tasks = list(self._tasks.values())
        for run_id in list(self._tasks):
            self._cancel_local(run_id)
        pending = [*self._background, *tasks]
        if pending:
            # asyncio.wait, not gather: when stop() itself is cancelled, gather
            # would cancel the run tasks again and abort their bookkeeping.
            done, _ = await asyncio.wait(pending)
            for task in done:
                if not task.cancelled():
                    task.exception()  # mark retrieved; failures were logged by the task

    # -- runs ----------------------------------------------------------------

    async def start_run(
        self,
        conversation_id: UUID,
        user_id: UUID,
        text: str,
        context: PageContext | None,
        *,
        locale: Locale = "en",
        login: Login | None = None,
        resolution: Resolution | None = None,
        target: UUID | None = None,
        answer: CardAnswer | None = None,
    ) -> tuple[UUID, UUID]:
        """``resolution``: the user's model, when the caller resolved it already
        (the run route does, before it prepares the login). ``target``: the
        project the conversation must be in once the run is recorded, bound then
        if it is unbound (``Repository.begin_run``; raises
        ``ConversationBoundElsewhere``). ``answer``: the user's answer to a card
        of this conversation; checked against the card before anything is
        stored (raises ``InvalidAnswer``)."""
        if self._stopping:
            raise ShuttingDown()
        page = context or NO_PAGE
        # Refused before anything is stored, like an unavailable model below.
        if page.surface in self.settings.disabled_surfaces:
            raise SurfaceDisabled(page.surface)
        # Resolved before anything is stored: a refused run (AI disabled, no
        # connection) leaves no trace in the conversation. Raises
        # AssistantUnavailable.
        if resolution is None:
            resolution = await self.resolver.resolve(user_id)
        previous = _stored_context(await self.repo.last_user_context(conversation_id))
        # The conversation's cards and answers: an answer is checked against its
        # card before anything is stored, and tools read them for the user's
        # consent (assistant.asks.user_chose).
        stored = await self.repo.list_messages(conversation_id, exclude_message_id=None)
        asks = AskHistory.from_stored(stored)
        answer_text = ""
        if answer is not None:
            asks, answer_text = _answered(asks, answer)
        else:
            asks = asks.with_typed_message()
        setup = RunSetup(
            page=page,
            locale=locale,
            note=render_note(page, previous, locale, text),
            login=login or StaticLogin(None),
            answer=answer_text,
            asks=asks,
            earlier_writes=earlier_writes(stored),
            runs=ConversationRuns.from_stored(stored),
        )
        user_parts: list[dict[str, Any]] = [{"type": "user_text", "text": text}]
        # A home page with @ mentioned sources still has context worth showing.
        if page.surface != "none" or page.sources:
            user_parts.append({"type": "context", "context": dump_context(page)})
        if answer is not None:
            user_parts.append(
                {"type": "answer", "answer": answer.model_dump(mode="json")}
            )
        run_id, message_id = await self.repo.begin_run(
            conversation_id,
            user_id,
            user_parts,
            resolution.main.provider,
            resolution.main.model,
            self.settings.user_max_concurrent_runs,
            target=target,
        )
        if self._stopping:  # stop() began while the run was being recorded
            await self._end_unstarted(run_id, text)
            raise ShuttingDown()
        started = asyncio.Event()
        task = asyncio.create_task(
            self._execute(
                run_id,
                conversation_id,
                message_id,
                user_id,
                text,
                resolution,
                started,
                setup=setup,
            )
        )
        self._tasks[run_id] = task
        task.add_done_callback(lambda _: self._tasks.pop(run_id, None))
        # A task cancelled before its first step never runs its handlers, which
        # would leave the run queued; once started, a cancel always reaches them.
        # Waiting on the task as well keeps start_run from hanging in that case.
        waiter = asyncio.create_task(started.wait())
        try:
            await asyncio.wait({task, waiter}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            waiter.cancel()
        if not started.is_set():
            await self._end_unstarted(run_id, text)
            raise ShuttingDown()
        return run_id, message_id

    async def _end_unstarted(self, run_id: UUID, text: str) -> None:
        """End a run that was recorded but never began executing. Its question
        stays in the model history, as for a cancelled run."""
        ended = RunEnded(status="interrupted")
        if await self.repo.finish_run(
            run_id,
            "interrupted",
            None,
            fold_parts([ended]),
            _partial_history(text, []),
        ):
            await _Emitter(self.repo, self.bus, run_id)(ended)

    def _cancel_local(self, run_id: UUID) -> bool:
        """Cancel a run owned by this replica. False when it is not local."""
        task = self._tasks.get(run_id)
        if task is None:
            return False
        if run_id not in self._ending:
            task.cancel()
        return True

    async def cancel(self, run_id: UUID) -> None:
        if self._cancel_local(run_id):
            return
        await self.bus.publish(
            CONTROL_CHANNEL, {"action": "cancel", "run_id": str(run_id)}
        )

    async def wait(self, run_id: UUID) -> None:
        task = self._tasks.get(run_id)
        if task is not None:
            # asyncio.wait never raises the task's outcome, and a cancellation of
            # the caller still propagates.
            await asyncio.wait({task})

    async def _execute(
        self,
        run_id: UUID,
        conversation_id: UUID,
        message_id: UUID,
        user_id: UUID,
        text: str,
        resolution: Resolution,
        started: asyncio.Event | None = None,
        *,
        setup: RunSetup | None = None,
    ) -> None:
        if started is not None:
            started.set()
        setup = setup or RunSetup.default()
        emit = _Emitter(self.repo, self.bus, run_id)
        part_ids = PartIds(str(message_id))
        status: RunStatus = "succeeded"
        error: str | None = None
        code: RunErrorCode | None = None
        model_messages: list[dict[str, Any]] = []
        #: The target of the latest attempt, whose usage is recorded, and the
        #: one that completed the answer.
        attempted = resolution.main
        served: Target | None = None
        run_usage = RunUsage()
        heartbeat: asyncio.Task[None] | None = None
        deadline: asyncio.Timeout | None = None
        deps: RunDeps | None = None
        try:
            if not await self.repo.mark_running(
                run_id, self.owner, self._lease_until()
            ):
                # The sweeper already ended this stale queued run and stored its
                # history: nothing to do.
                logger.info("Run %s is no longer queued; not starting it", run_id)
                return
            heartbeat = asyncio.create_task(self._heartbeat(run_id))
            await emit(RunStarted(message_id=str(message_id), run_id=str(run_id)))
            history = ModelMessagesTypeAdapter.validate_python(
                await self.repo.history(conversation_id)
            )
            deps = RunDeps(
                message_id=str(message_id),
                emit=emit,
                part_ids=part_ids,
                data_policy=resolution.data_policy,
                prompt_note=setup.note,
                prompt_answer=setup.answer,
                budget=self._budget(),
            )
            # A write repeated in this answer returns its first result, as in
            # the answer that made it (assistant.tools.toolset).
            deps.earlier_results.update(setup.earlier_writes)
            clock = AnswerClock(self.settings.run_wait_max_seconds)
            if self.tool_services is not None:
                deps.env = ToolEnv(
                    services=self.tool_services,
                    login=setup.login,
                    user_id=user_id,
                    data_policy=resolution.data_policy,
                    page=setup.page,
                    locale=setup.locale,
                    run_id=run_id,
                    emit_data=deps.emit_data,
                    repo=self.repo,
                    extra_secrets=client_secrets(self.settings),
                    asks=setup.asks,
                    clock=clock,
                    runs=setup.runs,
                    stopping=lambda: self._stopping or run_id in self._lost,
                )
            targets = [resolution.main]
            if resolution.fallback is not None:
                targets.append(resolution.fallback)
            async with asyncio.timeout(self.settings.run_max_seconds) as deadline:
                clock.timeout = deadline
                for index, target in enumerate(targets):
                    attempted = target
                    # Usage is per attempt: only the last attempt's is recorded,
                    # one row per run and purpose (spec §11).
                    run_usage = RunUsage()
                    emitted = len(emit.events)
                    try:
                        model_messages = await self._run_agent(
                            target, text, history, deps, part_ids, emit, run_usage
                        )
                    except Exception as exc:
                        # Not kept in a local: the token values must not outlive
                        # the login (dropped below).
                        failure = classify_failure(
                            exc,
                            self._secrets(target, setup.login),
                            vertex=target.provider == "vertex",
                        )
                        if failure is None:
                            raise
                        await self._note_failure(
                            run_id,
                            resolution.organization_id,
                            target,
                            failure,
                            self._secrets(target, setup.login),
                        )
                        if len(emit.events) == emitted and index + 1 < len(targets):
                            # Nothing of this attempt reached anyone yet and the
                            # admin enabled the fallback: switch, and say so.
                            fallback = targets[index + 1]
                            await self.repo.set_run_model(
                                run_id, fallback.provider, fallback.model
                            )
                            await deps.emit_data(
                                "caveat", {"kind": "fallback", "text": FALLBACK_CAVEAT}
                            )
                            continue
                        raise ProviderFailed(failure, target) from exc
                    served = target
                    break
        except asyncio.CancelledError:
            status = "interrupted" if self._stopping else "cancelled"
            # The cancellation is handled here; clear it so the bookkeeping below
            # (and any timeout machinery) does not see a pending cancel request.
            current = asyncio.current_task()
            if current is not None:
                current.uncancel()
        except TimeoutError as exc:
            if deadline is not None and deadline.expired():
                status, error, code = (
                    "failed",
                    "The run took longer than allowed.",
                    "run_timeout",
                )
            else:
                # Not the run's deadline: raised inside an attempt, possibly by
                # the provider's SDK, so logged with the credentials masked.
                logger.error(
                    "Run %s failed with a timeout\n%s",
                    run_id,
                    log_text(exc, self._secrets(attempted, setup.login)),
                )
                status, error, code = (
                    "failed",
                    "The assistant failed unexpectedly.",
                    "internal_error",
                )
        except UsageLimitExceeded as exc:
            status, error, code = (
                "failed",
                f"The run hit a limit: {exc}",
                "run_limit",
            )
        except ProviderFailed as exc:
            # Logged by _note_failure; members get a neutral sentence (spec §4.6).
            status, error, code = (
                "failed",
                user_message(exc.failure, own=exc.target.own),
                failure_code(exc.failure, own=exc.target.own),
            )
        except Exception as exc:
            # Anything else may still come from the provider's SDK: its text and
            # traceback are logged with the credentials masked.
            logger.error(
                "Run %s failed\n%s",
                run_id,
                log_text(exc, self._secrets(attempted, setup.login)),
            )
            status, error, code = (
                "failed",
                "The assistant failed unexpectedly.",
                "internal_error",
            )
        finally:
            if heartbeat is not None:
                heartbeat.cancel()
            self._lost.discard(run_id)
            # The agent part is over on every path. The login, and the refresh
            # token in it, lives for the run only (spec §6.5): this task drops
            # its references here, before the bookkeeping and the title. The
            # deps themselves can outlive the task: Pydantic AI keeps the run
            # context in a context variable, and a callback scheduled during
            # the run (asyncpg's statement-cache timers) holds a copy of that
            # context. So the tool environment is detached from them, too.
            if deps is not None:
                deps.env = None
                # And the emitter, which holds every event of the run.
                deps.emit = _emit_nothing
            deps = None
            setup = None
        # Outside the task's cancellation scope: the bookkeeping must complete.
        # It can still fail legitimately (the conversation was deleted while the
        # run was ending, so the rows are gone); that is logged, never raised.
        won = False
        self._ending.add(run_id)
        try:
            await self._record_usage(
                run_id,
                user_id,
                resolution.organization_id,
                attempted,
                run_usage,
                emit,
            )
            if status != "succeeded":
                model_messages = _partial_history(text, emit.events)
            ended = RunEnded(status=status, error=error, code=code)
            won = await self.repo.finish_run(
                run_id, status, error, fold_parts([*emit.events, ended]), model_messages
            )
            if won:
                await emit(ended)
            else:
                logger.info("Run %s was already ended by another party", run_id)
        except Exception:
            logger.exception("Run %s: recording the end of the run failed", run_id)
        finally:
            self._ending.discard(run_id)
        # Only the replica that recorded the end names the conversation: a run
        # that was swept or ended elsewhere meanwhile is not this task's to finish.
        if won and status == "succeeded" and served is not None:
            await self._write_title(
                run_id, conversation_id, user_id, resolution, served, text
            )

    def _budget(self) -> RunBudget:
        """The run's limits: the budget that ends an answer early and the hard
        limits, which count tokens the same way (assistant.budget)."""
        return RunBudget(
            max_tokens=self.settings.run_max_tokens,
            max_tool_calls=self.settings.run_max_tool_calls,
        )

    def _secrets(self, target: Target, login: Login) -> list[str]:
        """Everything to mask in what a run attempt logs or stores: the
        provider's credentials, the user's tokens and the Keycloak client
        secrets."""
        return [
            *secrets_of(target),
            *login.secrets(),
            *client_secrets(self.settings),
        ]

    def _open_models(self, target: Target) -> OpenModels:
        return open_models(target, self.policy)

    @asynccontextmanager
    async def _models(self, target: Target) -> AsyncIterator[OpenModels]:
        """The models of ``target``, closed afterwards. Opened on the event-loop
        thread, as ``open_models`` requires."""
        models = self.opener(target)
        try:
            yield models
        finally:
            await models.aclose()

    async def _run_agent(
        self,
        target: Target,
        text: str,
        history: list[ModelMessage],
        deps: RunDeps,
        part_ids: PartIds,
        emit: _Emitter,
        usage: RunUsage,
    ) -> list[dict[str, Any]]:
        """One attempt on one target. ``usage`` is the caller's, so tokens of an
        attempt that is cancelled or fails are still counted."""
        async with self._models(target) as models:
            agent = self.agent_factory(models.main)
            translator = EventTranslator(part_ids)
            limits = self._budget().usage_limits()

            async def on_event(event: AgentStreamEvent) -> None:
                for translated in translator.translate(event):
                    await emit(translated)

            turn = await run_turn(
                agent,
                with_note(deps.prompt_note, text, deps.prompt_answer),
                deps=deps,
                on_event=on_event,
                message_history=history,
                usage_limits=limits,
                usage=usage,
            )
            model_messages: list[dict[str, Any]] = to_jsonable_python(turn.messages)
            return model_messages

    async def _note_failure(
        self,
        run_id: UUID,
        organization_id: UUID,
        target: Target,
        failure: ProviderFailure,
        secrets: list[str],
    ) -> None:
        # An error body may echo the key back; neither the log nor the admin page shows it.
        message = redact(admin_message(failure), secrets)
        logger.warning(
            "Run %s: %s model %s failed: %s",
            run_id,
            target.provider,
            target.model,
            message,
        )
        if failure.kind == "rejected" and target.connection_id is not None:
            # The admin page shows this as a banner (spec §4.6).
            try:
                await self.resolver.org_repo.mark_connection_failed(
                    organization_id, target.connection_id, message
                )
            except Exception:
                logger.exception(
                    "Run %s: marking connection %s failed",
                    run_id,
                    target.connection_id,
                )

    async def _write_title(
        self,
        run_id: UUID,
        conversation_id: UUID,
        user_id: UUID,
        resolution: Resolution,
        target: Target,
        text: str,
    ) -> None:
        """Name a new conversation with the model of the connection that
        answered (spec §4.5). Best effort: a failure is logged and the
        conversation stays untitled. What the model consumed is recorded even
        when the title fails after the model answered."""
        try:
            conversation = await self.repo.get_conversation(conversation_id, user_id)
        except Exception:
            logger.exception("Run %s: reading the conversation failed", run_id)
            return
        if conversation is None or conversation["title"]:
            return
        usage = RunUsage()
        title: str | None = None
        try:
            async with self._models(target) as models:
                title, _ = await asyncio.wait_for(
                    generate_title(models.main, text, usage=usage),
                    TITLE_TIMEOUT_SECONDS,
                )
        except TimeoutError as exc:
            # A slow title is expected now and then and costs nothing.
            logger.warning(
                "Run %s: writing the conversation title timed out: %s",
                run_id,
                log_text(exc, secrets_of(target)),
            )
        except Exception as exc:
            logger.error(
                "Run %s: writing the conversation title failed\n%s",
                run_id,
                log_text(exc, secrets_of(target)),
            )
        try:
            if usage.input_tokens or usage.output_tokens:
                await self.repo.insert_usage(
                    run_id,
                    user_id,
                    resolution.organization_id,
                    target.provider,
                    target.model,
                    "background",
                    usage_event(target.provider, target.model, usage),
                    connection_id=target.connection_id,
                )
            if title:
                await self.repo.set_title_if_empty(conversation_id, title)
        except Exception:
            logger.exception("Run %s: storing the conversation title failed", run_id)

    async def _record_usage(
        self,
        run_id: UUID,
        user_id: UUID,
        organization_id: UUID,
        target: Target,
        run_usage: RunUsage,
        emit: _Emitter,
    ) -> None:
        """Store the tokens the run consumed, whatever its outcome: a cancelled or
        failed run has still been billed by the provider. One row per run and
        purpose, under the target that answered or was tried last; failures here
        never keep the run from ending."""
        if not (run_usage.input_tokens or run_usage.output_tokens):
            return
        reported = usage_event(target.provider, target.model, run_usage)
        try:
            await self.repo.insert_usage(
                run_id,
                user_id,
                organization_id,
                target.provider,
                target.model,
                "main",
                reported,
                connection_id=target.connection_id,
            )
        except Exception:
            logger.exception("Run %s: recording its usage failed", run_id)
        try:
            current = await self.repo.get_run(run_id)
            # A run the sweeper already ended has its final event stored; nothing
            # may follow it in the stream.
            if current is not None and current["status"] in ACTIVE:
                await emit(reported)
        except Exception:
            logger.exception("Run %s: publishing its usage failed", run_id)

    # -- leases --------------------------------------------------------------

    def _lease_until(self) -> datetime:
        return datetime.now(timezone.utc) + timedelta(
            seconds=self.settings.lease_seconds
        )

    async def _heartbeat(self, run_id: UUID) -> None:
        while True:
            await asyncio.sleep(self.settings.lease_heartbeat_seconds)
            try:
                renewed = await self.repo.renew_lease(
                    run_id, self.owner, self._lease_until()
                )
            except Exception:
                # One failed renewal must not stop the next; the lease has slack.
                logger.exception("Run %s: lease renewal failed", run_id)
                continue
            if not renewed:
                # The run was ended elsewhere (swept): stop working on it. The
                # cancel takes the normal path, where finish_run loses the
                # compare-and-set and nothing more is recorded.
                logger.warning("Run %s lost its lease; cancelling it here", run_id)
                self._lost.add(run_id)
                self._cancel_local(run_id)
                return

    async def sweep_once(self) -> int:
        """End runs whose lease lapsed (or that never left the queue) as
        ``interrupted``, and delete MCP audit rows past their retention
        (``mcp_audit_retention_days``). Returns the number of runs this call
        actually ended."""
        ended_count = 0
        for run in await self.repo.expired_runs(datetime.now(timezone.utc)):
            run_id: UUID = run["id"]
            try:
                stored = [event for _, event in await self.repo.list_events(run_id)]
                ended = RunEnded(status="interrupted")
                # The interrupted turn stays in the model history, as for a
                # cancelled run: the question and whatever answer was streamed.
                prompt = await self.repo.prompt_of(run["assistant_message_id"])
                history = _partial_history(prompt, stored) if prompt else []
                if not await self.repo.finish_run(
                    run_id, "interrupted", None, fold_parts([*stored, ended]), history
                ):
                    logger.info("Run %s was already ended; not sweeping it", run_id)
                    continue
                ended_count += 1
                await self._emit_sweep_end(run_id, ended)
            except Exception:
                logger.exception("Sweeping run %s failed", run_id)
        try:
            # MCP calls belong to no conversation, so nothing else deletes them.
            await self.repo.delete_mcp_tool_calls_before(
                datetime.now(timezone.utc)
                - timedelta(days=self.settings.mcp_audit_retention_days)
            )
        except Exception:
            logger.exception("Deleting expired MCP audit rows failed")
        return ended_count

    async def _emit_sweep_end(self, run_id: UUID, ended: RunEnded) -> None:
        """Record the sweeper's RunEnded. A live owner may insert its own event at
        the sequence number read here; the unique key then rejects one of the two
        and the sweeper reads the next free number again."""
        for _ in range(SWEEP_EMIT_ATTEMPTS):
            emit = _Emitter(
                self.repo, self.bus, run_id, first_seq=await self.repo.next_seq(run_id)
            )
            try:
                await emit(ended)
                return
            except asyncpg.UniqueViolationError:
                continue
        logger.error(
            "Run %s was swept but its RunEnded event could not be recorded", run_id
        )

    async def _sweep_forever(self) -> None:
        while True:
            try:
                await self.sweep_once()
            except Exception:
                logger.exception("Lease sweep failed")
            await asyncio.sleep(self.settings.lease_seconds)

    async def _listen_control(self, ready: asyncio.Event) -> None:
        """Cancel requests from other replicas. Once subscribed, a broken
        subscription is logged and re-established until the manager stops; a
        failure before the first subscription is raised to ``start()``."""
        while not self._stopping:
            try:
                async with self.bus.subscribe(CONTROL_CHANNEL) as messages:
                    ready.set()
                    async for message in messages:
                        self._handle_control(message)
                if not ready.is_set():
                    raise RuntimeError("The control subscription ended at once")
                logger.warning("The control subscription ended; resubscribing")
            except Exception:
                if not ready.is_set():
                    raise
                logger.exception("The control subscription failed; resubscribing")
            await asyncio.sleep(CONTROL_RESUBSCRIBE_DELAY)

    def _handle_control(self, message: dict[str, Any]) -> None:
        if message.get("action") != "cancel":
            return
        try:
            run_id = UUID(str(message["run_id"]))
        except (KeyError, ValueError):
            logger.warning("Ignoring malformed control message: %r", message)
            return
        self._cancel_local(run_id)
