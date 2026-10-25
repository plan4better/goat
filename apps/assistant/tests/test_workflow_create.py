"""workflow_check_draft and workflow_create (spec §4.3, §4.4, §9): the draft
is converted with the project's layers, checked by processes, mapped back to
the draft's ids, and created only when nothing but open steps remain."""

import json
from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx
import pytest
from pydantic_ai.exceptions import ToolFailed

from assistant.context import parse_context
from assistant.db import Database
from assistant.llm.types import DataPolicy
from assistant.login import Login
from assistant.repo import Repository
from assistant.tools.http import SIGN_IN_EXPIRED
from assistant.tools.policy import MIN_RESTRICTED_GROUP
from assistant.tools.runtime import InputInvalid, execute
from assistant.tools.testing import (
    Answer,
    Recorder,
    fake_clients,
    signed_in,
    tool_env,
)
from assistant.tools.workflow_tools import clear_description_cache
from assistant.tools.workflows import (
    CHECK_DRAFT,
    CHECK_UNAVAILABLE,
    CREATE,
    NOT_CHECKED,
    NOT_READABLE,
    VIEWER_WORKFLOWS,
    WorkflowCreated,
)

#: The toolbox (``GET /processes``) and the process descriptions
#: (``GET /processes/{id}``) captured from processes.
FIXTURE = Path(__file__).parent / "fixtures" / "process_descriptions.json"
PROCESSES: dict[str, Any] = json.loads(FIXTURE.read_text(encoding="utf-8"))
DESCRIPTIONS: dict[str, dict[str, Any]] = PROCESSES["descriptions"]
PROJECT = "00000000-0000-0000-0000-0000000005e4"
PAGE = parse_context({"surface": "project.workflows", "project_id": PROJECT})
WORKFLOW_ID = "0b6f0000-0000-0000-0000-00000000f10f"
LAYERS = [
    {
        "id": 31,
        "layer_id": "e2000000-0000-0000-0000-000000000031",
        "name": "Schulen",
        "type": "feature",
        "feature_layer_geometry_type": "point",
    },
    {
        "id": 33,
        "layer_id": "e2000000-0000-0000-0000-000000000033",
        "name": "Einwohner Raster",
        "type": "feature",
        "feature_layer_geometry_type": "polygon",
    },
    {
        "id": 36,
        "layer_id": "e2000000-0000-0000-0000-000000000036",
        "name": "Intern",
        "type": "feature",
        "locked": True,
    },
]
DRAFT: dict[str, Any] = {
    "name": "Schools: 15-minute walk",
    "steps": [
        {
            "id": "schools",
            "kind": "dataset",
            "label": "Schools",
            "layer": 31,
            "filter": {
                "area": "DE212",
                "where": [{"field": "schulart", "op": "=", "value": "Grundschule"}],
            },
        },
        {"id": "residents", "kind": "dataset", "layer": 33},
        {
            "id": "walk",
            "kind": "tool",
            "tool": "catchment_area_v2",
            "label": "15 minutes on foot",
            "settings": {"routing_mode": "walking", "max_cost": 15, "steps": 1},
        },
        {
            "id": "count",
            "kind": "tool",
            "tool": "aggregate_polygon",
            "settings": {
                "area_type": "polygon",
                "column_statistics": [{"operation": "sum", "field": "einwohner"}],
            },
        },
        {"id": "save", "kind": "export", "name": "Residents within 15 minutes"},
    ],
    "connections": [
        {"from": "schools", "to": "walk", "input": "starting_points"},
        {"from": "walk", "to": "count", "input": "area_layer_id"},
        {"from": "residents", "to": "count", "input": "source_layer_id"},
        {"from": "count", "to": "save"},
    ],
}
OPEN_DRAFT: dict[str, Any] = {
    "name": "Toilets: 5-minute walk",
    "steps": [
        {"id": "toilets", "kind": "dataset", "label": "Public toilets", "layer": None},
        {
            "id": "walk",
            "kind": "tool",
            "tool": "catchment_area_v2",
            "settings": {"routing_mode": "walking", "max_cost": 5},
        },
        {"id": "save", "kind": "export", "name": "Toilets within 5 minutes"},
    ],
    "connections": [
        {"from": "toilets", "to": "walk", "input": "starting_points"},
        {"from": "walk", "to": "save"},
    ],
}
#: processes' feature count, which the check asks for a catchment's start points.
FEATURE_COUNT = "/processes/feature-count/execution"
FEW_STARTS = {"count": 12}
MUNICH = {
    "type": "Feature",
    "properties": {
        "nuts_id": "DE212",
        "nuts_name": "München, Kreisfreie Stadt",
        "level": 3,
        "country": "DE",
    },
    "geometry": {
        "type": "Polygon",
        "coordinates": [
            [
                [11.36, 48.06],
                [11.72, 48.06],
                [11.72, 48.25],
                [11.36, 48.25],
                [11.36, 48.06],
            ]
        ],
    },
}


@pytest.fixture(autouse=True)
def _fresh_cache() -> Iterator[None]:
    clear_description_cache()
    yield
    clear_description_cache()


def _issue(
    code: str,
    step: str | None,
    message: str,
    level: str = "error",
    draft: dict[str, Any] = DRAFT,
    field: str | None = None,
) -> dict[str, Any]:
    """A row of processes' check about ``step`` of ``draft``. Each call
    converts with ids of its own, so the row holds the step's position in the
    draft, and the fake check names the node at that position of the config
    it checks (the steps come in draft order)."""
    positions = [item["id"] for item in draft["steps"]]
    return {
        "code": code,
        "level": level,
        "node_ids": [positions.index(step)] if step else [],
        "field": field,
        "message": message,
        "params": {},
        "source": "check",
    }


def _answer(issues: list[dict[str, Any]]) -> Any:
    """Processes' check answering ``issues`` with the node ids of the
    config it was sent."""

    def respond(request: httpx.Request) -> httpx.Response:
        nodes = json.loads(request.content)["nodes"]
        rows = [
            {**row, "node_ids": [nodes[index]["id"] for index in row["node_ids"]]}
            for row in issues
        ]
        return httpx.Response(200, json={"issues": rows})

    return respond


def _toolbox(
    *, extra: list[dict[str, Any]] | None = None, without: frozenset[str] = frozenset()
) -> Any:
    """``GET /processes`` for this user: the captured toolbox in the asked
    language, without the tools in ``without`` (processes leaves a beta tool
    out for a user outside the beta), with the rows of ``extra`` added."""

    def respond(request: httpx.Request) -> httpx.Response:
        language = "de" if request.headers.get("accept-language") == "de" else "en"
        rows = [row for row in PROCESSES["list"][language] if row["id"] not in without]
        return httpx.Response(
            200, json={"processes": [*rows, *(extra or [])], "links": []}
        )

    return respond


def _services(
    *,
    issues: list[dict[str, Any]] | None = None,
    check: Any = None,
    created: Any = None,
    queryables: Any = None,
    region: Any = MUNICH,
    descriptions: Mapping[str, Answer] | None = None,
    toolbox: Answer | None = None,
    count: Answer = FEW_STARTS,
) -> tuple[Recorder, Recorder, Recorder, Recorder]:
    """Fake services; processes lists the captured toolbox (or ``toolbox``)
    and describes the captured tools, or the tools of ``descriptions`` (tool
    id -> its answer) on top of them, and counts features with ``count``."""
    core = Recorder(
        {
            ("GET", f"/api/v2/project/{PROJECT}/layer"): LAYERS,
            ("POST", f"/api/v2/project/{PROJECT}/workflow"): created
            if created is not None
            else (
                lambda request: httpx.Response(
                    201,
                    json={
                        **json.loads(request.content),
                        "id": WORKFLOW_ID,
                        "project_id": PROJECT,
                    },
                )
            ),
        }
    )
    described = {**DESCRIPTIONS, **(descriptions or {})}
    processes = Recorder(
        {
            ("GET", "/processes"): toolbox if toolbox is not None else _toolbox(),
            **{
                ("GET", f"/processes/{tool}"): answer
                for tool, answer in described.items()
            },
            ("POST", "/workflows/check"): check
            if check is not None
            else _answer(issues or []),
            ("POST", FEATURE_COUNT): count,
        }
    )
    geoapi = Recorder(
        {
            (
                "GET",
                "/collections/e2000000-0000-0000-0000-000000000031/queryables",
            ): queryables
            if queryables is not None
            else {
                "properties": {
                    "name": {"type": "string"},
                    "schulart": {"type": "string"},
                    "geom": {"$ref": "geometry"},
                }
            },
        }
    )
    catalog = Recorder({("GET", "/stac/nuts/DE212/geometry"): region})
    return core, processes, geoapi, catalog


def _env(
    core: Recorder,
    processes: Recorder,
    geoapi: Recorder,
    catalog: Recorder,
    login: Login | None = None,
    data_policy: DataPolicy = "standard",
) -> Any:
    return tool_env(
        fake_clients(core=core, processes=processes, geoapi=geoapi, catalog=catalog),
        page=PAGE,
        login=login,
        data_policy=data_policy,
    )


async def test_check_converts_the_draft_and_maps_the_issues_back() -> None:
    core, processes, geoapi, catalog = _services(
        issues=[
            _issue(
                "setting_required",
                "count",
                "Aggregate Polygons: Area Type is required.",
            )
        ]
    )
    result = await execute(
        CHECK_DRAFT, _env(core, processes, geoapi, catalog), {"draft": DRAFT}
    )
    assert result == {
        "checked": True,
        "issues": [
            {
                "code": "setting_required",
                "level": "error",
                "steps": ["count"],
                "message": "Aggregate Polygons: Area Type is required.",
            }
        ],
        "blocking": 1,
        "open": 0,
    }
    [check] = [r for r in processes.requests if r.url.path == "/workflows/check"]
    body = json.loads(check.content)
    assert body["project_id"] == PROJECT
    assert [n["id"].split("-")[0] for n in body["nodes"]] == [
        s["kind"] for s in DRAFT["steps"]
    ]
    assert len({n["id"] for n in body["nodes"]}) == len(DRAFT["steps"])
    assert check.headers["accept-language"] == "en"
    assert core.paths() == [f"/api/v2/project/{PROJECT}/layer"]


#: Residents' cells joined to the district they lie in, then summed per
#: district by the field the join layer has, not the name the join gives it.
JOIN_DRAFT: dict[str, Any] = {
    "name": "Residents per district",
    "steps": [
        {"id": "cells", "kind": "dataset", "label": "Cells", "layer": 33},
        {"id": "districts", "kind": "dataset", "label": "Districts", "layer": 31},
        {
            "id": "joined",
            "kind": "tool",
            "tool": "join",
            "label": "District per cell",
            "settings": {
                "use_spatial_relationship": True,
                "spatial_relationship": "intersects",
                "join_operation": "one_to_one",
                "add_join_fields": True,
                "join_fields": ["district_name"],
            },
        },
        {
            "id": "sum",
            "kind": "tool",
            "tool": "aggregate_points",
            "label": "Residents per district",
            "settings": {
                "area_type": "polygon",
                "group_by_field": ["district_name"],
                "column_statistics": [{"operation": "sum", "field": "residents"}],
            },
        },
        {"id": "save", "kind": "export", "name": "Residents per district"},
    ],
    "connections": [
        {"from": "cells", "to": "joined", "input": "target_layer_id"},
        {"from": "districts", "to": "joined", "input": "join_layer_id"},
        {"from": "joined", "to": "sum", "input": "source_layer_id"},
        {"from": "districts", "to": "sum", "input": "area_layer_id"},
        {"from": "sum", "to": "save"},
    ],
}
#: Processes' check of a field the join before renamed.
RENAMED_BY_JOIN = (
    "Residents per district: Group Fields names the field district_name, which "
    "the step before does not produce: the join names it join_district_name."
)


async def test_a_field_the_join_renamed_reaches_the_model_and_stops_the_create() -> (
    None
):
    core, processes, geoapi, catalog = _services(
        issues=[
            _issue(
                "field_renamed_by_join",
                "sum",
                RENAMED_BY_JOIN,
                draft=JOIN_DRAFT,
                field="group_by_field",
            )
        ]
    )
    env = _env(core, processes, geoapi, catalog)
    result = await execute(CHECK_DRAFT, env, {"draft": JOIN_DRAFT})
    assert result["issues"] == [
        {
            "code": "field_renamed_by_join",
            "level": "error",
            "steps": ["sum"],
            "field": "group_by_field",
            "message": RENAMED_BY_JOIN,
        }
    ]
    assert result["blocking"] == 1
    with pytest.raises(ToolFailed, match="the join names it join_district_name"):
        await execute(CREATE, env, {"draft": JOIN_DRAFT})
    assert [r.method for r in core.requests] == ["GET", "GET"]


async def test_a_draft_with_two_notes_gets_a_warning_and_is_created() -> None:
    draft = {
        **DRAFT,
        "notes": [
            {"id": "about", "text": "Residents within 15 minutes of a school."},
            {"id": "more", "text": "The count step sums the residents."},
        ],
    }
    core, processes, geoapi, catalog = _services()
    env = _env(core, processes, geoapi, catalog)
    result = await execute(CHECK_DRAFT, env, {"draft": draft})
    [issue] = [i for i in result["issues"] if i["code"] == "more_than_one_note"]
    assert issue["level"] == "warning"
    assert "one note per workflow unless the user asked for more" in issue["message"]
    assert result["blocking"] == 0
    created = await execute(CREATE, env, {"draft": draft})
    assert created["workflow"]["id"] == WORKFLOW_ID


async def test_a_create_without_a_check_still_gives_the_assistants_warnings() -> None:
    """A draft sent straight to workflow_create hears the warnings of the
    assistant's own advice too, apart from the issues left open for the
    user; the workflow is created all the same."""
    draft = json.loads(json.dumps(DRAFT))
    walk = draft["steps"][2]
    draft["steps"].insert(
        3,
        {
            **walk,
            "id": "walk10",
            "label": "10 minutes on foot",
            "settings": {**walk["settings"], "max_cost": 10},
        },
    )
    draft["connections"].append(
        {"from": "schools", "to": "walk10", "input": "starting_points"}
    )
    draft["notes"] = [
        {"id": "about", "text": "Residents within 15 minutes of a school."},
        {"id": "more", "text": "The count step sums the residents."},
    ]
    core, processes, geoapi, catalog = _services()
    created = await execute(
        CREATE, _env(core, processes, geoapi, catalog), {"draft": draft}
    )
    assert created["workflow"]["id"] == WORKFLOW_ID
    assert created["open_issues"] == []
    bands, notes = created["warnings"]
    assert bands["code"] == "catchment_bands_split" and "step" not in bands
    assert "max_cost 15, steps 2 and step_sizes [10, 15]" in bands["message"]
    assert notes["code"] == "more_than_one_note" and "step" not in notes
    assert "one note per workflow unless the user asked for more" in notes["message"]


async def test_a_create_without_warnings_leaves_them_out() -> None:
    created = await execute(CREATE, _env(*_services()), {"draft": DRAFT})
    assert "warnings" not in created


def test_a_warning_after_the_create_is_no_reason_to_create_again() -> None:
    """The warnings come back once the workflow exists, and no tool changes
    or deletes it: a corrected draft created for a warning would be a second
    workflow."""
    text = " ".join(CREATE.description.split())
    assert (
        "When it answers, the workflow exists: never create it again for a warning"
        in text
    )
    assert "mention a warning in your answer when it matters" in text


async def test_check_adds_a_filter_field_the_layer_lacks() -> None:
    draft = json.loads(json.dumps(DRAFT))
    draft["steps"][0]["filter"]["where"][0]["field"] = "type"
    services = _services()
    result = await execute(CHECK_DRAFT, _env(*services), {"draft": draft})
    [issue] = result["issues"]
    assert issue == {
        "code": "filter_field_not_in_layer",
        "level": "error",
        "steps": ["schools"],
        "field": "type",
        "message": "Schools: the filter's field 'type' is not in the layer. Its fields: name, schulart.",
    }


async def test_a_check_that_cannot_run_says_so() -> None:
    services = _services(check=httpx.Response(503, json={"detail": "busy"}))
    result = await execute(CHECK_DRAFT, _env(*services), {"draft": DRAFT})
    assert result == {
        "checked": False,
        "issues": [],
        "blocking": 0,
        "open": 0,
        "note": NOT_CHECKED,
    }


def _counted(processes: Recorder) -> list[dict[str, Any]]:
    """The inputs of each feature count processes was asked for."""
    return [
        json.loads(request.content)["inputs"]
        for request in processes.requests
        if request.url.path == FEATURE_COUNT
    ]


def _too_many(result: Mapping[str, Any]) -> list[dict[str, Any]]:
    return [i for i in result["issues"] if i["code"] == "too_many_starting_points"]


async def test_check_counts_the_filtered_start_points() -> None:
    """The start points a catchment reads from a dataset step are counted with
    the step's area and conditions; above the limit the check says so, and
    the create is refused."""
    core, processes, geoapi, catalog = _services(count={"count": 4918})
    env = _env(core, processes, geoapi, catalog)
    result = await execute(CHECK_DRAFT, env, {"draft": DRAFT})
    [issue] = _too_many(result)
    assert (issue["level"], issue["steps"]) == ("error", ["walk", "schools"])
    assert issue["message"].startswith("15 minutes on foot starts from 4,918 points")
    assert "at most 1,000" in issue["message"]
    assert result["blocking"] == 1
    [inputs] = _counted(processes)
    assert inputs["collection"] == "e2000000-0000-0000-0000-000000000031"
    assert '"s_intersects"' in inputs["filter"] and '"schulart"' in inputs["filter"]
    assert json.loads(inputs["filter"]) == {
        "op": "and",
        "args": [
            {"op": "s_intersects", "args": [{"property": "geom"}, MUNICH["geometry"]]},
            {"op": "=", "args": [{"property": "schulart"}, "Grundschule"]},
        ],
    }
    with pytest.raises(ToolFailed, match="starts from 4,918 points"):
        await execute(CREATE, env, {"draft": DRAFT})
    assert [r.method for r in core.requests] == ["GET", "GET"]


async def test_an_unfiltered_dataset_step_counts_the_whole_layer() -> None:
    draft = json.loads(json.dumps(DRAFT))
    del draft["steps"][0]["filter"]
    core, processes, geoapi, catalog = _services(count={"count": 1500})
    result = await execute(
        CHECK_DRAFT, _env(core, processes, geoapi, catalog), {"draft": draft}
    )
    assert [i["steps"] for i in _too_many(result)] == [["walk", "schools"]]
    assert _counted(processes) == [
        {"collection": "e2000000-0000-0000-0000-000000000031"}
    ]
    assert geoapi.requests == []


async def test_catchments_from_one_dataset_step_count_it_once() -> None:
    draft = json.loads(json.dumps(DRAFT))
    walk = draft["steps"][2]
    for minutes in (5, 10):
        draft["steps"].append(
            {
                **walk,
                "id": f"walk{minutes}",
                "label": f"{minutes} minutes on foot",
                "settings": {**walk["settings"], "max_cost": minutes},
            }
        )
        draft["connections"].append(
            {"from": "schools", "to": f"walk{minutes}", "input": "starting_points"}
        )
    core, processes, geoapi, catalog = _services(count={"count": 4918})
    result = await execute(
        CHECK_DRAFT, _env(core, processes, geoapi, catalog), {"draft": draft}
    )
    assert sorted(i["steps"][0] for i in _too_many(result)) == [
        "walk",
        "walk10",
        "walk5",
    ]
    assert len(_counted(processes)) == 1


async def test_check_skips_start_points_from_a_result() -> None:
    """Start points another step computes cannot be counted before the run:
    the check reports nothing about them."""
    draft = {
        "name": "Around the buffered schools",
        "steps": [
            {"id": "schools", "kind": "dataset", "layer": 31},
            {
                "id": "ring",
                "kind": "tool",
                "tool": "buffer",
                "settings": {"distances": [500]},
            },
            {
                "id": "walk",
                "kind": "tool",
                "tool": "catchment_area_v2",
                "settings": {"routing_mode": "walking", "max_cost": 15, "steps": 1},
            },
            {"id": "save", "kind": "export", "name": "Reach"},
        ],
        "connections": [
            {"from": "schools", "to": "ring", "input": "input_layer_id"},
            {"from": "ring", "to": "walk", "input": "starting_points"},
            {"from": "walk", "to": "save"},
        ],
    }
    core, processes, geoapi, catalog = _services(count={"count": 4918})
    result = await execute(
        CHECK_DRAFT, _env(core, processes, geoapi, catalog), {"draft": draft}
    )
    assert result["checked"] is True
    assert _too_many(result) == []
    assert FEATURE_COUNT not in processes.paths()


@pytest.mark.parametrize(
    "count",
    [httpx.Response(500, json={"detail": "busy"}), {"detail": "no count"}],
    ids=["failed", "no-count"],
)
async def test_an_unreadable_count_reports_nothing(count: Answer) -> None:
    """The run's own limit still holds."""
    core, processes, geoapi, catalog = _services(count=count)
    result = await execute(
        CHECK_DRAFT, _env(core, processes, geoapi, catalog), {"draft": DRAFT}
    )
    assert result["checked"] is True
    assert _too_many(result) == []
    assert len(_counted(processes)) == 1


async def test_start_points_whose_fields_cannot_be_read_are_not_counted() -> None:
    """A condition is compiled against the layer's fields: without them (a
    catalog layer still being copied) the count is left to the run."""
    core, processes, geoapi, catalog = _services(
        count={"count": 4918},
        queryables=httpx.Response(404, json={"detail": "not found"}),
    )
    result = await execute(
        CHECK_DRAFT, _env(core, processes, geoapi, catalog), {"draft": DRAFT}
    )
    assert _too_many(result) == []
    assert FEATURE_COUNT not in processes.paths()


def _layer_input(name: str) -> dict[str, Any]:
    return {
        "title": name,
        "schema": {"type": "string", "x-ui": {"widget": "layer-selector"}},
        "minOccurs": 1,
    }


#: Tools that pass on how many features they read: a merge sums its two
#: inputs, a centroid keeps one point per feature; and the travel cost
#: matrix, which takes a limited number of pairs. Described with their layer
#: inputs only.
COUNTED_TOOLS: dict[str, dict[str, Any]] = {
    tool: {"id": tool, "title": title, "inputs": {n: _layer_input(n) for n in inputs}}
    for tool, title, inputs in [
        ("merge", "Merge", ("input_path_1", "input_path_2")),
        ("centroid", "Centroid", ("input_layer_id",)),
        (
            "travel_cost_matrix",
            "Travel Cost Matrix",
            ("origin_layer_id", "destination_layer_id"),
        ),
    ]
}


def _counted_services(
    counts: Mapping[str, int | None],
) -> tuple[Recorder, Recorder, Recorder, Recorder]:
    """Fake services that know merge, centroid and the travel cost matrix,
    and count each layer's features as ``counts`` says (by layer id; None
    fails)."""

    def count(request: httpx.Request) -> httpx.Response:
        found = counts[json.loads(request.content)["inputs"]["collection"]]
        if found is None:
            return httpx.Response(500, json={"detail": "busy"})
        return httpx.Response(200, json={"count": found})

    return _services(
        count=count,
        descriptions=COUNTED_TOOLS,
        toolbox=_toolbox(
            extra=[
                {"id": tool, "title": described["title"]}
                for tool, described in COUNTED_TOOLS.items()
            ]
        ),
    )


SCHOOLS_LAYER = "e2000000-0000-0000-0000-000000000031"
RESIDENTS_LAYER = "e2000000-0000-0000-0000-000000000033"
#: Schools and the centroids of the residents' cells, merged into the start
#: points of one catchment.
MERGED_DRAFT: dict[str, Any] = {
    "name": "Schools and homes: 5-minute walk",
    "steps": [
        {"id": "schools", "kind": "dataset", "label": "Schools", "layer": 31},
        {"id": "homes", "kind": "dataset", "label": "Homes", "layer": 33},
        {"id": "middle", "kind": "tool", "tool": "centroid"},
        {"id": "all", "kind": "tool", "tool": "merge"},
        {
            "id": "walk",
            "kind": "tool",
            "tool": "catchment_area_v2",
            "label": "5 minutes on foot",
            "settings": {"routing_mode": "walking", "max_cost": 5, "steps": 1},
        },
        {"id": "save", "kind": "export", "name": "Reach"},
    ],
    "connections": [
        {"from": "homes", "to": "middle", "input": "input_layer_id"},
        {"from": "schools", "to": "all", "input": "input_path_1"},
        {"from": "middle", "to": "all", "input": "input_path_2"},
        {"from": "all", "to": "walk", "input": "starting_points"},
        {"from": "walk", "to": "save"},
    ],
}


async def test_start_points_through_merge_and_centroid_steps_are_counted() -> None:
    """Each dataset step is counted once, and the catchment gets their sum."""
    core, processes, geoapi, catalog = _counted_services(
        {SCHOOLS_LAYER: 700, RESIDENTS_LAYER: 450}
    )
    result = await execute(
        CHECK_DRAFT, _env(core, processes, geoapi, catalog), {"draft": MERGED_DRAFT}
    )
    [issue] = _too_many(result)
    assert issue["steps"] == ["walk", "schools", "homes"]
    assert issue["message"].startswith("5 minutes on foot starts from 1,150 points")
    assert sorted(i["collection"] for i in _counted(processes)) == [
        SCHOOLS_LAYER,
        RESIDENTS_LAYER,
    ]


async def test_merged_start_points_within_the_limit_are_fine() -> None:
    services = _counted_services({SCHOOLS_LAYER: 500, RESIDENTS_LAYER: 450})
    result = await execute(CHECK_DRAFT, _env(*services), {"draft": MERGED_DRAFT})
    assert result["checked"] is True
    assert _too_many(result) == []


async def test_a_merge_with_a_count_that_failed_is_not_reported() -> None:
    """One input's count failed: the sum is unknown, never reported low."""
    services = _counted_services({SCHOOLS_LAYER: 5000, RESIDENTS_LAYER: None})
    result = await execute(CHECK_DRAFT, _env(*services), {"draft": MERGED_DRAFT})
    assert result["checked"] is True
    assert _too_many(result) == []


#: The residents' centroids to the schools as a pair matrix.
MATRIX_DRAFT: dict[str, Any] = {
    "name": "Homes to schools",
    "steps": [
        {"id": "homes", "kind": "dataset", "label": "Homes", "layer": 33},
        {"id": "schools", "kind": "dataset", "label": "Schools", "layer": 31},
        {"id": "middle", "kind": "tool", "tool": "centroid"},
        {
            "id": "times",
            "kind": "tool",
            "tool": "travel_cost_matrix",
            "label": "Travel times",
            "settings": {"routing_mode": "walking"},
        },
        {"id": "save", "kind": "export", "name": "Travel times"},
    ],
    "connections": [
        {"from": "homes", "to": "middle", "input": "input_layer_id"},
        {"from": "middle", "to": "times", "input": "origin_layer_id"},
        {"from": "schools", "to": "times", "input": "destination_layer_id"},
        {"from": "times", "to": "save"},
    ],
}


def _too_many_pairs(result: Mapping[str, Any]) -> list[dict[str, Any]]:
    return [i for i in result["issues"] if i["code"] == "too_many_matrix_pairs"]


async def test_a_matrix_over_the_pair_cap_is_refused() -> None:
    core, processes, geoapi, catalog = _counted_services(
        {RESIDENTS_LAYER: 559, SCHOOLS_LAYER: 313}
    )
    env = _env(core, processes, geoapi, catalog)
    result = await execute(CHECK_DRAFT, env, {"draft": MATRIX_DRAFT})
    [issue] = _too_many_pairs(result)
    assert (issue["level"], issue["steps"]) == ("error", ["times", "homes", "schools"])
    assert issue["message"].startswith(
        "Travel times pairs 559 origins with 313 destinations, 174,967 pairs"
    )
    assert result["blocking"] == 1
    with pytest.raises(ToolFailed, match="174,967 pairs"):
        await execute(CREATE, env, {"draft": MATRIX_DRAFT})


async def test_a_matrix_within_the_pair_cap_is_fine() -> None:
    services = _counted_services({RESIDENTS_LAYER: 100, SCHOOLS_LAYER: 100})
    result = await execute(CHECK_DRAFT, _env(*services), {"draft": MATRIX_DRAFT})
    assert result["checked"] is True
    assert _too_many_pairs(result) == []


async def test_a_matrix_with_one_side_from_another_result_is_not_reported() -> None:
    """Destinations from a buffer's result are not known before the run."""
    draft = json.loads(json.dumps(MATRIX_DRAFT))
    draft["steps"].insert(
        3,
        {
            "id": "ring",
            "kind": "tool",
            "tool": "buffer",
            "settings": {"distances": [500]},
        },
    )
    draft["connections"][2] = {
        "from": "schools",
        "to": "ring",
        "input": "input_layer_id",
    }
    draft["connections"].append(
        {"from": "ring", "to": "times", "input": "destination_layer_id"}
    )
    core, processes, geoapi, catalog = _counted_services(
        {RESIDENTS_LAYER: 559, SCHOOLS_LAYER: 313}
    )
    result = await execute(
        CHECK_DRAFT, _env(core, processes, geoapi, catalog), {"draft": draft}
    )
    assert result["checked"] is True
    assert _too_many_pairs(result) == []
    # The origins alone are no issue, and are not counted for nothing.
    assert _counted(processes) == []


#: A few schools picked by a condition as the origins, the residents'
#: centroids as the destinations: the reversed matrix.
FILTERED_ORIGINS_DRAFT: dict[str, Any] = {
    "name": "Schools to homes",
    "steps": [
        {
            "id": "schools",
            "kind": "dataset",
            "label": "Schools",
            "layer": 31,
            "filter": {
                "where": [{"field": "schulart", "op": "=", "value": "Gymnasium"}]
            },
        },
        {"id": "homes", "kind": "dataset", "label": "Homes", "layer": 33},
        {"id": "middle", "kind": "tool", "tool": "centroid"},
        {
            "id": "times",
            "kind": "tool",
            "tool": "travel_cost_matrix",
            "label": "Travel times",
            "settings": {"routing_mode": "walking"},
        },
        {"id": "save", "kind": "export", "name": "Travel times"},
    ],
    "connections": [
        {"from": "schools", "to": "times", "input": "origin_layer_id"},
        {"from": "homes", "to": "middle", "input": "input_layer_id"},
        {"from": "middle", "to": "times", "input": "destination_layer_id"},
        {"from": "times", "to": "save"},
    ],
}


@pytest.mark.parametrize(
    ("policy", "origins", "reported"),
    [
        ("standard", 3, True),
        # project_count_features withholds a filtered count below
        # MIN_RESTRICTED_GROUP, and the issue's message would name it.
        ("restricted", 3, False),
        ("restricted", MIN_RESTRICTED_GROUP, True),
    ],
)
async def test_under_restricted_a_small_filtered_count_is_not_named(
    policy: DataPolicy, origins: int, reported: bool
) -> None:
    services = _counted_services({SCHOOLS_LAYER: origins, RESIDENTS_LAYER: 5000})
    env = _env(*services, data_policy=policy)
    result = await execute(CHECK_DRAFT, env, {"draft": FILTERED_ORIGINS_DRAFT})
    assert result["checked"] is True
    issues = _too_many_pairs(result)
    assert bool(issues) is reported
    assert result["blocking"] == int(reported)
    if reported:
        assert issues[0]["message"].startswith(
            f"Travel times pairs {origins} origins with 5,000 destinations"
        )


@pytest.mark.parametrize(
    ("policy", "reported"), [("standard", True), ("restricted", False)]
)
async def test_under_restricted_start_points_with_a_small_filtered_part_are_not_summed(
    policy: DataPolicy, reported: bool
) -> None:
    """The start-point check reads the same counts: a sum with a withheld
    count is unknown."""
    draft = json.loads(json.dumps(MERGED_DRAFT))
    draft["steps"][0]["filter"] = {
        "where": [{"field": "schulart", "op": "=", "value": "Gymnasium"}]
    }
    services = _counted_services({SCHOOLS_LAYER: 3, RESIDENTS_LAYER: 2000})
    result = await execute(
        CHECK_DRAFT, _env(*services, data_policy=policy), {"draft": draft}
    )
    assert result["checked"] is True
    issues = _too_many(result)
    assert bool(issues) is reported
    if reported:
        assert issues[0]["message"].startswith(
            "5 minutes on foot starts from 2,003 points"
        )


async def test_under_restricted_an_unfiltered_count_is_still_used() -> None:
    """Only a filtered count is withheld: a whole layer's count is allowed
    under Restricted."""
    services = _counted_services({SCHOOLS_LAYER: 3, RESIDENTS_LAYER: 2000})
    result = await execute(
        CHECK_DRAFT,
        _env(*services, data_policy="restricted"),
        {"draft": MERGED_DRAFT},
    )
    [issue] = _too_many(result)
    assert issue["message"].startswith("5 minutes on foot starts from 2,003 points")


async def test_create_saves_the_config_the_check_checked() -> None:
    core, processes, geoapi, catalog = _services()
    env = _env(core, processes, geoapi, catalog)
    result = await execute(CREATE, env, {"draft": DRAFT}, tool_call_id="c1")
    checked = json.loads(
        next(r for r in processes.requests if r.url.path == "/workflows/check").content
    )
    posted = json.loads(next(r for r in core.requests if r.method == "POST").content)
    assert posted["name"] == "Schools: 15-minute walk"
    assert (posted["is_default"], posted["description"]) == (False, None)
    assert posted["config"]["nodes"] == checked["nodes"]
    assert posted["config"]["edges"] == checked["edges"]
    assert result == {
        "workflow": {
            "id": WORKFLOW_ID,
            "name": "Schools: 15-minute walk",
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
                        "name": "Schools: 15-minute walk",
                    }
                ]
            }
        ],
    }


async def test_create_saves_the_notes_after_the_steps() -> None:
    """A note is the editor's note node: checked and saved with the steps,
    and no issue of the check is about it."""
    note = {
        "id": "about",
        "text": "Counts the residents within 15 minutes on foot of a school.",
        "near": ["count", "save"],
    }
    draft = {**DRAFT, "notes": [note]}
    core, processes, geoapi, catalog = _services()
    env = _env(core, processes, geoapi, catalog)
    result = await execute(CREATE, env, {"draft": draft}, tool_call_id="c1")
    checked = json.loads(
        next(r for r in processes.requests if r.url.path == "/workflows/check").content
    )
    posted = json.loads(next(r for r in core.requests if r.method == "POST").content)
    nodes = posted["config"]["nodes"]
    assert checked["nodes"] == nodes
    assert [node["type"] for node in nodes] == [
        *(step["kind"] for step in DRAFT["steps"]),
        "textAnnotation",
    ]
    assert nodes[-1]["id"].startswith("text-")
    assert nodes[-1]["data"]["text"] == (
        "<p>Counts the residents within 15 minutes on foot of a school.</p>"
    )
    assert result["open_issues"] == []


def test_the_draft_tools_ask_for_a_short_note_without_data() -> None:
    for spec in (CHECK_DRAFT, CREATE):
        assert "one short note" in spec.description, spec.name
        assert "what it answers" in spec.description, spec.name
        assert "how to read its results" in spec.description, spec.name
        assert "personal data" in spec.description, spec.name
    draft = CREATE.json_schema()["properties"]["draft"]
    assert "notes" in draft["description"]


def _checked_ids(processes: Recorder) -> list[list[str]]:
    return [
        [node["id"] for node in json.loads(request.content)["nodes"]]
        for request in processes.requests
        if request.url.path == "/workflows/check"
    ]


async def test_each_conversion_gets_ids_of_its_own() -> None:
    """Export node ids are unique per workflow, so a draft created twice
    must not share them: every call converts the draft once, with new ids,
    and the create saves the ids its own check checked."""
    core, processes, geoapi, catalog = _services()
    env = _env(core, processes, geoapi, catalog)
    await execute(CHECK_DRAFT, env, {"draft": DRAFT})
    await execute(CHECK_DRAFT, env, {"draft": DRAFT})
    await execute(CREATE, env, {"draft": DRAFT}, tool_call_id="c1")
    first, second, created = _checked_ids(processes)
    assert not set(first) & set(second)
    assert not set(created) & (set(first) | set(second))
    posted = json.loads(next(r for r in core.requests if r.method == "POST").content)
    assert [node["id"] for node in posted["config"]["nodes"]] == created


async def test_create_refuses_while_a_blocking_issue_remains() -> None:
    core, processes, geoapi, catalog = _services(
        issues=[
            _issue(
                "setting_required",
                "count",
                "Aggregate Polygons: Area Type is required.",
            )
        ]
    )
    with pytest.raises(ToolFailed) as caught:
        await execute(CREATE, _env(core, processes, geoapi, catalog), {"draft": DRAFT})
    assert "Not created: 1 issue(s) must be fixed first." in caught.value.message
    assert "Aggregate Polygons: Area Type is required." in caught.value.message
    assert [r.method for r in core.requests] == ["GET"]


async def test_create_accepts_open_steps_and_names_what_is_open() -> None:
    core, processes, geoapi, catalog = _services(
        issues=[
            _issue(
                "layer_not_chosen",
                "toilets",
                "Public toilets: no layer is chosen.",
                draft=OPEN_DRAFT,
            ),
            _issue(
                "step_not_connected", "save", "x", level="warning", draft=OPEN_DRAFT
            ),
        ]
    )
    result = await execute(
        CREATE, _env(core, processes, geoapi, catalog), {"draft": OPEN_DRAFT}
    )
    assert result["open_issues"] == [
        {
            "step": "Public toilets",
            "code": "layer_not_chosen",
            "message": "Public toilets: no layer is chosen.",
        }
    ]


async def test_create_refuses_when_the_check_cannot_run() -> None:
    core, processes, geoapi, catalog = _services(check=httpx.Response(500, json={}))
    with pytest.raises(ToolFailed, match="could not be checked right now"):
        await execute(CREATE, _env(core, processes, geoapi, catalog), {"draft": DRAFT})
    assert CHECK_UNAVAILABLE.startswith("Not created")
    assert [r.method for r in core.requests] == ["GET"]


@pytest.mark.parametrize("status", [401, 403])
async def test_a_viewer_is_told_and_nothing_is_retried(status: int) -> None:
    services = _services(
        created=httpx.Response(status, json={"detail": "Unauthorized"})
    )
    with pytest.raises(ToolFailed) as caught:
        await execute(CREATE, _env(*services), {"draft": DRAFT})
    assert caught.value.message == VIEWER_WORKFLOWS
    assert [r.method for r in services[0].requests] == ["GET", "POST"]


async def test_a_layer_not_in_the_project_or_locked_goes_back_to_the_model() -> None:
    for layer, message in (
        (99, "no layer 99 in the project"),
        (36, "'Intern' is in the project, but the user has no access"),
    ):
        draft = json.loads(json.dumps(DRAFT))
        draft["steps"][1]["layer"] = layer
        services = _services()
        with pytest.raises(InputInvalid, match=message):
            await execute(CHECK_DRAFT, _env(*services), {"draft": draft})
        assert all(
            "e2000000-0000-0000-0000-000000000036" not in r.content.decode()
            for r in services[1].requests
        )


async def test_a_region_comes_from_the_catalog_and_a_box_is_noted() -> None:
    """Review Focus 5: a boundary too large to store is its bounding box, and the result says so."""
    huge = {
        **MUNICH,
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                [[11.36 + n / 100000, 48.06] for n in range(30000)]
                + [[11.36, 48.25], [11.36, 48.06]]
            ],
        },
    }
    core, processes, geoapi, catalog = _services(region=huge)
    result = await execute(
        CREATE, _env(core, processes, geoapi, catalog), {"draft": DRAFT}
    )
    assert catalog.paths() == ["/stac/nuts/DE212/geometry"]
    assert result["notes"] == [
        "Schools: the area is the bounding box of München, Kreisfreie Stadt, not its boundary, "
        "which is too detailed to store in a workflow. Features inside the box but outside the "
        "region are kept too."
    ]
    posted = json.loads(next(r for r in core.requests if r.method == "POST").content)
    area = json.loads(
        posted["config"]["nodes"][0]["data"]["filter"]["expressions"][0]["value"]
    )
    assert area["properties"] == {
        "type": "boundary",
        "label": "München, Kreisfreie Stadt (bounding box)",
    }
    unknown = _services(
        region=httpx.Response(404, json={"detail": "NUTS region not found"})
    )
    with pytest.raises(InputInvalid, match="find it with catalog_find_region"):
        await execute(CHECK_DRAFT, _env(*unknown), {"draft": DRAFT})


async def test_a_layer_still_copying_does_not_block_the_create() -> None:
    """Review Focus 4: geoapi cannot read the fields of a catalog layer yet."""
    draft = json.loads(json.dumps(DRAFT))
    draft["steps"][0]["filter"]["where"][0]["field"] = "type"
    core, processes, geoapi, catalog = _services(
        queryables=httpx.Response(404, json={"detail": "not found"})
    )
    result = await execute(
        CREATE, _env(core, processes, geoapi, catalog), {"draft": draft}
    )
    assert result["workflow"]["id"] == WORKFLOW_ID
    assert result["open_issues"] == []


@pytest.mark.parametrize(
    "properties",
    [{}, {"geom": {"$ref": "https://geojson.org/schema/Geometry.json"}}],
    ids=["none", "only-the-geometry"],
)
async def test_a_layer_whose_fields_are_not_listed_yet_does_not_block(
    properties: dict[str, Any],
) -> None:
    """geoapi lists no field of a table it does not see yet (a catalog
    dataset just added): a layer without a field besides its geometry is not
    judged, as one whose fields cannot be read."""
    draft = json.loads(json.dumps(DRAFT))
    draft["steps"][0]["filter"]["where"][0]["field"] = "type"
    core, processes, geoapi, catalog = _services(
        queryables={"type": "object", "properties": properties}
    )
    checked = await execute(
        CHECK_DRAFT, _env(core, processes, geoapi, catalog), {"draft": draft}
    )
    assert (checked["checked"], checked["issues"]) == (True, [])
    result = await execute(
        CREATE, _env(core, processes, geoapi, catalog), {"draft": draft}
    )
    assert result["workflow"]["id"] == WORKFLOW_ID


async def test_the_pack_needs_an_open_project() -> None:
    env = tool_env(fake_clients(), page=parse_context(None))
    with pytest.raises(ToolFailed, match="Open a project first"):
        await execute(CHECK_DRAFT, env, {"draft": DRAFT})


def _checked(processes: Recorder) -> bool:
    return "/workflows/check" in processes.paths()


async def test_a_draft_whose_tools_cannot_be_described_is_unchecked() -> None:
    """Without the tools' descriptions neither the layer inputs nor the field
    settings can be judged: nothing is checked or created."""
    failing = {"aggregate_polygon": httpx.Response(500, json={})}
    core, processes, geoapi, catalog = _services(descriptions=failing)
    result = await execute(
        CHECK_DRAFT, _env(core, processes, geoapi, catalog), {"draft": DRAFT}
    )
    assert result == {
        "checked": False,
        "issues": [],
        "blocking": 0,
        "open": 0,
        "note": NOT_CHECKED,
    }
    assert not _checked(processes)
    core, processes, geoapi, catalog = _services(descriptions=failing)
    with pytest.raises(ToolFailed) as caught:
        await execute(CREATE, _env(core, processes, geoapi, catalog), {"draft": DRAFT})
    assert caught.value.message == CHECK_UNAVAILABLE
    assert not _checked(processes)
    assert [r.method for r in core.requests] == ["GET"]


async def test_each_tool_is_described_once_and_names_its_step() -> None:
    core, processes, geoapi, catalog = _services()
    await execute(CREATE, _env(core, processes, geoapi, catalog), {"draft": DRAFT})
    assert sorted(processes.paths()) == [
        "/processes",
        "/processes/aggregate_polygon",
        "/processes/catchment_area_v2",
        FEATURE_COUNT,
        "/workflows/check",
    ]
    posted = json.loads(next(r for r in core.requests if r.method == "POST").content)
    labels = [node["data"]["label"] for node in posted["config"]["nodes"]]
    assert labels[2:4] == ["15 minutes on foot", "Aggregate Polygons"]


LOCKED_LAYER = "e2000000-0000-0000-0000-000000000036"


@pytest.mark.parametrize("tool", [CHECK_DRAFT, CREATE], ids=["check", "create"])
async def test_a_setting_cannot_feed_a_layer_input(tool: Any) -> None:
    """A layer reaches a tool only through a connection from a dataset step,
    so the locked-layer refusal cannot be bypassed with a layer id in a
    setting."""
    draft = json.loads(json.dumps(DRAFT))
    draft["steps"][2]["settings"]["point_grid_layer_id"] = LOCKED_LAYER
    core, processes, geoapi, catalog = _services()
    with pytest.raises(InputInvalid) as caught:
        await execute(tool, _env(core, processes, geoapi, catalog), {"draft": draft})
    assert "step 'walk'" in caught.value.message
    assert "point_grid_layer_id" in caught.value.message
    assert "connect a dataset step" in caught.value.message
    assert not _checked(processes)
    assert all(LOCKED_LAYER not in r.content.decode() for r in processes.requests)
    assert [r.method for r in core.requests] == ["GET"]


async def test_a_hidden_opportunity_handle_is_no_setting_either() -> None:
    draft = {
        "name": "Schools: gravity",
        "steps": [
            {"id": "schools", "kind": "dataset", "layer": 31},
            {
                "id": "heat",
                "kind": "tool",
                "tool": "heatmap_gravity",
                "settings": {
                    "routing_mode": "walking",
                    "opportunity_layer_2_id": {"layer_id": LOCKED_LAYER},
                },
            },
        ],
        "connections": [
            {"from": "schools", "to": "heat", "input": "opportunity_layer_1_id"}
        ],
    }
    services = _services()
    with pytest.raises(InputInvalid, match="opportunity_layer_2_id"):
        await execute(CHECK_DRAFT, _env(*services), {"draft": draft})
    assert not _checked(services[1])


async def test_a_required_field_of_an_open_input_stays_open() -> None:
    """catchment_area_v2's reference_field reads the starting points, which
    come from the step left open: its fields are not known yet."""
    core, processes, geoapi, catalog = _services(
        issues=[
            _issue(
                "setting_required",
                "walk",
                "Catchment Area: Reference field is required.",
                draft=OPEN_DRAFT,
                field="reference_field",
            )
        ]
    )
    result = await execute(
        CREATE, _env(core, processes, geoapi, catalog), {"draft": OPEN_DRAFT}
    )
    assert result["open_issues"] == [
        {
            "step": "Catchment Area",
            "code": "setting_required",
            "message": "Catchment Area: Reference field is required.",
        }
    ]


def _two_inputs(open_input: str, chosen_input: str) -> dict[str, Any]:
    return {
        "name": "Residents per district",
        "steps": [
            {"id": "districts", "kind": "dataset", "label": "Districts", "layer": None},
            {"id": "residents", "kind": "dataset", "layer": 33},
            {
                "id": "count",
                "kind": "tool",
                "tool": "aggregate_polygon",
                "settings": {"area_type": "polygon"},
            },
            {"id": "save", "kind": "export", "name": "Residents per district"},
        ],
        "connections": [
            {"from": "districts", "to": "count", "input": open_input},
            {"from": "residents", "to": "count", "input": chosen_input},
            {"from": "count", "to": "save"},
        ],
    }


@pytest.mark.parametrize(
    ("open_input", "chosen_input", "blocking", "still_open"),
    [
        ("source_layer_id", "area_layer_id", 0, 1),
        ("area_layer_id", "source_layer_id", 1, 0),
    ],
    ids=["read-input-open", "read-input-chosen"],
)
async def test_a_required_field_setting_stays_open_only_while_its_layer_is_open(
    open_input: str, chosen_input: str, blocking: int, still_open: int
) -> None:
    """aggregate_polygon's group_by_field reads source_layer_id: open while
    that input comes from the step left open, blocking once it has a layer,
    although the step reads from an open step either way."""
    draft = _two_inputs(open_input, chosen_input)
    services = _services(
        issues=[
            _issue(
                "setting_required",
                "count",
                "Aggregate Polygons: Group by is required.",
                draft=draft,
                field="group_by_field",
            )
        ]
    )
    result = await execute(CHECK_DRAFT, _env(*services), {"draft": draft})
    assert (result["blocking"], result["open"]) == (blocking, still_open)
    if blocking:
        with pytest.raises(ToolFailed, match="Not created: 1 issue"):
            await execute(CREATE, _env(*services), {"draft": draft})
    else:
        created = await execute(CREATE, _env(*services), {"draft": draft})
        assert created["workflow"]["id"] == WORKFLOW_ID


@pytest.mark.parametrize(
    ("field", "still_open"),
    [
        ("starting_points", True),
        ("reference_field", True),
        (None, True),
        ("routing_mode", False),
    ],
    ids=["open-input", "its-field-setting", "whole-step", "a-choice"],
)
async def test_a_rejected_setting_downstream_stays_open_only_if_the_layer_reaches_it(
    field: str | None, still_open: bool
) -> None:
    """On a step reading from a step left open, a setting the tool rejects
    stays open when the layer still to be chosen can be its cause: the open
    input itself, a field setting reading it, or the step's validation as a
    whole. A value like routing_mode "foot" is wrong whatever layer the user
    picks, so it blocks."""
    services = _services(
        issues=[
            _issue(
                "setting_invalid",
                "walk",
                "Catchment Area: it does not fit.",
                draft=OPEN_DRAFT,
                field=field,
            )
        ]
    )
    result = await execute(CHECK_DRAFT, _env(*services), {"draft": OPEN_DRAFT})
    assert (result["blocking"], result["open"]) == ((0, 1) if still_open else (1, 0))
    if still_open:
        created = await execute(CREATE, _env(*services), {"draft": OPEN_DRAFT})
        assert [issue["code"] for issue in created["open_issues"]] == [
            "setting_invalid"
        ]
    else:
        with pytest.raises(ToolFailed, match="Not created: 1 issue"):
            await execute(CREATE, _env(*services), {"draft": OPEN_DRAFT})


@pytest.mark.parametrize(
    ("open_input", "chosen_input", "blocking", "still_open"),
    [
        ("source_layer_id", "area_layer_id", 0, 1),
        ("area_layer_id", "source_layer_id", 1, 0),
    ],
    ids=["read-input-open", "read-input-chosen"],
)
async def test_a_statistic_without_a_field_stays_open_only_while_its_layer_is_open(
    open_input: str, chosen_input: str, blocking: int, still_open: int
) -> None:
    """column_statistics' items read their field from source_layer_id (the
    item's own widget names it): a sum without its field stays open while
    that input comes from the step left open."""
    draft = _two_inputs(open_input, chosen_input)
    draft["steps"][2]["settings"]["column_statistics"] = [{"operation": "sum"}]
    services = _services(
        issues=[
            _issue(
                "setting_invalid",
                "count",
                "Aggregate Polygons: Statistics Configuration: Field is required.",
                draft=draft,
                field="column_statistics",
            )
        ]
    )
    result = await execute(CHECK_DRAFT, _env(*services), {"draft": draft})
    assert (result["blocking"], result["open"]) == (blocking, still_open)


@pytest.mark.parametrize(
    ("field", "still_open"),
    [
        ("opportunity_1_potential_field", True),
        ("opportunity_1_input_path", True),
        ("opportunity_2_potential_field", False),
        ("routing_mode", False),
    ],
)
async def test_an_opportunitys_setting_stays_open_while_its_layer_is_open(
    field: str, still_open: bool
) -> None:
    """A heatmap keeps the settings of the opportunity on handle N as
    opportunity_<N>_<name>: open for the handle fed from the step left open,
    blocking for the one whose layer is chosen."""
    draft = {
        "name": "Toilets and schools: gravity",
        "steps": [
            {"id": "toilets", "kind": "dataset", "label": "Toilets", "layer": None},
            {"id": "schools", "kind": "dataset", "layer": 31},
            {
                "id": "heat",
                "kind": "tool",
                "tool": "heatmap_gravity",
                "settings": {"routing_mode": "walking"},
            },
            {"id": "save", "kind": "export", "name": "Gravity"},
        ],
        "connections": [
            {"from": "toilets", "to": "heat", "input": "opportunity_layer_1_id"},
            {"from": "schools", "to": "heat", "input": "opportunity_layer_2_id"},
            {"from": "heat", "to": "save"},
        ],
    }
    services = _services(
        issues=[
            _issue(
                "setting_invalid",
                "heat",
                "Heatmap Gravity: it does not fit.",
                draft=draft,
                field=field,
            )
        ]
    )
    result = await execute(CHECK_DRAFT, _env(*services), {"draft": draft})
    assert (result["blocking"], result["open"]) == ((0, 1) if still_open else (1, 0))


def _potential_draft(*, chosen_second: bool) -> dict[str, Any]:
    """A gravity heatmap whose first opportunity reads its potential from a
    field left out while its layer is open; with ``chosen_second`` a second
    opportunity reads a chosen layer."""
    settings: dict[str, Any] = {
        "routing_mode": "walking",
        "opportunity_1_potential_type": "field",
    }
    steps: list[dict[str, Any]] = [
        {"id": "toilets", "kind": "dataset", "label": "Toilets", "layer": None},
        {"id": "heat", "kind": "tool", "tool": "heatmap_gravity", "settings": settings},
        {"id": "save", "kind": "export", "name": "Gravity"},
    ]
    connections: list[dict[str, Any]] = [
        {"from": "toilets", "to": "heat", "input": "opportunity_layer_1_id"},
        {"from": "heat", "to": "save"},
    ]
    if chosen_second:
        steps.insert(1, {"id": "schools", "kind": "dataset", "layer": 31})
        connections.append(
            {"from": "schools", "to": "heat", "input": "opportunity_layer_2_id"}
        )
        settings["opportunity_2_potential_type"] = "constant"
        settings["opportunity_2_potential_constant"] = 1
    return {"name": "Toilets: gravity", "steps": steps, "connections": connections}


@pytest.mark.parametrize(
    ("chosen_second", "still_open"),
    [(False, True), (True, False)],
    ids=["every-opportunity-open", "one-opportunity-chosen"],
)
async def test_an_unnumbered_opportunity_error_stays_open_while_every_one_is_open(
    chosen_second: bool, still_open: bool
) -> None:
    """Processes reports an opportunity's own validation under
    ``opportunities`` when the error names no setting of it (here a field
    left out while its layer is open, as the skill says). It may stem from
    any connected opportunity: open while every one reads a layer still to be
    chosen, blocking once one of them has its layer."""
    draft = _potential_draft(chosen_second=chosen_second)
    services = _services(
        issues=[
            _issue(
                "setting_invalid",
                "heat",
                "Heatmap Gravity: Opportunities: potential_field must be set when "
                "potential_type is 'field'.",
                draft=draft,
                field="opportunities",
            )
        ]
    )
    result = await execute(CHECK_DRAFT, _env(*services), {"draft": draft})
    assert (result["blocking"], result["open"]) == ((0, 1) if still_open else (1, 0))
    if still_open:
        created = await execute(CREATE, _env(*services), {"draft": draft})
        assert [issue["code"] for issue in created["open_issues"]] == [
            "setting_invalid"
        ]
    else:
        with pytest.raises(ToolFailed, match="Not created: 1 issue"):
            await execute(CREATE, _env(*services), {"draft": draft})


BOTH_TOOLS = pytest.mark.parametrize(
    "tool", [CHECK_DRAFT, CREATE], ids=["check", "create"]
)


@BOTH_TOOLS
@pytest.mark.parametrize("status", [400, 422])
async def test_a_draft_processes_refuses_goes_back_to_the_model(
    tool: Any, status: int
) -> None:
    """Processes' verdict on the draft (here a setting named like a path,
    which only the server sets): the same draft gets the same answer, so the
    model must change it, not try again."""
    refused = httpx.Response(
        status, json={"detail": "source_path is set by the server, not the caller"}
    )
    core, processes, geoapi, catalog = _services(check=refused)
    with pytest.raises(InputInvalid, match="source_path is set by the server"):
        await execute(tool, _env(core, processes, geoapi, catalog), {"draft": DRAFT})
    assert [r.method for r in core.requests] == ["GET"]


#: A refusal of the project: (status, the token's seconds left, the message).
#: Core answers 401 also when its authorization denies the request, so only
#: an expired token names the sign-in.
PROJECT_REFUSALS = pytest.mark.parametrize(
    ("status", "expires_in", "message"),
    [
        (401, -60, SIGN_IN_EXPIRED),
        (401, 300, NOT_READABLE),
        (403, 300, NOT_READABLE),
        (404, 300, NOT_READABLE),
    ],
    ids=["401 expired", "401", "403", "404"],
)


@BOTH_TOOLS
@PROJECT_REFUSALS
async def test_a_project_processes_will_not_check_for_the_user_says_so(
    tool: Any, status: int, expires_in: float, message: str
) -> None:
    core, processes, geoapi, catalog = _services(
        check=httpx.Response(status, json={"detail": "Project not found"})
    )
    env = _env(core, processes, geoapi, catalog, login=signed_in(expires_in))
    with pytest.raises(ToolFailed) as caught:
        await execute(tool, env, {"draft": DRAFT})
    assert caught.value.message == message
    assert [r.method for r in core.requests] == ["GET"]


@BOTH_TOOLS
@PROJECT_REFUSALS
async def test_a_project_whose_layers_core_will_not_list_says_so(
    tool: Any, status: int, expires_in: float, message: str
) -> None:
    core, processes, geoapi, catalog = _services()
    core.routes[("GET", f"/api/v2/project/{PROJECT}/layer")] = httpx.Response(
        status, json={"detail": "Unauthorized"}
    )
    env = _env(core, processes, geoapi, catalog, login=signed_in(expires_in))
    with pytest.raises(ToolFailed) as caught:
        await execute(tool, env, {"draft": DRAFT})
    assert caught.value.message == message
    assert [r.method for r in core.requests] == ["GET"]


def test_a_project_not_readable_names_no_sign_in() -> None:
    """The project tools name an expired sign-in with SIGN_IN_EXPIRED."""
    assert "sign" not in NOT_READABLE


#: A tool processes describes and runs but keeps out of every toolbox.
LAYER_DELETE: dict[str, Any] = {
    "id": "layer_delete",
    "title": "Layer Delete",
    "inputs": {
        "layer_id": {
            "title": "Layer",
            "schema": {"type": "string", "x-ui": {"widget": "layer-selector"}},
            "minOccurs": 1,
        }
    },
}
DELETE_DRAFT: dict[str, Any] = {
    "name": "Schools removed",
    "steps": [
        {"id": "schools", "kind": "dataset", "layer": 31},
        {"id": "drop", "kind": "tool", "tool": "layer_delete"},
    ],
    "connections": [{"from": "schools", "to": "drop", "input": "layer_id"}],
}
GRAVITY_DRAFT: dict[str, Any] = {
    "name": "Schools: gravity",
    "steps": [
        {"id": "schools", "kind": "dataset", "layer": 31},
        {
            "id": "heat",
            "kind": "tool",
            "tool": "heatmap_gravity",
            "settings": {"routing_mode": "walking"},
        },
        {"id": "save", "kind": "export", "name": "Gravity"},
    ],
    "connections": [
        {"from": "schools", "to": "heat", "input": "opportunity_layer_1_id"},
        {"from": "heat", "to": "save"},
    ],
}
UNKNOWN_DRAFT: dict[str, Any] = {
    **DRAFT,
    "steps": [
        *DRAFT["steps"][:3],
        {"id": "count", "kind": "tool", "tool": "aggregate_polygon_v9"},
        DRAFT["steps"][4],
    ],
}


@BOTH_TOOLS
@pytest.mark.parametrize(
    ("draft", "tool_id", "services"),
    [
        (
            DELETE_DRAFT,
            "layer_delete",
            {
                "descriptions": {"layer_delete": LAYER_DELETE},
                "toolbox": _toolbox(
                    extra=[
                        {
                            "id": "layer_delete",
                            "title": "Layer Delete",
                            "x-ui-toolbox-hidden": True,
                        }
                    ]
                ),
            },
        ),
        (
            GRAVITY_DRAFT,
            "heatmap_gravity",
            {"toolbox": _toolbox(without=frozenset({"heatmap_gravity"}))},
        ),
        (
            UNKNOWN_DRAFT,
            "aggregate_polygon_v9",
            {
                "descriptions": {
                    "aggregate_polygon_v9": httpx.Response(404, json={"detail": "none"})
                }
            },
        ),
    ],
    ids=["toolbox-hidden", "beta-outside-the-beta", "unknown"],
)
async def test_a_tool_outside_the_users_toolbox_is_refused(
    tool: Any, draft: dict[str, Any], tool_id: str, services: dict[str, Any]
) -> None:
    """Processes describes, checks and runs tools the user's toolbox leaves
    out (hidden ones, beta tools for a user outside the beta); a draft takes
    only the tools of ``GET /processes`` for this user, as workflow_tools
    lists them, and an id processes does not know at all goes back the same
    way."""
    core, processes, geoapi, catalog = _services(**services)
    with pytest.raises(InputInvalid) as caught:
        await execute(tool, _env(core, processes, geoapi, catalog), {"draft": draft})
    assert repr(tool_id) in caught.value.message
    assert "workflow_tools" in caught.value.message
    assert not _checked(processes)
    assert [r.method for r in core.requests] == ["GET"]


@pytest.mark.parametrize(
    "unavailable",
    [
        httpx.Response(503, json={"detail": "busy"}),
        httpx.Response(200, json={"links": []}),
    ],
    ids=["failing", "without-a-list"],
)
async def test_a_draft_is_unchecked_while_the_toolbox_cannot_be_read(
    unavailable: httpx.Response,
) -> None:
    """Which tools the user may use comes from the toolbox listing; without
    it nothing is checked or created. An answer without a list of tools is
    no listing: it would refuse every tool as outside the toolbox."""
    core, processes, geoapi, catalog = _services(toolbox=unavailable)
    result = await execute(
        CHECK_DRAFT, _env(core, processes, geoapi, catalog), {"draft": DRAFT}
    )
    assert (result["checked"], result["note"]) == (False, NOT_CHECKED)
    assert not _checked(processes)
    core, processes, geoapi, catalog = _services(toolbox=unavailable)
    with pytest.raises(ToolFailed) as caught:
        await execute(CREATE, _env(core, processes, geoapi, catalog), {"draft": DRAFT})
    assert caught.value.message == CHECK_UNAVAILABLE
    assert not _checked(processes)
    assert [r.method for r in core.requests] == ["GET"]


async def test_the_audit_row_keeps_the_workflow_created(
    repo: Repository, db: Database
) -> None:
    user = UUID(int=1)
    conversation = await repo.create_conversation(user, "project.workflows", None, None)
    run_id, _ = await repo.begin_run(
        UUID(str(conversation["id"])),
        user,
        [{"type": "user_text", "text": "build it"}],
        "test",
        "test",
        3,
    )
    core, processes, geoapi, catalog = _services()
    env = tool_env(
        fake_clients(core=core, processes=processes, geoapi=geoapi, catalog=catalog),
        page=PAGE,
        user_id=user,
        repo=repo,
        run_id=run_id,
    )
    result = await execute(CREATE, env, {"draft": DRAFT}, tool_call_id="c1")
    created = {"kind": "workflow", "ids": [WORKFLOW_ID], "project_id": PROJECT}
    assert WorkflowCreated.model_validate(result).created() == created
    async with db.pool.acquire() as conn:
        rows = await conn.fetch(
            f"SELECT tool, status, created FROM {db.t('tool_call')}"
        )
    assert [dict(row) for row in rows] == [
        {"tool": "workflow_create", "status": "ok", "created": created}
    ]
