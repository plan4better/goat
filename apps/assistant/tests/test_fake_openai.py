"""The fake OpenAI-compatible model of the end-to-end test, driven through the
assistant's own model layer (openai_compatible), streamed and not."""

import threading
from collections.abc import Iterator
from typing import Any

import pytest
from pydantic_ai import Agent, AgentRunResultEvent

from assistant.llm.endpoints import EndpointPolicy
from assistant.llm.providers import OpenModels, Target, open_models
from e2e.fake_openai import ANSWER, ARGUMENTS, MODEL, TITLE, TOOL, make_server


@pytest.fixture
def base_url() -> Iterator[str]:
    server = make_server(0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}/v1"
    finally:
        server.shutdown()
        server.server_close()


def _models(base_url: str) -> OpenModels:
    target = Target(
        connection_id=None, provider="openai_compatible", model=MODEL, base_url=base_url
    )
    return open_models(target, EndpointPolicy(allow_private=False))


def _agent(models: OpenModels, seen: list[dict[str, Any]]) -> Agent[None, str]:
    agent: Agent[None, str] = Agent(models.main)

    @agent.tool_plain(name=TOOL)
    async def propose(
        title: str, q: str | None = None, facets: dict[str, list[str]] | None = None
    ) -> str:
        seen.append({"title": title, "q": q, "facets": facets})
        return "The proposal is shown."

    return agent


async def test_calls_the_filter_tool_then_answers(base_url: str) -> None:
    seen: list[dict[str, Any]] = []
    models = _models(base_url)
    try:
        result = await _agent(models, seen).run("Radverkehr")
    finally:
        await models.aclose()
    assert seen == [ARGUMENTS]
    assert result.output == ANSWER


async def test_streams_the_same_turns(base_url: str) -> None:
    seen: list[dict[str, Any]] = []
    models = _models(base_url)
    output = ""
    try:
        async with _agent(models, seen).run_stream_events("Radverkehr") as events:
            async for event in events:
                if isinstance(event, AgentRunResultEvent):
                    output = event.result.output
    finally:
        await models.aclose()
    assert seen == [ARGUMENTS]
    assert output == ANSWER


async def test_a_request_without_tools_gets_a_title(base_url: str) -> None:
    models = _models(base_url)
    try:
        result = await Agent(models.main).run("A title for this conversation, please.")
    finally:
        await models.aclose()
    assert result.output == TITLE
