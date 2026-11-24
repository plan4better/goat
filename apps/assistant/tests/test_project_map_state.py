"""project_get_layers reads the map: each layer's place in the tree, its
visibility, position, drawn style and filter in words, and on the map page the
basemap, the view and the 3D scene. Core is the eval stand-in of the map
project, which answers as core does."""

import copy
import json
from collections.abc import Callable, Iterable
from typing import Any
from uuid import UUID

import httpx
import pytest
from pydantic_ai.exceptions import ToolFailed

from assistant.context import parse_context
from assistant.maps.state import NO_PROJECT, read_map
from assistant.tools.project import GET_LAYERS
from assistant.tools.runtime import ToolEnv, execute
from assistant.tools.testing import Recorder, fake_clients, signed_in, tool_env
from evals.backends import _layer_routes
from evals.map_backends import MapState, map_core
from evals.map_fixture import (
    MAP_PROJECT_ID,
    MAP_VIEW_PROJECT_ID,
    map_layer,
)

BASE = f"/api/v2/project/{MAP_PROJECT_ID}"
LAND_USE = map_layer(34)
BASEMAPS = [
    {"id": "light", "name": "Light", "tone": "light"},
    {"id": "dark", "name": "Dark", "tone": "dark"},
    {"id": "satellite", "name": "Satellite", "tone": "dark", "imagery": True},
]
MAP_PAGE = {
    "surface": "project.map",
    "project_id": MAP_PROJECT_ID,
    "basemap": BASEMAPS[0],
    "basemaps": BASEMAPS,
    "viewport": {"center": [12.38, 51.34], "zoom": 13.5, "pitch": 40, "bearing": 10},
    "view_mode": "3d",
    "projection": "globe",
}


def _core(*cores: Any, edit: Callable[[str, Any], Any] | None = None) -> Any:
    """Core of the map projects; ``edit(path, body)`` changes a reply's body."""
    recorder = Recorder()

    def handle(request: httpx.Request) -> httpx.Response:
        for core in cores:
            response = core.answer(request)
            if response is not None:
                recorder.requests.append(request)
                if edit is None:
                    return response
                body = edit(request.url.path, response.json())
                return httpx.Response(response.status_code, json=body)
        return recorder(request)

    return httpx.MockTransport(handle)


def _geoapi() -> Recorder:
    return Recorder(_layer_routes(LAND_USE))


def _env(core: Any, geoapi: Any = None, page: dict[str, Any] | None = None) -> ToolEnv:
    return tool_env(
        fake_clients(core=core, geoapi=geoapi if geoapi is not None else _geoapi()),
        page=parse_context(page if page is not None else MAP_PAGE),
    )


async def _layers(state: MapState, **kwargs: Any) -> dict[str, Any]:
    result: dict[str, Any] = await execute(
        GET_LAYERS, _env(_core(map_core(state)), **kwargs), {}
    )
    return result


def _by_id(result: dict[str, Any]) -> dict[int, dict[str, Any]]:
    return {layer["layer_project_id"]: layer for layer in result["layers"]}


async def test_a_layer_row_carries_visibility_position_group_and_place() -> None:
    layers = _by_id(await _layers(MapState()))
    aerial, land_use, stations = layers[38], layers[34], layers[40]
    assert (aerial["visible"], aerial["position"], aerial["order"]) == (
        False,
        "below_roads",
        5,
    )
    assert "group_id" not in aerial and "group" not in aerial
    assert (land_use["visible"], land_use["position"]) == (True, "top")
    assert (land_use["group_id"], land_use["group"], land_use["order"]) == (
        1,
        "Base data",
        1,
    )
    assert (stations["group_id"], stations["order"]) == (2, 0)


async def test_rows_come_in_the_trees_order_not_the_projects_layer_order() -> None:
    state = MapState()
    result = await _layers(state)
    # Core lists the rows by layer_order (31 to 41); the map shows them so.
    assert [layer["layer_project_id"] for layer in result["layers"]] == [
        32, 35, 40, 33, 41, 36, 34, 31, 39, 37, 38,
    ]  # fmt: skip
    assert [layer["order"] for layer in result["layers"]] == [
        0, 1, 0, 1, 2, 0, 1, 2, 3, 4, 5,
    ]  # fmt: skip


async def test_a_layer_just_added_comes_last_without_map_state() -> None:
    """A row the map document does not list yet (still being copied) comes
    last; an entry of the document without a row is skipped."""

    def edit(path: str, body: Any) -> Any:
        if path == f"{BASE}/map":
            layers = body["map"]["layers"]
            # 32 has a row but no entry; 99 has an entry but no row.
            body["map"]["layers"] = [
                entry for entry in layers if entry.get("id") != 32
            ] + [{"type": "layer", "id": 99, "visible": True}]
        return body

    result = await execute(GET_LAYERS, _env(_core(map_core(MapState()), edit=edit)), {})
    ids = [layer["layer_project_id"] for layer in result["layers"]]
    assert ids[-1] == 32 and 99 not in ids and len(ids) == 11
    added = result["layers"][-1]
    for key in ("visible", "position", "order", "style"):
        assert key not in added
    assert added["name"] == map_layer(32).name


def _issues(*levels: str) -> list[dict[str, Any]]:
    return [
        {"level": level, "code": "x", "path": "/symbol", "message": "m"}
        for level in levels
    ]


async def test_the_active_style_is_a_one_line_summary_with_issue_counts_and_the_other_styles() -> (
    None
):
    state = MapState()
    default = state.active_style_id(31)
    dark = state.add_style(31, "Dark", copy.deepcopy(state.styles[default].document))

    def edit(path: str, body: Any) -> Any:
        if path == f"{BASE}/map":
            body["styles"]["31"]["active"]["issues"] = _issues(
                "error", "damaged", "warning", "info"
            )
            del body["styles"]["33"]["active"]["issues"]
        return body

    layers = _by_id(
        await execute(GET_LAYERS, _env(_core(map_core(state), edit=edit)), {})
    )
    assert layers[31]["style"] == {
        "id": default,
        "name": "Default",
        "summary": "fill #deebf7; labels name",
        "errors": 2,
        "warnings": 1,
        "others": [{"id": dark.id, "name": "Dark"}],
    }
    # Core sends no issues when it had none at hand: nothing is counted.
    assert layers[33]["style"]["errors"] == layers[33]["style"]["warnings"] == 0
    assert layers[34]["style"]["summary"] == "fill by use, 6 categories, rest grouped"
    assert layers[37]["style"]["summary"] == "image"

    state.layers[31]["active_style_id"] = dark.id
    style = _by_id(await _layers(state))[31]["style"]
    assert (style["id"], style["name"]) == (dark.id, "Dark")
    assert style["others"] == [{"id": default, "name": "Default"}]
    # No tool result carries a style document.
    assert '"document"' not in json.dumps(await _layers(state))


async def test_a_filter_is_shown_as_rows_and_never_as_raw_cql() -> None:
    geoapi = _geoapi()
    result = await _layers(MapState(), geoapi=geoapi)
    assert _by_id(result)[34]["filter"] == {
        "match": "all",
        "rows": [
            {"row": 1, "text": "area_m2 is greater than 5000", "on": True},
            {"row": 2, "text": 'use is "industrial"', "on": False},
            {"row": 3, "text": "custom", "on": True},
        ],
        "area": 'a drawn shape "Study area"',
    }
    assert [
        layer["layer_project_id"] for layer in result["layers"] if "filter" in layer
    ] == [34]
    dumped = json.dumps(result)
    assert "s_intersects" not in dumped and "12.28" not in dumped
    assert "cql" not in dumped
    # Only the filtered layer's fields are read.
    assert geoapi.paths() == [f"/collections/{LAND_USE.layer_id}/queryables"]


async def test_a_failed_field_read_shows_the_rows_as_custom() -> None:
    failing = Recorder()  # every read answers 599
    layers = _by_id(await _layers(MapState(), geoapi=failing))
    rows = layers[34]["filter"]["rows"]
    assert [(r["row"], r["text"], r["on"]) for r in rows] == [
        (1, "custom", True),
        (2, "custom", False),
        (3, "custom", True),
    ]
    assert layers[34]["filter"]["area"] == 'a drawn shape "Study area"'


def _hand_core(
    rows: list[dict[str, Any]],
    entries: list[dict[str, Any]],
    styles: dict[str, Any],
    project: dict[str, Any] | None = None,
) -> Recorder:
    base = "/api/v2/project/00000000-0000-0000-0000-000000000777"
    return Recorder(
        {
            ("GET", base): project or {"id": base[-36:], "name": "Hand"},
            ("GET", f"{base}/layer"): rows,
            ("GET", f"{base}/group"): [],
            ("GET", f"{base}/map"): {
                "map": {"version": "1.0.0", "layers": entries},
                "styles": styles,
                "unpublished": [],
            },
        }
    )


def _style_read(style_id: str) -> dict[str, Any]:
    return {
        "id": style_id,
        "name": "Default",
        "position": 0,
        "revision": 1,
        "document": {"version": "1.0.0", "kind": "vector", "geometry": "point"},
        "issues": [],
        "stale": False,
    }


async def test_a_locked_layer_a_table_and_a_layer_without_a_style_have_no_style() -> (
    None
):
    query = {"cql": {"op": "=", "args": [{"property": "a"}, "x"]}}
    rows = [
        {"id": 1, "layer_id": "l1", "name": "Locked", "type": "feature",
         "locked": True, "query": query},
        {"id": 2, "layer_id": "l2", "name": "Table", "type": "table",
         "locked": False},
        {"id": 3, "layer_id": "l3", "name": "Bare", "type": "feature",
         "feature_layer_geometry_type": "point", "locked": False},
    ]  # fmt: skip
    entries = [
        {"type": "layer", "id": 1, "visible": True},
        {"type": "layer", "id": 2, "visible": True, "style": "s2"},
        {"type": "layer", "id": 3, "visible": False},
    ]
    styles = {"2": {"active": _style_read("s2"), "others": []}}
    geoapi = Recorder()
    page = {
        "surface": "project.map",
        "project_id": "00000000-0000-0000-0000-000000000777",
    }
    result = await execute(
        GET_LAYERS, _env(_hand_core(rows, entries, styles), geoapi, page), {}
    )
    layers = _by_id(result)
    assert all("style" not in layer for layer in layers.values())
    assert layers[1]["locked"] is True and "filter" not in layers[1]
    assert layers[1]["visible"] is True and layers[3]["visible"] is False
    # A locked layer is never read from geoapi.
    assert geoapi.requests == []


async def test_the_map_brief_names_basemap_offered_basemaps_view_and_scene() -> None:
    state = MapState()
    result = await _layers(state)
    assert result["map"] == {
        "basemap": {"id": "light", "name": "Light", "tone": "light", "imagery": False},
        "basemaps": [
            {"id": "light", "name": "Light", "tone": "light", "imagery": False},
            {"id": "dark", "name": "Dark", "tone": "dark", "imagery": False},
            {"id": "satellite", "name": "Satellite", "tone": "dark", "imagery": True},
        ],
        "view": {
            "center": [12.38, 51.34],
            "zoom": 13.5,
            "pitch": 40.0,
            "bearing": 10.0,
            "mode": "3d",
            "projection": "globe",
        },
        "scene": "automatic",
    }

    # A basemap the page does not offer is named by its id; the stored view
    # stands in for a page that sends none.
    state.basemap = "custom-7"
    state.scene = {"terrain": {"exaggeration": 1.5}}
    page = {key: value for key, value in MAP_PAGE.items() if key != "viewport"}
    page.pop("view_mode")
    page.pop("projection")
    brief = (await _layers(state, page=page))["map"]
    assert brief["basemap"] == {"id": "custom-7"}
    assert brief["view"] == {"center": [12.4, 51.35], "zoom": 12.0}
    assert brief["scene"] == {"terrain": {"exaggeration": 1.5}}

    state.basemap = None
    assert "basemap" not in (await _layers(state, page=page))["map"]


async def test_another_projects_layers_carry_no_map_brief() -> None:
    core = _core(map_core(MapState()), map_core(MapState(), read_only=True))
    result = await execute(GET_LAYERS, _env(core), {"project_id": MAP_VIEW_PROJECT_ID})
    assert "map" not in result
    assert len(result["layers"]) == 11 and "visible" in result["layers"][0]
    # Another page of the same project: no map either.
    dashboard = {"surface": "project.dashboard", "project_id": MAP_PROJECT_ID}
    result = await execute(
        GET_LAYERS, _env(_core(map_core(MapState())), page=dashboard), {}
    )
    assert "map" not in result and "style" in result["layers"][0]


def _repeated(times: int) -> Callable[[str, Any], Any]:
    """Replies of a project of ``times`` layers, the fixture's rows over and
    over (land use's filter included), flat in the tree."""
    count = 11

    def source(n: int) -> int:
        return 31 + (n - 1) % count

    def edit(path: str, body: Any) -> Any:
        if path == f"{BASE}/layer":
            by_id = {row["id"]: row for row in body}
            return [
                {**by_id[source(n)], "id": 100 + n, "order": n}
                for n in range(1, times + 1)
            ]
        if path == f"{BASE}/map":
            entries = {
                entry["id"]: entry
                for entry in _walk(body["map"]["layers"])
                if entry["type"] == "layer"
            }
            body["map"]["layers"] = [
                {**entries[source(n)], "id": 100 + n} for n in range(1, times + 1)
            ]
            body["styles"] = {
                str(100 + n): body["styles"][str(source(n))]
                for n in range(1, times + 1)
            }
        return body

    return edit


def _walk(items: Iterable[dict[str, Any]]) -> Iterable[dict[str, Any]]:
    for item in items:
        yield item
        yield from _walk(item.get("children") or [])


async def test_the_result_stays_under_twenty_kilobytes_for_forty_layers() -> None:
    result = await execute(
        GET_LAYERS, _env(_core(map_core(MapState()), edit=_repeated(40))), {}
    )
    assert len(result["layers"]) == 40
    assert sum("filter" in layer for layer in result["layers"]) == 4
    size = len(json.dumps(result, separators=(",", ":")).encode())
    assert size < 20_000, size


async def test_read_map_names_the_tree_entries_and_active_styles() -> None:
    state = MapState()
    env = _env(_core(map_core(state)))
    read = await read_map(env, UUID(MAP_PROJECT_ID))
    tree = read.tree()
    assert [(i["type"], i["id"]) for i in tree][:5] == [
        ("layer", 32),
        ("layer", 35),
        ("group", 2),
        ("layer", 40),
        ("layer", 33),
    ]
    assert {
        "id": 1, "type": "group", "order": 3, "parent_id": None
    } in tree  # fmt: skip
    assert {"id": 31, "type": "layer", "order": 2, "parent_id": 1} in tree
    assert read.entry(38) == {
        "type": "layer",
        "id": 38,
        "visible": False,
        "style": state.active_style_id(38),
        "position": "below_roads",
    }
    assert read.entry(99) is None
    assert read.active_style_id(31) == state.active_style_id(31)
    assert read.active_style_id(99) is None
    assert set(read.rows) == set(range(31, 42))
    assert read.styles[31]["active"]["name"] == "Default"


@pytest.mark.parametrize("status", [401, 403, 404])
async def test_read_map_refuses_a_project_the_user_cannot_open(status: int) -> None:
    core = Recorder({("GET", f"{BASE}/map"): httpx.Response(status)})
    for path in ("", "/layer", "/group"):
        core.routes[("GET", BASE + path)] = []
    env = tool_env(fake_clients(core=core), login=signed_in(300))
    with pytest.raises(ToolFailed) as caught:
        await read_map(env, UUID(MAP_PROJECT_ID))
    assert caught.value.message == NO_PROJECT
    assert NO_PROJECT == "The project does not exist or the user cannot open it."


async def test_a_hidden_group_shows_hidden_and_its_layers_keep_their_own_flag() -> None:
    state = MapState()
    state.groups[1]["visible"] = False
    result = await _layers(state)
    groups = {group["id"]: group for group in result["groups"]}
    assert (groups[1]["visible"], groups[1]["order"]) == (False, 3)
    assert (groups[2]["visible"], groups[2]["order"]) == (True, 2)
    # Land use is in the hidden group: its own flag stays as stored.
    assert _by_id(result)[34]["visible"] is True


async def test_a_group_entry_without_visible_reads_as_shown() -> None:
    def edit(path: str, body: Any) -> Any:
        if path == f"{BASE}/map":
            for entry in body["map"]["layers"]:
                entry.pop("visible", None)
        return body

    result = await execute(GET_LAYERS, _env(_core(map_core(MapState()), edit=edit)), {})
    assert all(group["visible"] is True for group in result["groups"])
