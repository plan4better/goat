"""When an answer stops searching and writes up what it found.

A run that reaches its token limit (``run_max_tokens``) fails, and the user
gets nothing of what it found; calls past its tool-call limit
(``run_max_tool_calls``) are refused (``StepGuard``). So before either is
reached, the model's next call is told to answer with what it has, and from
then on a call of a tool the stage does not allow is refused as it runs
(``assistant.tools.toolset.answer_step``). A card is still allowed while it
fits: a choice the user has to make is still asked with a card. A finished
workflow run's result the answer has not written about yet may still be read
first, with as many reads as ``read_allowance`` gives it.

Tokens count at what they cost (``weighted_tokens``): every model call of an
answer resends the instructions, the tools, the skills it loaded and the
answer so far, and a provider reads that prefix from its cache. The budget and
the hard limit count the same way, and the hard limit leaves room for one call
that misses the cache (``RunLimits``). Every call of an answer offers the same
tools with the same instructions, and the note on the stage comes after the
conversation (``assistant.agent.StageNote``), so the calls that end an answer
read the prefix from the cache as a look-up does. Each is sized at its whole
context, from the run's messages (``next_call``), at the cache reads of the
newest call (``call_cost``); a provider that reports none pays the whole
context. One more look-up is allowed only while two such calls still fit after
it, a step that reads what the look-up returned and the answer step
(``RunBudget.spent``): a look-up that runs a workflow leaves room to read its
result. A step that reads a run's result past the look-ups comes while
those two fit before it (``RunBudget.read_fits``); the card while the answer
step fits, since a card ends the answer (``runs/turn.py``), and otherwise the
step answers in text (``RunBudget.can_ask``). Within a step, each call is held
to the tool-call limit and each result to the room the answer step needs, as
they run (``StepGuard``).
"""

import math
from collections.abc import Sequence
from dataclasses import dataclass, field

from pydantic_ai.exceptions import UsageLimitExceeded
from pydantic_ai.messages import (
    BaseToolReturnPart,
    ModelMessage,
    ModelRequest,
    ModelRequestPart,
    ModelResponse,
    RetryPromptPart,
    UserPromptPart,
)
from pydantic_ai.usage import RequestUsage, RunUsage, UsageLimits

#: Tool calls kept in reserve: a model may call several tools in one step.
#: At most a sixth of the limit, so a small limit still leaves some to use.
TOOL_CALL_RESERVE = 5
#: Model calls an answer keeps room for to answer: the answer step. A card
#: ends the answer without another call (``runs/turn.py``).
ANSWER_CALLS = 1
#: Tokens kept beyond the context of those calls for what answering adds:
#: the card, which is the answer step's output, the answer's text and the
#: reasoning before it, and the note to answer now.
ANSWER_ALLOWANCE = 8_000
#: The smallest step from one call to the next that a look-up is assumed to
#: add: a run's first steps show little of what a search or a skill can
#: return.
GROWTH_FLOOR = 8_000
#: What a token read from the provider's cache counts for: providers bill
#: cache reads at a fraction of the price of uncached input.
CACHE_READ_WEIGHT = 0.1
#: Reads an answer may still make once its look-ups are spent, while a
#: finished workflow run's result it has to report is not yet in its text
#: (``ToolSpec.report_first``): reading that result is what the answer needs.
#: The fewest a result gets; a run that saved more layers gets more
#: (``read_allowance``). They are allowed while ``READ_CALLS`` fit before each
#: read step (``RunBudget.read_fits``); ``StepGuard.admit_result`` keeps the
#: answer step's room. They run also past the tool-call limit
#: (``StepGuard.admit_call``): in a read step, and in any other step of the
#: answer while the result is not yet in its text. Both count toward the
#: result's one allowance.
RESULT_READS = 3
#: The most reads past the look-up budget a result gets.
MAX_RESULT_READS = 6
#: Model calls that must fit before a step that reads a run's result past the
#: look-ups: the read step and the answer step. A look-up keeps the same room
#: after it (``RunBudget.spent``): with room for the answer step only, a
#: workflow run in the last look-up left none to read its result. No room is
#: kept for asking a response without text again: after a read near the token
#: limit, that call can end the run at the limit (``run_limit``), before the
#: fixed text ``runs/turn.py`` gives an answer without text once its retries
#: are used up.
READ_CALLS = ANSWER_CALLS + 1
#: Characters per token for the results a call sends that no model has seen
#: yet. Tool results are JSON full of ids, numbers and German words, which
#: tokenizers split into short pieces, and each result also brings the framing
#: of its message: counted at this few characters per token, they come out
#: high rather than low.
CHARS_PER_TOKEN = 1.75


def read_allowance(saved_layers: int) -> int:
    """The reads past the look-up budget a finished run's result gets: one
    per layer the run saved and one more, at least ``RESULT_READS`` and at
    most ``MAX_RESULT_READS``."""
    return min(MAX_RESULT_READS, max(RESULT_READS, saved_layers + 1))


def call_cost(context: int, cached: int) -> float:
    """What a model call whose whole context is ``context`` tokens costs in
    weighted tokens when it reads ``cached`` of them from the provider's
    cache, before its output."""
    cached = min(cached, context)
    return context - cached + cached * CACHE_READ_WEIGHT


def weighted_tokens(usage: RunUsage) -> float:
    """The run's tokens with cache reads at ``CACHE_READ_WEIGHT``. Uncached
    input, cache writes among it, and output count fully. ``input_tokens``
    includes the cache reads (Pydantic AI normalizes every provider to that)."""
    cached = usage.cache_read_tokens
    return usage.total_tokens - cached + cached * CACHE_READ_WEIGHT


@dataclass(frozen=True)
class NextCall:
    """The run's next model call, as the run's messages show it while the
    call is prepared (``next_call``)."""

    #: The usage of the run's newest model call; empty before its first.
    newest: RequestUsage
    #: The next call's whole context: the newest call's input and output and
    #: what the next call sends with it (the results of the newest call's
    #: tools). What the call costs if it misses the provider's cache. Before
    #: the run's first response, only what that request sends.
    raw: int
    #: The largest step between the inputs of two of the run's calls in a
    #: row, as the provider counted them; 0 before the run's second call.
    growth: int


def _pending_text(part: ModelRequestPart) -> str:
    if isinstance(part, BaseToolReturnPart):
        return part.model_response_str()
    if isinstance(part, RetryPromptPart):
        return part.model_response()
    if isinstance(part, UserPromptPart):
        if isinstance(part.content, str):
            return part.content
        return "".join(item for item in part.content if isinstance(item, str))
    return ""


def next_call(messages: Sequence[ModelMessage], run_id: str | None) -> NextCall:
    """``messages``: a run's ``RunContext.messages`` while it prepares a model
    call; the last one is the request the call sends. Only the run's own
    messages count (``run_id``): a run that continues a conversation has no
    call of its own at first, whatever the last answer cost."""
    own: list[ModelMessage] = []
    for message in reversed(messages):
        if message.run_id != run_id:
            break
        own.append(message)
    own.reverse()
    pending = 0
    if own and isinstance(own[-1], ModelRequest):
        chars = sum(len(_pending_text(part)) for part in own[-1].parts)
        pending = math.ceil(chars / CHARS_PER_TOKEN)
    responses = [m.usage for m in own if isinstance(m, ModelResponse)]
    if not responses:
        return NextCall(newest=RequestUsage(), raw=pending, growth=0)
    newest = responses[-1]
    raw = newest.input_tokens + newest.output_tokens + pending
    steps = [b.input_tokens - a.input_tokens for a, b in zip(responses, responses[1:])]
    return NextCall(newest=newest, raw=raw, growth=max(steps, default=0))


@dataclass(repr=False, kw_only=True)
class RunLimits(UsageLimits):
    """Pydantic AI's limits plus one on ``weighted_tokens``, checked where it
    checks its own token limits: before each model call, while a response
    streams and after it.

    The limit is the planned budget and a margin for one call that misses
    the provider's cache. The calls that end an answer are planned at the
    cache reads of the newest call (``RunBudget._answering``); a provider
    that misses its cache on such a call charges those tokens in full, so the
    call costs more than the plan left room for. The margin is that
    difference for the most one call of the run read from the cache so far:
    a miss then costs tokens beyond the plan instead of the answer the run
    found. A look-up needs none of it, since the next step's plan counts what
    a missed look-up did cost. On a provider that has read nothing from its
    cache in the run, the plan sizes each call at its whole context, and a
    call more than planned (a card refused for want of text before it, a
    call its stage refused) costs that much again: the margin is then one
    call of the newest call's context. Raw tokens are held to the same limit
    as if every input token were a cache read: a backstop that never ends a
    run the weighted limit lets through."""

    weighted_tokens_limit: int | None = None
    #: The run's requests and cache reads as the request being made began
    #: (``check_before_request``): the difference at the next request is the
    #: cache reads of this one.
    _requests: int = field(default=0, init=False)
    _cached: int = field(default=0, init=False)
    _tokens: int = field(default=0, init=False)
    #: The most one request of the run read from the cache.
    _most_cached: int = field(default=0, init=False)
    #: The newest request's input and output.
    _newest: int = field(default=0, init=False)

    def has_token_limits(self) -> bool:
        return self.weighted_tokens_limit is not None or super().has_token_limits()

    def check_before_request(self, usage: RunUsage) -> None:
        self._count_request(usage)
        self._check_weighted(usage)
        super().check_before_request(usage)

    def check_tokens(self, usage: RunUsage) -> None:
        self._check_weighted(usage)
        super().check_tokens(usage)

    def margin(self) -> float:
        """What one call that misses the cache costs beyond its plan, at the
        most cache reads of one request so far; without any, one call of
        the newest call's context."""
        if self._most_cached == 0:
            return self._newest
        return (1 - CACHE_READ_WEIGHT) * self._most_cached

    def _count_request(self, usage: RunUsage) -> None:
        """Notes the cache reads, input and output of the request that came
        before this one; a run's first request starts the count again."""
        if usage.requests == 0:
            self._most_cached = self._newest = 0
        elif usage.requests == self._requests + 1:
            self._most_cached = max(
                self._most_cached, usage.cache_read_tokens - self._cached
            )
            self._newest = usage.total_tokens - self._tokens
        self._requests, self._cached = usage.requests, usage.cache_read_tokens
        self._tokens = usage.total_tokens

    def _check_weighted(self, usage: RunUsage) -> None:
        if self.weighted_tokens_limit is None:
            return
        limit = self.weighted_tokens_limit + self.margin()
        tokens = weighted_tokens(usage)
        if tokens > limit or usage.total_tokens > limit / CACHE_READ_WEIGHT:
            raise UsageLimitExceeded(
                f"Exceeded the token limit of {self.weighted_tokens_limit} "
                f"(tokens={tokens:.0f}, cache reads counted at "
                f"{CACHE_READ_WEIGHT:g}, {self.margin():.0f} more for one call "
                "past the plan)"
            )


@dataclass(frozen=True)
class RunBudget:
    max_tokens: int
    max_tool_calls: int

    def spent(
        self, usage: RunUsage, call: NextCall, tool_calls: int | None = None
    ) -> bool:
        """Time to answer: few tool calls left, or one more look-up and what
        has to follow it might not fit in the tokens left. ``call`` is the
        call being prepared (``next_call``). ``tool_calls``: the run's calls
        its tool-call limit counts, every call let run (``StepGuard``); the
        usage's successful calls when not given."""
        if tool_calls is None:
            tool_calls = usage.tool_calls
        reserve = min(TOOL_CALL_RESERVE, self.max_tool_calls // 6)
        if tool_calls >= self.max_tool_calls - reserve:
            return True
        if usage.requests == 0:
            return False
        # An assumption: the look-up reads from the cache what the newest call
        # read (nothing on a provider without caching), and its output is like
        # the newest call's. A look-up that misses the cache costs more than
        # this; the next check counts what it did cost, so the miss is absorbed
        # there.
        newest = call.newest
        look_up = call_cost(call.raw, newest.cache_read_tokens) + newest.output_tokens
        # After it, the read step and the answer step start from a context
        # larger by up to the run's largest step.
        after = self._answering(
            call.raw + max(call.growth, GROWTH_FLOOR), call, READ_CALLS
        )
        return weighted_tokens(usage) + look_up + after > self.max_tokens

    def can_ask(
        self, usage: RunUsage, call: NextCall, tool_calls: int | None = None
    ) -> bool:
        """Whether the answer step may ask with a card: ``ask_user`` is one
        more tool call, and the card ends the answer, so only the answer step
        has to fit. Otherwise the step answers in text. ``tool_calls`` as in
        ``spent``."""
        if tool_calls is None:
            tool_calls = usage.tool_calls
        if tool_calls >= self.max_tool_calls:
            return False
        return self.answer_fits(usage, call)

    def answer_fits(self, usage: RunUsage, call: NextCall) -> bool:
        """Whether the answer step still fits in the tokens left, from the
        call being prepared (``next_call``)."""
        answering = self._answering(call.raw, call, ANSWER_CALLS)
        return weighted_tokens(usage) + answering <= self.max_tokens

    def read_fits(self, usage: RunUsage, call: NextCall) -> bool:
        """Whether a step that reads a run's result past the look-ups and the
        answer step after it still fit (``READ_CALLS``), from the call being
        prepared (``next_call``)."""
        reading = self._answering(call.raw, call, READ_CALLS)
        return weighted_tokens(usage) + reading <= self.max_tokens

    @staticmethod
    def _answering(context: int, call: NextCall, calls: int) -> float:
        """What ``calls`` calls that end an answer cost from a context of
        ``context`` tokens. They offer the tools and instructions of the calls
        before them, so each reads from the cache what the newest call read
        (``call_cost``; the newest call of ``call``), and the card's share is
        in ``ANSWER_ALLOWANCE``."""
        each = call_cost(context, call.newest.cache_read_tokens)
        return calls * each + ANSWER_ALLOWANCE

    def usage_limits(self) -> UsageLimits:
        """The hard limits, counting tokens as ``spent`` does, with a margin
        for one call that misses the provider's cache (``RunLimits``); the
        plan itself keeps to ``max_tokens``. One per run: the margin follows
        the run's own requests.

        Pydantic AI counts a step's tool calls before it runs any of them, so
        at its own limit a step of several calls would end the run with
        everything it found. The run's tool-call limit is kept call by call
        instead (``StepGuard``); Pydantic AI's sits at twice it, plus the
        most reads of a run's result past it (``MAX_RESULT_READS``) and one
        more call of their step (a read refused past them, or the card),
        which only a single step of more calls than the run's whole limit
        reaches. A run without tool calls has no run's result to read."""
        reads = MAX_RESULT_READS + 1 if self.max_tool_calls > 0 else 0
        return RunLimits(
            tool_calls_limit=2 * self.max_tool_calls + reads,
            weighted_tokens_limit=self.max_tokens,
        )


@dataclass
class StepGuard:
    """What the tool calls of one step (one model response's calls) may still
    add to the run, decided call by call in the order they run: a call past
    the run's tool-call limit does not run, and a result that would leave the
    answer step too little room is not sent and ends the run's look-ups
    (``assistant.tools.toolset.answer_step``). The answer step is sized as
    ``RunBudget`` sizes it: at the cache reads of the step's own call. Every call let run counts
    toward the limit, failed and invalid ones too, so a model that repeats a
    failing call reaches it. The step's other calls go on, and the next model
    call answers with what the run found instead of the run failing at a
    limit, where the answer step still fits after the run's first call: that
    call is not checked (``RunBudget.spent``).

    The tally leaves out what the step sends besides the results it checks:
    the results of the tools it does not check (writes, proposals, cards) and
    the failure texts of refused or failed calls. They are short, and
    ``ANSWER_ALLOWANCE`` and the high count of results (bytes at
    ``CHARS_PER_TOKEN``) cover them."""

    budget: RunBudget
    #: The step: the run's id and the step's number.
    step: tuple[str | None, int]
    #: The calls let run so far, by run id, shared by a run's steps: what the
    #: run's tool-call limit counts. Failed and invalid calls count too, so
    #: a model that repeats a failing call still reaches the limit.
    calls: dict[str | None, int]
    #: The context the next call starts from before the step's results: the
    #: step's model call's input and output.
    context: int
    #: The tokens the step's model call read from the provider's cache.
    cached: int = 0
    #: Tokens of the step's results sent so far.
    results: int = 0

    def at_limit(self) -> bool:
        """Whether the run's tool-call limit is reached: a call runs only
        past it (``admit_call``)."""
        return self.calls.get(self.step[0], 0) >= self.budget.max_tool_calls

    def admit_call(self, *, past_limit: bool = False) -> bool:
        """``past_limit``: a read of a finished run's result
        (``read_allowance``), the card allowed with the reads, or the cards
        that show what the answer found past the look-ups
        (``assistant.tools.toolset.DISPLAY_TOOLS``), let run although the
        limit is reached; it counts all the same."""
        if self.at_limit() and not past_limit:
            return False
        run_id = self.step[0]
        self.calls[run_id] = self.calls.get(run_id, 0) + 1
        return True

    def admit_result(self, usage: RunUsage, result_bytes: int) -> bool:
        """Whether a result of ``result_bytes`` still leaves room for the
        answer step after the step's results sent so far: the step's whole
        context at the cache reads of the step's call (``call_cost``), and
        ``ANSWER_ALLOWANCE``. What else follows is decided at the next check,
        on the context the step left (``RunBudget``). Bytes count at least the
        characters the model reads."""
        tokens = math.ceil(result_bytes / CHARS_PER_TOKEN)
        context = self.context + self.results + tokens
        answering = ANSWER_CALLS * call_cost(context, self.cached) + ANSWER_ALLOWANCE
        if weighted_tokens(usage) + answering > self.budget.max_tokens:
            return False
        self.results += tokens
        return True
