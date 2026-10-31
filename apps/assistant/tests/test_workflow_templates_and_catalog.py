"""Templates and catalog datasets (spec §3, §5.3, §9): a template becomes a
workflow of the open project with its inputs bound to project layers, once
the bound workflow passes the check, and a catalog dataset is added only
after the user picked it in a card."""

import asyncio
import dataclasses
import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx
import pytest
from pydantic_ai import Agent
from pydantic_ai.exceptions import ToolFailed
from pydantic_ai.messages import (
    ModelMessage,
    ModelResponse,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.toolsets import FunctionToolset

from assistant.agent import RunDeps, build_agent
from assistant.asks import AskHistory, AskUserInput, CardAnswer, QuestionAnswer
from assistant.bus import InMemoryEventBus
from assistant.config import AssistantSettings
from assistant.context import parse_context
from assistant.repo import Repository
from assistant.runs.manager import RunManager
from assistant.skills import BUILT_IN
from assistant.surfaces import Locale
from assistant.tools.http import SIGN_IN_EXPIRED
from assistant.tools.runtime import InputInvalid, ToolEnv, execute
from assistant.tools.testing import (
    Recorder,
    ScriptedModel,
    TurnModel,
    fake_clients,
    signed_in,
    tool_env,
)
from assistant.tools.toolset import REPEATED_WRITE, _tool
from assistant.tools.workflow_tools import clear_description_cache
from assistant.tools.workflows import (
    ADD_CATALOG_LAYER,
    CREATE_FROM_TEMPLATE,
    CREATED_DESCRIPTION,
    FIND_TEMPLATES,
    MAX_BUNDLE_LOOKUPS,
    MAX_LISTED_TEMPLATES,
    MAX_SEARCH_WORDS,
    MAX_TEMPLATES,
    MIN_SEARCH_WORD_CHARS,
    NO_CONSENT,
    NO_PROJECT,
    NOT_READABLE,
    TEMPLATE_NOT_CHECKED,
    TEMPLATE_REFUSED,
    TEMPLATES_SEARCHED,
    VIEWER_LAYERS,
    WorkflowCreated,
    own_dataset,
)

USER = UUID(int=1)
PROJECT = "00000000-0000-0000-0000-0000000005e4"
PAGE = parse_context({"surface": "project.workflows", "project_id": PROJECT})
TEMPLATE = "7e000000-0000-0000-0000-0000000000a1"
WORKFLOW_ID = "0b6f0000-0000-0000-0000-00000000f10f"
LAYERS = [
    {
        "id": 31,
        "layer_id": "e2000000-0000-0000-0000-000000000031",
        "name": "Schulen",
        "type": "feature",
    },
    {
        "id": 36,
        "layer_id": "e2000000-0000-0000-0000-000000000036",
        "name": "Intern",
        "type": "feature",
        "locked": True,
    },
]
TEMPLATE_ROW: dict[str, Any] = {
    "id": TEMPLATE,
    "name": "Schools within walking distance",
    "description": "Catchment areas around schools, " + "on foot " * 40,
    "categories": ["Education"],
    "payload_kind": "workflow",
    "inputs": [
        {
            "key": "node:dataset-1",
            "label": "Schools",
            "mode": "ask",
            "layer_type": "feature",
            "geometry_type": "point",
        },
        {
            "key": "node:dataset-2",
            "label": "Districts",
            "mode": "ship",
            "layer_type": "feature",
        },
    ],
}

CARD_ARGS: dict[str, Any] = {
    "questions": [
        {
            "question": "Which supermarkets should the workflow use?",
            "header": "Shops",
            "options": [
                {"label": "Supermarkets Bavaria", "value": "eval-supermaerkte-bayern"},
                {"label": "Leave it open"},
            ],
        }
    ]
}
CARD = AskUserInput.model_validate(CARD_ARGS)
PICKED = AskHistory(
    cards={"ask-call-0-3": CARD},
    answers={
        "ask-call-0-3": CardAnswer(
            card_id="ask-call-0-3", answers=[QuestionAnswer(question=0, options=[0])]
        )
    },
)
ADDED = [
    {
        "id": 41,
        "layer_id": "e2000000-0000-0000-0000-000000000041",
        "name": "Supermärkte Bayern",
        "type": "feature",
        "feature_layer_geometry_type": "point",
    }
]


#: The toolbox and the process descriptions captured from processes.
PROCESSES: dict[str, Any] = json.loads(
    (Path(__file__).parent / "fixtures" / "process_descriptions.json").read_text(
        encoding="utf-8"
    )
)
#: The dataset the template ships; the project does not show it yet.
SHIPPED = "e2000000-0000-0000-0000-000000000077"
USE = f"/api/v2/template/{TEMPLATE}/use"
PREVIEW = f"{USE}/preview"


@pytest.fixture(autouse=True)
def _fresh_cache() -> Iterator[None]:
    clear_description_cache()
    yield
    clear_description_cache()


def _bound_config(bindings: dict[str, str], label: str = "Schools") -> dict[str, Any]:
    """The template's workflow, a gravity heatmap of the schools and the
    districts, as core binds it: the schools to the layer bound to them (with
    its project entry), or left open; the districts the template ships, which
    a use links anew, so they have no entry yet."""
    schools: dict[str, Any] = {
        "type": "dataset",
        "label": label,
        "templateInput": "node:dataset-1",
    }
    if "node:dataset-1" in bindings:
        layer_id = bindings["node:dataset-1"]
        schools["layerId"] = layer_id
        schools["projectLayerId"] = next(
            row["id"] for row in LAYERS if row["layer_id"] == layer_id
        )
    else:
        schools["unresolved"] = True
    districts = {
        "type": "dataset",
        "label": "Districts",
        "templateInput": "node:dataset-2",
        "layerId": SHIPPED,
    }
    return {
        "nodes": [
            {"id": "dataset-1", "type": "dataset", "data": schools},
            {"id": "dataset-2", "type": "dataset", "data": districts},
            {
                "id": "heat",
                "type": "tool",
                "data": {
                    "type": "tool",
                    # The editor's label of a new step: the tool's id.
                    "label": "heatmap_gravity",
                    "processId": "heatmap_gravity",
                    "config": {"routing_mode": "walking"},
                },
            },
            {
                "id": "save",
                "type": "export",
                "data": {
                    "type": "export",
                    "label": "Gravity",
                    "datasetName": "Gravity",
                },
            },
        ],
        "edges": [
            {
                "id": "e1",
                "source": "dataset-1",
                "target": "heat",
                "targetHandle": "opportunity_layer_1_id",
            },
            {
                "id": "e2",
                "source": "dataset-2",
                "target": "heat",
                "targetHandle": "opportunity_layer_2_id",
            },
            {
                "id": "e3",
                "source": "heat",
                "sourceHandle": "output",
                "target": "save",
                "targetHandle": "input",
            },
        ],
        "viewport": {"x": 0, "y": 0, "zoom": 1},
        "variables": [],
    }


def _preview(label: str = "Schools") -> Any:
    """Core's use preview: the config a use with the request's bindings
    would write, and the inputs it would leave open."""

    def respond(request: httpx.Request) -> httpx.Response:
        bindings = json.loads(request.content).get("bindings") or {}
        return httpx.Response(
            200,
            json={
                "config": _bound_config(bindings, label),
                "unresolved_inputs": [
                    item
                    for item in TEMPLATE_ROW["inputs"]
                    if item["mode"] == "ask" and item["key"] not in bindings
                ],
            },
        )

    return respond


def _processes(
    *issues: tuple[str, str | None, str, str | None], check: Any = None
) -> Recorder:
    """Processes describing the captured tools, and its check: a dataset
    step without a layer is ``layer_not_chosen``, and ``issues`` (code, node
    id, text, field) are reported too, each message starting with the name
    the step has in the config sent; an issue without a node id is one of
    the whole workflow."""

    def respond(request: httpx.Request) -> httpx.Response:
        nodes = {
            node["id"]: node["data"] for node in json.loads(request.content)["nodes"]
        }
        found = [
            ("layer_not_chosen", node_id, "no layer is chosen.", None)
            for node_id, data in nodes.items()
            if data["type"] == "dataset"
            and (data.get("unresolved") is True or not data.get("layerId"))
        ]
        rows: list[dict[str, Any]] = [
            {
                "code": code,
                "level": "error",
                "node_ids": [node_id] if node_id else [],
                "field": field,
                "message": f"{nodes[node_id]['label']}: {text}" if node_id else text,
                "params": {},
                "source": "check",
            }
            for code, node_id, text, field in [*found, *issues]
        ]
        return httpx.Response(200, json={"issues": rows})

    return Recorder(
        {
            **{
                ("GET", f"/processes/{tool}"): described
                for tool, described in PROCESSES["descriptions"].items()
            },
            ("POST", "/workflows/check"): check if check is not None else respond,
        }
    )


def _env(core: Recorder, processes: Recorder | None = None) -> Any:
    return tool_env(
        fake_clients(core=core, processes=processes or _processes()), page=PAGE
    )


def _core(**routes: Any) -> Recorder:
    recorder = Recorder(
        {
            ("GET", f"/api/v2/project/{PROJECT}/layer"): LAYERS,
            ("GET", "/api/v2/template"): {"items": [TEMPLATE_ROW], "total": 1},
            ("GET", f"/api/v2/template/{TEMPLATE}"): TEMPLATE_ROW,
            ("POST", PREVIEW): _preview(),
            ("POST", f"/api/v2/template/{TEMPLATE}/use"): {
                "project_id": PROJECT,
                "workflow_id": WORKFLOW_ID,
                "added_layer_project_ids": [],
                "unresolved_inputs": [],
                "copy_jobs": [],
            },
            ("POST", f"/api/v2/project/{PROJECT}/layer-catalog"): ADDED,
        }
    )
    for key, answer in routes.items():
        method, path = key.split(" ", 1)
        recorder.routes[(method, path)] = answer
    return recorder


def _searched(core: Recorder) -> list[str]:
    """The texts core was asked to search for, sorted."""
    return sorted(
        r.url.params["search"] for r in core.requests if "search" in r.url.params
    )


def _listings(core: Recorder) -> list[dict[str, str]]:
    """The requests that listed the usable workflow templates, without a
    search."""
    return [
        dict(r.url.params)
        for r in core.requests
        if r.url.path == "/api/v2/template" and "search" not in r.url.params
    ]


#: The listing request: the workflow templates the user can use, most
#: recently changed first.
LISTING = {"kind": "workflow", "source": "all", "size": str(MAX_LISTED_TEMPLATES)}


async def test_find_templates_lists_workflow_templates_with_their_inputs() -> None:
    core = _core()
    result = await execute(
        FIND_TEMPLATES,
        tool_env(fake_clients(core=core), page=PAGE),
        {"query": "schools walking"},
    )
    [template] = result["templates"]
    assert template["inputs"] == [
        {
            "key": "node:dataset-1",
            "label": "Schools",
            "needs_binding": True,
            "layer_type": "feature",
            "geometry_type": "point",
        },
        {
            "key": "node:dataset-2",
            "label": "Districts",
            "needs_binding": False,
            "layer_type": "feature",
        },
    ]
    assert len(template["description"]) <= 200
    # The whole query and each of its words: three searches, one template,
    # and the list of the usable ones beside them.
    searches = sorted(
        (dict(r.url.params) for r in core.requests if "search" in r.url.params),
        key=lambda params: params["search"],
    )
    assert searches == [
        {"kind": "workflow", "search": search, "source": "all", "size": "10"}
        for search in ("schools", "schools walking", "walking")
    ]
    assert _listings(core) == [LISTING]


def _matching(rows: list[dict[str, Any]]) -> Any:
    """Core's template search: the whole search text, case-insensitive, in
    the name or the description (``crud_template``); without one, every
    template. A page of ``size`` rows, with the total of all that match."""

    def respond(request: httpx.Request) -> httpx.Response:
        search = request.url.params.get("search", "").casefold()
        items = [
            row
            for row in rows
            if search in row["name"].casefold()
            or search in row["description"].casefold()
        ]
        size = int(request.url.params.get("size", 20))
        return httpx.Response(200, json={"items": items[:size], "total": len(items)})

    return respond


def _row(n: int, name: str) -> dict[str, Any]:
    return {
        **TEMPLATE_ROW,
        "id": f"7e000000-0000-0000-0000-{n:012d}",
        "name": name,
        "description": "",
    }


async def test_a_query_of_several_words_finds_a_template_by_one_of_them() -> None:
    core = _core(**{"GET /api/v2/template": _matching([TEMPLATE_ROW])})
    result = await execute(
        FIND_TEMPLATES,
        tool_env(fake_clients(core=core), page=PAGE),
        {"query": "schools by bus"},
    )
    assert [template["id"] for template in result["templates"]] == [TEMPLATE]
    # "by" is too short to search on its own.
    assert _searched(core) == ["bus", "schools", "schools by bus"]


def test_the_skill_says_how_templates_are_searched() -> None:
    """build-a-workflow tells the model what one query searches, what comes
    back when no template holds its words, and that it searches once."""
    number = {
        2: "two",
        3: "three",
        4: "four",
        5: "five",
        6: "six",
        10: "ten",
        15: "fifteen",
        20: "twenty",
        25: "twenty-five",
    }
    text = " ".join(BUILT_IN["build-a-workflow"].instructions.split())
    assert (
        f"it searches the whole query, then up to {number[MAX_SEARCH_WORDS]} of "
        f"its words of {number[MIN_SEARCH_WORD_CHARS]} or more characters on "
        "their own"
    ) in text
    assert (
        "When no template holds those words, it lists the workflow templates the "
        f"user can use instead, up to {number[MAX_LISTED_TEMPLATES]}"
    ) in text
    assert (
        f"When it finds fewer than {number[MAX_LISTED_TEMPLATES]}, "
        "`other_templates` lists the other workflow templates the user can use "
        f"as well, up to {number[MAX_LISTED_TEMPLATES]} in all"
    ) in text
    assert "A second call in the same answer returns the first call's result" in text


async def test_when_no_search_finds_a_template_the_usable_ones_are_listed() -> None:
    """Template texts are often in another language than the query: when no
    search finds one, the model gets the workflow templates the user can use
    and judges the fit itself, instead of searching again."""
    rows = [
        {**_row(1, "Unterversorgungsbereiche"), "description": "Nahversorgung"},
        _row(2, "ÖV-Güteklassen"),
    ]
    core = _core(**{"GET /api/v2/template": _matching(rows)})
    result = await execute(
        FIND_TEMPLATES,
        tool_env(fake_clients(core=core), page=PAGE),
        {"query": "walking supermarkets"},
    )
    assert [template["name"] for template in result["templates"]] == [
        "Unterversorgungsbereiche",
        "ÖV-Güteklassen",
    ]
    assert result["templates"][0]["description"] == "Nahversorgung"
    assert result["templates"][0]["inputs"][0]["key"] == "node:dataset-1"
    # The three searches found nothing; one more request lists the templates.
    assert _searched(core) == ["supermarkets", "walking", "walking supermarkets"]
    assert _listings(core) == [LISTING]
    assert "other_templates" not in result
    note = result["note"]
    assert "No template's name or description holds" in note
    assert "all 2 workflow templates the user can use" in note
    assert "—" not in note and "–" not in note


async def test_the_listed_templates_are_capped_and_say_how_many_there_are() -> None:
    rows = [_row(n, f"Vorlage {n}") for n in range(MAX_LISTED_TEMPLATES + 5)]
    core = _core(**{"GET /api/v2/template": _matching(rows)})
    result = await execute(
        FIND_TEMPLATES,
        tool_env(fake_clients(core=core), page=PAGE),
        {"query": "walking"},
    )
    assert [template["name"] for template in result["templates"]] == [
        f"Vorlage {n}" for n in range(MAX_LISTED_TEMPLATES)
    ]
    assert (
        f"the {MAX_LISTED_TEMPLATES} most recently changed of the "
        f"{MAX_LISTED_TEMPLATES + 5} workflow templates the user can use"
    ) in result["note"]


async def test_a_user_without_workflow_templates_is_told_so() -> None:
    core = _core(**{"GET /api/v2/template": _matching([])})
    result = await execute(
        FIND_TEMPLATES,
        tool_env(fake_clients(core=core), page=PAGE),
        {"query": "walking"},
    )
    assert result["templates"] == []
    assert "the user can use no workflow template" in result["note"]
    assert "workflow_create" in result["note"]


async def test_when_every_usable_template_is_found_no_others_are_listed() -> None:
    core = _core(**{"GET /api/v2/template": _matching([TEMPLATE_ROW])})
    result = await execute(
        FIND_TEMPLATES,
        tool_env(fake_clients(core=core), page=PAGE),
        {"query": "schools by bus"},
    )
    assert [template["id"] for template in result["templates"]] == [TEMPLATE]
    assert "note" not in result and "other_templates" not in result
    assert _listings(core) == [LISTING]


async def test_a_weak_hit_comes_with_the_other_usable_templates() -> None:
    """One template holds a word of the query, but its texts and the others'
    are in another language: the others come beside it, apart from the hits
    and without repeating them, so the hit does not hide a better fit."""
    rows = [
        _row(1, "Supermarkt Standorte"),
        {**_row(2, "Unterversorgungsbereiche"), "description": "Nahversorgung"},
        _row(3, "ÖV-Güteklassen"),
    ]
    core = _core(**{"GET /api/v2/template": _matching(rows)})
    result = await execute(
        FIND_TEMPLATES,
        tool_env(fake_clients(core=core), page=PAGE),
        {"query": "walking supermarkt"},
    )
    assert [t["name"] for t in result["templates"]] == ["Supermarkt Standorte"]
    assert [t["name"] for t in result["other_templates"]] == [
        "Unterversorgungsbereiche",
        "ÖV-Güteklassen",
    ]
    assert result["other_templates"][0]["description"] == "Nahversorgung"
    assert result["other_templates"][0]["inputs"][0]["key"] == "node:dataset-1"
    note = result["note"]
    assert "other_templates" in note and "2 more of the 3 workflow templates" in note
    assert "—" not in note and "–" not in note
    assert _listings(core) == [LISTING]


async def test_the_other_templates_fill_the_list_up_to_its_cap() -> None:
    rows = [_row(0, "Schulweg")] + [
        _row(n, f"Vorlage {n}") for n in range(1, MAX_LISTED_TEMPLATES + 5)
    ]
    core = _core(**{"GET /api/v2/template": _matching(rows)})
    result = await execute(
        FIND_TEMPLATES,
        tool_env(fake_clients(core=core), page=PAGE),
        {"query": "Schulweg"},
    )
    assert [t["name"] for t in result["templates"]] == ["Schulweg"]
    assert [t["name"] for t in result["other_templates"]] == [
        f"Vorlage {n}" for n in range(1, MAX_LISTED_TEMPLATES)
    ]
    assert (
        f"{MAX_LISTED_TEMPLATES - 1} more of the {MAX_LISTED_TEMPLATES + 5} "
        "workflow templates"
    ) in result["note"]


async def test_many_hits_come_without_the_other_templates() -> None:
    words = ["alpha", "beta", "gamma"]
    rows = [
        _row(10 * i + k, f"{word} {k}")
        for i, word in enumerate(words)
        for k in range(10)
    ]
    rows.append(_row(99, "Vorlage"))
    core = _core(**{"GET /api/v2/template": _matching(rows)})
    result = await execute(
        FIND_TEMPLATES,
        tool_env(fake_clients(core=core), page=PAGE),
        {"query": " ".join(words)},
    )
    # The searches found more than the list holds: the hits are no weak ones.
    assert len(result["templates"]) == MAX_TEMPLATES
    assert "other_templates" not in result and "note" not in result


async def test_the_hits_come_when_the_usable_templates_cannot_be_listed() -> None:
    search = _matching([TEMPLATE_ROW, _row(2, "Vorlage")])

    def respond(request: httpx.Request) -> httpx.Response:
        if "search" not in request.url.params:
            return httpx.Response(503, json={"detail": "busy"})
        return search(request)

    core = _core(**{"GET /api/v2/template": respond})
    result = await execute(
        FIND_TEMPLATES,
        tool_env(fake_clients(core=core), page=PAGE),
        {"query": "schools"},
    )
    assert [template["id"] for template in result["templates"]] == [TEMPLATE]
    assert "other_templates" not in result and "note" not in result


def _run_deps(core: Recorder) -> RunDeps:
    async def emit(event: Any) -> None:
        return None

    return RunDeps(
        message_id="m1", emit=emit, env=tool_env(fake_clients(core=core), page=PAGE)
    )


def _returned(messages: list[Any]) -> dict[str, Any]:
    return {
        part.tool_call_id: part.content
        for message in messages
        for part in getattr(message, "parts", [])
        if isinstance(part, ToolReturnPart)
    }


async def test_templates_are_searched_once_per_answer() -> None:
    """A second search in the same answer, with other words, gets the first
    one's result and a note, without asking core again: a rephrased query
    searches the same names and descriptions."""
    core = _core(**{"GET /api/v2/template": _matching([TEMPLATE_ROW])})
    script = ScriptedModel(
        [
            ("workflow_find_templates", {"query": "schools walking"}),
            ("workflow_find_templates", {"query": "Schulen zu Fuß"}),
        ]
    )
    await build_agent(script.model).run("hi", deps=_run_deps(core))
    assert _searched(core) == ["schools", "schools walking", "walking"]
    assert _listings(core) == [LISTING]
    first, again = _returned(script.requests[-1]).values()
    assert [template["id"] for template in first["templates"]] == [TEMPLATE]
    assert again == {**first, "repeated_call": TEMPLATES_SEARCHED}
    assert "already searched in this answer" in TEMPLATES_SEARCHED


async def test_two_searches_in_one_response_ask_core_once() -> None:
    """The calls of one response run concurrently: the search runs alone, so
    the second call finds the first one's result, also the list of templates
    when nothing matched."""
    core = _core(**{"GET /api/v2/template": _matching([_row(1, "Zentralität")])})

    async def search_slowly(env: ToolEnv, args: Any) -> Any:
        # A real core takes a while: two searches run together overlap here.
        await asyncio.sleep(0.05)
        return await FIND_TEMPLATES.run(env, args)

    def both_at_once(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        if any(isinstance(message, ModelResponse) for message in messages):
            return ModelResponse(parts=[TextPart(content="done")])
        return ModelResponse(
            parts=[
                ToolCallPart(
                    tool_name="workflow_find_templates",
                    args={"query": query},
                    tool_call_id=f"call-{n}",
                )
                for n, query in enumerate(("walking", "Erreichbarkeit"), start=1)
            ]
        )

    slow = dataclasses.replace(FIND_TEMPLATES, run=search_slowly)
    agent: Agent[RunDeps, str] = Agent(
        FunctionModel(both_at_once),
        deps_type=RunDeps,
        toolsets=[FunctionToolset([_tool(slow)], max_retries=3)],
    )
    result = await agent.run("hi", deps=_run_deps(core))
    # "walking" found nothing, so its call listed the templates: two requests.
    assert [r.url.params.get("search") for r in core.requests] == ["walking", None]
    returned = _returned(result.all_messages())
    assert [t["name"] for t in returned["call-1"]["templates"]] == ["Zentralität"]
    assert returned["call-2"] == {
        **returned["call-1"],
        "repeated_call": TEMPLATES_SEARCHED,
    }


async def test_a_template_found_by_several_searches_is_listed_once() -> None:
    rows = [_row(1, "Schools walking"), _row(2, "Walking to parks")]
    core = _core(**{"GET /api/v2/template": _matching(rows)})
    result = await execute(
        FIND_TEMPLATES,
        tool_env(fake_clients(core=core), page=PAGE),
        {"query": "schools walking"},
    )
    # The whole query's hits first, then each word's, in the query's order.
    assert [template["name"] for template in result["templates"]] == [
        "Schools walking",
        "Walking to parks",
    ]


async def test_at_most_max_templates_from_at_most_four_words() -> None:
    words = ["access", "schools", "walking", "parks", "shops", "doctors"]
    rows = [
        _row(10 * i + k, f"{word} {k}")
        for i, word in enumerate(words)
        for k in range(4)
    ]
    core = _core(**{"GET /api/v2/template": _matching(rows)})
    result = await execute(
        FIND_TEMPLATES,
        tool_env(fake_clients(core=core), page=PAGE),
        {"query": " ".join(words)},
    )
    assert len(result["templates"]) == MAX_TEMPLATES
    assert _searched(core) == sorted([" ".join(words), *words[:4]])


async def test_a_template_becomes_a_workflow_of_the_open_project() -> None:
    """The bindings go to core's use preview first; the bound workflow is
    checked as a draft is, and with nothing to fix it is created."""
    core, processes = _core(), _processes()
    result = await execute(
        CREATE_FROM_TEMPLATE,
        _env(core, processes),
        {"template_id": TEMPLATE, "bindings": {"node:dataset-1": 31}},
    )
    preview, use = [r for r in core.requests if r.method == "POST"]
    assert [preview.url.path, use.url.path] == [PREVIEW, USE]
    bindings = {"node:dataset-1": "e2000000-0000-0000-0000-000000000031"}
    assert json.loads(preview.content) == {"project_id": PROJECT, "bindings": bindings}
    assert json.loads(use.content) == {
        "project_id": PROJECT,
        "bindings": bindings,
        "description": CREATED_DESCRIPTION["en"]
        + "\n\n"
        + TEMPLATE_ROW["description"].strip(),
    }
    [check] = [r for r in processes.requests if r.url.path == "/workflows/check"]
    body = json.loads(check.content)
    assert body["project_id"] == PROJECT
    assert [node["id"] for node in body["nodes"]] == [
        "dataset-1",
        "dataset-2",
        "heat",
        "save",
    ]
    assert body["nodes"][0]["data"]["layerId"] == bindings["node:dataset-1"]
    assert body["edges"] == _bound_config(bindings)["edges"]
    assert check.headers["accept-language"] == "en"
    assert result == {
        "workflow": {
            "id": WORKFLOW_ID,
            "name": "Schools within walking distance",
            "project_id": PROJECT,
        },
        "open_issues": [],
        "groups": [
            {
                "items": [
                    {
                        "kind": "workflow",
                        "id": WORKFLOW_ID,
                        "project_id": PROJECT,
                        "name": "Schools within walking distance",
                    }
                ]
            }
        ],
    }


async def test_inputs_the_template_left_open_are_named() -> None:
    """An input left unbound stays open: the workflow is created, and the
    step without a layer comes back in open_issues, from the check of the
    workflow (the use's own list is not read)."""
    core = _core(
        **{
            f"POST /api/v2/template/{TEMPLATE}/use": {
                "project_id": PROJECT,
                "workflow_id": WORKFLOW_ID,
                "unresolved_inputs": [],
            }
        }
    )
    env = _env(core)
    result = await execute(CREATE_FROM_TEMPLATE, env, {"template_id": TEMPLATE})
    assert core.paths()[-1] == USE
    assert result["workflow"]["id"] == WORKFLOW_ID
    # A workflow this answer built: the step that answers may still run it.
    assert env.workflows_created == {WORKFLOW_ID}
    assert result["open_issues"] == [
        {
            "step": "Schools",
            "code": "layer_not_chosen",
            "message": "Schools: no layer is chosen.",
        }
    ]


async def test_an_input_the_check_does_not_report_is_still_named() -> None:
    """Processes checks nothing in a workflow without a tool step, so its
    unbound input is named from the preview's unresolved inputs."""
    config = _bound_config({})
    config["nodes"] = [config["nodes"][0], config["nodes"][3]]
    config["edges"] = [
        {"id": "e1", "source": "dataset-1", "target": "save", "targetHandle": "input"}
    ]
    preview = {
        "config": config,
        "unresolved_inputs": [TEMPLATE_ROW["inputs"][0]],
    }
    core = _core(**{f"POST {PREVIEW}": preview})
    processes = _processes(check=httpx.Response(200, json={"issues": []}))
    result = await execute(
        CREATE_FROM_TEMPLATE, _env(core, processes), {"template_id": TEMPLATE}
    )
    assert core.paths()[-1] == USE
    assert result["open_issues"] == [
        {
            "step": "Schools",
            "code": "layer_not_chosen",
            "message": "Schools: no layer is chosen.",
        }
    ]


TOO_MANY = (
    "too_many_destinations",
    "heat",
    "the opportunity layers without a filter have 2,400,000 features together, "
    "more than the 1,000,000 the heatmap takes. Limit them to an area or with a "
    "filter.",
    None,
)


async def test_a_binding_the_check_refuses_creates_nothing() -> None:
    """Bound to a layer with more destinations than the heatmap takes, the
    workflow could not run: nothing is created, and the model is told the
    issue and what to do instead."""
    core, processes = _core(), _processes(TOO_MANY)
    with pytest.raises(InputInvalid) as caught:
        await execute(
            CREATE_FROM_TEMPLATE,
            _env(core, processes),
            {"template_id": TEMPLATE, "bindings": {"node:dataset-1": 31}},
        )
    message = caught.value.message
    assert message.startswith("Not created: 1 issue(s) must be fixed first.")
    # Named as the editor names the step: by its tool's title.
    assert "Heatmap Gravity: the opportunity layers without a filter" in message
    assert "Bind another layer" in message
    assert "filter.area" in message
    assert "workflow_create" in message
    assert USE not in core.paths()


@pytest.mark.parametrize(
    ("issue", "bindings"),
    [
        # The shipped districts: no binding reaches that step.
        (("setting_invalid", "dataset-2", "the filter does not fit.", "filter"), 31),
        # The whole workflow.
        (
            ("connection_to_removed_step", None, "A connection points nowhere.", None),
            None,
        ),
    ],
)
async def test_an_issue_no_binding_causes_says_the_template_cannot_be_used(
    issue: tuple[str, str | None, str, str | None], bindings: int | None
) -> None:
    """Binding another layer cannot fix the template's own issues: the
    model is told to use another template or build a draft."""
    core = _core()
    args: dict[str, Any] = {"template_id": TEMPLATE}
    if bindings is not None:
        args["bindings"] = {"node:dataset-1": bindings}
    with pytest.raises(ToolFailed) as caught:
        await execute(CREATE_FROM_TEMPLATE, _env(core, _processes(issue)), args)
    message = caught.value.message
    assert message.startswith("Not created: 1 issue(s) must be fixed first.")
    assert issue[2] in message
    assert "cannot be used as it is" in message
    assert "workflow_find_templates" in message
    assert "workflow_create" in message
    assert "Bind another layer" not in message
    assert USE not in core.paths()


async def test_a_damaged_template_workflow_is_not_an_input_error() -> None:
    """Processes refusing the template's config is the author's to fix, not
    the model's: it says so and suggests another template or a draft."""
    core = _core()
    refused = httpx.Response(422, json={"detail": "A workflow node is malformed"})
    with pytest.raises(ToolFailed) as caught:
        await execute(
            CREATE_FROM_TEMPLATE,
            _env(core, _processes(check=refused)),
            {"template_id": TEMPLATE, "bindings": {"node:dataset-1": 31}},
        )
    message = caught.value.message
    assert message.startswith("Not created: the template's workflow is damaged")
    assert "A workflow node is malformed" in message
    assert "workflow_find_templates" in message
    assert "workflow_create" in message
    assert USE not in core.paths()


@pytest.mark.parametrize(
    ("bindings", "created"),
    [({}, True), ({"node:dataset-1": 31}, False)],
)
async def test_an_issue_of_the_layer_still_to_choose_stays_open(
    bindings: dict[str, int], created: bool
) -> None:
    """The gate of workflow_create: a setting of the heatmap's opportunity
    on the schools' handle stays open while the schools input is unbound,
    since choosing the layer can resolve it; with the input bound it blocks."""
    rejected = (
        "setting_invalid",
        "heat",
        "the potential field does not fit.",
        "opportunity_1_potential_field",
    )
    core, processes = _core(), _processes(rejected)
    args = {"template_id": TEMPLATE, "bindings": bindings}
    if not created:
        with pytest.raises(InputInvalid, match="the potential field does not fit"):
            await execute(CREATE_FROM_TEMPLATE, _env(core, processes), args)
        assert USE not in core.paths()
        return
    result = await execute(CREATE_FROM_TEMPLATE, _env(core, processes), args)
    assert core.paths()[-1] == USE
    assert [issue["code"] for issue in result["open_issues"]] == [
        "layer_not_chosen",
        "setting_invalid",
    ]
    assert result["open_issues"][1] == {
        "step": "Heatmap Gravity",
        "code": "setting_invalid",
        "message": "Heatmap Gravity: the potential field does not fit.",
    }


@pytest.mark.parametrize(
    ("copy_content", "bound", "steps", "refused"),
    [
        # An empty copy: its dataset stays the author's, and the copy job
        # points the step at the user's copy once it is made.
        (False, False, ("dataset-2",), None),
        # The heatmap it feeds names another layer the user cannot read: core's
        # preview clears the settings naming the copy's dataset by entry, so
        # the issue is that other layer's.
        (False, False, ("dataset-2", "heat"), InputInvalid),
        # A step it does not feed has a reason of its own.
        (False, False, ("dataset-2", "save"), InputInvalid),
        # A copy with its rows is readable by whoever may read the template:
        # the template cannot be used as it is.
        (True, False, ("dataset-2",), ToolFailed),
        # Bound to a layer of the user's: no copy is made.
        (False, True, ("dataset-2",), InputInvalid),
    ],
)
async def test_a_step_reading_an_empty_copy_waits_for_the_copy(
    copy_content: bool,
    bound: bool,
    steps: tuple[str, ...],
    refused: type[Exception] | None,
) -> None:
    """Until the copy is made, the districts step reads the template's own
    dataset, which the user may not read; that is no issue of theirs, nor of
    the step it feeds."""
    districts = {
        **TEMPLATE_ROW["inputs"][1],
        "mode": "copy",
        "copy_content": copy_content,
        "layer_id": SHIPPED,
    }
    row = {**TEMPLATE_ROW, "inputs": [TEMPLATE_ROW["inputs"][0], districts]}
    core = _core(**{f"GET /api/v2/template/{TEMPLATE}": row})
    unreadable = [
        ("layer_not_readable", step, "the layer cannot be read with your access.", None)
        for step in steps
    ]
    bindings = {"node:dataset-1": 31}
    if bound:
        # The preview fake keeps the districts on the template's dataset.
        bindings["node:dataset-2"] = 31
    args = {"template_id": TEMPLATE, "bindings": bindings}
    env = _env(core, _processes(*unreadable))
    if refused is not None:
        with pytest.raises(refused, match="cannot be read with your access"):
            await execute(CREATE_FROM_TEMPLATE, env, args)
        assert USE not in core.paths()
        return
    result = await execute(CREATE_FROM_TEMPLATE, env, args)
    assert core.paths()[-1] == USE
    assert result["open_issues"] == []


@pytest.mark.parametrize(
    "check",
    [
        httpx.Response(503, json={"detail": "busy"}),
        httpx.Response(200, json={"unexpected": True}),
    ],
)
async def test_a_template_that_cannot_be_checked_is_not_created(check: Any) -> None:
    core = _core()
    with pytest.raises(ToolFailed) as caught:
        await execute(
            CREATE_FROM_TEMPLATE,
            _env(core, _processes(check=check)),
            {"template_id": TEMPLATE, "bindings": {"node:dataset-1": 31}},
        )
    assert caught.value.message == TEMPLATE_NOT_CHECKED
    assert USE not in core.paths()


async def test_a_template_whose_tools_cannot_be_described_is_not_created() -> None:
    processes = _processes()
    processes.routes[("GET", "/processes/heatmap_gravity")] = httpx.Response(
        503, json={"detail": "busy"}
    )
    core = _core()
    with pytest.raises(ToolFailed) as caught:
        await execute(
            CREATE_FROM_TEMPLATE,
            _env(core, processes),
            {"template_id": TEMPLATE, "bindings": {"node:dataset-1": 31}},
        )
    assert caught.value.message == TEMPLATE_NOT_CHECKED
    assert "/workflows/check" not in processes.paths()
    assert USE not in core.paths()


#: A template another user saved, every text far longer than a template needs.
OVERSIZED = {
    **TEMPLATE_ROW,
    "name": "Schools " * 200,
    "categories": [f"Category {n} " + "x" * 300 for n in range(30)],
    # A key longer than a binding takes comes first: it is never listed.
    "inputs": [{"key": "node:" + "k" * 300, "label": "Too long a key", "mode": "ask"}]
    + [
        {"key": f"node:dataset-{n:02}", "label": "Schools " * 100, "mode": "ask"}
        for n in range(30)
    ],
}


async def test_template_text_reaches_the_model_short() -> None:
    core = _core(**{"GET /api/v2/template": {"items": [OVERSIZED], "total": 1}})
    result = await execute(
        FIND_TEMPLATES,
        tool_env(fake_clients(core=core), page=PAGE),
        {"query": "schools"},
    )
    [template] = result["templates"]
    assert len(template["name"]) <= 200
    assert 0 < len(template["categories"]) <= 10
    assert all(len(category) <= 80 for category in template["categories"])
    assert 0 < len(template["inputs"]) <= 20
    assert all(len(item["label"]) <= 80 for item in template["inputs"])
    assert all(len(item["key"]) <= 200 for item in template["inputs"])


async def test_template_text_in_a_refusal_and_open_issues_is_short() -> None:
    long_label = {**OVERSIZED["inputs"][1], "label": "Schools " * 100}
    core = _core(
        **{
            f"GET /api/v2/template/{TEMPLATE}": OVERSIZED,
            # The step's label in the template's workflow is just as long.
            f"POST {PREVIEW}": _preview(label="Schools " * 100),
            f"POST /api/v2/template/{TEMPLATE}/use": {
                "project_id": PROJECT,
                "workflow_id": WORKFLOW_ID,
                "unresolved_inputs": [long_label],
            },
        }
    )
    env = _env(core)
    with pytest.raises(InputInvalid) as caught:
        await execute(
            CREATE_FROM_TEMPLATE, env, {"template_id": TEMPLATE, "bindings": {"x": 31}}
        )
    assert "node:dataset-19" in caught.value.message
    assert "node:dataset-20" not in caught.value.message
    assert "k" * 300 not in caught.value.message
    # A key past the first twenty listed is still the template's own.
    result = await execute(
        CREATE_FROM_TEMPLATE,
        env,
        {"template_id": TEMPLATE, "bindings": {"node:dataset-25": 31}},
    )
    assert json.loads(core.requests[-1].content)["bindings"] == {
        "node:dataset-25": "e2000000-0000-0000-0000-000000000031"
    }
    assert len(result["workflow"]["name"]) <= 200
    [issue] = result["open_issues"]
    assert len(issue["step"]) <= 80
    assert len(issue["message"]) <= 80 + len(": no layer is chosen.")
    # A refusal quotes the check's messages clipped too: here one about the
    # step of the shipped districts, whose layer is chosen.
    blocked = ("setting_invalid", "dataset-2", "Schools " * 100, "filter")
    with pytest.raises(ToolFailed) as refused:
        await execute(
            CREATE_FROM_TEMPLATE,
            _env(core, _processes(blocked)),
            {"template_id": TEMPLATE, "bindings": {"node:dataset-25": 31}},
        )
    assert refused.value.message.startswith("Not created: 1 issue(s)")
    assert "Schools " * 60 not in refused.value.message
    assert len(refused.value.message) < 1000


COPY_JOB = {
    "key": "node:dataset-2",
    "source_layer_id": "e2000000-0000-0000-0000-000000000077",
    "layer_project_ids": [53],
    "copy_content": True,
    "job_id": "job-1",
}


@pytest.mark.parametrize(
    ("added", "jobs", "ids", "copying"),
    [
        ([52], [], "52", False),
        ([], [COPY_JOB], "53", True),
        ([52, 53], [COPY_JOB], "52, 53", True),
        # A copy core could not start is not being made; its layer was added.
        (
            [53],
            [{**COPY_JOB, "job_id": None, "error": "copy_not_started"}],
            "53",
            False,
        ),
    ],
)
async def test_layers_the_template_added_are_named(
    added: list[int], jobs: list[dict[str, Any]], ids: str, copying: bool
) -> None:
    """Core links the template's shipped datasets into the project and starts
    copies of the copied ones: the answer says so, the audit keeps the workflow."""
    core = _core(
        **{
            f"POST /api/v2/template/{TEMPLATE}/use": {
                "project_id": PROJECT,
                "workflow_id": WORKFLOW_ID,
                "added_layer_project_ids": added,
                "unresolved_inputs": [],
                "copy_jobs": jobs,
            }
        }
    )
    result = await execute(
        CREATE_FROM_TEMPLATE,
        _env(core),
        {"template_id": TEMPLATE},
    )
    [note] = result["notes"]
    assert f"(layer_project_ids {ids})" in note
    assert "project_get_layers" in note
    assert ("in the background" in note) is copying
    assert WorkflowCreated.model_validate(result).created() == {
        "kind": "workflow",
        "ids": [WORKFLOW_ID],
        "project_id": PROJECT,
    }


@pytest.mark.parametrize(
    ("layer", "message"),
    [(36, "no access to its data"), (99, "no layer 99 in the project")],
)
async def test_a_binding_must_be_a_readable_project_layer(
    layer: int, message: str
) -> None:
    core = _core()
    with pytest.raises(InputInvalid, match=message):
        await execute(
            CREATE_FROM_TEMPLATE,
            _env(core),
            {"template_id": TEMPLATE, "bindings": {"node:dataset-1": layer}},
        )
    assert [r.method for r in core.requests] == ["GET", "GET"]


@pytest.mark.parametrize(
    ("route", "status"),
    [
        # Not shared with the user: core's authz answers 403 on the read.
        (f"GET /api/v2/template/{TEMPLATE}", 403),
        # A viewer of the project: 401 from core's route check, 403 from
        # authz, on the preview already or on the use.
        (f"POST {PREVIEW}", 401),
        (f"POST {PREVIEW}", 403),
        (f"POST {USE}", 401),
        (f"POST {USE}", 403),
    ],
)
async def test_a_template_the_user_may_not_use_is_refused_without_retry(
    route: str, status: int
) -> None:
    core = _core(**{route: httpx.Response(status, json={"detail": "Unauthorized"})})
    with pytest.raises(ToolFailed) as caught:
        await execute(
            CREATE_FROM_TEMPLATE,
            _env(core),
            {"template_id": TEMPLATE},
        )
    assert caught.value.message == TEMPLATE_REFUSED
    # The refused request is the last one: no use after a refused read or
    # preview, and no second use after a refused one.
    method, path = route.split(" ", 1)
    assert (core.requests[-1].method, core.requests[-1].url.path) == (method, path)
    assert core.paths().count(USE) == (path == USE)


@pytest.mark.parametrize("name", [None, "Walk to school"])
async def test_the_workflow_is_named_without_a_call_after_the_write(
    name: str | None,
) -> None:
    """Core names the workflow ``name`` or the template's. Nothing is read
    after the write, so a failing read cannot hide a workflow that exists."""
    core = _core()
    args: dict[str, Any] = {"template_id": TEMPLATE}
    if name is not None:
        args["name"] = name
    result = await execute(CREATE_FROM_TEMPLATE, _env(core), args)
    assert core.requests[-1].method == "POST"
    assert result["workflow"]["name"] == (name or "Schools within walking distance")
    body = json.loads(core.requests[-1].content)
    assert body.get("name") == name


CREATED_TEXTS = [
    (
        "en",
        "Created with the GOAT AI assistant. Check the steps and settings before "
        "you use the results.",
    ),
    (
        "de",
        "Mit dem GOAT KI-Assistenten erstellt. Prüfen Sie Schritte und "
        "Einstellungen, bevor Sie die Ergebnisse verwenden.",
    ),
]


@pytest.mark.parametrize(("locale", "notice"), CREATED_TEXTS)
async def test_the_workflow_says_the_assistant_made_it_before_the_templates_text(
    locale: Locale, notice: str
) -> None:
    """The notice in the interface language comes first; the template's
    own description stays, after a blank line."""
    own = "Schools within 15 minutes on foot.\nThe districts ship with it."
    core = _core(
        **{f"GET /api/v2/template/{TEMPLATE}": {**TEMPLATE_ROW, "description": own}}
    )
    env = tool_env(
        fake_clients(core=core, processes=_processes()), page=PAGE, locale=locale
    )
    await execute(CREATE_FROM_TEMPLATE, env, {"template_id": TEMPLATE})
    body = json.loads(core.requests[-1].content)
    assert core.requests[-1].url.path == USE
    assert body["description"] == f"{notice}\n\n{own}"


@pytest.mark.parametrize(("locale", "notice"), CREATED_TEXTS)
@pytest.mark.parametrize("own", [None, "", "  \n "])
async def test_a_template_without_a_description_gets_the_notice_alone(
    locale: Locale, notice: str, own: str | None
) -> None:
    core = _core(
        **{f"GET /api/v2/template/{TEMPLATE}": {**TEMPLATE_ROW, "description": own}}
    )
    env = tool_env(
        fake_clients(core=core, processes=_processes()), page=PAGE, locale=locale
    )
    await execute(CREATE_FROM_TEMPLATE, env, {"template_id": TEMPLATE})
    assert json.loads(core.requests[-1].content)["description"] == notice


@pytest.mark.parametrize("kind", ["layout", "project"])
async def test_only_a_workflow_template_is_used(kind: str) -> None:
    """Core puts a layout template into the project's layouts: refused
    before anything is written."""
    core = _core(
        **{f"GET /api/v2/template/{TEMPLATE}": {**TEMPLATE_ROW, "payload_kind": kind}}
    )
    with pytest.raises(InputInvalid, match=f"is a {kind} template"):
        await execute(
            CREATE_FROM_TEMPLATE,
            _env(core),
            {"template_id": TEMPLATE},
        )
    assert "POST" not in [r.method for r in core.requests]


async def test_a_template_of_unknown_kind_is_refused_without_naming_one() -> None:
    row = {key: value for key, value in TEMPLATE_ROW.items() if key != "payload_kind"}
    core = _core(**{f"GET /api/v2/template/{TEMPLATE}": row})
    with pytest.raises(InputInvalid) as caught:
        await execute(
            CREATE_FROM_TEMPLATE,
            _env(core),
            {"template_id": TEMPLATE},
        )
    assert caught.value.message.startswith("Only workflow templates can be used")
    assert "None" not in caught.value.message
    assert "POST" not in [r.method for r in core.requests]


async def test_a_binding_must_name_an_input_of_the_template() -> None:
    """Core ignores a key the template does not have, so the input would be
    left open and a corrected call would make a second workflow."""
    core = _core()
    with pytest.raises(InputInvalid, match="node:dataset-1, node:dataset-2"):
        await execute(
            CREATE_FROM_TEMPLATE,
            _env(core),
            {"template_id": TEMPLATE, "bindings": {"node:dataset-7": 31}},
        )
    assert "POST" not in [r.method for r in core.requests]


async def test_an_unknown_template_goes_back_to_the_model() -> None:
    core = _core(
        **{
            f"GET /api/v2/template/{TEMPLATE}": httpx.Response(
                404, json={"detail": "Template not found"}
            )
        }
    )
    with pytest.raises(InputInvalid, match="workflow_find_templates"):
        await execute(
            CREATE_FROM_TEMPLATE,
            _env(core),
            {"template_id": TEMPLATE},
        )
    assert "POST" not in [r.method for r in core.requests]


async def test_a_catalog_dataset_is_added_only_after_the_users_pick() -> None:
    core = _core()
    without = tool_env(fake_clients(core=core), page=PAGE)
    with pytest.raises(ToolFailed) as caught:
        await execute(
            ADD_CATALOG_LAYER, without, {"catalog_id": "eval-supermaerkte-bayern"}
        )
    assert caught.value.message == NO_CONSENT
    assert core.requests == []


async def test_without_a_project_the_model_is_not_told_to_ask() -> None:
    """Asking for consent is pointless while there is no project to add to."""
    core = _core()
    with pytest.raises(ToolFailed) as caught:
        await execute(
            ADD_CATALOG_LAYER,
            tool_env(fake_clients(core=core)),
            {"catalog_id": "eval-supermaerkte-bayern"},
        )
    assert caught.value.message == NO_PROJECT
    assert core.requests == []


async def test_a_picked_catalog_dataset_is_added_by_its_id() -> None:
    core = _core()
    env = tool_env(fake_clients(core=core), page=PAGE)
    env.asks = PICKED
    result = await execute(
        ADD_CATALOG_LAYER, env, {"catalog_id": "eval-supermaerkte-bayern"}
    )
    [request] = core.requests
    assert request.url.path == f"/api/v2/project/{PROJECT}/layer-catalog"
    assert request.url.params.get_list("catalog_ids") == ["eval-supermaerkte-bayern"]
    assert result["layers"] == [
        {
            "layer_project_id": 41,
            "name": "Supermärkte Bayern",
            "type": "feature",
            "geometry_type": "point",
        }
    ]


async def test_a_typed_reply_does_not_add_a_dataset() -> None:
    """Review Focus 3: the card was shown and the user typed, not picked."""
    core = _core()
    env = tool_env(fake_clients(core=core), page=PAGE)
    env.asks = AskHistory(cards={"ask-call-0-3": CARD})
    with pytest.raises(ToolFailed, match="has not picked this catalog dataset"):
        await execute(
            ADD_CATALOG_LAYER, env, {"catalog_id": "eval-supermaerkte-bayern"}
        )
    assert core.requests == []


async def test_the_id_typed_into_the_cards_free_text_is_no_pick() -> None:
    """The card's own free-text field is typed text too, whatever it says."""
    core = _core()
    env = tool_env(fake_clients(core=core), page=PAGE)
    env.asks = AskHistory(
        cards={"ask-call-0-3": CARD},
        answers={
            "ask-call-0-3": CardAnswer(
                card_id="ask-call-0-3",
                answers=[
                    QuestionAnswer(
                        question=0, options=[], other="eval-supermaerkte-bayern"
                    )
                ],
            )
        },
    )
    with pytest.raises(ToolFailed) as caught:
        await execute(
            ADD_CATALOG_LAYER, env, {"catalog_id": "eval-supermaerkte-bayern"}
        )
    assert caught.value.message == NO_CONSENT
    assert core.requests == []


def _picked(option: dict[str, Any]) -> AskHistory:
    """A card whose first option the user picked."""
    card = AskUserInput.model_validate(
        {
            "questions": [
                {
                    "question": "Which data should the workflow use?",
                    "header": "Data",
                    "options": [option, {"label": "Leave it open"}],
                }
            ]
        }
    )
    answer = CardAnswer(
        card_id="ask-c1", answers=[QuestionAnswer(question=0, options=[0])]
    )
    return AskHistory(cards={"ask-c1": card}, answers={"ask-c1": answer})


#: The catalog's answer for a bundle: its members under ``items``.
BUNDLE = {
    "kind": "collection",
    "collection": {"id": "cat_bundle", "title": "Population"},
    "items": [{"id": "cat_item_2"}, {"id": "cat_item_3"}],
    "goat:member_count": 2,
}


async def test_a_pick_with_adds_authorises_its_ids() -> None:
    core = _core()
    env = tool_env(fake_clients(core=core), page=PAGE)
    env.asks = _picked(
        {"label": "Population", "value": "population", "adds": ["cat_item_1"]}
    )
    out = await execute(ADD_CATALOG_LAYER, env, {"catalog_id": "cat_item_1"})
    assert out["layers"]
    [request] = core.requests
    assert request.url.params.get_list("catalog_ids") == ["cat_item_1"]


async def test_a_picked_bundle_authorises_its_members() -> None:
    core = _core()
    catalog = Recorder({("GET", "/stac/resolve/cat_bundle"): BUNDLE})
    env = tool_env(fake_clients(core=core, catalog=catalog), page=PAGE)
    env.asks = _picked({"label": "Population", "value": "cat_bundle"})
    out = await execute(ADD_CATALOG_LAYER, env, {"catalog_id": "cat_item_2"})
    assert out["layers"]
    assert catalog.paths() == ["/stac/resolve/cat_bundle"]


async def test_a_slug_authorises_nothing() -> None:
    core = _core()
    catalog = Recorder(
        {
            ("GET", "/stac/resolve/population"): httpx.Response(
                404, json={"detail": "Catalog entry not found: population"}
            )
        }
    )
    env = tool_env(fake_clients(core=core, catalog=catalog), page=PAGE)
    env.asks = _picked({"label": "Population", "value": "population"})
    with pytest.raises(ToolFailed, match="not picked") as caught:
        await execute(ADD_CATALOG_LAYER, env, {"catalog_id": "cat_item_1"})
    assert caught.value.message == NO_CONSENT
    assert core.requests == []


async def test_a_picked_member_does_not_authorise_its_bundle() -> None:
    """A bundle's pick covers its members; one member's pick is that member."""
    core = _core()
    item = {
        "kind": "item",
        "item": {"id": "cat_item_2"},
        "collection_id": "cat_bundle",
    }
    catalog = Recorder({("GET", "/stac/resolve/cat_item_2"): item})
    env = tool_env(fake_clients(core=core, catalog=catalog), page=PAGE)
    env.asks = _picked({"label": "Population", "value": "cat_item_2"})
    with pytest.raises(ToolFailed) as caught:
        await execute(ADD_CATALOG_LAYER, env, {"catalog_id": "cat_bundle"})
    assert caught.value.message == NO_CONSENT
    assert core.requests == []


async def test_a_value_that_is_no_catalog_id_is_not_looked_up() -> None:
    """A value is any short key; only ids are sent to the catalog."""
    core = _core()
    catalog = Recorder()
    env = tool_env(fake_clients(core=core, catalog=catalog), page=PAGE)
    for value in ("..", "two words", "run:0b6f0000-0000-0000-0000-00000000f10f"):
        env.asks = _picked({"label": "Population", "value": value})
        with pytest.raises(ToolFailed) as caught:
            await execute(ADD_CATALOG_LAYER, env, {"catalog_id": "cat_item_1"})
        assert caught.value.message == NO_CONSENT
    assert catalog.requests == []
    assert core.requests == []


def _many_picks(*values: str) -> AskHistory:
    """One answered card per value, answered in this order, each picking the
    option with that value."""
    cards: dict[str, AskUserInput] = {}
    answers: dict[str, CardAnswer] = {}
    for n, value in enumerate(values):
        card_id = f"ask-c{n}"
        cards[card_id] = AskUserInput.model_validate(
            {
                "questions": [
                    {
                        "question": "Which one?",
                        "header": "Data",
                        "options": [
                            {"label": "Picked", "value": value},
                            {"label": "Not now", "value": "no"},
                        ],
                    }
                ]
            }
        )
        answers[card_id] = CardAnswer(
            card_id=card_id, answers=[QuestionAnswer(question=0, options=[0])]
        )
    return AskHistory(cards=cards, answers=answers)


async def test_the_newest_bundle_pick_is_looked_up_first() -> None:
    """More picks than bundle lookups: run values and other picks do not
    crowd out the bundle picked last."""
    core = _core()
    catalog = Recorder({("GET", "/stac/resolve/cat_bundle"): BUNDLE})
    env = tool_env(fake_clients(core=core, catalog=catalog), page=PAGE)
    earlier = [
        *(str(n) for n in range(31, 39)),
        *(str(UUID(int=n)) for n in range(1, 5)),
        *(f"run:{UUID(int=n)}" for n in range(5, 9)),
    ]
    env.asks = _many_picks(*earlier, "cat_bundle")
    out = await execute(ADD_CATALOG_LAYER, env, {"catalog_id": "cat_item_2"})
    assert out["layers"]
    looked_up = catalog.paths()
    assert "/stac/resolve/cat_bundle" in looked_up
    assert len(looked_up) <= MAX_BUNDLE_LOOKUPS
    assert not any("run" in path for path in looked_up)


async def test_a_viewer_cannot_add_a_dataset() -> None:
    core = _core(
        **{
            f"POST /api/v2/project/{PROJECT}/layer-catalog": httpx.Response(
                403, json={"detail": "editor access"}
            )
        }
    )
    env = tool_env(fake_clients(core=core), page=PAGE)
    env.asks = PICKED
    with pytest.raises(ToolFailed) as caught:
        await execute(
            ADD_CATALOG_LAYER, env, {"catalog_id": "eval-supermaerkte-bayern"}
        )
    assert caught.value.message == VIEWER_LAYERS


@pytest.mark.parametrize(
    ("expires_in", "message"),
    [
        (-60, SIGN_IN_EXPIRED),
        # Core answers 401 also when its authorization denies the request.
        (300, VIEWER_LAYERS),
    ],
)
async def test_an_expired_sign_in_is_no_missing_right_to_add(
    expires_in: float, message: str
) -> None:
    core = _core(
        **{
            f"POST /api/v2/project/{PROJECT}/layer-catalog": httpx.Response(
                401, json={"detail": "Unauthorized"}
            )
        }
    )
    env = tool_env(fake_clients(core=core), page=PAGE, login=signed_in(expires_in))
    env.asks = PICKED
    with pytest.raises(ToolFailed) as caught:
        await execute(
            ADD_CATALOG_LAYER, env, {"catalog_id": "eval-supermaerkte-bayern"}
        )
    assert caught.value.message == message


async def test_an_unknown_catalog_dataset_goes_back_to_the_model() -> None:
    core = _core(
        **{
            f"POST /api/v2/project/{PROJECT}/layer-catalog": httpx.Response(
                404, json={"detail": "Catalog item not found: eval-supermaerkte-bayern"}
            )
        }
    )
    env = tool_env(fake_clients(core=core), page=PAGE)
    env.asks = PICKED
    with pytest.raises(InputInvalid, match="The catalog has no dataset"):
        await execute(
            ADD_CATALOG_LAYER, env, {"catalog_id": "eval-supermaerkte-bayern"}
        )


OWN_DATASET = "bd000000-0000-0000-0000-0000000000d1"


async def test_a_dataset_of_the_users_own_is_sent_to_its_add_tool() -> None:
    """A dataset id from core_find given to the catalog's add tool: the
    error names the tool that adds it."""
    core = _core(
        **{
            f"POST /api/v2/project/{PROJECT}/layer-catalog": httpx.Response(
                404, json={"detail": f"Catalog item not found: {OWN_DATASET}"}
            ),
            f"GET /api/v2/layer/{OWN_DATASET}": {"id": OWN_DATASET, "name": "Classes"},
        }
    )
    env = tool_env(fake_clients(core=core), page=PAGE)
    env.asks = _picked({"label": "Classes", "value": "classes", "adds": [OWN_DATASET]})
    with pytest.raises(InputInvalid) as caught:
        await execute(ADD_CATALOG_LAYER, env, {"catalog_id": OWN_DATASET})
    assert caught.value.message == own_dataset(OWN_DATASET)
    assert "project_add_dataset adds it" in caught.value.message


@pytest.mark.parametrize("status", [403, 404])
async def test_an_id_core_cannot_read_stays_unknown_to_the_catalog(
    status: int,
) -> None:
    """Another user's private dataset (403) reads as an unknown id (404)."""
    core = _core(
        **{
            f"POST /api/v2/project/{PROJECT}/layer-catalog": httpx.Response(
                404, json={"detail": f"Catalog item not found: {OWN_DATASET}"}
            ),
            f"GET /api/v2/layer/{OWN_DATASET}": httpx.Response(
                status, json={"detail": "no"}
            ),
        }
    )
    env = tool_env(fake_clients(core=core), page=PAGE)
    env.asks = _picked({"label": "Classes", "value": OWN_DATASET})
    with pytest.raises(InputInvalid) as caught:
        await execute(ADD_CATALOG_LAYER, env, {"catalog_id": OWN_DATASET})
    assert caught.value.message == f"The catalog has no dataset {OWN_DATASET!r}."


async def test_an_id_that_is_no_uuid_is_not_looked_up_in_core() -> None:
    """The user's datasets have UUIDs: another id is no dataset of theirs."""
    core = _core(
        **{
            f"POST /api/v2/project/{PROJECT}/layer-catalog": httpx.Response(
                404, json={"detail": "Catalog item not found: eval-supermaerkte-bayern"}
            )
        }
    )
    env = tool_env(fake_clients(core=core), page=PAGE)
    env.asks = PICKED
    with pytest.raises(InputInvalid):
        await execute(
            ADD_CATALOG_LAYER, env, {"catalog_id": "eval-supermaerkte-bayern"}
        )
    assert [request.method for request in core.requests] == ["POST"]


async def test_a_project_that_is_gone_is_not_an_unknown_dataset() -> None:
    """Core answers 404 for a trashed project too."""
    core = _core(
        **{
            f"POST /api/v2/project/{PROJECT}/layer-catalog": httpx.Response(
                404, json={"detail": "Project not found"}
            )
        }
    )
    env = tool_env(fake_clients(core=core), page=PAGE)
    env.asks = PICKED
    with pytest.raises(ToolFailed) as caught:
        await execute(
            ADD_CATALOG_LAYER, env, {"catalog_id": "eval-supermaerkte-bayern"}
        )
    assert caught.value.message == NOT_READABLE


async def test_a_card_answer_lets_the_next_run_add_the_dataset(
    repo: Repository, settings: AssistantSettings
) -> None:
    """The consent travels from the stored card and answer into the tool."""
    core = _core()
    model = TurnModel(
        [
            ([("ask_user", CARD_ARGS)], "I asked which supermarkets to use."),
            (
                [
                    (
                        "project_add_catalog_layer",
                        {"catalog_id": "eval-supermaerkte-bayern"},
                    )
                ],
                "Added.",
            ),
        ]
    )
    manager = RunManager(
        repo,
        InMemoryEventBus(),
        settings,
        owner="a",
        agent_factory=lambda _: build_agent(model.model),
        tool_services=fake_clients(core=core),
    )
    conversation = await repo.create_conversation(USER, "project.workflows", None, None)
    conversation_id = UUID(str(conversation["id"]))
    run_id, _ = await manager.start_run(
        conversation_id, USER, "Build a workflow about supermarkets", PAGE
    )
    await manager.wait(run_id)
    assert core.requests == []
    # The server mints the card id; the web answers the id the stored card has.
    [card_id] = AskHistory.from_stored(
        await repo.list_messages(conversation_id, None)
    ).cards
    answer = CardAnswer(
        card_id=card_id, answers=[QuestionAnswer(question=0, options=[0])]
    )
    run_id, _ = await manager.start_run(
        conversation_id, USER, "Shops: Supermarkets Bavaria", PAGE, answer=answer
    )
    await manager.wait(run_id)
    assert [request.url.path for request in core.requests] == [
        f"/api/v2/project/{PROJECT}/layer-catalog"
    ]


async def test_a_dataset_added_again_in_the_conversation_is_added_once(
    repo: Repository, settings: AssistantSettings
) -> None:
    """Review Focus 1 for datasets: a repeat in the same answer and a "try
    again" in a later one get the first result."""
    core = _core()
    add = ("project_add_catalog_layer", {"catalog_id": "eval-supermaerkte-bayern"})
    model = TurnModel(
        [
            ([("ask_user", CARD_ARGS)], "I asked which supermarkets to use."),
            ([add, add], "Added."),
            ([add], "It is in the project."),
        ]
    )
    manager = RunManager(
        repo,
        InMemoryEventBus(),
        settings,
        owner="a",
        agent_factory=lambda _: build_agent(model.model),
        tool_services=fake_clients(core=core),
    )
    conversation = await repo.create_conversation(USER, "project.workflows", None, None)
    conversation_id = UUID(str(conversation["id"]))

    async def say(text: str, answer: CardAnswer | None = None) -> None:
        run_id, _ = await manager.start_run(
            conversation_id, USER, text, PAGE, answer=answer
        )
        await manager.wait(run_id)

    await say("Build a workflow about supermarkets")
    [card_id] = AskHistory.from_stored(
        await repo.list_messages(conversation_id, None)
    ).cards
    picked = CardAnswer(
        card_id=card_id, answers=[QuestionAnswer(question=0, options=[0])]
    )
    await say("Shops: Supermarkets Bavaria", picked)
    await say("Add it again")
    assert [request.method for request in core.requests] == ["POST"]
    outputs = [
        part["output"]
        for message in await repo.list_messages(conversation_id, None)
        for part in message["parts"]
        if part.get("tool_name") == "project_add_catalog_layer"
    ]
    first, *repeats = outputs
    assert [41] == [layer["layer_project_id"] for layer in first["layers"]]
    assert repeats == [{**first, "repeated_call": REPEATED_WRITE}] * 2


async def test_a_word_is_searched_once_whatever_its_case() -> None:
    core = _core(**{"GET /api/v2/template": _matching([TEMPLATE_ROW])})
    env = tool_env(fake_clients(core=core), page=PAGE)
    await execute(FIND_TEMPLATES, env, {"query": "Schools schools SCHOOLS"})
    assert _searched(core) == ["Schools", "Schools schools SCHOOLS"]
    core = _core(**{"GET /api/v2/template": _matching([TEMPLATE_ROW])})
    env = tool_env(fake_clients(core=core), page=PAGE)
    await execute(FIND_TEMPLATES, env, {"query": "schools"})
    assert _searched(core) == ["schools"]
