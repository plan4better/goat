"""Test connection (spec §4.3).

One small agent run with one tool: it proves authentication, a streamed text
answer and a tool call, which is the contract a model must meet (§4.2). A
model that answers without calling the tool cannot be activated.
"""

import asyncio
import logging
from collections.abc import Iterable
from dataclasses import dataclass, field, replace
from typing import Any

import httpx2
from pydantic_ai import Agent, Tool
from pydantic_ai.exceptions import UnexpectedModelBehavior, UsageLimitExceeded
from pydantic_ai.messages import PartDeltaEvent, PartStartEvent, TextPart, TextPartDelta
from pydantic_ai.models import Model
from pydantic_ai.usage import UsageLimits

from assistant.llm.capabilities import capabilities_for
from assistant.llm.endpoints import EndpointPolicy
from assistant.llm.failures import (
    admin_message,
    classify_failure,
    log_text,
    redact,
    secrets_of,
)
from assistant.llm.providers import Target, open_models

logger = logging.getLogger(__name__)

PROBE_TOOL = "probe_echo"
PROBE_PROMPT = (
    "This is an automatic connection test. Call the tool probe_echo exactly once "
    "with the value 'goat'. When the tool result arrives, reply with the single word: done"
)
#: Generous for a slow self-hosted model's first token, and below the read
#: timeout of common ingress defaults, so the admin gets the probe's answer
#: rather than a gateway error. Plan 5 keeps the /assistant route's timeout above it.
PROBE_TIMEOUT_SECONDS = 45.0


@dataclass(frozen=True)
class ProbeResult:
    ok: bool
    error: str | None
    capabilities: dict[str, Any] = field(default_factory=dict)


def _failed(error: str) -> ProbeResult:
    return ProbeResult(ok=False, error=error, capabilities={})


async def probe_model(
    model: Model,
    model_name: str,
    *,
    timeout: float = PROBE_TIMEOUT_SECONDS,
    secrets: Iterable[str] = (),
    vertex: bool = False,
) -> ProbeResult:
    """``secrets`` are the connection's credentials (``secrets_of``), masked in
    everything reported or logged. ``vertex`` marks a Vertex AI model, whose
    token errors arrive outside the model class."""
    known = list(secrets)
    calls: list[str] = []

    async def probe_echo(value: str) -> str:
        """Echo a value back. Part of an automatic connection test."""
        calls.append(value)
        return f"ok-{value}"

    agent: Agent[None, str] = Agent(
        model, tools=[Tool(probe_echo, name=PROBE_TOOL, takes_ctx=False)]
    )
    streamed = False
    try:
        async with asyncio.timeout(timeout):
            async with agent.run_stream_events(
                PROBE_PROMPT,
                usage_limits=UsageLimits(request_limit=4, tool_calls_limit=3),
            ) as events:
                async for event in events:
                    if (
                        isinstance(event, PartStartEvent)
                        and isinstance(event.part, TextPart)
                        and event.part.content
                    ) or (
                        isinstance(event, PartDeltaEvent)
                        and isinstance(event.delta, TextPartDelta)
                        and event.delta.content_delta
                    ):
                        streamed = True
    except TimeoutError:
        return _failed("The provider did not answer in time.")
    except UsageLimitExceeded:
        return _failed("The model kept calling tools and did not finish its answer.")
    except UnexpectedModelBehavior:
        return _failed(
            "The model did not complete the tool call. "
            "GOAT needs a model that supports tool calling."
        )
    except Exception as exc:
        failure = classify_failure(exc, known, vertex=vertex)
        if failure is None:
            logger.error("The connection test failed\n%s", log_text(exc, known))
            return _failed(
                "The test failed unexpectedly. The service log has the details."
            )
        return _failed(admin_message(failure))
    if not calls:
        return _failed(
            "The model answered without calling the test tool. "
            "GOAT needs a model that supports tool calling."
        )
    if not streamed:
        return _failed("The model did not stream a text answer.")
    return ProbeResult(
        ok=True,
        error=None,
        capabilities={
            **capabilities_for(model, model_name),
            "tool_calling": True,
            "streaming": True,
        },
    )


async def probe_target(
    target: Target,
    policy: EndpointPolicy,
    *,
    transport: httpx2.AsyncBaseTransport | None = None,
) -> ProbeResult:
    """Probe a connection's main model. ``transport`` replaces the network in tests."""
    known = secrets_of(target)
    try:
        models = open_models(target, policy, transport=transport)
    except Exception as exc:
        logger.error(
            "Building the models of connection %s failed\n%s",
            target.connection_id,
            log_text(exc, known),
        )
        return _failed(
            "The connection settings could not be used. Check them and try again."
        )
    try:
        result = await probe_model(
            models.main,
            target.model,
            secrets=known,
            vertex=target.provider == "vertex",
        )
    finally:
        await models.aclose()
    if result.error is None:
        return result
    # The error is stored on the connection and shown to admins: never with a key in it.
    return replace(result, error=redact(result.error, known))
