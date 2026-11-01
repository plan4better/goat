"""The harness runs the production agent and tool layer against the fixed
backends. Scripted models stand in for a provider, so no token is spent."""

import json
from collections.abc import Iterator

import pytest
from pydantic_ai.messages import (
    ModelRequest,
    ModelResponse,
    RetryPromptPart,
    TextPart,
    ThinkingPart,
    UserPromptPart,
)

from assistant.config import AssistantSettings
from assistant.tools.testing import ScriptedModel
from evals.backends import PROJECT_ID, Backends, write_eval_catalog
from evals.graders import grade
from evals.harness import answered_by, run_task, stalls
from evals.tasks import EvalTask, load_tasks


@pytest.fixture(scope="session")
def backends(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Backends]:
    path = tmp_path_factory.mktemp("eval-catalog-h")
    write_eval_catalog(path)
    backends = Backends(path)
    yield backends
    backends.close()


def _task(task_id: str) -> EvalTask:
    return next(task for task in load_tasks() if task.id == task_id)


async def test_a_model_that_proposes_the_right_filters_passes(
    backends: Backends, settings: AssistantSettings
) -> None:
    model = ScriptedModel(
        calls=[
            (
                "catalog_propose_filters",
                {"title": "Verkehr", "facets": {"themes": ["transportation"]}},
            )
        ],
        answer="I set the filters to transportation.",
    )
    transcript = await run_task(_task("cat-14"), model.model, backends, settings)
    assert transcript.error is None, transcript.error
    assert [g.passed for g in await grade(_task("cat-14"), transcript, backends)] == [
        True,
        True,
        True,
    ]
    assert transcript.proposals[-1]["kind"] == "catalog.filters"


async def test_a_model_that_answers_without_searching_fails(
    backends: Backends, settings: AssistantSettings
) -> None:
    model = ScriptedModel(answer="Try the open data portal of Leipzig.")
    transcript = await run_task(_task("cat-01"), model.model, backends, settings)
    assert [g.passed for g in await grade(_task("cat-01"), transcript, backends)] == [
        False,
        True,
    ]


async def test_project_counts_go_through_the_real_tools(
    backends: Backends, settings: AssistantSettings
) -> None:
    model = ScriptedModel(
        calls=[
            (
                "project_count_features",
                {
                    "layer_project_id": 21,
                    "filter": {
                        "conditions": [
                            {"field": "art", "op": "=", "value": "Schutzstreifen"}
                        ]
                    },
                },
            )
        ],
        answer="Es sind 16 Schutzstreifen.",
    )
    transcript = await run_task(_task("proj-04"), model.model, backends, settings)
    assert transcript.error is None, transcript.error
    count = next(
        call for call in transcript.tool_calls if call.name == "project_count_features"
    )
    assert count.result["count"] == 16
    assert [g.passed for g in await grade(_task("proj-04"), transcript, backends)] == [
        True,
        True,
    ]
    assert any(PROJECT_ID in str(r.url) for r in transcript.requests["core"])


async def test_the_locked_layer_is_never_sent(
    backends: Backends, settings: AssistantSettings
) -> None:
    model = ScriptedModel(
        calls=[("project_count_features", {"layer_project_id": 24})],
        answer="The user has no access to Interne Planung, so I cannot count it.",
    )
    transcript = await run_task(_task("proj-12"), model.model, backends, settings)
    assert [g.passed for g in await grade(_task("proj-12"), transcript, backends)] == [
        True,
        True,
        True,
        True,
    ]


async def test_catalog_tools_reach_the_fixture_catalog_and_find_the_named_rows(
    backends: Backends, settings: AssistantSettings
) -> None:
    model = ScriptedModel(
        calls=[
            ("catalog_describe", {}),
            ("catalog_suggest_terms", {"prefix": "Ladesä"}),
            ("catalog_search", {"q": "Ladesäulen", "limit": 20}),
        ],
        answer="I found the charging stations for Leipzig in the catalog.",
    )
    transcript = await run_task(_task("cat-01"), model.model, backends, settings)
    assert transcript.error is None, transcript.error
    assert not any(call.failed for call in transcript.tool_calls), transcript.tool_calls
    assert any(r.url.path == "/stac/suggest" for r in transcript.requests["catalog"])
    assert any(
        r.url.path.endswith("/queryables") and r.url.params.get("unit") == "collections"
        for r in transcript.requests["catalog"]
    )
    assert [g.passed for g in await grade(_task("cat-01"), transcript, backends)] == [
        True,
        True,
    ]


async def test_a_locked_layer_fails_the_call_and_the_run_goes_on(
    backends: Backends, settings: AssistantSettings
) -> None:
    model = ScriptedModel(
        calls=[("project_count_features", {"layer_project_id": 24})], answer="No."
    )
    transcript = await run_task(_task("proj-12"), model.model, backends, settings)
    assert transcript.error is None, transcript.error
    assert [call.failed for call in transcript.tool_calls] == [True]


async def test_restricted_numeric_statistics_use_the_extra_calls_and_exact_breaks(
    backends: Backends, settings: AssistantSettings
) -> None:
    schutz = {"conditions": [{"field": "art", "op": "=", "value": "Schutzstreifen"}]}
    model = ScriptedModel(
        calls=[
            (
                "project_field_statistics",
                {"layer_project_id": 21, "field": "laenge_m", "filter": schutz},
            )
        ],
        answer="Done.",
    )
    task = _task("proj-13")
    transcript = await run_task(task, model.model, backends, settings)
    assert transcript.error is None, transcript.error
    stats = transcript.tool_calls[0].result
    assert stats["feature_count"] == 16
    # 16 features with a value: two break points keep every class at 5 or more.
    assert len(stats["breaks"]) == 2
    assert stats.get("mean") is None
    bodies = [json.loads(r.content) for r in transcript.requests["processes"]]
    count = next(
        b for b in bodies if "filter" in b["inputs"] and "attribute" not in b["inputs"]
    )
    assert '"isNull"' in count["inputs"]["filter"]


async def test_restricted_categorical_statistics_judge_cardinality_on_the_whole_layer(
    backends: Backends, settings: AssistantSettings
) -> None:
    model = ScriptedModel(
        calls=[
            (
                "project_field_statistics",
                {
                    "layer_project_id": 21,
                    "field": "bezirk",
                    "filter": {
                        "conditions": [{"field": "art", "op": "=", "value": "Radweg"}]
                    },
                },
            )
        ],
        answer="Done.",
    )
    transcript = await run_task(_task("proj-13"), model.model, backends, settings)
    assert transcript.error is None, transcript.error
    result = transcript.tool_calls[0].result
    assert result["values"]
    unique_calls = [
        json.loads(r.content)["inputs"]
        for r in transcript.requests["processes"]
        if r.url.path.endswith("/unique-values/execution")
    ]
    # Whole layer, no filter: the filter's field with its value counts (a
    # Restricted filter must pick a category shared by enough features), and the
    # distinct count of the field the statistics are about.
    whole = sorted(
        (c["attribute"], c["limit"]) for c in unique_calls if "filter" not in c
    )
    assert whole == [("art", 50), ("bezirk", 1)]


async def test_restricted_sampling_is_withheld_and_graded(
    backends: Backends, settings: AssistantSettings
) -> None:
    model = ScriptedModel(
        calls=[("project_sample_features", {"layer_project_id": 21})],
        answer="Not possible: the values are withheld by the data policy.",
    )
    transcript = await run_task(_task("proj-13"), model.model, backends, settings)
    assert transcript.tool_calls[0].result["withheld"] is True
    assert [g.passed for g in await grade(_task("proj-13"), transcript, backends)] == [
        True,
        True,
        True,
    ]
    assert not transcript.requests["geoapi"] or all(
        not r.url.path.endswith("/items") for r in transcript.requests["geoapi"]
    )


async def test_the_map_view_of_a_layer_is_proposed_and_graded(
    backends: Backends, settings: AssistantSettings
) -> None:
    model = ScriptedModel(
        calls=[("map_propose_view", {"title": "Bezirke", "fit_layer_project_id": 22})],
        answer="The map now shows the Bezirke layer.",
    )
    transcript = await run_task(_task("proj-11"), model.model, backends, settings)
    assert transcript.error is None, transcript.error
    assert [g.passed for g in await grade(_task("proj-11"), transcript, backends)] == [
        True,
        True,
        True,
    ]


#: An answer far longer than the room a run keeps for answering: it ends the
#: run at the token limit (assistant.budget), after the run's look-ups.
OVERLONG = "word " * 40_000


async def test_an_exhausted_budget_is_a_failed_task_not_a_failed_eval(
    backends: Backends, settings: AssistantSettings
) -> None:
    tight = settings.model_copy(update={"run_max_tokens": 30_000})
    model = ScriptedModel(calls=[("project_get_layers", {})], answer=OVERLONG)
    transcript = await run_task(_task("proj-01"), model.model, backends, tight)
    assert transcript.error is not None and "UsageLimitExceeded" in transcript.error
    assert transcript.seconds > 0
    # What the run did and spent before it failed is kept.
    assert [call.name for call in transcript.tool_calls][:1] == ["project_get_layers"]
    assert transcript.tool_calls[0].result is not None
    assert transcript.input_tokens > 0 and transcript.output_tokens > 0


async def test_a_failed_run_keeps_its_calls_for_the_safety_checks(
    backends: Backends, settings: AssistantSettings
) -> None:
    tight = settings.model_copy(update={"run_max_tokens": 30_000})
    model = ScriptedModel(
        calls=[("project_sample_features", {"layer_project_id": 21})],
        answer=OVERLONG,
    )
    task = _task("proj-13")
    transcript = await run_task(task, model.model, backends, tight)
    assert transcript.error is not None
    grades = await grade(task, transcript, backends)
    # The withheld call happened before the failure: the safety check sees it,
    # the answer and language checks do not pass on a failed run.
    assert [g.passed for g in grades] == [True, False, False]


async def test_restricted_refuses_a_filter_that_singles_out_one_feature(
    backends: Backends, settings: AssistantSettings
) -> None:
    model = ScriptedModel(
        calls=[
            (
                "project_field_statistics",
                {
                    "layer_project_id": 22,
                    "field": "einwohner",
                    "filter": {
                        "conditions": [{"field": "name", "op": "=", "value": "Mitte"}]
                    },
                },
            )
        ],
        answer="The exact value is withheld by the data policy for such a small group.",
    )
    task = _task("proj-16")
    transcript = await run_task(task, model.model, backends, settings)
    assert transcript.error is None, transcript.error
    # One district's name is a category of one: refused before anything is
    # computed, so not even a withheld group is returned.
    [call] = transcript.tool_calls
    assert call.failed and "at least 5 features share" in str(call.result)
    assert [g.passed for g in await grade(task, transcript, backends)] == [
        True,
        True,
        True,
    ]


async def test_catalog_describe_lists_the_themes_of_the_eval_catalog(
    backends: Backends, settings: AssistantSettings
) -> None:
    model = ScriptedModel(calls=[("catalog_describe", {})], answer="Listed.")
    transcript = await run_task(_task("cat-26"), model.model, backends, settings)
    assert transcript.error is None, transcript.error
    filters = {f["parameter"]: f for f in transcript.tool_calls[0].result["filters"]}
    values = {v["value"]: v["count"] for v in filters["themes"]["values"]}
    assert {"transportation", "environment", "landuse", "people", "boundary"} <= set(
        values
    )
    assert all(count > 0 for count in values.values())


def test_any_outcome_but_success_is_a_failed_call() -> None:
    from pydantic_ai import FunctionToolCallEvent, FunctionToolResultEvent
    from pydantic_ai.messages import ToolCallPart, ToolReturnPart

    from evals.harness import _ToolLog

    log = _ToolLog()
    for index, outcome in enumerate(("success", "failed", "denied", "interrupted")):
        call = ToolCallPart("t", {}, tool_call_id=f"c{index}")
        log.see(FunctionToolCallEvent(call))
        log.see(
            FunctionToolResultEvent(
                ToolReturnPart("t", {"x": 1}, tool_call_id=f"c{index}", outcome=outcome)  # type: ignore[arg-type]
            )
        )
    assert [c.failed for c in log.calls] == [False, True, True, True]


async def test_restricted_refuses_excluding_one_feature_to_read_the_runner_up(
    backends: Backends, settings: AssistantSettings
) -> None:
    """ "All districts but the largest", then their maximum, is the second
    largest value: a value shared by fewer than five features is no category."""
    model = ScriptedModel(
        calls=[
            (
                "project_field_statistics",
                {
                    "layer_project_id": 22,
                    "field": "einwohner",
                    "filter": {
                        "conditions": [
                            {"field": "name", "op": "!=", "value": "Südwest"}
                        ]
                    },
                },
            )
        ],
        answer="Withheld.",
    )
    transcript = await run_task(_task("proj-17"), model.model, backends, settings)
    [call] = transcript.tool_calls
    assert call.failed and "at least 5 features share" in str(call.result)


def test_the_answering_providers_and_their_cost_come_from_the_responses() -> None:
    """A gateway such as OpenRouter names the provider that answered and what it
    billed on each response; requests and responses without them add nothing."""
    responses = [
        ModelRequest(parts=[UserPromptPart(content="Where are the schools?")]),
        ModelResponse(
            parts=[TextPart(content="a")],
            provider_details={"downstream_provider": "DeepInfra", "cost": 0.002},
        ),
        ModelResponse(
            parts=[TextPart(content="b")],
            provider_details={"downstream_provider": "DeepInfra", "cost": 0.001},
        ),
        ModelResponse(
            parts=[TextPart(content="c")],
            provider_details={"downstream_provider": "Together"},
        ),
        ModelResponse(parts=[TextPart(content="d")]),
    ]
    providers, cost = answered_by(responses)
    assert providers == {"DeepInfra": 2, "Together": 1}
    assert cost == pytest.approx(0.003)
    assert answered_by([ModelResponse(parts=[TextPart(content="d")])]) == ({}, None)


def test_responses_without_text_or_a_call_and_the_retries_are_counted() -> None:
    """A response of reasoning only gives the agent nothing to show or run, so it
    asks the model again: both cost a model call and time without failing a task."""
    messages = [
        ModelRequest(parts=[UserPromptPart(content="Build the workflow.")]),
        ModelResponse(parts=[ThinkingPart(content="I should create it.")]),
        ModelRequest(
            parts=[RetryPromptPart(content="Please return text or call a tool.")]
        ),
        ModelResponse(parts=[ThinkingPart(content="Now."), TextPart(content="Done.")]),
        ModelResponse(parts=[]),
    ]
    assert stalls(messages) == (2, 1)
    assert stalls([ModelResponse(parts=[TextPart(content="Done.")])]) == (0, 0)
