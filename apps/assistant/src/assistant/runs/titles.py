"""Conversation titles from the model that answered (spec §4.5)."""

from pydantic_ai import Agent
from pydantic_ai.models import Model
from pydantic_ai.usage import RunUsage, UsageLimits

from assistant.agent import instrumentation

TITLE_INSTRUCTIONS = (
    "Write a title of at most six words for a conversation that starts with the "
    "message below. Use the language of the message. Reply with the title only."
)
MAX_TITLE_CHARS = 80
#: Only the first part of a long message decides the title.
_INPUT_CHARS = 2000
_TRIM = " \t\"'`*#.“”„«»"


def clean_title(raw: str) -> str | None:
    line = next((candidate for candidate in raw.splitlines() if candidate.strip()), "")
    title = line.strip().strip(_TRIM).strip()
    if not title:
        return None
    if len(title) > MAX_TITLE_CHARS:
        title = title[: MAX_TITLE_CHARS - 1].rstrip() + "…"
    return title


async def generate_title(
    model: Model, text: str, *, usage: RunUsage | None = None
) -> tuple[str | None, RunUsage]:
    """``usage``, when given, is filled as the request goes, so the caller
    sees what an answered request consumed even when the title fails afterwards."""
    agent: Agent[None, str] = Agent(model, instructions=TITLE_INSTRUCTIONS)
    agent.instrument = instrumentation()
    result = await agent.run(
        text[:_INPUT_CHARS], usage_limits=UsageLimits(request_limit=1), usage=usage
    )
    return clean_title(result.output), result.usage
