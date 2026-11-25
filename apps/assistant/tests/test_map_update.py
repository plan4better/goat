"""map_update changes the map itself: a layer's state and name, the order and
the groups, the basemap, the scene, and the view, which it hands to the page.
Everything is planned on one read of the map before the first write; a write
that fails after another landed ends the call with a result, never an error.
Core, geoapi and processes are the eval stand-ins of the map project."""

import copy
import dataclasses
import json
from collections.abc import Callable, Iterator
from typing import Any
from uuid import UUID

import httpx
import pytest
from pydantic import ValidationError
from pydantic_ai import Agent, RunContext
from pydantic_ai.exceptions import ToolFailed
from pydantic_ai.messages import RetryPromptPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models import Model

from assistant.agent import INSTRUCTIONS, RunDeps, build_agent
from assistant.asks import AskHistory, AskUserInput
from assistant.bus import InMemoryEventBus
from assistant.config import AssistantSettings
from assistant.context import ProjectMapContext, parse_context
from assistant.events import to_ui_message
from assistant.login import Login, StaticLogin
from assistant.maps.filter_rows import FilterBrief, FilterRowView, apply_row_ops, brief
from assistant.maps.operations import (
    MAX_OPERATIONS,
    FilterLayer,
    MapUpdateInput,
    SetView,
)
from assistant.maps.state import MapRead, read_map
from assistant.maps.view import ViewTarget, merged_view, view_target
from assistant.repo import Repository
from assistant.runs.manager import RunManager
from assistant.surfaces import SURFACES
from assistant.tools.http import SIGN_IN_EXPIRED
from assistant.tools.map_edits import (
    CONFIRM_NOTE,
    MAP_SURFACES,
    MAP_UPDATE,
    MAY_BE_SAVED,
    NO_GROUP_ID,
    NOT_EMPTY_NOW,
    REPEATED_MAP_EDIT,
    REPLACED_VIEW,
    STOPPED,
    VIEWER,
    FailedOp,
    MapUpdated,
    Planned,
    apply,
    plan,
    stored,
)
from assistant.tools.project import GET_LAYERS, STILL_COPYING
from assistant.tools.registry import BY_WIRE_NAME, tools_for
from assistant.tools.runtime import Creates, InputInvalid, ToolEnv, Undoes, execute
from assistant.tools.testing import (
    Recorder,
    ScriptedModel,
    fake_clients,
    signed_in,
    tool_env,
)
from assistant.tools.toolset import REPEATED_CALL, earlier_writes
from assistant.workflows.runs import ConversationRuns
from evals.backends import Backends, write_eval_catalog
from evals.graders import grade
from evals.harness import ToolCall, Transcript, auto_answer
from evals.map_backends import MapState, map_core
from evals.map_fixture import (
    LAND_USE_QUERY,
    MAP_PROJECT_ID,
    MAP_VIEW_PROJECT_ID,
    map_layer,
)
from evals.tasks import load_tasks
from tests.test_style_get import _geoapi, _processes, _Proxy

BASEMAPS = [
    {"id": "light", "name": "Light", "tone": "light"},
    {"id": "dark", "name": "Dark", "tone": "dark"},
    {"id": "satellite", "name": "Satellite", "tone": "dark", "imagery": True},
]
#: The fixture's tree as the map document lists it: top first.
TREE = [
    {"id": 32, "type": "layer", "order": 0, "parent_id": None},
    {"id": 35, "type": "layer", "order": 1, "parent_id": None},
    {"id": 2, "type": "group", "order": 2, "parent_id": None},
    {"id": 40, "type": "layer", "order": 0, "parent_id": 2},
    {"id": 33, "type": "layer", "order": 1, "parent_id": 2},
    {"id": 41, "type": "layer", "order": 2, "parent_id": 2},
    {"id": 1, "type": "group", "order": 3, "parent_id": None},
    {"id": 36, "type": "layer", "order": 0, "parent_id": 1},
    {"id": 34, "type": "layer", "order": 1, "parent_id": 1},
    {"id": 31, "type": "layer", "order": 2, "parent_id": 1},
    {"id": 39, "type": "layer", "order": 3, "parent_id": 1},
    {"id": 37, "type": "layer", "order": 4, "parent_id": None},
    {"id": 38, "type": "layer", "order": 5, "parent_id": None},
]


class _Services:
    def __init__(
        self,
        state: MapState,
        *,
        core: Any = None,
        processes: Recorder | None = None,
        read_only: bool = False,
        login: Login | None = None,
        basemaps: list[dict[str, Any]] | None = None,
    ) -> None:
        self.state = state
        self.project_id = MAP_VIEW_PROJECT_ID if read_only else MAP_PROJECT_ID
        self.base = f"/api/v2/project/{self.project_id}"
        self.core = core if core is not None else map_core(state, read_only=read_only)
        self.processes = processes if processes is not None else _processes()
        self.geoapi = _geoapi()
        page = {
            "surface": "project.map",
            "project_id": self.project_id,
            "basemaps": BASEMAPS if basemaps is None else basemaps,
        }
        self.env: ToolEnv = tool_env(
            fake_clients(core=self.core, geoapi=self.geoapi, processes=self.processes),
            page=parse_context(page),
            login=login,
        )

    def writes(self) -> list[tuple[str, str, Any]]:
        """Core's requests that are no reads, as (method, path after the
        project's, body)."""
        return [
            (
                request.method,
                request.url.path[len(self.base) :]
                + (f"?{request.url.query.decode()}" if request.url.query else ""),
                json.loads(request.content) if request.content else None,
            )
            for request in self.core.requests
            if request.method != "GET"
        ]

    def reads(self) -> list[str]:
        return [
            request.url.path[len(self.base) :]
            for request in self.core.requests
            if request.method == "GET"
        ]


async def _update(services: _Services, *operations: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = await execute(
        MAP_UPDATE, services.env, {"operations": list(operations)}
    )
    return result


async def _run(services: _Services, *operations: dict[str, Any]) -> MapUpdated:
    result = await MAP_UPDATE.run(
        services.env, MapUpdateInput.model_validate({"operations": list(operations)})
    )
    assert isinstance(result, MapUpdated)
    return result


def _failing(
    state: MapState,
    fails: Callable[[httpx.Request], httpx.Response | None],
    *,
    read_only: bool = False,
) -> _Proxy:
    """The stand-in core, but ``fails`` answers a request in its place
    (without doing anything) when it returns a response."""
    core = map_core(state, read_only=read_only)

    def handler(request: httpx.Request) -> httpx.Response:
        refused = fails(request)
        if refused is not None:
            return refused
        response = core.answer(request)
        assert response is not None, request.url.path
        return response

    return _Proxy(handler)


def _on(method: str, ending: str, status: int, body: Any = None) -> Callable[..., Any]:
    def fails(request: httpx.Request) -> httpx.Response | None:
        if request.method == method and request.url.path.endswith(ending):
            return httpx.Response(status, json=body if body is not None else {})
        return None

    return fails


def _tree(state: MapState) -> list[dict[str, Any]]:
    """The stored tree as ``MapRead.tree`` reads it."""
    request = httpx.Request("GET", f"http://core/api/v2/project/{MAP_PROJECT_ID}/map")
    response = map_core(state).answer(request)
    assert response is not None
    found: list[dict[str, Any]] = []

    def walk(entries: list[dict[str, Any]], parent: int | None) -> None:
        for order, entry in enumerate(entries):
            found.append(
                {
                    "id": entry["id"],
                    "type": entry["type"],
                    "order": order,
                    "parent_id": parent,
                }
            )
            if entry["type"] == "group":
                walk(entry.get("children") or [], entry["id"])

    walk(response.json()["map"]["layers"], None)
    return found


# ---- the input -------------------------------------------------------------------


def _parse(*operations: Any) -> MapUpdateInput:
    return MapUpdateInput.model_validate({"operations": list(operations)})


def test_the_input_is_a_closed_list_of_operations() -> None:
    schema = MAP_UPDATE.json_schema()
    assert schema["required"] == ["operations"]
    operations = schema["properties"]["operations"]
    assert (operations["minItems"], operations["maxItems"]) == (1, MAX_OPERATIONS)
    assert MAX_OPERATIONS == 30
    ops = set()
    for definition in schema["$defs"].values():
        op = (definition.get("properties") or {}).get("op") or {}
        if "const" in op and definition["properties"].keys() != {"op", "path", "value"}:
            ops.add(op["const"])
    assert ops == {
        "set_layer",
        "filter",
        "move",
        "add_group",
        "rename_group",
        "set_group",
        "remove_group",
        "remove_layer",
        "set_basemap",
        "set_view",
        "set_scene",
    }
    with pytest.raises(ValidationError, match="does not match any of the expected"):
        _parse({"op": "delete_everything"})
    with pytest.raises(ValidationError):
        _parse()
    with pytest.raises(ValidationError):
        _parse(*[{"op": "set_layer", "layer_project_id": 31, "visible": True}] * 31)
    # No operation takes a key it does not know.
    with pytest.raises(ValidationError, match="Extra inputs"):
        _parse({"op": "set_basemap", "basemap_id": "dark", "tone": "dark"})


def test_every_field_of_every_operation_is_described() -> None:
    def walk(node: Any, where: str) -> None:
        if isinstance(node, dict):
            for name, sub in (node.get("properties") or {}).items():
                assert sub.get("description"), f"{where}.{name}"
                assert name not in ("project_id", "layer_id", "url"), name
            for key, value in node.items():
                walk(value, f"{where}.{key}")
        elif isinstance(node, list):
            for value in node:
                walk(value, where)

    walk(MAP_UPDATE.json_schema(), "map_update")
    text = json.dumps(MAP_UPDATE.json_schema()) + MAP_UPDATE.description
    assert "—" not in text and "–" not in text


def test_operations_are_checked_as_they_are_read() -> None:
    # set_layer and set_group change at least one thing.
    with pytest.raises(ValidationError, match="at least one of"):
        _parse({"op": "set_layer", "layer_project_id": 31})
    with pytest.raises(ValidationError, match="at least one of"):
        _parse({"op": "set_group", "group_id": 1})
    with pytest.raises(ValidationError):
        _parse({"op": "set_layer", "layer_project_id": 31, "position": "bottom"})
    # A name is 1 to 255 characters, without the blanks around it.
    assert (
        _parse({"op": "set_layer", "layer_project_id": 31, "name": "  Wards "})
        .operations[0]
        .name  # type: ignore[union-attr]
        == "Wards"
    )
    for name in ("", "   ", "x" * 256):
        with pytest.raises(ValidationError):
            _parse({"op": "set_layer", "layer_project_id": 31, "name": name})
        with pytest.raises(ValidationError):
            _parse({"op": "add_group", "name": name})
    # A style id is a UUID, kept in its canonical form.
    style = "5F000000-0000-4000-8000-000000000001"
    parsed = _parse(
        {"op": "set_layer", "layer_project_id": 31, "active_style_id": style}
    ).operations[0]
    assert parsed.active_style_id == style.lower()  # type: ignore[union-attr]
    with pytest.raises(ValidationError, match="project_get_layers"):
        _parse({"op": "set_layer", "layer_project_id": 31, "active_style_id": "x"})
    # A layer is named by its number, a new group by the operation that adds it.
    with pytest.raises(ValidationError):
        _parse({"op": "move", "item": {"type": "layer", "id": "new:0"}})
    with pytest.raises(ValidationError):
        _parse({"op": "rename_group", "group_id": "the first", "name": "A"})
    # Operations sent as JSON text are read as the objects.
    hide = {"op": "set_layer", "layer_project_id": 31, "visible": False}
    as_text = MapUpdateInput.model_validate({"operations": json.dumps([hide])})
    assert as_text == _parse(hide) == _parse(json.dumps(hide))


def test_a_view_is_camera_parts_or_a_layer_to_fit() -> None:
    assert _parse({"op": "set_view", "mode": "3d", "pitch": 50})
    assert _parse({"op": "set_view", "fit_layer_project_id": 31})
    assert _parse({"op": "set_view", "center": [12.4, 51.3], "zoom": 13})
    # A fit decides the camera; the mode and the projection may come with it.
    assert _parse(
        {
            "op": "set_view",
            "fit_layer_project_id": 31,
            "mode": "3d",
            "projection": "globe",
        }
    )
    fit = MAP_UPDATE.json_schema()["$defs"]["SetView"]["properties"][
        "fit_layer_project_id"
    ]["description"]
    assert "of the open project" in fit and "not a table or a raster" in fit
    for bad in (
        {},
        {"fit_layer_project_id": 31, "zoom": 12},
        {"fit_layer_project_id": 31, "center": [12.4, 51.3]},
        {"fit_layer_project_id": 31, "pitch": 40, "mode": "3d"},
        {"fit_layer_project_id": 31, "bearing": 10},
        {"zoom": 25},
        {"zoom": -1},
        {"pitch": 86},
        {"bearing": 361},
        {"center": [181, 0]},
        {"center": [0, 91]},
        {"center": [12.4]},
        {"mode": "4d"},
        {"projection": "flat"},
    ):
        with pytest.raises(ValidationError):
            _parse({"op": "set_view", **bad})


def test_a_scene_change_is_automatic_or_operations() -> None:
    assert _parse({"op": "set_scene", "automatic": True})
    ops = [{"op": "set", "path": "/terrain/exaggeration", "value": 1.5}]
    assert _parse({"op": "set_scene", "operations": ops})
    for bad in (
        {},
        {"automatic": False},
        {"automatic": True, "operations": ops},
        {"operations": []},
        {"operations": ops * 21},
        {"operations": [{"op": "add", "path": "/sky", "value": {}}]},
        {"operations": [{"op": "set", "path": "/sky"}]},
        {"operations": [{"op": "remove", "path": "/sky", "value": 1}]},
    ):
        with pytest.raises(ValidationError):
            _parse({"op": "set_scene", **bad})


# ---- layers ----------------------------------------------------------------------


async def test_set_layer_patches_only_the_fields_given_and_records_before_and_written() -> (
    None
):
    state = MapState()
    services = _Services(state)
    result = await _run(
        services,
        {
            "op": "set_layer",
            "layer_project_id": 33,
            "visible": False,
            "position": "below_labels",
        },
    )
    assert services.writes() == [
        (
            "PATCH",
            "/layer/33/map-state",
            {"visible": False, "position": "below_labels"},
        )
    ]
    assert state.layers[33]["visible"] is False
    assert state.layers[33]["position"] == "below_labels"
    assert state.layers[33]["legend_expanded"] is True
    payload = result.model_dump(mode="json", exclude_none=True)
    assert payload == {
        "project_id": MAP_PROJECT_ID,
        "confirm": [],
        "applied": [
            {
                "index": 0,
                "op": "set_layer",
                "layer_project_id": 33,
                "fields": ["visible", "position"],
                "summary": "'Bus lines': hidden, drawn below the basemap's labels.",
            }
        ],
    }
    assert isinstance(result, Undoes) and not isinstance(result, Creates)
    assert result.undo() == {
        "kind": "map",
        "project_id": MAP_PROJECT_ID,
        "changes": [
            {
                "object": "layer_state",
                "layer_project_id": 33,
                "before": {"visible": True, "position": "top"},
                "written": {"visible": False, "position": "below_labels"},
            }
        ],
    }
    # One read of the map, before the write.
    assert sorted(services.reads()) == ["", "/group", "/layer", "/map"]


async def test_a_later_operation_sees_what_an_earlier_one_did() -> None:
    state = MapState()
    services = _Services(state)
    hide = {"op": "set_layer", "layer_project_id": 33, "visible": False}
    closed = {"op": "set_layer", "layer_project_id": 33, "legend_expanded": False}
    show = {"op": "set_layer", "layer_project_id": 33, "visible": True}
    result = await _run(services, hide, closed, show)
    assert state.layers[33]["visible"] is True
    assert state.layers[33]["legend_expanded"] is False
    undo = result.undo()
    assert undo is not None
    # Changes of one layer that follow each other are one: the first before,
    # the last written.
    assert undo["changes"] == [
        {
            "object": "layer_state",
            "layer_project_id": 33,
            "before": {"visible": True, "legend_expanded": True},
            "written": {"visible": True, "legend_expanded": False},
        }
    ]
    assert [op.summary for op in result.applied] == [
        "'Bus lines': hidden.",
        "'Bus lines': legend closed.",
        "'Bus lines': shown.",
    ]


async def test_a_rename_goes_to_the_layer_route() -> None:
    state = MapState()
    services = _Services(state)
    result = await _run(
        services,
        {"op": "set_layer", "layer_project_id": 39, "name": "Wards of 1990"},
    )
    assert services.writes() == [("PUT", "/layer/39", {"name": "Wards of 1990"})]
    assert state.layers[39]["name"] == "Wards of 1990"
    [applied] = result.applied
    assert applied.fields == ["name"]
    assert applied.summary == "'Old boundaries' is now named 'Wards of 1990'."
    assert result.undo() == {
        "kind": "map",
        "project_id": MAP_PROJECT_ID,
        "changes": [
            {
                "object": "layer_name",
                "layer_project_id": 39,
                "before": "Old boundaries",
                "written": "Wards of 1990",
            }
        ],
    }


async def test_the_state_and_the_name_of_one_operation_are_two_writes() -> None:
    state = MapState()
    services = _Services(state)
    result = await _run(
        services,
        {"op": "set_layer", "layer_project_id": 39, "visible": False, "name": "Old"},
    )
    assert services.writes() == [
        ("PATCH", "/layer/39/map-state", {"visible": False}),
        ("PUT", "/layer/39", {"name": "Old"}),
    ]
    [applied] = result.applied
    assert applied.fields == ["visible", "name"]
    assert applied.summary == (
        "'Old boundaries': hidden. 'Old boundaries' is now named 'Old'."
    )
    undo = result.undo()
    assert undo is not None
    assert [change["object"] for change in undo["changes"]] == [
        "layer_state",
        "layer_name",
    ]


async def test_the_active_style_is_one_of_the_layers_styles() -> None:
    state = MapState()
    first = state.active_style_id(31)
    second = state.add_style(31, "Density", state.styles[first].document).id
    other = state.active_style_id(32)
    services = _Services(state)
    with pytest.raises(InputInvalid) as raised:
        await _update(
            services,
            {"op": "set_layer", "layer_project_id": 31, "active_style_id": other},
        )
    assert raised.value.message == (
        "operations[0] (set_layer): This style does not belong to 'Districts'. "
        f"Its styles are: Default ({first}), Density ({second})."
    )
    assert services.writes() == []
    result = await _run(
        services,
        {"op": "set_layer", "layer_project_id": 31, "active_style_id": second},
    )
    assert services.writes() == [
        ("PATCH", "/layer/31/map-state", {"active_style_id": second})
    ]
    assert state.layers[31]["active_style_id"] == second
    assert result.applied[0].summary == "'Districts': draws the style 'Density'."
    undo = result.undo()
    assert undo is not None
    assert undo["changes"] == [
        {
            "object": "layer_state",
            "layer_project_id": 31,
            "before": {"active_style_id": first},
            "written": {"active_style_id": second},
        }
    ]


async def test_an_unknown_layer_fails_the_whole_call_with_nothing_written() -> None:
    state = MapState()
    before = state.snapshot()
    services = _Services(state)
    with pytest.raises(InputInvalid) as raised:
        await _update(
            services,
            {"op": "set_layer", "layer_project_id": 33, "visible": False},
            {"op": "set_layer", "layer_project_id": 99, "visible": False},
        )
    assert raised.value.message == (
        "operations[1] (set_layer): There is no layer 99 in this project. Call "
        "project_get_layers to list the layers."
    )
    assert services.writes() == [] and state.snapshot() == before
    with pytest.raises(InputInvalid, match=r"operations\[0\] \(move\): There is no"):
        await _update(services, {"op": "move", "item": {"type": "layer", "id": 99}})
    with pytest.raises(InputInvalid) as raised:
        await _update(services, {"op": "rename_group", "group_id": 9, "name": "A"})
    assert raised.value.message == (
        "operations[0] (rename_group): There is no group 9 in this project. Its "
        "groups are: 1 (Base data), 2 (Transport)."
    )
    assert services.writes() == []


async def test_a_locked_layer_is_refused_before_any_write() -> None:
    state = MapState()
    core = map_core(state)

    def rows(request: httpx.Request) -> httpx.Response:
        response = core.answer(request)
        assert response is not None
        if request.url.path.endswith("/layer") and request.method == "GET":
            listed = response.json()
            for row in listed:
                if row["id"] == 33:
                    row["locked"] = True
            return httpx.Response(200, json=listed)
        return response

    services = _Services(state, core=_Proxy(rows))
    with pytest.raises(ToolFailed, match="no access to its data"):
        await _update(
            services,
            {"op": "set_layer", "layer_project_id": 32, "visible": False},
            {"op": "set_layer", "layer_project_id": 33, "visible": False},
        )
    assert services.writes() == []
    # Its data is not read for a view either.
    with pytest.raises(ToolFailed, match="no access to its data"):
        await _update(services, {"op": "set_view", "fit_layer_project_id": 33})
    assert services.processes.requests == []


def test_a_filter_operation_takes_one_to_twenty_row_operations() -> None:
    rows = [{"do": "clear"}]
    with pytest.raises(ValidationError):
        _parse({"op": "filter", "layer_project_id": 34, "rows": []})
    with pytest.raises(ValidationError):
        _parse({"op": "filter", "layer_project_id": 34, "rows": rows * 21})


# ---- removing a layer ------------------------------------------------------------

REMOVE_39 = {"op": "remove_layer", "layer_project_id": 39}
#: The card a good answer shows before a removal.
REMOVAL_CARD = {
    "questions": [
        {
            "question": "A dashboard widget, a workflow and a print layout use "
            "the layer Old boundaries. Remove it from the project?",
            "header": "Remove",
            "options": [
                {"label": "Keep it", "value": "keep", "recommended": True},
                {"label": "Remove it", "value": "remove_layer:39"},
            ],
        }
    ]
}
#: What a removal the user has not picked answers for the fixture's layer 39.
CONFIRM_39 = {
    "layer_project_id": 39,
    "name": "Old boundaries",
    "value": "remove_layer:39",
    "facts": 'The layer "Old boundaries" has 1 style and no filter. It is used '
    'in the dashboard (1 widget), the workflow "Boundary check" and the print '
    'layout "Overview".',
}


def _picked(
    services: _Services, value: str, card: dict[str, Any] | None = None
) -> None:
    """The user answered a card with the option of ``value`` (the first
    option when the card offers no such value)."""
    shown = AskUserInput.model_validate(card or REMOVAL_CARD)
    answer, _ = auto_answer("ask-1", shown, value)
    services.env = dataclasses.replace(
        services.env, asks=AskHistory(cards={"ask-1": shown}).with_answer(answer)
    )


async def test_a_removal_pick_from_an_earlier_request_asks_again() -> None:
    """The pick lies before the user's last typed message: a removal of the
    same layer later asks again, and so does a pick with the user's own
    text beside it."""
    state = MapState()
    services = _Services(state)
    _picked(services, "remove_layer:39")
    picked = services.env.asks
    services.env.asks = dataclasses.replace(picked, chain=frozenset())
    result = await _run(services, REMOVE_39)
    assert [item.value for item in result.confirm] == ["remove_layer:39"]
    shown = AskUserInput.model_validate(REMOVAL_CARD)
    answer, _ = auto_answer("ask-1", shown, "remove_layer:39")
    hedged = answer.model_copy(
        update={
            "answers": [
                reply.model_copy(update={"other": "wait, not yet"})
                for reply in answer.answers
            ]
        }
    )
    services.env.asks = AskHistory(cards={"ask-1": shown}).with_answer(hedged)
    result = await _run(services, REMOVE_39)
    assert [item.value for item in result.confirm] == ["remove_layer:39"]
    assert services.writes() == [] and 39 in state.layers


async def test_removal_without_a_pick_changes_nothing_and_answers_what_to_ask() -> None:
    """No failed step before the card: the call returns, with nothing
    applied, the value the card's option carries and what goes with the
    layer."""
    state = MapState()
    before = state.snapshot()
    services = _Services(state)
    result = await _run(services, REMOVE_39)
    assert result.applied == [] and result.failed is None and result.view is None
    assert [item.model_dump() for item in result.confirm] == [CONFIRM_39]
    assert result.note == CONFIRM_NOTE
    for phrase in (
        "Nothing was changed",
        "ask_user",
        "one option that carries its value and one that keeps the layer",
        "single-select",
        "does not come back with the undo button",
        "hide it",
    ):
        assert phrase in CONFIRM_NOTE, phrase
    # Nothing landed, so there is nothing to take back.
    assert result.undo() is None
    assert services.writes() == [] and state.snapshot() == before
    # The workflows and the print layouts are read once, beside the map.
    assert sorted(services.reads()) == sorted(
        ["", "/layer", "/group", "/map", "/workflow", "/report-layout"]
    )
    # As the model reads it.
    answered = await _update(services, REMOVE_39)
    assert answered["applied"] == [] and answered["confirm"] == [CONFIRM_39]
    # A layer with a filter and two styles, locked in a print layout's map.
    state.add_style(
        34, "Second", copy.deepcopy(state.styles[state.active_style_id(34)].document)
    )
    result = await _run(services, {"op": "remove_layer", "layer_project_id": 34})
    [asked] = result.confirm
    assert (asked.name, asked.value) == ("Land use", "remove_layer:34")
    assert asked.facts == (
        'The layer "Land use" has 2 styles and a filter. It is used in the '
        'print layout "Overview".'
    )
    # A layer used nowhere.
    result = await _run(services, {"op": "remove_layer", "layer_project_id": 32})
    assert result.confirm[0].facts == (
        'The layer "Points of interest" has 1 style and no filter. It is not '
        "used in the dashboard, a workflow, a print layout or a custom basemap."
    )
    assert services.writes() == []


async def test_a_result_without_a_removal_to_confirm_carries_an_empty_list() -> None:
    services = _Services(MapState())
    answered = await _update(
        services, {"op": "set_layer", "layer_project_id": 39, "visible": False}
    )
    assert answered["confirm"] == [] and len(answered["applied"]) == 1


async def test_a_removal_to_confirm_holds_back_the_whole_call() -> None:
    """The other operations of the call are valid, and none of them is
    applied: no write, no view, one entry per removal the user has not
    picked."""
    state = MapState()
    before = state.snapshot()
    services = _Services(state)
    result = await _run(
        services,
        {"op": "set_layer", "layer_project_id": 31, "visible": False},
        REMOVE_39,
        {"op": "remove_layer", "layer_project_id": 34},
        {"op": "set_view", "zoom": 9},
    )
    assert result.applied == [] and result.view is None and result.undo() is None
    assert [item.value for item in result.confirm] == [
        "remove_layer:39",
        "remove_layer:34",
    ]
    assert services.writes() == [] and state.snapshot() == before
    # One of the two picked: the other still holds the call back.
    _picked(services, "remove_layer:39")
    result = await _run(
        services, REMOVE_39, {"op": "remove_layer", "layer_project_id": 34}
    )
    assert [item.layer_project_id for item in result.confirm] == [34]
    assert services.writes() == [] and 39 in state.layers


async def test_any_other_problem_beside_a_removal_to_confirm_fails_the_call() -> None:
    state = MapState()
    services = _Services(state)
    with pytest.raises(InputInvalid) as raised:
        await _update(
            services, REMOVE_39, {"op": "set_basemap", "basemap_id": "streets-9"}
        )
    assert raised.value.message.startswith("operations[1] (set_basemap): ")
    with pytest.raises(InputInvalid) as raised:
        await _update(
            services,
            {"op": "set_layer", "layer_project_id": 99, "visible": True},
            REMOVE_39,
        )
    assert raised.value.message.startswith("operations[0] (set_layer): ")
    # The layer counts as removed for the operations after it.
    with pytest.raises(InputInvalid) as raised:
        await _update(
            services,
            REMOVE_39,
            {"op": "set_layer", "layer_project_id": 39, "visible": False},
        )
    assert raised.value.message == (
        "operations[1] (set_layer): operations[0] of this call removes layer "
        "39, so no later operation can name it."
    )
    with pytest.raises(InputInvalid, match="There is no layer 99"):
        await _update(services, {"op": "remove_layer", "layer_project_id": 99})
    assert services.writes() == []


async def test_the_models_own_words_are_no_consent() -> None:
    """The card offered the removal, but the user picked to keep the layer
    and the model then says "yes, remove it": nothing is removed."""
    state = MapState()
    services = _Services(state)
    _picked(services, "keep")
    result = await _run(services, REMOVE_39)
    assert [item.model_dump() for item in result.confirm] == [CONFIRM_39]
    # A card that was shown and not answered is no pick either.
    services.env = dataclasses.replace(
        services.env,
        asks=AskHistory(cards={"ask-1": AskUserInput.model_validate(REMOVAL_CARD)}),
    )
    result = await _run(services, REMOVE_39)
    assert result.applied == [] and len(result.confirm) == 1
    assert services.writes() == [] and 39 in state.layers


async def test_a_pick_for_another_layer_does_not_count() -> None:
    state = MapState()
    services = _Services(state)
    other = copy.deepcopy(REMOVAL_CARD)
    other["questions"][0]["options"][1]["value"] = "remove_layer:34"
    _picked(services, "remove_layer:34", other)
    result = await _run(services, REMOVE_39)
    assert [item.model_dump() for item in result.confirm] == [CONFIRM_39]
    assert services.writes() == [] and 39 in state.layers


async def test_with_the_pick_the_layer_is_deleted_and_the_record_says_it_does_not_come_back() -> (
    None
):
    state = MapState()
    services = _Services(state)
    _picked(services, "remove_layer:39")
    result = await _run(services, REMOVE_39)
    assert services.writes() == [("DELETE", "/layer?layer_project_id=39", None)]
    # Nothing else was read for a removal the user picked.
    assert "/workflow" not in services.reads()
    assert 39 not in state.layers and state.removed == [39]
    [applied] = result.applied
    assert (applied.index, applied.op, applied.layer_project_id) == (
        0,
        "remove_layer",
        39,
    )
    # It names what went with the layer: one style, no filter.
    assert applied.summary == (
        'Removed the layer "Old boundaries" with its style. The dock\'s undo '
        "button does not bring it back."
    )
    undo = result.undo()
    assert undo is not None
    assert undo["changes"] == [
        {"object": "layer_removed", "layer_project_id": 39, "name": "Old boundaries"}
    ]


async def test_the_summary_of_a_removal_names_only_what_went_with_the_layer() -> None:
    state = MapState()
    state.add_style(
        34, "Second", copy.deepcopy(state.styles[state.active_style_id(34)].document)
    )
    services = _Services(state)
    other = copy.deepcopy(REMOVAL_CARD)
    other["questions"][0]["options"][1]["value"] = "remove_layer:34"
    _picked(services, "remove_layer:34", other)
    result = await _run(services, {"op": "remove_layer", "layer_project_id": 34})
    assert result.applied[0].summary == (
        'Removed the layer "Land use" with its 2 styles and its filter. The '
        "dock's undo button does not bring it back."
    )


async def test_a_removed_layer_is_out_of_the_rest_of_the_call() -> None:
    state = MapState()
    services = _Services(state)
    _picked(services, "remove_layer:39")
    for later in (
        {"op": "set_layer", "layer_project_id": 39, "visible": False},
        {"op": "move", "item": {"type": "layer", "id": 39}, "group_id": 2},
        {
            "op": "move",
            "item": {"type": "layer", "id": 31},
            "after": {"type": "layer", "id": 39},
        },
        {"op": "set_view", "fit_layer_project_id": 39},
        _filter(39, {"do": "clear"}),
        REMOVE_39,
    ):
        with pytest.raises(InputInvalid) as raised:
            await _update(services, REMOVE_39, later)
        assert raised.value.message == (
            f"operations[1] ({later['op']}): operations[0] of this call removes "
            "layer 39, so no later operation can name it."
        )
    assert services.writes() == [] and 39 in state.layers
    # A move after the removal writes the tree without the layer.
    result = await _run(
        services,
        REMOVE_39,
        {"op": "move", "item": {"type": "layer", "id": 31}, "group_id": 2},
    )
    [_, (method, path, body)] = services.writes()
    assert (method, path) == ("PUT", "/layer-tree")
    assert 39 not in [item["id"] for item in body["items"] if item["type"] == "layer"]
    assert [op.op for op in result.applied] == ["remove_layer", "move"]
    assert 39 not in [item["id"] for item in _tree(state) if item["type"] == "layer"]


async def test_a_layer_of_a_bundle_group_is_refused() -> None:
    state = MapState()
    core = map_core(state)

    def bundled(request: httpx.Request) -> httpx.Response:
        response = core.answer(request)
        assert response is not None
        if request.method == "GET" and request.url.path.endswith("/group"):
            groups = response.json()
            for group in groups:
                if group["id"] == 1:
                    group["bundle_id"] = "b0000000-0000-4000-8000-000000000001"
            return httpx.Response(200, json=groups)
        return response

    services = _Services(state, core=_Proxy(bundled))
    for picked in (False, True):
        if picked:
            _picked(services, "remove_layer:39")
        with pytest.raises(ToolFailed) as raised:
            await _update(services, REMOVE_39)
        assert raised.value.message == (
            "operations[0] (remove_layer): This layer belongs to a dataset "
            "bundle and cannot be removed on its own."
        )
    assert services.writes() == []
    # Core's own refusal says the same.
    detail = (
        "Layers in a bundle can't be removed individually; remove the bundle "
        "from the project instead."
    )
    state = MapState()
    services = _Services(
        state, core=_failing(state, _on("DELETE", "/layer", 409, {"detail": detail}))
    )
    _picked(services, "remove_layer:39")
    with pytest.raises(ToolFailed) as raised:
        await _update(services, REMOVE_39)
    assert raised.value.message == (
        "operations[0] (remove_layer): This layer belongs to a dataset bundle "
        "and cannot be removed on its own."
    )


async def test_a_viewer_cannot_remove_a_layer() -> None:
    state = MapState()
    services = _Services(state, read_only=True, login=signed_in(300))
    _picked(services, "remove_layer:39")
    with pytest.raises(ToolFailed) as raised:
        await _update(services, REMOVE_39)
    assert raised.value.message == VIEWER
    assert 39 in state.layers


async def test_uses_that_cannot_be_read_are_said_so() -> None:
    state = MapState()
    core = _failing(state, _on("GET", "/workflow", 500))
    services = _Services(state, core=core)
    [asked] = (await _run(services, REMOVE_39)).confirm
    assert asked.facts.endswith(
        'It is used in the dashboard (1 widget) and the print layout "Overview". '
        "Where it is used could not be read in full."
    )


async def test_a_locked_layer_can_be_removed_after_the_pick() -> None:
    """The layer list offers nothing but removal for a layer the user cannot
    read; what goes with it is not known, so the refusal leaves it out."""
    state = MapState()
    core = map_core(state)

    def locked(request: httpx.Request) -> httpx.Response:
        response = core.answer(request)
        assert response is not None
        if request.method == "GET" and request.url.path.endswith("/layer"):
            rows = response.json()
            for row in rows:
                if row["id"] == 39:
                    row["locked"] = True
            return httpx.Response(200, json=rows)
        return response

    services = _Services(state, core=_Proxy(locked))
    [asked] = (await _run(services, REMOVE_39)).confirm
    assert "has 1 style" not in asked.facts
    assert asked.value == "remove_layer:39"
    _picked(services, "remove_layer:39")
    removed = await _run(services, REMOVE_39)
    assert 39 not in state.layers
    # What went with it is not known, so the summary names nothing.
    assert removed.applied[0].summary == (
        'Removed the layer "Old boundaries". The dock\'s undo button does not '
        "bring it back."
    )


async def test_a_removal_without_an_answer_is_read_back() -> None:
    state = MapState()
    services = _Services(state, core=_losing(state, _any_write, lands=True))
    _picked(services, "remove_layer:39")
    result = await _run(services, REMOVE_39)
    assert result.failed is None and [op.op for op in result.applied] == [
        "remove_layer"
    ]
    state = MapState()
    services = _Services(state, core=_losing(state, _any_write, lands=False))
    _picked(services, "remove_layer:39")
    with pytest.raises(ToolFailed, match="operations\\[0\\] \\(remove_layer\\)"):
        await _run(services, REMOVE_39)
    assert 39 in state.layers


# ---- filters ---------------------------------------------------------------------

#: Land use's fields, as geoapi lists them (field_kind).
LAND_USE_FIELDS = {"use": "string", "area_m2": "number"}
NOT_RESIDENTIAL = {"field": "use", "op": "!=", "value": "residential"}


def _filter(link: int, *rows: dict[str, Any]) -> dict[str, Any]:
    return {"op": "filter", "layer_project_id": link, "rows": list(rows)}


def _add(*conditions: dict[str, Any]) -> dict[str, Any]:
    return {"do": "add", "conditions": list(conditions)}


def _counted(services: _Services) -> list[Any]:
    """The filters processes was asked to count with, in order."""
    return [
        json.loads(request.content)["inputs"].get("filter")
        for request in services.processes.requests
        if request.url.path == "/processes/feature-count/execution"
    ]


async def test_a_filter_operation_saves_the_whole_query_with_notes_and_metadata() -> (
    None
):
    state = MapState()
    metadata = {"intersection": {"label": "Study area", "geom_type": "Polygon"}}
    stored = {**copy.deepcopy(LAND_USE_QUERY), "metadata": metadata}
    state.layers[34]["query"] = copy.deepcopy(stored)
    services = _Services(state)
    rows = [_add(NOT_RESIDENTIAL), {"do": "set_match", "match": "all"}]
    result = await _run(services, _filter(34, *rows))
    [operation] = _parse(_filter(34, *rows)).operations
    assert isinstance(operation, FilterLayer)
    expected = apply_row_ops(stored, operation.rows, LAND_USE_FIELDS)
    assert expected is not None and expected["metadata"] == metadata
    # One write, the whole query; the fields were read from geoapi once.
    assert services.writes() == [("PUT", "/layer/34", {"query": expected})]
    assert state.layers[34]["query"] == expected
    assert [r.url.path for r in services.geoapi.requests] == [
        f"/collections/{map_layer(34).layer_id}/queryables"
    ]
    [applied] = result.applied
    assert (applied.index, applied.op, applied.layer_project_id) == (0, "filter", 34)
    assert applied.summary == (
        "'Land use': the filter's rows are now 1. area_m2 is greater than 5000; "
        '2. use is "industrial" (switched off); 3. custom; 4. use is not '
        '"residential" (a feature passes every switched-on row). Area: a drawn '
        'shape "Study area".'
    )
    undo = result.undo()
    assert undo is not None
    assert undo["changes"] == [
        {
            "object": "filter",
            "layer_project_id": 34,
            "before": stored,
            "written": expected,
        }
    ]


async def test_counts_before_and_after_come_with_the_result() -> None:
    state = MapState()
    services = _Services(state)
    result = await _run(services, _filter(34, _add(NOT_RESIDENTIAL)))
    [applied] = result.applied
    stored = state.layers[34]["query"]
    # The query before and the query after, each as CQL text.
    assert sorted(_counted(services)) == sorted(
        [json.dumps(LAND_USE_QUERY["cql"]), json.dumps(stored["cql"])]
    )
    assert applied.count_before is not None and applied.count_after is not None
    assert applied.count_after < applied.count_before
    # A layer without a filter counts every feature.
    clear = await _run(
        _Services(MapState()),
        _filter(33, _add({"field": "frequency_per_hour", "op": ">=", "value": 6})),
    )
    assert clear.applied[0].count_before == len(map_layer(33).features)
    assert clear.applied[0].count_after == 24


async def test_a_failed_count_leaves_the_numbers_out_and_saves_all_the_same() -> None:
    state = MapState()
    processes = _processes()
    processes.routes[("POST", "/processes/feature-count/execution")] = httpx.Response(
        500, json={"detail": "boom"}
    )
    services = _Services(state, processes=processes)
    result = await _run(services, _filter(34, _add(NOT_RESIDENTIAL)))
    [applied] = result.applied
    assert (applied.count_before, applied.count_after) == (None, None)
    assert state.layers[34]["query"] != LAND_USE_QUERY
    payload = result.model_dump(mode="json", exclude_none=True)
    assert "count_before" not in payload["applied"][0]


async def test_the_area_and_switched_off_rows_of_layer_34_survive() -> None:
    """End to end through the tool: one more condition on the stored filter
    with a drawn area, a switched-off row and a custom row keeps all three
    byte for byte, and the notes still point at the right rows."""
    state = MapState()
    services = _Services(state)
    await _run(services, _filter(34, _add(NOT_RESIDENTIAL)))
    written = state.layers[34]["query"]
    old = LAND_USE_QUERY
    assert written["cql"]["args"][:3] == old["cql"]["args"]
    assert written["ui"]["off"] == old["ui"]["off"]
    assert written["ui"]["area"] == old["ui"]["area"]
    assert brief(written, LAND_USE_FIELDS) == FilterBrief(
        match="all",
        rows=[
            FilterRowView(row=1, text="area_m2 is greater than 5000"),
            FilterRowView(row=2, text='use is "industrial"', on=False),
            FilterRowView(row=3, text="custom"),
            FilterRowView(row=4, text='use is not "residential"'),
        ],
        area='a drawn shape "Study area"',
    )
    # The layer list reads the same rows.
    layers = await execute(GET_LAYERS, services.env, {})
    [row] = [layer for layer in layers["layers"] if layer["layer_project_id"] == 34]
    assert [r["row"] for r in row["filter"]["rows"]] == [1, 2, 3, 4]
    assert row["filter"]["area"] == 'a drawn shape "Study area"'


async def test_clear_on_a_filter_without_an_area_saves_null() -> None:
    state = MapState()
    services = _Services(state)
    frequent = {"field": "frequency_per_hour", "op": ">=", "value": 6}
    await _run(services, _filter(33, _add(frequent)))
    added = state.layers[33]["query"]
    assert added is not None
    result = await _run(services, _filter(33, {"do": "clear"}))
    assert services.writes()[-1] == ("PUT", "/layer/33", {"query": None})
    assert state.layers[33]["query"] is None
    [applied] = result.applied
    assert applied.summary == "'Bus lines' has no filter now: every feature is shown."
    assert applied.count_after == len(map_layer(33).features)
    undo = result.undo()
    assert undo is not None
    assert undo["changes"] == [
        {"object": "filter", "layer_project_id": 33, "before": added, "written": None}
    ]
    # A long layer name still leaves room for the rows.
    state.layers[34]["name"] = "L" * 290
    long = await _run(_Services(state), _filter(34, _add(NOT_RESIDENTIAL)))
    assert len(long.applied[0].summary) <= 300
    assert "1. area_m2" in long.applied[0].summary
    state.layers[34]["name"] = "Land use"
    state.layers[34]["query"] = copy.deepcopy(LAND_USE_QUERY)
    # With an area, clear keeps the area.
    area = await _run(services, _filter(34, {"do": "clear"}))
    assert (
        state.layers[34]["query"]["cql"]["args"][0] == LAND_USE_QUERY["cql"]["args"][0]
    )
    assert area.applied[0].summary == (
        "'Land use': the filter has no rows now. Area: a drawn shape " '"Study area".'
    )


async def test_a_field_the_layer_does_not_have_is_input_invalid_before_any_write() -> (
    None
):
    state = MapState()
    before = state.snapshot()
    services = _Services(state)
    hide = {"op": "set_layer", "layer_project_id": 33, "visible": False}
    with pytest.raises(InputInvalid) as raised:
        await _update(
            services,
            hide,
            _filter(34, _add({"field": "colour", "op": "=", "value": "red"})),
        )
    assert raised.value.message.startswith("operations[1] (filter): Row operation 1: ")
    assert "colour" in raised.value.message
    # A row the filter does not have.
    with pytest.raises(InputInvalid) as raised:
        await _update(services, _filter(34, {"do": "remove", "row": 7}))
    assert raised.value.message == (
        "operations[0] (filter): Row operation 1: the filter has no row 7; its "
        "rows are 1 to 3."
    )
    assert services.writes() == [] and state.snapshot() == before
    assert services.processes.requests == []


async def test_cores_refusal_is_the_failure_reason() -> None:
    state = MapState()
    detail = "Invalid CQL query: the filter holds 21 conditions; at most 20."
    core = _failing(state, _on("PUT", "/layer/34", 422, {"detail": detail}))
    services = _Services(state, core=core)
    with pytest.raises(ToolFailed) as raised:
        await _run(services, _filter(34, _add(NOT_RESIDENTIAL)))
    assert raised.value.message == (
        f"operations[0] (filter): The filter was not saved: {detail}"
    )
    # After a landed write it is the failed operation's reason.
    hide = {"op": "set_layer", "layer_project_id": 33, "visible": False}
    result = await _run(services, hide, _filter(34, _add(NOT_RESIDENTIAL)))
    assert result.failed == FailedOp(
        index=1, reason=f"The filter was not saved: {detail}"
    )
    assert state.layers[34]["query"] == LAND_USE_QUERY
    # The other limit core checks, and its refusal wrapped in a validation
    # error, read as one sentence too.
    for detail, said in (
        (
            "The filter's ui notes take at most 16384 bytes; these take 20000.",
            "The filter's ui notes take at most 16384 bytes; these take 20000.",
        ),
        (
            "1 validation error for CQLQueryObject\ncql\n  Value error, Invalid "
            "CQL query: unknown op 'nope' [type=value_error, input_value={}, "
            "input_type=dict]\n    For further information visit "
            "https://errors.pydantic.dev/2.13/v/value_error",
            "Invalid CQL query: unknown op 'nope'",
        ),
    ):
        state = MapState()
        core = _failing(state, _on("PUT", "/layer/34", 422, {"detail": detail}))
        with pytest.raises(ToolFailed) as raised:
            await _run(_Services(state, core=core), _filter(34, _add(NOT_RESIDENTIAL)))
        assert raised.value.message == (
            f"operations[0] (filter): The filter was not saved: {said}"
        )


async def test_what_cannot_be_filtered_is_refused_before_any_write() -> None:
    state = MapState()
    services = _Services(state)
    with pytest.raises(ToolFailed) as raised:
        await _update(services, _filter(37, _add(NOT_RESIDENTIAL)))
    assert raised.value.message == (
        "operations[0] (filter): 'Elevation' is a raster layer, which has no filter."
    )
    with pytest.raises(InputInvalid, match="There is no layer 99"):
        await _update(services, _filter(99, _add(NOT_RESIDENTIAL)))
    assert services.geoapi.requests == []

    core = map_core(state)

    def rows(request: httpx.Request) -> httpx.Response:
        response = core.answer(request)
        assert response is not None
        if request.url.path.endswith("/layer") and request.method == "GET":
            listed = response.json()
            for row in listed:
                if row["id"] == 33:
                    row["locked"] = True
                if row["id"] == 36:
                    row["other_properties"] = {
                        "catalog_materialize": {"status": "running"}
                    }
            return httpx.Response(200, json=listed)
        return response

    services = _Services(state, core=_Proxy(rows))
    with pytest.raises(ToolFailed, match="no access to its data"):
        await _update(services, _filter(33, _add(NOT_RESIDENTIAL)))
    with pytest.raises(ToolFailed) as raised:
        await _update(services, _filter(36, _add(NOT_RESIDENTIAL)))
    assert raised.value.message == f"operations[0] (filter): {STILL_COPYING}"
    # Neither layer's dataset reaches geoapi.
    assert services.geoapi.requests == []
    assert services.writes() == []


async def test_fields_that_cannot_be_read_fail_the_call_before_any_write() -> None:
    state = MapState()
    services = _Services(state)
    services.geoapi.routes[
        ("GET", f"/collections/{map_layer(34).layer_id}/queryables")
    ] = httpx.Response(500, json={"detail": "boom"})
    hide = {"op": "set_layer", "layer_project_id": 33, "visible": False}
    with pytest.raises(ToolFailed) as raised:
        await _update(services, hide, _filter(34, _add(NOT_RESIDENTIAL)))
    assert raised.value.message == (
        "operations[1] (filter): The fields of 'Land use' could not be read, so "
        "its filter was not changed. Try again in a moment."
    )
    assert services.writes() == []


async def test_two_filter_operations_on_one_layer_build_on_each_other() -> None:
    state = MapState()
    services = _Services(state)
    result = await _run(
        services,
        _filter(34, _add(NOT_RESIDENTIAL)),
        _filter(34, {"do": "remove", "row": 4}),
    )
    # The second starts from the first: its row 4 is the one the first added.
    assert state.layers[34]["query"] == LAND_USE_QUERY
    undo = result.undo()
    assert undo is not None
    assert undo["changes"] == [
        {
            "object": "filter",
            "layer_project_id": 34,
            "before": LAND_USE_QUERY,
            "written": LAND_USE_QUERY,
        }
    ]
    assert [w[1] for w in services.writes()] == ["/layer/34", "/layer/34"]


async def test_a_filter_saved_without_an_answer_is_read_back() -> None:
    state = MapState()
    services = _Services(state, core=_losing(state, _any_write, lands=True))
    result = await _run(services, _filter(34, _add(NOT_RESIDENTIAL)))
    assert result.failed is None and result.applied[0].op == "filter"
    undo = result.undo()
    assert (
        undo is not None and undo["changes"][0]["written"] == state.layers[34]["query"]
    )
    # Not landed: the call fails as the write did.
    state = MapState()
    services = _Services(state, core=_losing(state, _any_write, lands=False))
    with pytest.raises(ToolFailed, match="operations\\[0\\] \\(filter\\)"):
        await _run(services, _filter(34, _add(NOT_RESIDENTIAL)))
    assert state.layers[34]["query"] == LAND_USE_QUERY
    # A cleared filter reads as none, and so does a layer that is gone: that
    # is no landed write.
    state = MapState()
    state.layers[33]["query"] = {
        "cql": {"op": ">=", "args": [{"property": "frequency_per_hour"}, 6]}
    }
    core = map_core(state)

    def without_33(request: httpx.Request) -> httpx.Response | None:
        if request.method == "GET" and request.url.path.endswith("/layer"):
            response = core.answer(request)
            assert response is not None
            rows = [row for row in response.json() if row["id"] != 33]
            return httpx.Response(200, json=rows)
        return None

    services = _Services(
        state, core=_losing(state, _any_write, lands=False, afterwards=without_33)
    )
    with pytest.raises(ToolFailed, match="operations\\[0\\] \\(filter\\)"):
        await _run(services, _filter(33, {"do": "clear"}))


def test_a_stored_filter_is_compared_without_the_keys_core_sends_empty() -> None:
    query = {"cql": {"op": "=", "args": [{"property": "use"}, "park"]}}
    row = {"id": 34, "query": {**query, "metadata": None, "ui": None}}
    read = MapRead(project={}, rows={34: row}, groups=[], document={}, styles={})
    change = {"object": "filter", "layer_project_id": 34, "before": None}
    assert stored(read, {**change, "written": query}) == query
    cleared = MapRead(
        project={},
        rows={34: {"id": 34, "query": {}}},
        groups=[],
        document={},
        styles={},
    )
    assert stored(cleared, {**change, "written": None}) is None


# ---- order and groups ------------------------------------------------------------


async def test_move_sends_the_whole_tree_with_orders_from_zero() -> None:
    state = MapState()
    assert _tree(state) == TREE
    services = _Services(state)
    # Districts to the top of Transport.
    result = await _run(
        services, {"op": "move", "item": {"type": "layer", "id": 31}, "group_id": 2}
    )
    written = [
        {"id": 32, "type": "layer", "order": 0, "parent_id": None},
        {"id": 35, "type": "layer", "order": 1, "parent_id": None},
        {"id": 2, "type": "group", "order": 2, "parent_id": None},
        {"id": 31, "type": "layer", "order": 0, "parent_id": 2},
        {"id": 40, "type": "layer", "order": 1, "parent_id": 2},
        {"id": 33, "type": "layer", "order": 2, "parent_id": 2},
        {"id": 41, "type": "layer", "order": 3, "parent_id": 2},
        {"id": 1, "type": "group", "order": 3, "parent_id": None},
        {"id": 36, "type": "layer", "order": 0, "parent_id": 1},
        {"id": 34, "type": "layer", "order": 1, "parent_id": 1},
        {"id": 39, "type": "layer", "order": 2, "parent_id": 1},
        {"id": 37, "type": "layer", "order": 4, "parent_id": None},
        {"id": 38, "type": "layer", "order": 5, "parent_id": None},
    ]
    assert services.writes() == [("PUT", "/layer-tree", {"items": written})]
    # What a fresh read of the map shows is what was written.
    assert _tree(state) == written
    read = await read_map(services.env, services.env.page.project_id)  # type: ignore[union-attr]
    assert read.tree() == written
    [applied] = result.applied
    assert (applied.op, applied.layer_project_id, applied.group_id) == (
        "move",
        31,
        None,
    )
    assert applied.summary == "'Districts' is now first in the group 'Transport'."
    assert result.undo() == {
        "kind": "map",
        "project_id": MAP_PROJECT_ID,
        "changes": [{"object": "tree", "before": TREE, "written": written}],
    }


async def test_a_move_places_an_item_after_another_or_at_the_top_level() -> None:
    state = MapState()
    services = _Services(state)
    result = await _run(
        services,
        {
            "op": "move",
            "item": {"type": "layer", "id": 39},
            "after": {"type": "group", "id": 2},
        },
        {
            "op": "move",
            "item": {"type": "group", "id": 1},
            "after": {"type": "layer", "id": 32},
        },
        {
            "op": "move",
            "item": {"type": "layer", "id": 41},
            "group_id": 2,
            "after": {"type": "layer", "id": 40},
        },
    )
    top = [item["id"] for item in _tree(state) if item["parent_id"] is None]
    assert top == [32, 1, 35, 2, 39, 37, 38]
    assert [i["id"] for i in _tree(state) if i["parent_id"] == 2] == [40, 41, 33]
    assert [op.summary for op in result.applied] == [
        "'Old boundaries' is now after 'Transport' at the top level.",
        "'Base data' is now after 'Points of interest' at the top level.",
        "'Cycling network' is now after 'Stations' in the group 'Transport'.",
    ]
    assert [(op.layer_project_id, op.group_id) for op in result.applied] == [
        (39, None),
        (None, 1),
        (41, None),
    ]
    # An item cannot follow itself, or one that is somewhere else.
    for after in ({"type": "layer", "id": 40}, {"type": "layer", "id": 36}):
        with pytest.raises(InputInvalid, match=r"operations\[0\] \(move\)"):
            await _update(
                services,
                {
                    "op": "move",
                    "item": {"type": "layer", "id": 40},
                    "group_id": 2,
                    "after": after,
                },
            )


async def test_two_moves_in_one_call_are_one_tree_change() -> None:
    state = MapState()
    services = _Services(state)
    result = await _run(
        services,
        {"op": "move", "item": {"type": "layer", "id": 31}, "group_id": 2},
        {"op": "move", "item": {"type": "layer", "id": 38}},
    )
    assert [method for method, _, _ in services.writes()] == ["PUT", "PUT"]
    undo = result.undo()
    assert undo is not None
    [change] = undo["changes"]
    assert change["object"] == "tree"
    assert change["before"] == TREE
    assert change["written"] == _tree(state)
    assert change["written"] == services.writes()[-1][2]["items"]
    assert [i["id"] for i in _tree(state) if i["parent_id"] is None][0] == 38
    # A change of something else between two moves keeps them apart.
    state = MapState()
    services = _Services(state)
    result = await _run(
        services,
        {"op": "move", "item": {"type": "layer", "id": 31}, "group_id": 2},
        {"op": "set_layer", "layer_project_id": 31, "visible": False},
        {"op": "move", "item": {"type": "layer", "id": 38}},
    )
    undo = result.undo()
    assert undo is not None
    first, between, last = undo["changes"]
    assert [c["object"] for c in undo["changes"]] == ["tree", "layer_state", "tree"]
    assert first["before"] == TREE and first["written"] == last["before"]
    assert last["written"] == _tree(state)


async def test_a_group_can_be_added_and_a_layer_moved_into_it_in_the_same_call() -> (
    None
):
    state = MapState()
    services = _Services(state)
    result = await _run(
        services,
        {"op": "add_group", "name": "Elections"},
        {"op": "move", "item": {"type": "layer", "id": 35}, "group_id": "new:0"},
        {"op": "rename_group", "group_id": "new:0", "name": "Votes"},
    )
    # Core answered 3 for the new group, and the later operations name it so.
    assert state.groups[3]["name"] == "Votes"
    assert state.layers[35]["layer_project_group_id"] == 3
    post, put, rename = services.writes()
    assert post == ("POST", "/group", {"name": "Elections"})
    assert put[:2] == ("PUT", "/layer-tree")
    assert {"id": 3, "type": "group", "order": 0, "parent_id": None} in put[2]["items"]
    assert {"id": 35, "type": "layer", "order": 0, "parent_id": 3} in put[2]["items"]
    assert rename == ("PUT", "/group/3", {"name": "Votes"})
    assert [op.group_id for op in result.applied] == [3, None, 3]
    assert result.applied[0].summary == "Added the group 'Elections' at the top level."
    assert result.applied[1].summary == (
        "'Polling stations' is now first in the group 'Elections'."
    )
    undo = result.undo()
    assert undo is not None
    added, tree, name = undo["changes"]
    assert added == {"object": "group_added", "group_id": 3}
    assert tree["written"] == _tree(state)
    assert {"id": 3, "type": "group", "order": 0, "parent_id": None} in tree["before"]
    assert name == {
        "object": "group_name",
        "group_id": 3,
        "before": "Elections",
        "written": "Votes",
    }
    # A reference names an add_group operation that came before.
    for ref in ("new:1", "new:2", "new:7"):
        with pytest.raises(InputInvalid, match="add_group"):
            await _update(
                services,
                {"op": "set_layer", "layer_project_id": 31, "visible": True},
                {"op": "move", "item": {"type": "layer", "id": 35}, "group_id": ref},
                {"op": "add_group", "name": "Later"},
            )


async def test_a_group_is_added_inside_a_group_renamed_shown_and_closed() -> None:
    state = MapState()
    services = _Services(state)
    result = await _run(
        services,
        {"op": "add_group", "name": "Rail", "parent_group_id": 2},
        {"op": "rename_group", "group_id": 1, "name": "Basis"},
        {"op": "set_group", "group_id": 1, "visible": False, "expanded": False},
    )
    post, rename, shown, closed = services.writes()
    assert post == ("POST", "/group", {"name": "Rail", "parent_id": 2})
    assert rename == ("PUT", "/group/1", {"name": "Basis"})
    assert shown == ("PATCH", "/group/1/map-state", {"visible": False})
    # Opened or closed goes with the whole tree, in the order it has.
    assert closed[:2] == ("PUT", "/layer-tree")
    items = closed[2]["items"]
    assert {
        "id": 1,
        "type": "group",
        "order": 3,
        "parent_id": None,
        "expanded": False,
    } in items
    assert [i for i in items if "expanded" in i or "visible" in i] == [
        {"id": 1, "type": "group", "order": 3, "parent_id": None, "expanded": False}
    ]
    assert state.groups[1] == {
        "name": "Basis",
        "parent_id": None,
        "order": 3,
        "visible": False,
        "expanded": False,
    }
    assert state.groups[3]["parent_id"] == 2
    assert [op.summary for op in result.applied] == [
        "Added the group 'Rail' in the group 'Transport'.",
        "The group 'Base data' is now named 'Basis'.",
        "The group 'Basis' is hidden. The group 'Basis' is closed.",
    ]
    assert result.applied[2].fields == ["visible", "expanded"]
    undo = result.undo()
    assert undo is not None
    assert undo["changes"] == [
        {"object": "group_added", "group_id": 3},
        {
            "object": "group_name",
            "group_id": 1,
            "before": "Base data",
            "written": "Basis",
        },
        {
            "object": "group_state",
            "group_id": 1,
            "before": {"visible": True, "expanded": True},
            "written": {"visible": False, "expanded": False},
        },
    ]


async def test_remove_group_with_layers_is_refused_before_any_write() -> None:
    state = MapState()
    before = state.snapshot()
    services = _Services(state)
    with pytest.raises(InputInvalid) as raised:
        await _update(
            services,
            {"op": "set_layer", "layer_project_id": 33, "visible": False},
            {"op": "remove_group", "group_id": 2},
        )
    assert raised.value.message == (
        "operations[1] (remove_group): The group 'Transport' holds 3 layers or "
        "groups, and a group is removed only when it is empty. Move them out "
        "first, or hide the group with set_group."
    )
    assert services.writes() == [] and state.snapshot() == before
    # Emptied in the same call, it goes.
    result = await _run(
        services,
        *(
            {"op": "move", "item": {"type": "layer", "id": link}}
            for link in (40, 33, 41)
        ),
        {"op": "remove_group", "group_id": 2},
    )
    assert services.writes()[-1] == ("DELETE", "/group/2", None)
    assert 2 not in state.groups and state.removed == []
    assert set(state.layers) == set(before["layers"])
    assert result.applied[-1].summary == "Removed the empty group 'Transport'."
    assert result.applied[-1].group_id == 2
    undo = result.undo()
    assert undo is not None
    assert undo["changes"][-1] == {
        "object": "group_removed",
        "group_id": 2,
        "before": {"name": "Transport", "parent_id": None, "order": 5},
    }
    assert [c["object"] for c in undo["changes"]] == ["tree", "group_removed"]
    # A group the same call added is named by the id core gave it.
    result = await _run(
        services,
        {"op": "add_group", "name": "Schools"},
        {"op": "remove_group", "group_id": "new:0"},
    )
    undo = result.undo()
    assert undo is not None
    [added, removed] = undo["changes"]
    assert added == {"object": "group_added", "group_id": removed["group_id"]}
    assert removed["group_id"] > 2


async def test_a_group_that_is_not_empty_any_more_is_not_deleted() -> None:
    """Deleting a group deletes the layers in it: the group is read once
    more right before, and a layer that arrived meanwhile stops the delete."""
    state = MapState()
    state.groups[5] = {
        "name": "Empty",
        "parent_id": None,
        "order": 9,
        "visible": True,
        "expanded": True,
    }
    core = map_core(state)
    reads = {"layers": 0}

    def arrives(request: httpx.Request) -> httpx.Response:
        if request.method == "GET" and request.url.path.endswith("/layer"):
            reads["layers"] += 1
            if reads["layers"] == 2:
                state.layers[39]["layer_project_group_id"] = 5
        response = core.answer(request)
        assert response is not None
        return response

    services = _Services(state, core=_Proxy(arrives))
    with pytest.raises(ToolFailed) as raised:
        await _update(services, {"op": "remove_group", "group_id": 5})
    assert raised.value.message == f"operations[0] (remove_group): {NOT_EMPTY_NOW}"
    assert services.writes() == []
    assert 5 in state.groups and 39 in state.layers


async def test_a_group_a_layer_row_names_is_refused_before_the_first_write() -> None:
    """The map document does not list the layer under the group, its row
    does: the call is refused before anything is written."""
    state = MapState()
    state.groups[5] = {
        "name": "Empty",
        "parent_id": None,
        "order": 9,
        "visible": True,
        "expanded": True,
    }
    core = map_core(state)

    def stray(request: httpx.Request) -> httpx.Response:
        response = core.answer(request)
        assert response is not None
        if request.method == "GET" and request.url.path.endswith("/layer"):
            rows = response.json()
            for row in rows:
                if row["id"] == 39:
                    row["layer_project_group_id"] = 5
            return httpx.Response(200, json=rows)
        return response

    services = _Services(state, core=_Proxy(stray))
    with pytest.raises(InputInvalid, match="holds 1 layers or groups"):
        await _update(
            services,
            {"op": "set_layer", "layer_project_id": 33, "visible": False},
            {"op": "remove_group", "group_id": 5},
        )
    assert services.writes() == []


async def test_three_levels_of_groups_and_bundle_groups_are_refused() -> None:
    state = MapState()
    state.groups[3] = {
        "name": "Rail",
        "parent_id": 2,
        "order": 0,
        "visible": True,
        "expanded": True,
    }
    state.groups[4] = {
        "name": "Feed",
        "parent_id": None,
        "order": 9,
        "visible": True,
        "expanded": True,
    }
    state.layers[41]["layer_project_group_id"] = 4
    core = map_core(state)

    def bundle(request: httpx.Request) -> httpx.Response:
        response = core.answer(request)
        assert response is not None
        if request.method == "GET" and request.url.path.endswith("/group"):
            rows = response.json()
            for row in rows:
                if row["id"] == 4:
                    row["bundle_id"] = "b0000000-0000-4000-8000-000000000001"
            return httpx.Response(200, json=rows)
        return response

    services = _Services(state, core=_Proxy(bundle))
    before = state.snapshot()
    refused = [
        # A third level.
        ({"op": "add_group", "name": "Deep", "parent_group_id": 3}, "two deep"),
        (
            {"op": "move", "item": {"type": "group", "id": 1}, "group_id": 3},
            "two deep",
        ),
        # Transport holds a group, so it cannot go into one.
        (
            {"op": "move", "item": {"type": "group", "id": 2}, "group_id": 1},
            "two deep",
        ),
        ({"op": "move", "item": {"type": "group", "id": 1}, "group_id": 1}, "itself"),
        # A bundle's group keeps its layers and takes no others.
        ({"op": "move", "item": {"type": "layer", "id": 41}}, "bundle"),
        (
            {"op": "move", "item": {"type": "layer", "id": 31}, "group_id": 4},
            "bundle",
        ),
        (
            {"op": "move", "item": {"type": "group", "id": 1}, "group_id": 4},
            "bundle",
        ),
        ({"op": "add_group", "name": "More", "parent_group_id": 4}, "bundle"),
    ]
    for operation, word in refused:
        with pytest.raises(InputInvalid, match=word):
            await _update(services, operation)
    assert services.writes() == [] and state.snapshot() == before
    # A group without groups in it goes into a top-level group, and a
    # bundle's layers and its group can still be put in another order.
    await _update(
        services,
        {"op": "move", "item": {"type": "group", "id": 3}, "group_id": 1},
        {"op": "move", "item": {"type": "group", "id": 4}},
        {"op": "move", "item": {"type": "layer", "id": 41}, "group_id": 4},
    )
    assert state.groups[3]["parent_id"] == 1
    assert _tree(state)[0]["id"] == 4


# ---- basemap and scene -----------------------------------------------------------


async def test_a_basemap_outside_the_pages_list_is_refused_and_lists_the_ids() -> None:
    state = MapState()
    services = _Services(state)
    with pytest.raises(InputInvalid) as raised:
        await _update(services, {"op": "set_basemap", "basemap_id": "streets"})
    assert raised.value.message == (
        "operations[0] (set_basemap): 'streets' is not a basemap of this "
        "project. Its basemaps are: light (Light), dark (Dark), satellite "
        "(Satellite)."
    )
    assert services.writes() == []
    result = await _run(services, {"op": "set_basemap", "basemap_id": "dark"})
    assert services.writes() == [("PUT", "", {"basemap": "dark"})]
    assert state.basemap == "dark"
    assert result.applied[0].summary == "The basemap is now 'Dark'."
    assert result.undo() == {
        "kind": "map",
        "project_id": MAP_PROJECT_ID,
        "changes": [{"object": "basemap", "before": "light", "written": "dark"}],
    }
    # Without the page's list no basemap can be told from a wrong one.
    without = _Services(MapState(), basemaps=[])
    with pytest.raises(ToolFailed) as failed:
        await _update(without, {"op": "set_basemap", "basemap_id": "dark"})
    assert failed.value.message == (
        "operations[0] (set_basemap): The page did not send its basemaps."
    )
    assert without.writes() == []


async def test_set_scene_automatic_sends_null_and_operations_edit_the_stored_scene() -> (
    None
):
    state = MapState()
    services = _Services(state)
    # From automatic, operations start from an empty scene.
    result = await _run(
        services,
        {
            "op": "set_scene",
            "operations": [
                {"op": "set", "path": "/terrain/exaggeration", "value": 1.5},
                {"op": "set", "path": "/buildings", "value": False},
            ],
        },
    )
    scene = {"terrain": {"exaggeration": 1.5}, "buildings": False}
    assert services.writes() == [("PUT", "", {"scene": scene})]
    assert state.scene == scene
    assert result.applied[0].summary == (
        "The 3D scene was changed at /terrain/exaggeration, /buildings."
    )
    undo = result.undo()
    assert undo is not None
    assert undo["changes"] == [{"object": "scene", "before": None, "written": scene}]
    # The next call edits what is stored, and a later operation of one call
    # what the earlier one left.
    services = _Services(state)
    result = await _run(
        services,
        {"op": "set_scene", "operations": [{"op": "remove", "path": "/buildings"}]},
        {
            "op": "set_scene",
            "operations": [{"op": "set", "path": "/terrain/exaggeration", "value": 2}],
        },
    )
    assert [body for _, _, body in services.writes()] == [
        {"scene": {"terrain": {"exaggeration": 1.5}}},
        {"scene": {"terrain": {"exaggeration": 2}}},
    ]
    undo = result.undo()
    assert undo is not None
    assert undo["changes"] == [
        {
            "object": "scene",
            "before": scene,
            "written": {"terrain": {"exaggeration": 2}},
        }
    ]
    # Automatic stores no scene; so does a scene emptied by its operations.
    services = _Services(state)
    result = await _run(services, {"op": "set_scene", "automatic": True})
    assert services.writes() == [("PUT", "", {"scene": None})]
    assert state.scene is None
    assert result.applied[0].summary == "The 3D scene is automatic now."
    undo = result.undo()
    assert undo is not None
    assert undo["changes"][0]["written"] is None
    state.scene = {"buildings": False}
    services = _Services(state)
    result = await _run(
        services,
        {"op": "set_scene", "operations": [{"op": "remove", "path": "/buildings"}]},
    )
    assert services.writes() == [("PUT", "", {"scene": None})]
    assert state.scene is None
    # An operation that cannot be applied is the model's to fix.
    with pytest.raises(InputInvalid) as raised:
        await _update(
            services,
            {"op": "set_scene", "operations": [{"op": "remove", "path": "/sky"}]},
        )
    assert raised.value.message == (
        "operations[0] (set_scene): Its operations[0]: The scene has no key "
        "'sky'; it is empty."
    )


async def test_cores_scene_issues_reach_the_model() -> None:
    state = MapState()
    services = _Services(state)
    bad = {
        "op": "set_scene",
        "operations": [{"op": "set", "path": "/terrain/exaggeration", "value": "high"}],
    }
    # As the first write it fails the call: nothing was changed.
    with pytest.raises(ToolFailed) as raised:
        await _update(services, bad)
    message = raised.value.message
    assert message.startswith(
        "operations[0] (set_scene): The scene was not saved: /scene/terrain"
    )
    assert state.scene is None
    # After a write that landed it is the operation's reason.
    result = await _update(services, {"op": "set_basemap", "basemap_id": "dark"}, bad)
    assert [op["op"] for op in result["applied"]] == ["set_basemap"]
    assert result["failed"]["index"] == 1
    assert result["failed"]["reason"] == message.split(": ", 1)[1]
    assert state.basemap == "dark" and state.scene is None

    # At most five issues are listed, and a scene too large says so.
    def many(request: httpx.Request) -> httpx.Response | None:
        if request.method != "PUT" or "scene" not in json.loads(request.content):
            return None
        issues = [
            {"level": "error", "code": "c", "path": f"/scene/k{n}", "message": f"m{n}."}
            for n in range(7)
        ]
        return httpx.Response(
            422, json={"detail": {"code": "invalid_scene", "issues": issues}}
        )

    with pytest.raises(ToolFailed) as raised:
        await _update(_Services(state, core=_failing(state, many)), bad)
    assert raised.value.message == (
        "operations[0] (set_scene): The scene was not saved: /scene/k0: m0. "
        "/scene/k1: m1. /scene/k2: m2. /scene/k3: m3. /scene/k4: m4. 2 more "
        "issues are not listed."
    )
    large = _on(
        "PUT", str(MAP_PROJECT_ID), 422, {"detail": {"code": "scene_too_large"}}
    )
    with pytest.raises(ToolFailed, match="too large"):
        await _update(_Services(state, core=_failing(state, large)), bad)


# ---- the view --------------------------------------------------------------------


async def test_set_view_calls_nothing_in_core_and_answers_the_target() -> None:
    state = MapState()
    before = state.snapshot()
    services = _Services(state)
    result = await _run(
        services,
        {
            "op": "set_view",
            "center": [12.4, 51.34],
            "zoom": 14,
            "pitch": 50,
            "mode": "3d",
        },
    )
    assert services.core.requests == [] and services.processes.requests == []
    assert state.snapshot() == before
    assert result.model_dump(mode="json", exclude_none=True) == {
        "project_id": MAP_PROJECT_ID,
        "confirm": [],
        "applied": [
            {
                "index": 0,
                "op": "set_view",
                "fields": [],
                "summary": (
                    "The page shows the view: center 12.4, 51.34, zoom 14, pitch "
                    "50, 3D."
                ),
            }
        ],
        "view": {
            "camera": {"center": [12.4, 51.34], "zoom": 14.0, "pitch": 50.0},
            "mode": "3d",
        },
    }
    # Nothing was saved, so nothing is taken back.
    assert result.undo() is None
    only_mode = await _run(services, {"op": "set_view", "projection": "globe"})
    assert only_mode.view == ViewTarget(projection="globe")
    assert services.core.requests == []


def test_views_are_merged_field_by_field_in_order() -> None:
    box = (12.2, 51.2, 12.6, 51.5)
    assert merged_view([]) is None
    assert merged_view([ViewTarget(bbox=box), ViewTarget(mode="3d")]) == ViewTarget(
        bbox=box, mode="3d"
    )
    # A later value of the same field counts; the other fields stay.
    assert merged_view(
        [
            ViewTarget(camera={"center": [12.4, 51.3], "zoom": 12.0, "pitch": 30.0}),
            ViewTarget(camera={"zoom": 9.0, "bearing": -30.0}, mode="3d"),
            ViewTarget(mode="2d", projection="globe"),
        ]
    ) == ViewTarget(
        camera={"center": [12.4, 51.3], "zoom": 9.0, "pitch": 30.0, "bearing": -30.0},
        mode="2d",
        projection="globe",
    )
    # A box replaces a camera before it, and a camera a box before it.
    assert merged_view(
        [ViewTarget(camera={"zoom": 9.0}, projection="globe"), ViewTarget(bbox=box)]
    ) == ViewTarget(bbox=box, projection="globe")
    assert merged_view(
        [ViewTarget(bbox=box, mode="3d"), ViewTarget(camera={"pitch": 50.0})]
    ) == ViewTarget(camera={"pitch": 50.0}, mode="3d")


async def test_the_views_of_a_call_are_one_view() -> None:
    state = MapState()
    services = _Services(state)
    # Fit a layer, then 3D: the box and the mode.
    result = await _run(
        services,
        {"op": "set_view", "fit_layer_project_id": 31},
        {"op": "set_layer", "layer_project_id": 31, "visible": True},
        {"op": "set_view", "mode": "3d"},
    )
    assert result.view is not None
    assert result.view.bbox is not None and result.view.camera is None
    assert result.view.mode == "3d"
    assert [op.summary for op in result.applied] == [
        "The page shows the view: fitted to 'Districts'.",
        "'Districts': shown.",
        "The page shows the view: 3D.",
    ]
    # The view is no change of the map: the record holds the layer alone.
    undo = result.undo()
    assert undo is not None
    assert [c["object"] for c in undo["changes"]] == ["layer_state"]
    # The same in one operation.
    both = await _run(
        services,
        {"op": "set_view", "fit_layer_project_id": 31, "mode": "3d"},
    )
    assert both.view == result.view
    assert both.applied[0].summary == (
        "The page shows the view: fitted to 'Districts', 3D."
    )
    # A camera after a fit takes its place, and the model reads that.
    moved = await _run(
        services,
        {"op": "set_view", "fit_layer_project_id": 31, "projection": "globe"},
        {"op": "set_view", "zoom": 9, "bearing": -30},
    )
    assert moved.view == ViewTarget(
        camera={"zoom": 9.0, "bearing": -30.0}, projection="globe"
    )
    assert [op.summary for op in moved.applied] == [
        f"The page shows the view: fitted to 'Districts', the globe. {REPLACED_VIEW}",
        "The page shows the view: zoom 9, bearing -30.",
    ]
    fitted = await _run(
        services,
        {"op": "set_view", "center": [12.4, 51.3], "zoom": 9},
        {"op": "set_view", "fit_layer_project_id": 31},
    )
    assert fitted.view is not None and fitted.view.camera is None
    assert fitted.view.bbox is not None
    assert fitted.applied[0].summary.endswith(REPLACED_VIEW)
    assert not fitted.applied[1].summary.endswith(REPLACED_VIEW)


async def test_fit_layer_uses_the_layers_extent_with_its_filter() -> None:
    state = MapState()
    services = _Services(state)
    result = await _run(services, {"op": "set_view", "fit_layer_project_id": 34})
    assert [r.method for r in services.core.requests] == ["GET"] * 4
    [body] = services.processes.bodies()
    assert services.processes.paths() == ["/processes/extent/execution"]
    assert body["inputs"] == {
        "collection": map_layer(34).layer_id,
        "filter": json.dumps(state.layers[34]["query"]["cql"]),
    }
    assert result.view is not None and result.view.camera is None
    west, south, east, north = result.view.bbox or (0, 0, 0, 0)
    assert 12.2 < west < east < 12.6 and 51.2 < south < north < 51.5
    assert result.applied[0].summary == "The page shows the view: fitted to 'Land use'."
    assert result.applied[0].layer_project_id == 34
    assert result.undo() is None
    # A layer without a filter is asked for whole.
    services = _Services(state)
    await _run(services, {"op": "set_view", "fit_layer_project_id": 31})
    assert services.processes.bodies()[0]["inputs"] == {
        "collection": map_layer(31).layer_id
    }


async def test_a_view_fitted_after_a_filter_of_the_layer_uses_the_new_filter() -> None:
    state = MapState()
    services = _Services(state)
    await _run(
        services,
        _filter(34, _add(NOT_RESIDENTIAL)),
        {"op": "set_view", "fit_layer_project_id": 34},
    )
    [extent] = [
        json.loads(r.content)["inputs"]
        for r in services.processes.requests
        if r.url.path == "/processes/extent/execution"
    ]
    assert extent["filter"] == json.dumps(state.layers[34]["query"]["cql"])
    # A view fitted before the filter of the call uses the filter before it.
    state = MapState()
    before = json.dumps(state.layers[34]["query"]["cql"])
    services = _Services(state)
    await _run(
        services,
        {"op": "set_view", "fit_layer_project_id": 34},
        _filter(34, _add(NOT_RESIDENTIAL)),
    )
    [extent] = [
        json.loads(r.content)["inputs"]
        for r in services.processes.requests
        if r.url.path == "/processes/extent/execution"
    ]
    assert extent["filter"] == before


async def test_a_view_cannot_be_fitted_to_what_has_no_features() -> None:
    state = MapState()
    core = map_core(state)

    def rows(request: httpx.Request) -> httpx.Response:
        response = core.answer(request)
        assert response is not None
        if request.url.path.endswith("/layer") and request.method == "GET":
            listed = response.json()
            for row in listed:
                if row["id"] == 39:
                    row["type"] = "table"
                    row["feature_layer_geometry_type"] = None
                if row["id"] == 36:
                    row["other_properties"] = {
                        "catalog_materialize": {"status": "running"}
                    }
            return httpx.Response(200, json=listed)
        return response

    services = _Services(state, core=_Proxy(rows))
    with pytest.raises(ToolFailed, match="'Old boundaries' has no geometry"):
        await _update(services, {"op": "set_view", "fit_layer_project_id": 39})
    with pytest.raises(ToolFailed, match="'Elevation' is a raster layer"):
        await _update(services, {"op": "set_view", "fit_layer_project_id": 37})
    with pytest.raises(ToolFailed) as raised:
        await _update(services, {"op": "set_view", "fit_layer_project_id": 36})
    assert raised.value.message == f"operations[0] (set_view): {STILL_COPYING}"
    with pytest.raises(InputInvalid, match="There is no layer 99"):
        await _update(services, {"op": "set_view", "fit_layer_project_id": 99})
    assert services.processes.requests == []


async def test_a_tiny_extent_is_widened_and_an_empty_one_is_refused() -> None:
    state = MapState()

    def extent(bbox: Any) -> Recorder:
        return Recorder(
            {
                ("POST", "/processes/extent/execution"): {
                    "bbox": bbox,
                    "feature_count": 1,
                }
            }
        )

    point = await _run(
        _Services(state, processes=extent([12.4, 51.3, 12.4, 51.3])),
        {"op": "set_view", "fit_layer_project_id": 31},
    )
    assert point.view is not None and point.view.bbox is not None
    west, south, east, north = point.view.bbox
    assert west < 12.4 < east and south < 51.3 < north
    assert round(east - west, 6) == 0.004
    # Features on one meridian: only the width is widened.
    line = await _run(
        _Services(state, processes=extent([12.4, 51.0, 12.4, 52.0])),
        {"op": "set_view", "fit_layer_project_id": 31},
    )
    assert line.view is not None and line.view.bbox is not None
    assert line.view.bbox[1::2] == (51.0, 52.0)
    assert line.view.bbox[0] < 12.4 < line.view.bbox[2]
    for broken in ([12.4, 51.3], ["a", 1, 2, 3], [13.0, 52.0, 12.0, 51.0]):
        with pytest.raises(ToolFailed, match="cannot be shown as a map view"):
            await _update(
                _Services(state, processes=extent(broken)),
                {"op": "set_view", "fit_layer_project_id": 31},
            )
    services = _Services(state, processes=extent(None))
    hide = {"op": "set_layer", "layer_project_id": 33, "visible": False}
    with pytest.raises(ToolFailed, match="No features"):
        await _update(services, hide, {"op": "set_view", "fit_layer_project_id": 31})
    # The extent is read before the first write: nothing was changed.
    assert services.writes() == []
    target = await view_target(
        _Services(state).env,
        SetView(op="set_view", zoom=3),
        None,
    )
    assert target == ViewTarget(camera={"zoom": 3.0})


# ---- a viewer --------------------------------------------------------------------


async def test_a_viewer_can_set_the_view_and_nothing_else() -> None:
    state = MapState()
    before = state.snapshot()
    services = _Services(state, read_only=True, login=signed_in(300))
    result = await _update(services, {"op": "set_view", "mode": "3d", "pitch": 45})
    assert result["view"] == {"camera": {"pitch": 45.0}, "mode": "3d"}
    assert services.core.requests == []
    fitted = await _update(services, {"op": "set_view", "fit_layer_project_id": 31})
    assert len(fitted["view"]["bbox"]) == 4
    assert all(r.method == "GET" for r in services.core.requests)
    # Core refuses a viewer with 403 on the map state and with 401 on the
    # other writes; both say the same, and neither is an expired sign-in.
    for operation in (
        {"op": "set_layer", "layer_project_id": 31, "visible": False},
        {"op": "set_layer", "layer_project_id": 31, "name": "Wards"},
        {"op": "move", "item": {"type": "layer", "id": 31}},
        {"op": "add_group", "name": "Mine"},
        {"op": "rename_group", "group_id": 1, "name": "Mine"},
        {"op": "set_group", "group_id": 1, "visible": False},
        {"op": "set_group", "group_id": 1, "expanded": False},
        {"op": "set_basemap", "basemap_id": "dark"},
        {"op": "set_scene", "automatic": True},
    ):
        with pytest.raises(ToolFailed) as raised:
            await _update(services, {"op": "set_view", "zoom": 12}, operation)
        assert raised.value.message == VIEWER, operation
    assert VIEWER == "The user can view this project but not change it."
    assert state.snapshot() == before
    statuses = {(w[0], w[1]) for w in services.writes()}
    assert ("PATCH", "/layer/31/map-state") in statuses
    assert ("PUT", "/layer-tree") in statuses


async def test_an_expired_sign_in_is_not_taken_for_a_viewer() -> None:
    state = MapState()

    def unauthorized(request: httpx.Request) -> httpx.Response | None:
        if request.method != "GET":
            return httpx.Response(401, json={"detail": "Unauthorized"})
        return None

    services = _Services(
        state,
        core=_failing(state, unauthorized),
        login=signed_in(-10),
    )
    with pytest.raises(ToolFailed) as raised:
        await _update(services, {"op": "set_basemap", "basemap_id": "dark"})
    assert raised.value.message == SIGN_IN_EXPIRED


# ---- a failure on the way --------------------------------------------------------


async def test_operations_after_a_failed_one_are_not_tried_and_the_rest_can_be_undone() -> (
    None
):
    state = MapState()
    core = _failing(state, _on("PUT", str(MAP_PROJECT_ID), 500))
    services = _Services(state, core=core)
    result = await _run(
        services,
        {"op": "set_layer", "layer_project_id": 33, "visible": False},
        {"op": "set_basemap", "basemap_id": "dark"},
        {"op": "set_layer", "layer_project_id": 32, "visible": False},
    )
    assert [w[:2] for w in services.writes()] == [
        ("PATCH", "/layer/33/map-state"),
        ("PUT", ""),
    ]
    assert state.layers[33]["visible"] is False
    assert state.layers[32]["visible"] is True and state.basemap == "light"
    assert [op.index for op in result.applied] == [0]
    assert result.failed is not None and result.failed.index == 1
    assert "not available right now" in result.failed.reason
    assert result.note == (
        "The operations before operations[1] were applied and stay. "
        "operations[1] failed, and the operations after it were not tried: "
        "send only what is left in a new call."
    )
    undo = result.undo()
    assert undo is not None
    assert undo["changes"] == [
        {
            "object": "layer_state",
            "layer_project_id": 33,
            "before": {"visible": True},
            "written": {"visible": False},
        }
    ]
    payload = result.model_dump(mode="json", exclude_none=True)
    assert "changes" not in payload
    assert payload["failed"] == {"index": 1, "reason": result.failed.reason}


async def test_the_reason_of_a_later_failed_write_is_masked() -> None:
    token = "tok-4f9a8c7e1b2d3a5c6e7f"
    state = MapState()
    body = {"detail": f"refused for bearer {token}"}
    core = _failing(state, _on("PUT", str(MAP_PROJECT_ID), 400, body))
    services = _Services(state, core=core, login=StaticLogin(token))
    result = await _run(
        services,
        {"op": "set_layer", "layer_project_id": 33, "visible": False},
        {"op": "set_basemap", "basemap_id": "dark"},
    )
    assert result.failed is not None and result.failed.index == 1
    assert token not in result.failed.reason and token[:12] not in result.failed.reason


async def test_a_first_write_that_fails_fails_the_call_and_the_same_call_runs_again() -> (
    None
):
    state = MapState()
    answers = iter([500, None, None])

    def once(request: httpx.Request) -> httpx.Response | None:
        if request.method == "PATCH":
            status = next(answers)
            return httpx.Response(status, json={}) if status else None
        return None

    services = _Services(state, core=_failing(state, once))
    hide = (
        "map_update",
        {
            "operations": [
                {"op": "set_layer", "layer_project_id": 33, "visible": False},
                {"op": "set_layer", "layer_project_id": 32, "visible": False},
            ]
        },
    )
    first, second = await _answer(services, hide, hide)
    # Nothing was changed, so the call failed, and the retry is a new call.
    assert "operations[0] (set_layer)" in str(first)
    assert "not available right now" in str(first)
    assert [op["index"] for op in second["applied"]] == [0, 1]
    assert "repeated_call" not in second
    assert state.layers[33]["visible"] is False and state.layers[32]["visible"] is False


async def test_a_part_of_an_operation_that_landed_is_applied_and_can_be_undone() -> (
    None
):
    state = MapState()
    core = _failing(state, _on("PUT", "/layer/39", 500))
    services = _Services(state, core=core)
    result = await _run(
        services,
        {"op": "set_layer", "layer_project_id": 39, "visible": False, "name": "Old"},
        {"op": "set_basemap", "basemap_id": "dark"},
    )
    assert state.layers[39]["visible"] is False
    assert state.layers[39]["name"] == "Old boundaries" and state.basemap == "light"
    [applied] = result.applied
    assert (applied.index, applied.fields) == (0, ["visible"])
    assert applied.summary == "'Old boundaries': hidden."
    assert result.failed is not None and result.failed.index == 0
    assert result.note == (
        "A part of operations[0] was applied and stays (see applied); the rest "
        "of it failed, and the operations after it were not tried: send only "
        "what is left in a new call."
    )
    undo = result.undo()
    assert undo is not None
    assert [c["object"] for c in undo["changes"]] == ["layer_state"]


async def test_a_group_added_without_its_id_ends_the_call_with_a_result() -> None:
    state = MapState()

    def broken(request: httpx.Request) -> httpx.Response | None:
        if request.method == "POST":
            # The group may exist; its id is not known.
            return httpx.Response(201, json=["no", "object"])
        return None

    services = _Services(state, core=_failing(state, broken))
    result = await _run(
        services,
        {"op": "set_layer", "layer_project_id": 33, "visible": False},
        {"op": "add_group", "name": "Elections"},
        {"op": "move", "item": {"type": "layer", "id": 35}, "group_id": "new:1"},
    )
    # The page reads the groups again: the operation is listed, without an id.
    assert [(op.index, op.group_id) for op in result.applied] == [(0, None), (1, None)]
    assert result.failed is not None and result.failed.index == 1
    assert result.failed.reason == NO_GROUP_ID
    assert [w[0] for w in services.writes()] == ["PATCH", "POST"]
    undo = result.undo()
    assert undo is not None
    assert [c["object"] for c in undo["changes"]] == ["layer_state"]


async def test_an_unexpected_failure_after_a_write_still_returns_the_result() -> None:
    state = MapState()
    core = map_core(state)

    def breaks(request: httpx.Request) -> httpx.Response:
        if request.method == "PUT":
            raise RuntimeError("boom")
        response = core.answer(request)
        assert response is not None
        return response

    services = _Services(state, core=_Proxy(breaks))
    hide = {"op": "set_layer", "layer_project_id": 33, "visible": False}
    dark = {"op": "set_basemap", "basemap_id": "dark"}
    result = await _run(services, hide, dark, hide)
    assert [op.index for op in result.applied] == [0]
    assert result.failed == FailedOp(index=1, reason=STOPPED)
    undo = result.undo()
    assert undo is not None and len(undo["changes"]) == 1
    # Before any write it is an error like any other.
    with pytest.raises(RuntimeError):
        await _run(_Services(state, core=_Proxy(breaks)), dark)


# ---- a write without an answer ---------------------------------------------------


def _losing(
    state: MapState,
    lost: Callable[[httpx.Request], bool],
    *,
    lands: bool,
    afterwards: Callable[[httpx.Request], httpx.Response | None] | None = None,
    gateway: int | None = None,
) -> _Proxy:
    """The stand-in core, but the answer to a request ``lost`` picks never
    arrives: the write is made first when it ``lands``, and not made
    otherwise. ``afterwards`` answers the requests after the first lost one
    in core's place when it returns a response. ``gateway``: a proxy answers
    this status in place of core's answer."""
    core = map_core(state)
    seen = {"lost": False}

    def handler(request: httpx.Request) -> httpx.Response:
        if seen["lost"] and afterwards is not None:
            answer = afterwards(request)
            if answer is not None:
                return answer
        if lost(request):
            seen["lost"] = True
            if lands:
                assert core.answer(request) is not None
            if gateway is not None:
                return httpx.Response(gateway, text="Bad Gateway")
            raise httpx.ReadTimeout("no answer", request=request)
        response = core.answer(request)
        assert response is not None, request.url.path
        return response

    return _Proxy(handler)


def _any_write(request: httpx.Request) -> bool:
    return request.method != "GET"


def _with_an_empty_group(state: MapState) -> MapState:
    state.groups[5] = {
        "name": "Empty",
        "parent_id": None,
        "order": 9,
        "visible": True,
        "expanded": True,
    }
    state._next_group = 6
    return state


#: One call with every kind of write.
_EVERY_WRITE: list[dict[str, Any]] = [
    {"op": "set_layer", "layer_project_id": 33, "visible": False, "name": "Buses"},
    {"op": "move", "item": {"type": "layer", "id": 31}, "group_id": 2},
    {"op": "add_group", "name": "Elections", "parent_group_id": 1},
    {"op": "move", "item": {"type": "layer", "id": 35}, "group_id": "new:2"},
    {"op": "rename_group", "group_id": 1, "name": "Basis"},
    {"op": "set_group", "group_id": 1, "visible": False, "expanded": False},
    {"op": "set_basemap", "basemap_id": "dark"},
    {
        "op": "set_scene",
        "operations": [{"op": "set", "path": "/terrain/exaggeration", "value": 1.5}],
    },
    {"op": "remove_group", "group_id": 5},
]


async def test_a_write_that_landed_without_an_answer_is_read_back() -> None:
    """Core did not answer in time, but the map holds what was sent: the
    operation is applied, its undo change recorded, and the call goes on."""
    answered_state = _with_an_empty_group(MapState())
    answered = await _run(_Services(answered_state), *_EVERY_WRITE)
    assert answered.failed is None and len(answered.applied) == len(_EVERY_WRITE)

    state = _with_an_empty_group(MapState())
    services = _Services(state, core=_losing(state, _any_write, lands=True))
    result = await _run(services, *_EVERY_WRITE)
    assert result.model_dump(mode="json") == answered.model_dump(mode="json")
    assert result.undo() == answered.undo()
    assert state.snapshot() == answered_state.snapshot()
    # The group core added is found by its name and parent.
    assert [op.group_id for op in result.applied if op.op == "add_group"] == [6]
    assert state.layers[35]["layer_project_group_id"] == 6
    # Each write without an answer is followed by one read of the map.
    writes = len(services.writes())
    assert writes == 11
    assert len(services.reads()) == 4 + 4 * writes + 2


@pytest.mark.parametrize("status", [502, 503, 504])
async def test_a_write_behind_a_gateway_error_is_read_back(status: int) -> None:
    answered_state = _with_an_empty_group(MapState())
    answered = await _run(_Services(answered_state), *_EVERY_WRITE)

    state = _with_an_empty_group(MapState())
    services = _Services(
        state, core=_losing(state, _any_write, lands=True, gateway=status)
    )
    result = await _run(services, *_EVERY_WRITE)
    assert result.model_dump(mode="json") == answered.model_dump(mode="json")
    assert result.undo() == answered.undo()


async def test_a_group_added_without_an_answer_is_told_from_one_of_the_same_name() -> (
    None
):
    state = MapState()
    services = _Services(
        state, core=_losing(state, lambda r: r.method == "POST", lands=True)
    )
    result = await _run(
        services,
        {"op": "add_group", "name": "Transport"},
        {"op": "move", "item": {"type": "layer", "id": 35}, "group_id": "new:0"},
    )
    assert result.failed is None
    assert result.applied[0].group_id == 3
    assert state.layers[35]["layer_project_group_id"] == 3
    undo = result.undo()
    assert undo is not None
    assert undo["changes"][0] == {"object": "group_added", "group_id": 3}
    # A group of that name that was there before is not the one added, and
    # neither is a new one somewhere else.
    hide = {"op": "set_layer", "layer_project_id": 33, "visible": False}
    for parent, elsewhere in ((None, None), (1, {"name": "Transport"})):
        state = MapState()
        core = map_core(state)

        def handler(
            request: httpx.Request,
            state: MapState = state,
            core: Any = core,
            elsewhere: dict[str, Any] | None = elsewhere,
        ) -> httpx.Response:
            if request.method == "POST":
                if elsewhere is not None:
                    state.groups[9] = {
                        **elsewhere,
                        "parent_id": None,
                        "order": 0,
                        "visible": True,
                        "expanded": True,
                    }
                raise httpx.ReadTimeout("no answer", request=request)
            response = core.answer(request)
            assert response is not None
            return response

        add: dict[str, Any] = {"op": "add_group", "name": "Transport"}
        if parent is not None:
            add["parent_group_id"] = parent
        result = await _run(_Services(state, core=_Proxy(handler)), hide, add)
        assert [op.index for op in result.applied] == [0], parent
        assert result.failed is not None and result.failed.index == 1
        assert "did not answer in time" in result.failed.reason


async def test_a_write_without_an_answer_that_did_not_land_fails_as_it_did() -> None:
    hide = {"op": "set_layer", "layer_project_id": 33, "visible": False}
    dark = {"op": "set_basemap", "basemap_id": "dark"}
    # As the first write it fails the call.
    state = MapState()
    before = state.snapshot()
    services = _Services(state, core=_losing(state, _any_write, lands=False))
    with pytest.raises(ToolFailed) as raised:
        await _update(services, hide, dark)
    assert raised.value.message == (
        "operations[0] (set_layer): The GOAT core service did not answer in "
        "time. Try a narrower request."
    )
    assert state.snapshot() == before
    assert len(services.writes()) == 1 and len(services.reads()) == 8
    # After a write that landed it is the operation that failed.
    for operation, change in (
        (dark, lambda state: state.basemap == "light"),
        ({"op": "add_group", "name": "Elections"}, lambda state: 3 not in state.groups),
        (
            {"op": "move", "item": {"type": "layer", "id": 31}, "group_id": 2},
            lambda state: state.layers[31]["layer_project_group_id"] == 1,
        ),
        (
            {"op": "set_group", "group_id": 1, "expanded": False},
            lambda state: state.groups[1]["expanded"] is True,
        ),
    ):
        state = MapState()
        lost = _losing(state, lambda r: r.method not in ("GET", "PATCH"), lands=False)
        services = _Services(state, core=lost)
        result = await _run(
            services,
            hide,
            operation,
            {"op": "set_layer", "layer_project_id": 32, "visible": False},
        )
        assert [op.index for op in result.applied] == [0], operation
        assert result.failed is not None and result.failed.index == 1
        assert "did not answer in time" in result.failed.reason
        assert change(state), operation
        assert state.layers[32]["visible"] is True
        undo = result.undo()
        assert undo is not None
        assert [c["object"] for c in undo["changes"]] == ["layer_state"]


async def test_a_write_without_an_answer_and_no_read_after_it_is_not_known() -> None:
    hide = {"op": "set_layer", "layer_project_id": 33, "visible": False}
    dark = {"op": "set_basemap", "basemap_id": "dark"}

    def down(request: httpx.Request) -> httpx.Response | None:
        return httpx.Response(503, json={}) if request.method == "GET" else None

    state = MapState()
    lost = _losing(state, lambda r: r.method == "PUT", lands=True, afterwards=down)
    result = await _run(
        _Services(state, core=lost),
        hide,
        dark,
        {"op": "set_layer", "layer_project_id": 32, "visible": False},
    )
    assert [op.index for op in result.applied] == [0]
    assert result.failed == FailedOp(index=1, reason=MAY_BE_SAVED)
    assert "may or may not" in MAY_BE_SAVED and "project_get_layers" in MAY_BE_SAVED
    assert state.layers[32]["visible"] is True
    # The operation before it keeps its undo change.
    undo = result.undo()
    assert undo is not None
    assert undo["changes"] == [
        {
            "object": "layer_state",
            "layer_project_id": 33,
            "before": {"visible": True},
            "written": {"visible": False},
        }
    ]
    # As the first write the call fails with the same words.
    state = MapState()
    lost = _losing(state, _any_write, lands=True, afterwards=down)
    with pytest.raises(ToolFailed) as raised:
        await _update(_Services(state, core=lost), dark, hide)
    assert raised.value.message == f"operations[0] (set_basemap): {MAY_BE_SAVED}"
    assert state.layers[33]["visible"] is True


async def test_a_refusal_core_answered_is_not_read_back() -> None:
    state = MapState()
    core = _failing(state, _on("PUT", str(MAP_PROJECT_ID), 500))
    services = _Services(state, core=core)
    with pytest.raises(ToolFailed, match="not available right now"):
        await _update(services, {"op": "set_basemap", "basemap_id": "dark"})
    assert len(services.reads()) == 4


# ---- plan and apply --------------------------------------------------------------


async def test_plan_decides_everything_and_apply_only_sends() -> None:
    state = MapState()
    services = _Services(state)
    page = services.env.page
    assert isinstance(page, ProjectMapContext)
    read = await read_map(services.env, page.project_id)
    operations = _parse(
        {"op": "set_layer", "layer_project_id": 33, "visible": False, "name": "Buses"},
        {"op": "add_group", "name": "New"},
        {"op": "move", "item": {"type": "layer", "id": 33}, "group_id": "new:1"},
        {"op": "set_view", "zoom": 11},
    ).operations
    planned = plan(operations, read, page)
    assert isinstance(planned, Planned)
    assert [(step.index, step.op) for step in planned.steps] == [
        (0, "set_layer"),
        (1, "add_group"),
        (2, "move"),
        (3, "set_view"),
    ]
    assert [len(step.parts) for step in planned.steps] == [2, 1, 1, 0]
    assert services.writes() == []
    # Planning read nothing more and changed nothing it was given.
    assert len(services.core.requests) == 4
    assert read.tree() == TREE
    result = await apply(services.env, planned)
    assert [w[:2] for w in services.writes()] == [
        ("PATCH", "/layer/33/map-state"),
        ("PUT", "/layer/33"),
        ("POST", "/group"),
        ("PUT", "/layer-tree"),
    ]
    assert result.applied[2].summary == "'Buses' is now first in the group 'New'."
    assert result.view == ViewTarget(camera={"zoom": 11.0})


# ---- the registry, repeats and what a change makes stale -------------------------


def test_map_propose_view_is_gone_and_the_map_page_has_forty_one_tools() -> None:
    assert "map_propose_view" not in BY_WIRE_NAME
    assert BY_WIRE_NAME["map_update"] is MAP_UPDATE
    assert len(tools_for("project.map")) == 41
    assert MAP_UPDATE.name == "map.update"
    assert (MAP_UPDATE.risk, MAP_UPDATE.scope) == ("write", "goat:write")
    assert MAP_UPDATE.surfaces == MAP_SURFACES == frozenset({"project.map"})
    assert not MAP_UPDATE.mcp
    for surface in SURFACES:
        offered = {spec.wire_name for spec in tools_for(surface)}
        assert ("map_update" in offered) == (surface == "project.map")
    assert MAP_UPDATE.repeatable == REPEATED_MAP_EDIT
    assert {"project_get_layers", "style_get", "map_update"} <= MAP_UPDATE.invalidates
    # Any change of the map makes every earlier read and change stale.
    assert MAP_UPDATE.same == frozenset()
    description = " ".join(MAP_UPDATE.description.split())
    for said in (
        "in order",
        "stop at the first",
        "for this user only",
        "undo button",
        "row numbers",
        "read the layers again",
        "pick in a card",
        "rather than remove it",
        "does not bring back",
        "counting from 0",
    ):
        assert said in description, said
    assert "Undo" not in MAP_UPDATE.description
    assert "not available" not in description


async def _answer(services: _Services, *calls: tuple[str, dict[str, Any]]) -> list[Any]:
    """One answer that makes ``calls`` in order: what each returned."""
    script = ScriptedModel(list(calls))

    async def emit(event: Any) -> None:
        return None

    deps = RunDeps(message_id="m1", emit=emit, env=services.env)
    await build_agent(script.model).run("change the map", deps=deps)
    return [
        part.content
        for message in script.requests[-1]
        for part in getattr(message, "parts", [])
        if isinstance(part, ToolReturnPart)
    ]


async def test_a_change_made_again_after_another_one_runs_again() -> None:
    """Hide, show, hide in one answer: the third call is no repeat, because
    the second changed the map in between. Hide twice in a row is one."""
    state = MapState()
    services = _Services(state)

    def visible(value: bool) -> tuple[str, dict[str, Any]]:
        operation = {"op": "set_layer", "layer_project_id": 33, "visible": value}
        return ("map_update", {"operations": [operation]})

    first, second, third, fourth = await _answer(
        services, visible(False), visible(True), visible(False), visible(False)
    )
    assert [w[2] for w in services.writes()] == [
        {"visible": False},
        {"visible": True},
        {"visible": False},
    ]
    assert state.layers[33]["visible"] is False
    for result in (first, second, third):
        assert "repeated_call" not in result
    assert fourth == {**third, "repeated_call": REPEATED_MAP_EDIT}


async def test_a_change_makes_the_earlier_reads_of_the_answer_stale() -> None:
    state = MapState()
    services = _Services(state)
    layers = ("project_get_layers", {})
    style = ("style_get", {"layer_project_id": 31})
    hide = (
        "map_update",
        {"operations": [{"op": "set_layer", "layer_project_id": 33, "visible": False}]},
    )
    results = await _answer(services, layers, style, layers, hide, layers, style)
    assert results[2]["repeated_call"] == REPEATED_CALL
    assert "repeated_call" not in results[4] and "repeated_call" not in results[5]
    shown = {row["layer_project_id"]: row["visible"] for row in results[4]["layers"]}
    assert shown[33] is False


async def test_a_change_makes_the_filtered_reads_and_style_edits_stale() -> None:
    """Statistics as drawn after a filter change, and a style edit after the
    active style changed, run again."""
    state = MapState()
    services = _Services(state)
    counted = ("project_count_features", {"layer_project_id": 34, "as_drawn": True})
    refilter = ("map_update", {"operations": [_filter(34, _add(NOT_RESIDENTIAL))]})
    results = await _answer(services, counted, refilter, counted)
    assert "repeated_call" not in results[2]
    assert MAP_UPDATE.invalidates >= {
        "project_count_features",
        "project_field_statistics",
        "project_group_statistics",
        "project_area_statistics",
        "project_sample_features",
        "style_update",
    }


async def test_a_style_edit_is_remembered_across_a_map_change_that_leaves_styles() -> (
    None
):
    """A view, a basemap or a visibility change leaves what a style edit does
    as it was: the same edit again is answered from memory, and nothing is
    added twice. A switch of the layer's active style makes it run again."""
    from assistant.tools.styles import REPEATED_STYLE_EDIT

    add_rule = (
        "style_update",
        {
            "layer_project_id": 31,
            "operations": [
                {
                    "op": "add",
                    "path": "/classify",
                    "item": {"field": "density", "method": "quantile", "count": 5},
                }
            ],
        },
    )
    state = MapState()
    services = _Services(state)
    view = (
        "map_update",
        {
            "operations": [
                {"op": "set_view", "zoom": 9},
                {"op": "set_basemap", "basemap_id": "dark"},
                {"op": "set_layer", "layer_project_id": 33, "visible": False},
            ]
        },
    )
    first, _, second = await _answer(services, add_rule, view, add_rule)
    assert second == {**first, "repeated_call": REPEATED_STYLE_EDIT}
    assert len(state.styles[state.active_style_id(31)].document["classify"]) == 1

    state = MapState()
    other = state.add_style(
        31, "Other", state.styles[state.active_style_id(31)].document
    ).id
    services = _Services(state)
    switch = (
        "map_update",
        {
            "operations": [
                {"op": "set_layer", "layer_project_id": 31, "active_style_id": other}
            ]
        },
    )
    first, _, second = await _answer(services, add_rule, switch, add_rule)
    assert "repeated_call" not in second
    assert second["style_id"] == other


def test_a_later_answer_runs_the_same_change_again() -> None:
    args = {
        "operations": [{"op": "set_layer", "layer_project_id": 33, "visible": False}]
    }
    output = {"project_id": MAP_PROJECT_ID, "applied": []}
    stored = [
        {
            "role": "assistant",
            "parts": [
                {
                    "type": "tool",
                    "tool_name": "map_update",
                    "state": "output",
                    "args": args,
                    "output": output,
                }
            ],
        }
    ]
    assert earlier_writes(stored) == {}


async def test_the_result_stays_small() -> None:
    state = MapState()
    services = _Services(state)
    operations = [
        {"op": "move", "item": {"type": "layer", "id": link}, "group_id": group}
        for link, group in [(31, 2), (32, 1), (33, 1), (34, 2), (35, 1)] * 6
    ]
    result = await _update(services, *operations)
    assert len(result["applied"]) == 30
    assert len(json.dumps(result)) < 6000
    assert "changes" not in result and "before" not in json.dumps(result)


# ---- a stored conversation with the view suggestion -----------------------------

_OLD_CARD = {
    "version": 1,
    "kind": "map.view",
    "surface": "project.map",
    "target": {"project_id": MAP_PROJECT_ID, "name": "Stadtplan Beispiel"},
    "title": "Districts",
    "rows": [
        {"k": "project", "v": "Stadtplan Beispiel"},
        {"k": "layer", "v": "Districts"},
    ],
    "payload": {
        "project_id": MAP_PROJECT_ID,
        "camera": None,
        "bbox": [12.25, 51.25, 12.55, 51.45],
        "layer_project_id": 31,
    },
}


async def test_a_conversation_with_the_old_view_suggestion_still_loads(
    repo: Repository, settings: AssistantSettings
) -> None:
    """A stored answer can hold a call of ``map_propose_view``, which is no
    tool any more, and its ``map.view`` card: both are read back as they are,
    and the next answer runs with the call in its history."""
    user = UUID(int=1)
    created = await repo.create_conversation(user, "project.map", None, None)
    conversation_id = UUID(str(created["id"]))
    old = ScriptedModel(
        [("map_propose_view", {"title": "Districts", "fit_layer_project_id": 31})],
        answer="Here is a view of the districts.",
    )

    def old_agent(_: Model | str) -> Agent[RunDeps, str]:
        agent: Agent[RunDeps, str] = Agent(
            old.model, deps_type=RunDeps, instructions=INSTRUCTIONS
        )

        @agent.tool(name="map_propose_view")
        async def propose(
            ctx: RunContext[RunDeps], /, title: str, fit_layer_project_id: int
        ) -> dict[str, Any]:
            part_id = await ctx.deps.emit_data("proposal", _OLD_CARD)
            return {"proposal_id": part_id, "status": "shown"}

        return agent

    first = RunManager(
        repo, InMemoryEventBus(), settings, owner="a", agent_factory=old_agent
    )
    run_id, _ = await first.start_run(conversation_id, user, "show the districts", None)
    await first.wait(run_id)

    stored = await repo.list_messages(conversation_id, exclude_message_id=None)
    [answer] = [m for m in stored if m["role"] == "assistant"]
    [call] = [p for p in answer["parts"] if p["type"] == "tool"]
    assert (call["tool_name"], call["state"]) == ("map_propose_view", "output")
    [card] = [p for p in answer["parts"] if p["type"] == "data"]
    assert card["name"] == "proposal" and card["data"] == _OLD_CARD
    # The page gets the call and the card as they were stored.
    shown = to_ui_message(str(answer["id"]), "assistant", answer["parts"])
    kinds = [part["type"] for part in shown["parts"]]
    assert "dynamic-tool" in kinds and "data-proposal" in kinds
    [ui_card] = [p for p in shown["parts"] if p["type"] == "data-proposal"]
    assert ui_card["data"]["payload"]["bbox"] == [12.25, 51.25, 12.55, 51.45]
    # What a new answer reads from the stored conversation takes the call of
    # a tool that no longer exists as it takes any other.
    assert earlier_writes(stored) == {}
    assert AskHistory.from_stored(stored).cards == {}
    assert isinstance(ConversationRuns.from_stored(stored), ConversationRuns)

    script = ScriptedModel(answer="You are welcome.")
    second = RunManager(
        repo,
        InMemoryEventBus(),
        settings,
        owner="a",
        agent_factory=lambda _: build_agent(script.model),
        tool_services=fake_clients(),
    )
    next_id, _ = await second.start_run(conversation_id, user, "thanks", None)
    await second.wait(next_id)
    earlier = [
        part.tool_name
        for message in script.requests[0]
        for part in getattr(message, "parts", [])
        if isinstance(part, (ToolCallPart, ToolReturnPart))
    ]
    assert earlier == ["map_propose_view", "map_propose_view"]
    assert "map_propose_view" not in {
        tool.name for tool in script.infos[0].function_tools
    }
    stored = await repo.list_messages(conversation_id, exclude_message_id=None)
    last = [m for m in stored if m["role"] == "assistant"][-1]
    assert [p["text"] for p in last["parts"] if p["type"] == "text"] == [
        "You are welcome."
    ]
    assert not [p for p in last["parts"] if p["type"] == "run_status"]


# ---- the eval task that zooms to a layer -----------------------------------------


async def test_the_zoom_task_of_the_project_suite_is_met_by_the_tool(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    """``proj-11`` runs on the project suite's own fixture project: the tool
    fits its layer there, and the result meets the task's checks."""
    task = next(t for t in load_tasks("project") if t.id == "proj-11")
    path = tmp_path_factory.mktemp("eval-catalog-map-update")
    write_eval_catalog(path)
    backends = Backends(path)
    try:
        clients, requests, _ = backends.clients()
        env = tool_env(clients, page=parse_context(task.context))
        args = {"operations": [{"op": "set_view", "fit_layer_project_id": 22}]}
        result = await execute(MAP_UPDATE, env, args)
        west, south, east, north = result["view"]["bbox"]
        assert west < east and south < north
        assert result["applied"][0]["layer_project_id"] == 22
        assert all(r.method == "GET" for r in requests["core"])
        assert [r.url.path for r in requests["processes"]] == [
            "/processes/extent/execution"
        ]
        transcript = Transcript(
            task_id=task.id,
            answer="The map now shows the Bezirke layer.",
            tool_calls=[ToolCall("map_update", args, result, False)],
            proposals=[],
            requests=requests,
            error=None,
            input_tokens=0,
            output_tokens=0,
            seconds=0.0,
            first_text_seconds=None,
        )
        assert [g.passed for g in await grade(task, transcript, backends)] == [
            True,
            True,
            True,
        ]
    finally:
        backends.close()


# ---- the map suite's filter and removal tasks, met by the tool -------------------


@pytest.fixture(scope="module")
def map_backends(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Backends]:
    path = tmp_path_factory.mktemp("eval-catalog-map-tasks")
    write_eval_catalog(path)
    backends = Backends(path)
    yield backends
    backends.close()


def _graded_transcript(
    task_id: str,
    calls: list[ToolCall],
    before: dict[str, Any],
    after: dict[str, Any],
    answer: str,
    before_answer: dict[str, Any] | None = None,
) -> Transcript:
    return Transcript(
        task_id=task_id,
        answer=answer,
        tool_calls=calls,
        proposals=[],
        requests={},
        error=None,
        input_tokens=0,
        output_tokens=0,
        seconds=0.0,
        first_text_seconds=None,
        map_before=before,
        map_before_answer=before_answer,
        map_after=after,
    )


async def _passes(task_id: str, transcript: Transcript, backends: Backends) -> None:
    task = next(t for t in load_tasks("map") if t.id == task_id)
    grades = await grade(task, transcript, backends)
    assert all(g.passed is True for g in grades), [(g.check, g.detail) for g in grades]


def _task_services(task_id: str) -> _Services:
    task = next(t for t in load_tasks("map") if t.id == task_id)
    state = MapState()
    basemap = task.context.get("basemap")
    if isinstance(basemap, dict):
        state.basemap = str(basemap["id"])
    return _Services(state)


async def test_the_bus_line_filter_task_is_met_by_the_tool(
    map_backends: Backends,
) -> None:
    services = _task_services("map-23")
    before = services.state.snapshot()
    args = {
        "operations": [
            _filter(33, _add({"field": "frequency_per_hour", "op": ">=", "value": 6}))
        ]
    }
    result = await execute(MAP_UPDATE, services.env, args)
    transcript = _graded_transcript(
        "map-23",
        [ToolCall("map_update", args, result, False)],
        before,
        services.state.snapshot(),
        "The map now shows only the bus lines that run at least six times an hour.",
    )
    await _passes("map-23", transcript, map_backends)


async def test_the_land_use_filter_task_is_met_by_the_tool(
    map_backends: Backends,
) -> None:
    services = _task_services("map-24")
    before = services.state.snapshot()
    args = {"operations": [_filter(34, _add(NOT_RESIDENTIAL))]}
    result = await execute(MAP_UPDATE, services.env, args)
    transcript = _graded_transcript(
        "map-24",
        [ToolCall("map_update", args, result, False)],
        before,
        services.state.snapshot(),
        "Residential areas are now left out of the land use layer; the drawn "
        "area and the other rows stay as they were.",
    )
    await _passes("map-24", transcript, map_backends)


async def test_the_removal_task_is_met_by_the_tool_with_the_card(
    map_backends: Backends,
) -> None:
    """The first turn calls the removal, which answers what to ask and
    changes nothing, and asks; the second turn, after the pick, removes."""
    services = _task_services("map-25")
    before = services.state.snapshot()
    args = {"operations": [REMOVE_39]}
    waiting = await execute(MAP_UPDATE, services.env, args)
    assert waiting["confirm"][0]["value"] == "remove_layer:39"
    refused = ToolCall("map_update", args, waiting, False)
    asked = ToolCall("ask_user", REMOVAL_CARD, {"card_id": "ask-1"}, False)
    before_answer = services.state.snapshot()
    _picked(services, "remove_layer:39")
    result = await execute(MAP_UPDATE, services.env, args)
    transcript = _graded_transcript(
        "map-25",
        [refused, asked, ToolCall("map_update", args, result, False)],
        before,
        services.state.snapshot(),
        "I removed the layer Old boundaries from the project.",
        before_answer=before_answer,
    )
    await _passes("map-25", transcript, map_backends)


async def test_a_removal_without_a_pick_keeps_the_value_it_asks_for() -> None:
    """The answer's card may then offer the value although the user
    answered a question under the same header (``ToolEnv.confirm_values``)."""
    services = _Services(MapState())
    await _update(services, REMOVE_39)
    assert services.env.confirm_values == {"remove_layer:39"}
    await _update(
        services, {"op": "set_layer", "layer_project_id": 33, "visible": False}
    )
    assert services.env.confirm_values == {"remove_layer:39"}


async def _scripted_turn(
    services: _Services, history: AskHistory, *calls: tuple[str, dict[str, Any]]
) -> list[tuple[str, Any]]:
    """One answer of a scripted model on a fresh environment with the
    conversation's cards and answers in ``history``: the cards it showed, by
    card id, and each call's tool name with what came back (a refusal as
    its text)."""
    services.env = dataclasses.replace(
        services.env, asks=history, confirm_values=set(), notes_given=set()
    )
    shown: list[tuple[str, Any]] = []
    script = ScriptedModel(list(calls))

    async def emit(event: Any) -> None:
        return None

    deps = RunDeps(message_id="m1", emit=emit, env=services.env)

    async def emit_data(
        name: str, data: dict[str, Any], *, part_id: str | None = None
    ) -> str:
        shown.append((part_id or "", data))
        return part_id or "m1:1"

    services.env.emit_data = emit_data
    await build_agent(script.model).run("go on", deps=deps)
    returned = [
        (part.tool_name, part.content)
        for message in script.requests[-1]
        for part in getattr(message, "parts", [])
        if isinstance(part, ToolReturnPart | RetryPromptPart)
    ]
    return [*[("shown", card_id) for card_id, _ in shown], *returned]


async def test_a_removal_asked_about_first_goes_through_in_the_third_turn() -> None:
    """The model asked with its own card before calling the tool; after the
    pick, map_update answers the value it takes, and the card that offers it
    is shown under the same header. The pick of that card removes the layer.
    The model's own value is never taken as the pick."""
    state = MapState()
    services = _Services(state)
    own = {
        "questions": [
            {
                "question": 'Should the layer "Old boundaries" be removed?',
                "header": "Remove",
                "options": [
                    {"label": "Remove it", "value": "remove:39"},
                    {"label": "Just hide it", "value": "hide:39"},
                ],
            }
        ]
    }
    first = await _scripted_turn(services, AskHistory(), ("ask_user", own))
    [(_, own_id)] = [item for item in first if item[0] == "shown"]
    own_card = AskUserInput.model_validate(own)
    own_answer, _ = auto_answer(own_id, own_card, "remove:39")
    picked_own = AskHistory(cards={own_id: own_card}).with_answer(own_answer)
    confirmed = copy.deepcopy(REMOVAL_CARD)
    second = await _scripted_turn(
        services,
        picked_own,
        ("map_update", {"operations": [REMOVE_39]}),
        ("ask_user", confirmed),
    )
    assert services.writes() == [] and 39 in state.layers
    [waiting] = [content for name, content in second if name == "map_update"]
    assert waiting["confirm"][0]["value"] == "remove_layer:39"
    [(_, card_id)] = [item for item in second if item[0] == "shown"]
    card = AskUserInput.model_validate(confirmed)
    answer, _ = auto_answer(card_id, card, "remove_layer:39")
    both = AskHistory(
        cards={own_id: own_card, card_id: card}, answers={own_id: own_answer}
    ).with_answer(answer)
    third = await _scripted_turn(
        services, both, ("map_update", {"operations": [REMOVE_39]})
    )
    [removed] = [content for name, content in third if name == "map_update"]
    assert [op["op"] for op in removed["applied"]] == ["remove_layer"]
    assert 39 not in state.layers


async def test_an_ordinary_repeated_card_is_still_refused_in_a_removal_answer() -> None:
    """After map_update answered confirm, a card that does not offer its
    value is checked as any other."""
    services = _Services(MapState())
    own_card = AskUserInput.model_validate(REMOVAL_CARD)
    answer, _ = auto_answer("ask-1", own_card, "keep")
    history = AskHistory(cards={"ask-1": own_card}).with_answer(answer)
    again = copy.deepcopy(REMOVAL_CARD)
    again["questions"][0]["options"][1]["value"] = "remove:39"
    turn = await _scripted_turn(
        services,
        history,
        ("map_update", {"operations": [REMOVE_39]}),
        ("ask_user", again),
    )
    assert not [item for item in turn if item[0] == "shown"]
    [refusal] = [content for name, content in turn if name == "ask_user"]
    assert "The user already answered" in str(refusal)


async def test_the_hide_task_is_met_by_the_tool(map_backends: Backends) -> None:
    services = _task_services("map-26")
    before = services.state.snapshot()
    args = {
        "operations": [{"op": "set_layer", "layer_project_id": 39, "visible": False}]
    }
    result = await execute(MAP_UPDATE, services.env, args)
    transcript = _graded_transcript(
        "map-26",
        [ToolCall("map_update", args, result, False)],
        before,
        services.state.snapshot(),
        "I hid Old boundaries; it stays in the project.",
    )
    await _passes("map-26", transcript, map_backends)
