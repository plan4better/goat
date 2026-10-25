"""workflow_tools and workflow_describe_tool (spec §3): the toolbox of the
user, each tool's layer inputs and settings in short, in the user's language,
from process descriptions captured from processes."""

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from pydantic_ai.exceptions import ToolFailed

from assistant.context import parse_context
from assistant.login import StaticLogin
from assistant.tools.runtime import execute
from assistant.tools.testing import Recorder, fake_clients, tool_env
from assistant.tools.workflow_tools import (
    DESCRIBE_TOOL,
    NOT_OFFERED,
    WORKFLOW_TOOL_LIST,
    clear_description_cache,
)
from assistant.workflows import tool_info

FIXTURE = Path(__file__).parent / "fixtures" / "process_descriptions.json"
PROCESSES: dict[str, Any] = json.loads(FIXTURE.read_text(encoding="utf-8"))
DESCRIPTIONS: dict[str, dict[str, Any]] = PROCESSES["descriptions"]
#: A tool processes knows and describes but keeps out of the toolbox.
HIDDEN = {"id": "custom_sql", "title": "Custom SQL", "x-ui-toolbox-hidden": True}
PAGE = parse_context(
    {
        "surface": "project.workflows",
        "project_id": "00000000-0000-0000-0000-0000000005e4",
    }
)


@pytest.fixture(autouse=True)
def _fresh_cache() -> Iterator[None]:
    clear_description_cache()
    yield
    clear_description_cache()


def _processes() -> Recorder:
    def listing(request: httpx.Request) -> httpx.Response:
        language = "de" if request.headers.get("accept-language") == "de" else "en"
        return httpx.Response(
            200, json={"processes": [*PROCESSES["list"][language], HIDDEN], "links": []}
        )

    routes: dict[tuple[str, str], Any] = {
        ("GET", "/processes"): listing,
        ("GET", "/processes/custom_sql"): {
            "id": "custom_sql",
            "title": "Custom SQL",
            "inputs": {},
        },
    }
    for tool_id, described in DESCRIPTIONS.items():
        routes[("GET", f"/processes/{tool_id}")] = described
    return Recorder(routes)


def _names(settings: list[tool_info.SettingInfo]) -> list[str]:
    return [setting.name for setting in settings]


def test_layer_inputs_are_every_handle_the_editor_draws() -> None:
    heatmap = tool_info.layer_inputs(DESCRIPTIONS["heatmap_gravity"])
    assert [i.name for i in heatmap] == [
        "reference_area_layer_id",
        "opportunity_layer_1_id",
        "opportunity_layer_2_id",
        "opportunity_layer_3_id",
    ]
    [starting, grid] = tool_info.layer_inputs(DESCRIPTIONS["catchment_area_v2"])
    assert starting.model_dump(exclude_none=True) == {
        "name": "starting_points",
        "title": "Starting points",
        "required": True,
        "geometry_types": ["Point", "MultiPoint"],
    }
    assert (grid.name, grid.required, grid.visible_when) == (
        "point_grid_layer_id",
        False,
        'catchment_area_type = "point_grid"',
    )


def test_settings_leave_out_hidden_layer_and_result_inputs() -> None:
    names = _names(tool_info.settings(DESCRIPTIONS["catchment_area_v2"]))
    assert names[:3] == ["routing_mode", "pt_modes", "pt_max_transfers"]
    assert {"max_cost", "steps", "cost_type", "show_advanced"} <= set(names)
    assert not {
        "starting_points",
        "point_grid_layer_id",
        "result_layer_name",
        "user_id",
        "output_format",
    } & set(names)


def test_a_setting_says_its_type_choices_and_default() -> None:
    by_name = {
        setting.name: setting.model_dump(exclude_none=True)
        for setting in tool_info.settings(DESCRIPTIONS["catchment_area_v2"])
    }
    assert by_name["routing_mode"] == {
        "name": "routing_mode",
        "title": "Transport mode",
        "description": "Select the transport mode for accessibility analysis",
        "type": "choice",
        "required": True,
        "choices": ["walking", "bicycle", "pedelec", "car", "pt"],
    }
    assert by_name["max_cost"] == {
        "name": "max_cost",
        "title": "Limit",
        "description": "Upper limit for the selected measure type: travel time or travel distance.",
        "type": "integer",
        "default": 15,
        "default_hint": (
            '30 if routing_mode = "pt", '
            'else 5000 if cost_type = "distance" and routing_mode = "car", '
            'else 30 if routing_mode = "car", else 500 if cost_type = "distance", '
            "else 15"
        ),
    }
    assert by_name["step_sizes"]["type"] == "list of integer"
    assert by_name["pt_modes"]["type"] == "choices"


def test_a_setting_says_what_it_means_and_shows_an_example() -> None:
    """The name and type do not say what a value means: step_sizes are band
    edges, not the width of each band. The description says it, in full, and
    the tool's own example shows it."""
    by_name = {
        setting.name: setting
        for setting in tool_info.settings(DESCRIPTIONS["catchment_area_v2"])
    }
    edges = by_name["step_sizes"]
    assert edges.description is not None and "band edges" in edges.description
    assert "e.g. 5, 10, 15" in edges.description
    assert edges.example == [5, 10, 15]
    assert by_name["routing_mode"].example is None


def test_a_description_that_only_repeats_the_title_is_left_out() -> None:
    [setting] = tool_info.settings(
        {
            "inputs": {
                "units": {
                    "title": "Units",
                    "description": "Units.",
                    "schema": {"type": "string", "title": "Units"},
                }
            }
        }
    )
    assert setting.description is None


def test_a_default_the_form_derives_is_given_in_short_form() -> None:
    """The form fills some settings in from others (x-ui `default_by_field`,
    `default_from`, `compute_from`, `default_all`); the summary says how, so a
    model that leaves the default out or sets it knows the value it takes."""
    catchment = {
        setting.name: setting
        for setting in tool_info.settings(DESCRIPTIONS["catchment_area_v2"])
    }
    assert catchment["speed"].default_hint == (
        '15 if routing_mode = "bicycle", else 23 if routing_mode = "pedelec", '
        'else 5 if routing_mode = "walking"'
    )
    assert catchment["access_speed"].default_hint == (
        '15 if access_mode = "bicycle", else 23 if access_mode = "pedelec", '
        'else 5 if access_mode = "walk"'
    )
    assert catchment["max_cost"].default_hint == (
        '30 if routing_mode = "pt", '
        'else 5000 if cost_type = "distance" and routing_mode = "car", '
        'else 30 if routing_mode = "car", else 500 if cost_type = "distance", '
        "else 15"
    )
    assert catchment["step_sizes"].default_hint == (
        "max_cost split into steps equal steps, rounded"
    )
    assert catchment["routing_mode"].default_hint is None
    join = {
        setting.name: setting for setting in tool_info.settings(DESCRIPTIONS["join"])
    }
    assert join["join_fields"].default_hint == "every field of join_layer_id"


def test_an_opportunity_default_follows_the_steps_settings() -> None:
    gravity = tool_info.opportunity_settings(DESCRIPTIONS["heatmap_gravity"])
    assert gravity is not None
    by_name = {setting.name: setting for setting in gravity}
    assert by_name["max_cost"].default_hint is not None
    assert by_name["max_cost"].default_hint.endswith("else 15")


def test_visibility_is_given_in_short_form() -> None:
    by_name = {
        setting.name: setting
        for setting in tool_info.settings(DESCRIPTIONS["catchment_area_v2"])
    }
    assert by_name["pt_max_transfers"].visible_when == (
        'routing_mode = "pt" and show_advanced = true'
    )


@pytest.mark.parametrize(
    ("condition", "text"),
    [
        ({"a": 1}, "a = 1"),
        ({"a": {"$ne": None}}, "a != null"),
        ({"a": {"$in": ["x", "y"]}}, 'a in ["x", "y"]'),
        ({"$or": [{"a": 1}, {"b": {"$exists": False}}]}, "a = 1 or b is not set"),
        (
            {"$and": [{"a": 1}, {"$or": [{"b": 2}, {"c": 3}]}]},
            "a = 1 and (b = 2 or c = 3)",
        ),
        ({"a": {"$gte": 2, "$lt": 5}, "b": True}, "a >= 2 and a < 5 and b = true"),
    ],
)
def test_conditions_are_one_line(condition: dict[str, Any], text: str) -> None:
    assert tool_info.short_condition(condition) == text


def test_field_settings_name_the_layer_input_they_read() -> None:
    by_name = {
        setting.name: setting
        for setting in tool_info.settings(DESCRIPTIONS["aggregate_polygon"])
    }
    assert by_name["group_by_field"].reads_layer == "source_layer_id"
    statistics = by_name["column_statistics"]
    assert (statistics.type, statistics.required) == ("list", True)
    assert statistics.items is not None
    items = {item.name: item for item in statistics.items}
    assert items["operation"].choices == [
        "count",
        "sum",
        "min",
        "max",
        "mean",
        "standard_deviation",
    ]
    assert items["field"].reads_layer == "source_layer_id"


def test_a_field_setting_names_the_layer_input_not_a_path_into_it() -> None:
    """catchment_area_v2's reference_field reads ``starting_points.layer_id``;
    the model connects to ``starting_points``."""
    by_name = {
        setting.name: setting
        for setting in tool_info.settings(DESCRIPTIONS["catchment_area_v2"])
    }
    assert by_name["reference_field"].reads_layer == "starting_points"
    unnamed = {
        "inputs": {
            "field": {
                "title": "Field",
                "schema": {"type": "string", "x-ui": {"widget": "field-selector"}},
            }
        }
    }
    [field] = tool_info.settings(unnamed)
    assert field.reads_layer is None


def _field_input(name: str, ui: dict[str, Any]) -> dict[str, Any]:
    return {"title": name, "schema": {"type": "string", "x-ui": ui}}


def _layer_input(name: str) -> dict[str, Any]:
    return _field_input(name, {"widget": "layer-selector"})


def test_field_settings_pair_with_the_layer_input_they_read() -> None:
    """As processes' check pairs them: the input ``source_layer`` names
    (before any dot), else ``<name>_layer_id`` for a name ending in
    ``_field``, else the tool's only layer input."""
    assert tool_info.field_inputs(DESCRIPTIONS["aggregate_polygon"]) == {
        "group_by_field": "source_layer_id"
    }
    assert tool_info.field_inputs(DESCRIPTIONS["catchment_area_v2"]) == {
        "reference_field": "starting_points"
    }
    assert tool_info.field_inputs(DESCRIPTIONS["join"]) == {
        "join_fields": "join_layer_id",
        "field_statistics": "join_layer_id",
    }
    # Only top-level inputs with a field widget: a heatmap's field settings
    # live inside its opportunities, buffer's distance_field has no widget.
    assert tool_info.field_inputs(DESCRIPTIONS["heatmap_gravity"]) == {}
    assert tool_info.field_inputs(DESCRIPTIONS["buffer"]) == {}
    field = {"widget": "field-selector"}
    one_input = {
        "inputs": {
            "input_layer_id": _layer_input("input_layer_id"),
            "target_field": _field_input("target_field", field),
            "group": _field_input("group", field),
        }
    }
    assert tool_info.field_inputs(one_input) == {
        "target_field": "target_layer_id",
        "group": "input_layer_id",
    }
    two_inputs = {
        "inputs": {
            "a_layer_id": _layer_input("a_layer_id"),
            "b_layer_id": _layer_input("b_layer_id"),
            "group": _field_input("group", field),
        }
    }
    assert tool_info.field_inputs(two_inputs) == {}


def test_list_settings_pair_their_items_fields_with_the_layer_input_they_read() -> None:
    """An item's own ``source_layer`` first, else the list setting's
    pairing; a heatmap's opportunities read their numbered handles."""
    assert tool_info.list_field_inputs(DESCRIPTIONS["aggregate_polygon"]) == {
        "column_statistics": frozenset({"source_layer_id"})
    }
    assert tool_info.list_field_inputs(DESCRIPTIONS["join"]) == {
        "attribute_relationships": frozenset({"target_layer_id", "join_layer_id"})
    }
    assert tool_info.list_field_inputs(DESCRIPTIONS["heatmap_gravity"]) == {}
    assert tool_info.list_field_inputs(DESCRIPTIONS["catchment_area_v2"]) == {}
    item = {"type": "object", "properties": {"weight_field": {"type": "string"}}}
    one_input = {
        "inputs": {
            "input_layer_id": _layer_input("input_layer_id"),
            "weights": {"title": "Weights", "schema": {"type": "array", "items": item}},
        }
    }
    assert tool_info.list_field_inputs(one_input) == {
        "weights": frozenset({"input_layer_id"})
    }


def test_an_opportunity_keeps_every_field_of_its_item() -> None:
    """Its layer's own fields too: processes reports a problem with any of
    them as ``opportunity_<N>_<name>``."""
    fields = tool_info.opportunity_fields(DESCRIPTIONS["heatmap_gravity"])
    assert {"input_path", "max_cost", "potential_field"} <= set(fields)
    assert tool_info.opportunity_fields(DESCRIPTIONS["buffer"]) == []


def test_heatmaps_have_settings_per_opportunity() -> None:
    gravity = tool_info.opportunity_settings(DESCRIPTIONS["heatmap_gravity"])
    assert gravity is not None
    assert _names(gravity) == [
        "max_cost",
        "sensitivity",
        "potential_type",
        "potential_field",
        "potential_constant",
        "potential_expression",
    ]
    assert {s.name: s.reads_layer for s in gravity}["potential_field"] == (
        "opportunity_layer_<N>_id"
    )
    closest = tool_info.opportunity_settings(DESCRIPTIONS["heatmap_closest_average"])
    assert closest is not None and _names(closest) == ["max_cost", "n_destinations"]
    assert tool_info.opportunity_settings(DESCRIPTIONS["buffer"]) is None


def test_an_opportunity_condition_names_the_numbered_handle() -> None:
    """An opportunity's layer is ``input_path`` in its schema and
    ``opportunity_layer_<N>_id`` on the canvas; conditions say the latter."""
    gravity = {
        setting.name: setting
        for setting in tool_info.opportunity_settings(DESCRIPTIONS["heatmap_gravity"])
        or []
    }
    assert gravity["max_cost"].visible_when == "opportunity_layer_<N>_id != null"
    assert gravity["potential_field"].visible_when == (
        'opportunity_layer_<N>_id != null and potential_type = "field"'
    )
    closest = {
        setting.name: setting
        for setting in tool_info.opportunity_settings(
            DESCRIPTIONS["heatmap_closest_average"]
        )
        or []
    }
    assert closest["max_cost"].visible_when == (
        '(reference_area_layer_id is not set or routing_mode = "pt" or '
        "show_advanced != true) and opportunity_layer_<N>_id != null"
    )
    for setting in [*gravity.values(), *closest.values()]:
        conditions = f"{setting.visible_when} {setting.hidden_when}"
        assert "input_path" not in conditions, setting.name


async def test_workflow_tools_lists_the_toolbox_in_the_users_language() -> None:
    processes = _processes()
    env = tool_env(fake_clients(processes=processes), page=PAGE, locale="de")
    result = await execute(WORKFLOW_TOOL_LIST, env, {})
    tools = {tool["id"]: tool for tool in result["tools"]}
    assert "custom_sql" not in tools
    assert set(tools) == set(DESCRIPTIONS)
    assert tools["aggregate_polygon"]["title"] == "Polygone aggregieren"
    assert [i["name"] for i in tools["aggregate_polygon"]["layer_inputs"]] == [
        "source_layer_id",
        "area_layer_id",
    ]
    assert tools["buffer"]["summary"].endswith(".")
    assert {request.headers["accept-language"] for request in processes.requests} == {
        "de"
    }


async def test_descriptions_are_cached_per_language() -> None:
    processes = _processes()
    english = tool_env(fake_clients(processes=processes), page=PAGE)
    await execute(WORKFLOW_TOOL_LIST, english, {})
    await execute(WORKFLOW_TOOL_LIST, english, {})
    described = [path for path in processes.paths() if path != "/processes"]
    assert sorted(described) == sorted(f"/processes/{tool}" for tool in DESCRIPTIONS)
    german = tool_env(fake_clients(processes=processes), page=PAGE, locale="de")
    await execute(WORKFLOW_TOOL_LIST, german, {})
    assert len([p for p in processes.paths() if p != "/processes"]) == 2 * len(
        DESCRIPTIONS
    )


async def test_describe_says_when_a_tool_is_not_offered() -> None:
    processes = _processes()
    env = tool_env(fake_clients(processes=processes), page=PAGE)
    result = await execute(
        DESCRIBE_TOOL, env, {"tool_ids": ["no_such_tool", "custom_sql", "buffer"]}
    )
    assert result["tools"][:2] == [
        {"id": "no_such_tool", "note": NOT_OFFERED},
        {"id": "custom_sql", "note": NOT_OFFERED},
    ]
    assert result["tools"][2]["title"] == "Buffer"
    assert "/processes/no_such_tool" not in processes.paths()
    assert "/processes/custom_sql" not in processes.paths()


def _failing(tool_id: str) -> Recorder:
    processes = _processes()
    processes.routes[("GET", f"/processes/{tool_id}")] = httpx.Response(
        500, json={"detail": "boom"}
    )
    return processes


async def test_one_tool_without_a_description_does_not_fail_the_list() -> None:
    env = tool_env(fake_clients(processes=_failing("join")), page=PAGE)
    result = await execute(WORKFLOW_TOOL_LIST, env, {})
    tools = {tool["id"]: tool for tool in result["tools"]}
    assert set(tools) == set(DESCRIPTIONS)
    assert tools["join"]["layer_inputs"] == []
    assert tools["buffer"]["layer_inputs"][0]["name"] == "input_layer_id"


async def test_a_listing_without_a_list_of_tools_is_a_failure() -> None:
    """Not an empty toolbox: the model is told the tools could not be read."""
    processes = _processes()
    processes.routes[("GET", "/processes")] = {"links": []}
    env = tool_env(fake_clients(processes=processes), page=PAGE)
    for spec, args in (
        (WORKFLOW_TOOL_LIST, {}),
        (DESCRIBE_TOOL, {"tool_ids": ["buffer"]}),
    ):
        with pytest.raises(ToolFailed, match="no list of tools"):
            await execute(spec, env, args)


async def test_describe_names_the_tool_it_could_not_describe() -> None:
    env = tool_env(fake_clients(processes=_failing("join")), page=PAGE)
    with pytest.raises(ToolFailed) as failed:
        await execute(DESCRIBE_TOOL, env, {"tool_ids": ["buffer", "join"]})
    assert "join" in failed.value.message
    assert "HTTP 500" in failed.value.message


async def test_describe_takes_several_tools_in_one_call() -> None:
    env = tool_env(fake_clients(processes=_processes()), page=PAGE)
    result = await execute(
        DESCRIBE_TOOL, env, {"tool_ids": ["catchment_area_v2", "heatmap_gravity"]}
    )
    catchment, heatmap = result["tools"]
    assert catchment["layer_inputs"][0]["name"] == "starting_points"
    assert "per_opportunity" not in catchment
    assert heatmap["note"] == tool_info.OPPORTUNITY_NOTE
    assert heatmap["per_opportunity"][0]["name"] == "max_cost"
    assert len(json.dumps(result)) < 20_000


async def test_a_tool_sends_the_users_language_and_keeps_its_sign_in() -> None:
    core = Recorder({("GET", "/x"): {"ok": True}})
    env = tool_env(fake_clients(core=core), login=StaticLogin("token-1"))
    await env.call(
        "core",
        "GET",
        "/x",
        headers={"Accept-Language": "de", "Authorization": "Bearer evil"},
    )
    [request] = core.requests
    assert request.headers["accept-language"] == "de"
    assert request.headers["authorization"] == "Bearer token-1"


async def test_no_spelling_of_authorization_replaces_the_sign_in() -> None:
    core = Recorder({("GET", "/x"): {"ok": True}})
    signed_in = tool_env(fake_clients(core=core), login=StaticLogin("token-1"))
    await signed_in.call("core", "GET", "/x", headers={"authorization": "Bearer evil"})
    without_auth = tool_env(fake_clients(core=core))
    await without_auth.call("core", "GET", "/x", headers={"Authorization": "Bearer x"})
    assert [r.headers.get_list("authorization") for r in core.requests] == [
        ["Bearer token-1"],
        [],
    ]


async def test_the_toolbox_is_asked_with_the_largest_limit_processes_takes() -> None:
    """``GET /processes`` cuts its list at ``limit`` (100 unless asked, at most
    1000, no paging), so a toolbox longer than the default is not cut."""
    processes = _processes()
    env = tool_env(fake_clients(processes=processes), page=PAGE)
    await execute(WORKFLOW_TOOL_LIST, env, {})
    await execute(DESCRIBE_TOOL, env, {"tool_ids": ["buffer"]})
    listings = [r for r in processes.requests if r.url.path == "/processes"]
    assert [r.url.params.get("limit") for r in listings] == ["1000", "1000"]
