"""The dock's Undo of an answer's map changes: what the answer wrote goes
back to the state before where the map still holds it, a value a person
changed since is asked about first, and what cannot come back is said.

The undo records are the ones the real ``map_update`` leaves (a filter's and
a removed layer's are written by hand in the contract's shape), and core is
the eval stand-in of the map project."""

import asyncio
import json
from collections.abc import Callable, Iterator
from typing import Any, cast
from uuid import UUID, uuid4

import httpx
import pytest
from pydantic_ai.exceptions import ToolFailed

from assistant.context import parse_context
from assistant.maps.operations import MapUpdateInput
from assistant.maps.state import MapRead, map_read
from assistant.repo import Repository
from assistant.tools.http import ServiceError
from assistant.tools.map_edits import MAP_UPDATE, MapUpdated
from assistant.tools.runtime import execute
from assistant.tools.testing import (
    Recorder,
    ScriptedModel,
    fake_clients,
    tool_env,
)
from assistant.undo import (
    NothingToUndo,
    UndoOutcome,
    UndoRefused,
    undo_groups,
    undo_run,
    undone,
)
from assistant.undo_map import (
    ChangedMap,
    MapChanges,
    RestoredMap,
    _in_use,
    map_groups,
    restore_map,
)
from assistant.undo_styles import CreatedStyle, RestoredStyle
from evals.backends import Backends, write_eval_catalog
from evals.graders import grade
from evals.harness import AuditRows, press_undo, run_task
from evals.map_backends import MapState, map_core
from evals.map_fixture import MAP_PROJECT_ID
from evals.tasks import load_tasks
from tests.test_style_get import _geoapi, _processes, _Proxy
from tests.test_undo import Core, Stored, answer, config, stored_answer, url
from tests.test_undo import edit as workflow_edit
from tests.test_undo_styles import RED, _audit, _second_style, _styled

BASE = f"/api/v2/project/{MAP_PROJECT_ID}"
Api = Any  # conftest.ApiFactory
ProjectFactory = Any  # conftest.ProjectFactory
BASEMAPS = [
    {"id": "light", "name": "Light", "tone": "light"},
    {"id": "dark", "name": "Dark", "tone": "dark"},
    {"id": "satellite", "name": "Satellite", "tone": "dark", "imagery": True},
]
SHOPS = {"cql": {"op": "=", "args": [{"property": "kind"}, "shop"]}}
CAFES = {"cql": {"op": "=", "args": [{"property": "kind"}, "cafe"]}}
HIDE_LAND_USE = {"op": "set_layer", "layer_project_id": 34, "visible": False}
DARK = {"op": "set_basemap", "basemap_id": "dark"}


async def _changed(state: MapState, *operations: dict[str, Any]) -> dict[str, Any]:
    """The undo record the real ``map_update`` leaves for a call, as the
    audit row holds it."""
    env = tool_env(
        fake_clients(core=map_core(state), geoapi=_geoapi(), processes=_processes()),
        page=parse_context(
            {
                "surface": "project.map",
                "project_id": MAP_PROJECT_ID,
                "basemaps": BASEMAPS,
            }
        ),
    )
    result = await MAP_UPDATE.run(
        env, MapUpdateInput.model_validate({"operations": list(operations)})
    )
    assert isinstance(result, MapUpdated) and result.failed is None, result
    record = result.undo()
    assert record is not None, result
    stored: dict[str, Any] = json.loads(json.dumps(record))
    return stored


def _map(*changes: dict[str, Any]) -> dict[str, Any]:
    """A ``map`` undo record with changes written by hand."""
    return {"kind": "map", "project_id": MAP_PROJECT_ID, "changes": list(changes)}


def _filtered(
    state: MapState, link: int, written: dict[str, Any] | None
) -> dict[str, Any]:
    """An answer's filter change of a layer: core holds ``written``, and the
    record is the contract's."""
    before = state.layers[link]["query"]
    state.layers[link]["query"] = written
    return _map(
        {
            "object": "filter",
            "layer_project_id": link,
            "before": before,
            "written": written,
        }
    )


def _group(*records: dict[str, Any]) -> MapChanges:
    [group] = map_groups([(uuid4(), record) for record in records])
    return group


Outcome = tuple[RestoredMap | None, list[ChangedMap]]


async def _restore(
    state: MapState,
    *records: dict[str, Any],
    force: bool = False,
    core: Recorder | None = None,
) -> Outcome:
    return await restore_map(
        fake_clients(core=core if core is not None else map_core(state)),
        "token",
        _group(*records),
        force,
    )


def _back(**went: Any) -> RestoredMap:
    return RestoredMap(project_id=MAP_PROJECT_ID, **went)


def _writes(core: Recorder) -> list[tuple[str, str, Any]]:
    """Core's requests that are no reads: (method, path after the project's, body)."""
    return [
        (
            request.method,
            request.url.path[len(BASE) :],
            json.loads(request.content) if request.content else None,
        )
        for request in core.requests
        if request.method != "GET"
    ]


def _places(state: MapState) -> dict[tuple[str, int], tuple[int | None, int]]:
    """Every layer's and group's parent and order as core stores them."""
    found: dict[tuple[str, int], tuple[int | None, int]] = {
        ("layer", link): (row["layer_project_group_id"], row["order"])
        for link, row in state.layers.items()
    }
    for group_id, row in state.groups.items():
        found[("group", group_id)] = (row["parent_id"], row["order"])
    return found


def _move(kind: str, item: int | str, **where: Any) -> dict[str, Any]:
    return {"op": "move", "item": {"type": kind, "id": item}, **where}


async def _undo(
    audit: AuditRows,
    core: Any,
    run_id: UUID,
    *,
    force: bool = False,
    bearer: str | None = "token",
) -> UndoOutcome:
    return await undo_run(
        cast(Repository, audit), fake_clients(core=core), bearer, run_id, force=force
    )


# ---- the records of an answer --------------------------------------------------------


def test_the_map_records_of_an_answer_are_one_group_oldest_first() -> None:
    hidden = {
        "object": "layer_state",
        "layer_project_id": 34,
        "before": {"visible": True},
        "written": {"visible": False},
    }
    dark = {"object": "basemap", "before": "light", "written": "dark"}
    rows = [
        (uuid4(), _map(hidden)),
        (uuid4(), {"kind": "workflow"}),
        (uuid4(), _map(dark)),
    ]
    assert map_groups(rows) == [
        MapChanges(
            project_id=MAP_PROJECT_ID,
            rows=[rows[0][0], rows[2][0]],
            changes=[hidden, dark],
            undone=False,
        )
    ]
    done = {**_map(hidden), "undone_at": "2026-11-23T10:00:00+00:00"}
    assert _group(done).undone
    assert not _group(done, _map(dark)).undone
    # A record without what an Undo needs is left out.
    broken = [
        {"kind": "map", "project_id": MAP_PROJECT_ID, "changes": []},
        {"kind": "map", "project_id": MAP_PROJECT_ID, "changes": None},
        {"kind": "map", "project_id": None, "changes": [hidden]},
        {"kind": "map", "project_id": MAP_PROJECT_ID, "changes": ["hidden", {}]},
        {"kind": "style", "project_id": MAP_PROJECT_ID, "changes": [hidden]},
    ]
    assert map_groups([(uuid4(), record) for record in broken]) == []


async def test_a_view_change_leaves_no_record() -> None:
    state = MapState()
    env = tool_env(
        fake_clients(core=map_core(state)),
        page=parse_context({"surface": "project.map", "project_id": MAP_PROJECT_ID}),
    )
    result = await MAP_UPDATE.run(
        env,
        MapUpdateInput.model_validate(
            {"operations": [{"op": "set_view", "zoom": 9, "mode": "3d"}]}
        ),
    )
    assert isinstance(result, MapUpdated) and result.view is not None
    assert result.undo() is None
    # An answer whose calls left no record has nothing to undo.
    audit, run_id = await _audit()
    assert undo_groups(await audit.undo_records(run_id)) == []
    assert not undone(await audit.undo_records(run_id))
    with pytest.raises(NothingToUndo) as raised:
        await _undo(audit, map_core(state), run_id)
    assert not raised.value.undone


# ---- values ----------------------------------------------------------------------------


async def test_visibility_name_filter_basemap_and_scene_go_back() -> None:
    state = MapState()
    before = state.snapshot()
    record = await _changed(
        state,
        {**HIDE_LAND_USE, "position": "below_labels", "name": "Land"},
        DARK,
        {
            "op": "set_scene",
            "operations": [
                {"op": "set", "path": "/terrain/exaggeration", "value": 1.5}
            ],
        },
    )
    filtered = _filtered(state, 33, SHOPS)
    assert state.snapshot() != before
    core = map_core(state)
    outcome = await _restore(state, record, filtered, core=core)
    assert outcome == (_back(layers=[33, 34], basemap=True, scene=True), [])
    assert state.snapshot() == before
    # One write per thing that goes back, the layer's state fields together.
    assert _writes(core) == [
        ("PATCH", "/layer/34/map-state", {"visible": True, "position": "top"}),
        ("PUT", "/layer/34", {"name": "Land use"}),
        ("PUT", "/layer/33", {"query": None}),
        ("PUT", "", {"basemap": "light"}),
        ("PUT", "", {"scene": None}),
    ]
    # The map was read once: the project, its layers, its groups, the document.
    assert sorted(
        r.url.path[len(BASE) :] for r in core.requests if r.method == "GET"
    ) == [
        "",
        "/group",
        "/layer",
        "/map",
    ]


async def _stopped_map_call(
    state: MapState, stop: Callable[[httpx.Request], bool], *operations: Any
) -> tuple[AuditRows, UUID]:
    """``map_update`` through the runtime, ended by a Stop at the request
    ``stop`` names, before core sees it; its audit row."""
    core = map_core(state)

    def handler(request: httpx.Request) -> httpx.Response:
        if stop(request):
            raise asyncio.CancelledError()
        response = core.answer(request)
        assert response is not None, request.url.path
        return response

    audit, run_id = AuditRows(), uuid4()
    env = tool_env(
        fake_clients(core=_Proxy(handler), geoapi=_geoapi(), processes=_processes()),
        page=parse_context(
            {
                "surface": "project.map",
                "project_id": MAP_PROJECT_ID,
                "basemaps": BASEMAPS,
            }
        ),
        repo=cast(Repository, audit),
        run_id=run_id,
    )
    with pytest.raises(asyncio.CancelledError):
        await execute(MAP_UPDATE, env, {"operations": list(operations)})
    return audit, run_id


async def test_a_stop_after_a_landed_write_keeps_it_undoable() -> None:
    state = MapState()
    before = state.snapshot()
    audit, run_id = await _stopped_map_call(
        state,
        lambda request: request.method != "GET" and request.url.path.endswith("/33"),
        HIDE_LAND_USE,
        {"op": "set_layer", "layer_project_id": 33, "name": "Shops"},
    )
    assert state.layers[34]["visible"] is False
    [row] = audit.rows
    assert row["error"] == "cancelled" and row["undo"]["kind"] == "map"
    await _undo(audit, map_core(state), run_id)
    assert state.snapshot() == before


async def test_a_stop_before_the_first_write_of_a_map_change_leaves_no_record() -> None:
    state = MapState()
    audit, _ = await _stopped_map_call(
        state, lambda request: request.method != "GET", HIDE_LAND_USE
    )
    [row] = audit.rows
    assert row["undo"] is None


async def test_the_kept_map_record_is_the_returned_result_s_record() -> None:
    state = MapState()
    env = tool_env(
        fake_clients(core=map_core(state), geoapi=_geoapi(), processes=_processes()),
        page=parse_context(
            {
                "surface": "project.map",
                "project_id": MAP_PROJECT_ID,
                "basemaps": BASEMAPS,
            }
        ),
    )
    result = await MAP_UPDATE.run(
        env, MapUpdateInput.model_validate({"operations": [HIDE_LAND_USE, DARK]})
    )
    assert env.landed.read() == result.undo() is not None


async def test_a_filter_goes_back_to_the_one_before() -> None:
    state = MapState()
    first = _filtered(state, 33, SHOPS)
    second = _filtered(state, 33, CAFES)
    # Core answers a query with the keys it leaves empty: the same filter.
    state.layers[33]["query"] = {"metadata": None, **CAFES, "ui": None}
    assert await _restore(state, second) == (_back(layers=[33]), [])
    assert state.layers[33]["query"] == SHOPS
    assert await _restore(state, first) == (_back(layers=[33]), [])
    assert state.layers[33]["query"] is None


async def test_a_filter_the_tool_changed_goes_back_whole() -> None:
    """The records of the real filter operation: a stored filter with a
    drawn area and the panel's notes comes back as it was, and a layer that
    had no filter has none again."""
    state = MapState()
    before = state.snapshot()
    record = await _changed(
        state,
        {
            "op": "filter",
            "layer_project_id": 34,
            "rows": [
                {
                    "do": "add",
                    "conditions": [
                        {"field": "use", "op": "!=", "value": "residential"}
                    ],
                },
                {"do": "set_match", "match": "all"},
            ],
        },
        {
            "op": "filter",
            "layer_project_id": 33,
            "rows": [
                {
                    "do": "add",
                    "conditions": [
                        {"field": "frequency_per_hour", "op": ">=", "value": 6}
                    ],
                }
            ],
        },
    )
    assert [change["object"] for change in record["changes"]] == ["filter", "filter"]
    assert state.layers[33]["query"] is not None
    core = map_core(state)
    assert await _restore(state, record, core=core) == (_back(layers=[33, 34]), [])
    assert _writes(core) == [
        ("PUT", "/layer/33", {"query": None}),
        ("PUT", "/layer/34", {"query": before["layers"][34]["query"]}),
    ]
    assert state.snapshot() == before


async def test_a_value_the_user_changed_since_asks_first_and_force_writes_it() -> None:
    state = MapState()
    before = state.snapshot()
    record = await _changed(state, HIDE_LAND_USE, DARK)
    filtered = _filtered(state, 33, SHOPS)
    # A person picked another basemap and another filter after the answer.
    state.basemap = "satellite"
    state.layers[33]["query"] = CAFES
    core = map_core(state)
    asked = [ChangedMap("filter", layer_project_id=33), ChangedMap("basemap")]
    outcome = await _restore(state, record, filtered, core=core)
    assert outcome == (_back(layers=[34]), asked)
    assert _writes(core) == [("PATCH", "/layer/34/map-state", {"visible": True})]
    assert (state.basemap, state.layers[33]["query"]) == ("satellite", CAFES)
    # A second press writes nothing again: what went back is done, the rest
    # is still asked about.
    core = map_core(state)
    assert await _restore(state, record, filtered, core=core) == (_back(), asked)
    assert _writes(core) == []
    # Undo anyway writes over the person's values, and only those.
    core = map_core(state)
    outcome = await _restore(state, record, filtered, force=True, core=core)
    assert outcome == (_back(layers=[33], basemap=True), [])
    assert _writes(core) == [
        ("PUT", "/layer/33", {"query": None}),
        ("PUT", "", {"basemap": "light"}),
    ]
    assert state.snapshot() == before


async def test_fields_are_compared_one_by_one() -> None:
    state = MapState()
    record = await _changed(
        state, {**HIDE_LAND_USE, "position": "below_labels", "legend_expanded": False}
    )
    # A person moved the layer below the roads and opened the legend again
    # (the value before): the first is asked about, the second is done.
    state.layers[34].update(position="below_roads", legend_expanded=True)
    core = map_core(state)
    outcome = await _restore(state, record, core=core)
    assert outcome == (
        _back(layers=[34]),
        [ChangedMap("layer_state", layer_project_id=34)],
    )
    assert _writes(core) == [("PATCH", "/layer/34/map-state", {"visible": True})]
    core = map_core(state)
    assert await _restore(state, record, force=True, core=core) == (
        _back(layers=[34]),
        [],
    )
    assert _writes(core) == [("PATCH", "/layer/34/map-state", {"position": "top"})]


async def test_two_changes_of_one_layer_go_back_to_the_first_before() -> None:
    state = MapState()
    before = state.snapshot()
    first = await _changed(
        state, {**HIDE_LAND_USE, "legend_expanded": False, "name": "Land"}
    )
    second = await _changed(
        state,
        {
            "op": "set_layer",
            "layer_project_id": 34,
            "visible": True,
            "position": "below_roads",
            "name": "Uses of land",
        },
    )
    core = map_core(state)
    assert await _restore(state, first, second, core=core) == (_back(layers=[34]), [])
    # Shown, hidden, shown again is no change: only what differs from the
    # first state before is written, each thing once.
    assert _writes(core) == [
        ("PATCH", "/layer/34/map-state", {"position": "top", "legend_expanded": True}),
        ("PUT", "/layer/34", {"name": "Land use"}),
    ]
    assert state.snapshot() == before
    # Hidden and shown again is no change of the answer's: a person who hid
    # the layer afterwards is neither asked nor overruled.
    first = await _changed(state, HIDE_LAND_USE)
    second = await _changed(
        state, {"op": "set_layer", "layer_project_id": 34, "visible": True}
    )
    state.layers[34]["visible"] = False
    core = map_core(state)
    assert await _restore(state, first, second, core=core) == (_back(), [])
    assert _writes(core) == []


async def test_a_layer_that_is_gone_or_locked_is_skipped() -> None:
    state = MapState()
    record = await _changed(
        state,
        {**HIDE_LAND_USE, "name": "Land"},
        {"op": "set_layer", "layer_project_id": 39, "visible": False},
    )
    filtered = _filtered(state, 34, None)
    state.remove_layer(34)
    inner = map_core(state)

    def locked(request: httpx.Request) -> httpx.Response:
        response = inner.answer(request)
        assert response is not None
        if request.method == "GET" and request.url.path == f"{BASE}/layer":
            rows = [
                {**row, "locked": True} if row["id"] == 39 else row
                for row in response.json()
            ]
            return httpx.Response(200, json=rows)
        return response

    core = _Proxy(locked)
    assert await _restore(state, record, filtered, core=core) == (_back(), [])
    assert _writes(core) == []


async def test_a_group_gets_its_name_and_its_state_back() -> None:
    state = MapState()
    before = state.snapshot()
    record = await _changed(
        state,
        {"op": "rename_group", "group_id": 2, "name": "Getting around"},
        {"op": "set_group", "group_id": 2, "visible": False, "expanded": False},
    )
    assert state.groups[2]["expanded"] is False
    core = map_core(state)
    assert await _restore(state, record, core=core) == (_back(groups=True), [])
    assert state.snapshot() == before
    # Open or closed is stored with the tree: the whole tree goes with it.
    [tree, shown, named] = _writes(core)
    assert shown == ("PATCH", "/group/2/map-state", {"visible": True})
    assert named == ("PUT", "/group/2", {"name": "Transport"})
    assert tree[:2] == ("PUT", "/layer-tree") and len(tree[2]["items"]) == 13
    assert [item for item in tree[2]["items"] if "expanded" in item] == [
        {"id": 2, "type": "group", "order": 2, "parent_id": None, "expanded": True}
    ]
    # A person renamed the group since: asked, and the rest is left alone.
    record = await _changed(
        state, {"op": "rename_group", "group_id": 1, "name": "Basis"}
    )
    state.groups[1]["name"] = "Background"
    assert await _restore(state, record) == (
        _back(),
        [ChangedMap("group_name", group_id=1)],
    )
    assert await _restore(state, record, force=True) == (_back(groups=True), [])
    assert state.groups[1]["name"] == "Base data"


# ---- the style a layer draws -----------------------------------------------------------


async def test_a_new_style_then_a_switch_goes_back_to_the_style_before_the_answer() -> (
    None
):
    """One answer made a new style active, then switched the layer to
    another: Undo puts the layer back on the style it drew before the answer
    and asks about nothing nobody did."""
    state = MapState()
    drawn = state.active_style_id(31)
    other = _second_style(state, 31)
    made = await _styled(
        state,
        layer_project_id=31,
        new_style={"name": "New", "asked": "as a new style", "start": "current"},
        operations=[RED],
    )
    switched = await _changed(
        state, {"op": "set_layer", "layer_project_id": 31, "active_style_id": other}
    )
    audit, run_id = await _audit(made, switched)
    outcome = await _undo(audit, map_core(state), run_id)
    assert outcome.changed_map == [] and outcome.changed_styles == []
    assert state.active_style_id(31) == drawn
    assert made["style_id"] not in state.styles


async def test_the_style_a_layer_draws_goes_back_while_that_style_exists() -> None:
    state = MapState()
    default = state.active_style_id(31)
    other = _second_style(state, 31)
    record = await _changed(
        state, {"op": "set_layer", "layer_project_id": 31, "active_style_id": other}
    )
    assert state.active_style_id(31) == other
    assert await _restore(state, record) == (_back(layers=[31]), [])
    assert state.active_style_id(31) == default

    # The style to go back to was deleted since: nothing to switch to. It is
    # asked about once, and Undo anyway leaves the layer as it is.
    third = _second_style(state, 31, "Third")
    state.layers[31]["active_style_id"] = other
    record = await _changed(
        state, {"op": "set_layer", "layer_project_id": 31, "active_style_id": third}
    )
    del state.styles[other]
    core = map_core(state)
    asked = [ChangedMap("layer_state", layer_project_id=31)]
    assert await _restore(state, record, core=core) == (_back(), asked)
    assert await _restore(state, record, force=True, core=core) == (_back(), [])
    assert _writes(core) == []
    assert state.active_style_id(31) == third


async def test_a_style_the_layer_lost_meanwhile_is_left_out_of_the_write() -> None:
    state = MapState()
    other = _second_style(state, 31)
    record = await _changed(
        state,
        {
            "op": "set_layer",
            "layer_project_id": 31,
            "active_style_id": other,
            "visible": False,
        },
    )

    def lost(request: httpx.Request) -> httpx.Response | None:
        if request.method == "PATCH" and b"active_style_id" in request.content:
            return httpx.Response(422, json={"detail": {"code": "style_not_on_layer"}})
        return None

    core = _failing(state, lost)
    assert await _restore(state, record, core=core) == (
        _back(layers=[31]),
        [ChangedMap("layer_state", layer_project_id=31)],
    )
    assert [write[2] for write in _writes(core)] == [
        {"visible": True, "active_style_id": state.styles_of(31)[0].id},
        {"visible": True},
    ]
    assert state.layers[31]["visible"] is True
    # Any other refusal of the state for what it holds: left out, and said.
    state.layers[31]["visible"] = False
    refused = _failing(
        state,
        lambda request: (
            httpx.Response(422, json={"detail": {"code": "time_value_too_large"}})
            if request.method == "PATCH"
            else None
        ),
    )
    assert await _restore(state, record, force=True, core=refused) == (
        _back(not_restored=["map_refused"]),
        [],
    )
    state.layers[31]["visible"] = True
    # Undo anyway: nothing to switch to, and nothing asked.
    assert await _restore(state, record, force=True, core=_failing(state, lost)) == (
        _back(),
        [],
    )
    assert state.active_style_id(31) == other


async def test_forced_nothing_is_asked_about() -> None:
    """Undo anyway never answers with a question, whatever the map holds."""
    state = MapState()
    other = _second_style(state, 31)
    record = await _changed(
        state,
        {
            "op": "set_layer",
            "layer_project_id": 31,
            "active_style_id": other,
            "visible": False,
            "name": "Wards",
        },
        _move("layer", 37),
        {"op": "rename_group", "group_id": 2, "name": "Getting around"},
        {"op": "set_group", "group_id": 2, "visible": False, "expanded": False},
        DARK,
        {
            "op": "set_scene",
            "operations": [{"op": "set", "path": "/buildings", "value": False}],
        },
    )
    filtered = _filtered(state, 33, SHOPS)
    # A person changed every one of them since.
    third = _second_style(state, 31, "Third")
    state.layers[31].update(active_style_id=third, visible=True, name="Boroughs")
    state.layers[31]["position"] = "below_labels"
    state.layers[37].update(layer_project_group_id=1, order=9)
    state.groups[2].update(name="Traffic", visible=True, expanded=True)
    state.basemap = "satellite"
    state.scene = {"terrain": {"exaggeration": 2}}
    state.layers[33]["query"] = CAFES
    restored, asked = await _restore(state, record, filtered)
    assert {
        (change.object, change.layer_project_id or change.group_id) for change in asked
    } == {
        ("layer_state", 31),
        ("layer_name", 31),
        ("filter", 33),
        ("tree", None),
        ("group_name", 2),
        ("basemap", None),
        ("scene", None),
    }
    assert restored == _back()
    restored, asked = await _restore(state, record, filtered, force=True)
    assert asked == []
    assert restored == _back(
        layers=[31, 33], tree=True, groups=True, basemap=True, scene=True
    )


# ---- the order ---------------------------------------------------------------------------


async def test_the_order_goes_back_and_ignores_layers_that_are_gone() -> None:
    state = MapState()
    before = _places(state)
    record = await _changed(
        state,
        _move("layer", 37),
        _move("layer", 34, group_id=2, after={"type": "layer", "id": 40}),
        _move("group", 1, after={"type": "layer", "id": 37}),
    )
    assert _places(state) != before
    # A person removed a layer since, and added a group on top.
    state.remove_layer(33)
    state.groups[7] = {
        "name": "Mine",
        "parent_id": None,
        "order": -1,
        "visible": True,
        "expanded": True,
    }
    core = map_core(state)
    assert await _restore(state, record, core=core) == (_back(tree=True), [])
    # Every item that is still there stands where it stood, counted again
    # from 0 under its parent; the person's group keeps its place on top.
    assert _places(state) == {
        ("group", 7): (None, 0),
        ("layer", 32): (None, 1),
        ("layer", 35): (None, 2),
        ("group", 2): (None, 3),
        ("layer", 40): (2, 0),
        ("layer", 41): (2, 1),
        ("group", 1): (None, 4),
        ("layer", 36): (1, 0),
        ("layer", 34): (1, 1),
        ("layer", 31): (1, 2),
        ("layer", 39): (1, 3),
        ("layer", 37): (None, 5),
        ("layer", 38): (None, 6),
    }
    [(method, path, body)] = _writes(core)
    assert (method, path) == ("PUT", "/layer-tree")
    assert all(
        set(item) == {"id", "type", "order", "parent_id"} for item in body["items"]
    )
    # Done: a second press finds the order as it was before and writes nothing.
    core = map_core(state)
    assert await _restore(state, record, core=core) == (_back(), [])
    assert _writes(core) == []


async def test_an_order_the_user_changed_since_asks_first() -> None:
    state = MapState()
    before = _places(state)
    record = await _changed(state, _move("layer", 37))
    # A person dragged another layer into a group since.
    state.layers[35].update(layer_project_group_id=2, order=5)
    held = _places(state)
    core = map_core(state)
    assert await _restore(state, record, core=core) == (_back(), [ChangedMap("tree")])
    assert _writes(core) == [] and _places(state) == held
    assert await _restore(state, record, force=True) == (_back(tree=True), [])
    assert _places(state) == before


# ---- groups --------------------------------------------------------------------------------


async def test_an_added_group_is_removed_only_when_empty_even_with_force() -> None:
    state = MapState()
    before = state.snapshot()
    record = await _changed(
        state,
        {"op": "add_group", "name": "Schools"},
        _move("layer", 37, group_id="new:0"),
        {"op": "rename_group", "group_id": "new:0", "name": "Education"},
    )
    [new] = set(state.groups) - {1, 2}
    assert state.layers[37]["layer_project_group_id"] == new
    core = map_core(state)
    outcome = await _restore(state, record, core=core)
    assert outcome == (_back(tree=True, groups=True), [])
    assert state.snapshot() == before
    # The layer leaves the group before the group goes; the name of a group
    # that goes is not written back.
    assert [write[:2] for write in _writes(core)] == [
        ("PUT", "/layer-tree"),
        ("DELETE", f"/group/{new}"),
    ]

    # A person put a layer into the group the answer added: core would delete
    # the layer with the group, so the group stays, also on Undo anyway.
    record = await _changed(state, {"op": "add_group", "name": "Schools"})
    [new] = set(state.groups) - {1, 2}
    state.layers[38]["layer_project_group_id"] = new
    for force in (False, True):
        core = map_core(state)
        outcome = await _restore(state, record, force=force, core=core)
        assert outcome == (_back(not_restored=["group_in_use"]), [])
        assert _writes(core) == []
    assert new in state.groups and 38 in state.layers
    # A group in it counts as well.
    state.layers[38]["layer_project_group_id"] = None
    state.groups[9] = {**state.groups[new], "name": "Inner", "parent_id": new}
    assert await _restore(state, record, force=True) == (
        _back(not_restored=["group_in_use"]),
        [],
    )
    # Empty again, it goes; and once gone nothing is left to do.
    del state.groups[9]
    assert await _restore(state, record) == (_back(groups=True), [])
    assert new not in state.groups
    assert await _restore(state, record) == (_back(), [])


def test_a_group_is_in_use_by_the_rows_or_by_the_map_document() -> None:
    group = {"id": 7, "name": "Schools", "parent_id": None}
    entry = {"type": "group", "id": 7, "children": []}

    def held(rows: list[Any], groups: list[Any], children: list[Any]) -> MapRead:
        document = {"layers": [{**entry, "children": children}]}
        return map_read({}, rows, groups, {"map": document})

    assert not _in_use(held([], [group], []), 7)
    assert _in_use(held([{"id": 38, "layer_project_group_id": 7}], [group], []), 7)
    assert _in_use(held([], [group, {"id": 8, "parent_id": 7}], []), 7)
    # A layer only the map document lists counts too.
    assert _in_use(held([], [group], [{"type": "layer", "id": 38}]), 7)


async def test_a_group_is_read_again_right_before_it_is_deleted() -> None:
    state = MapState()
    record = await _changed(state, {"op": "add_group", "name": "Schools"})
    [new] = set(state.groups) - {1, 2}
    inner = map_core(state)
    reads = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal reads
        if request.method == "GET" and request.url.path == f"{BASE}/layer":
            reads += 1
            if reads == 2:
                # A person drags a layer into the group while the Undo runs.
                state.layers[38]["layer_project_group_id"] = new
        response = inner.answer(request)
        assert response is not None
        return response

    core = _Proxy(handler)
    assert await _restore(state, record, core=core) == (
        _back(not_restored=["group_in_use"]),
        [],
    )
    assert reads == 2 and _writes(core) == []
    assert 38 in state.layers


async def test_a_removed_group_is_created_again() -> None:
    state = MapState()
    before = state.snapshot()
    record = await _changed(
        state,
        _move("layer", 40),
        _move("layer", 33),
        _move("layer", 41),
        {"op": "remove_group", "group_id": 2},
    )
    assert set(state.groups) == {1}
    core = map_core(state)
    assert await _restore(state, record, core=core) == (
        _back(tree=True, groups=True),
        [],
    )
    # The group has a new id; its name, its place and its layers are back.
    [new] = set(state.groups) - {1}
    assert [write[:2] for write in _writes(core)] == [
        ("POST", "/group"),
        ("PUT", "/layer-tree"),
    ]
    assert _writes(core)[0][2] == {"name": "Transport"}
    assert state.groups[new] == before["groups"][2]
    assert {
        link: (row["layer_project_group_id"], row["order"])
        for link, row in state.layers.items()
    } == {
        link: (
            new
            if row["layer_project_group_id"] == 2
            else row["layer_project_group_id"],
            row["order"],
        )
        for link, row in before["layers"].items()
    }
    # A second press creates no second group.
    core = map_core(state)
    assert await _restore(state, record, core=core) == (_back(), [])
    assert _writes(core) == [] and set(state.groups) == {1, new}


async def test_an_undo_that_stopped_after_creating_the_group_goes_on_from_there() -> (
    None
):
    state = MapState()
    before = state.snapshot()
    record = await _changed(
        state,
        *(_move("layer", link) for link in (40, 33, 41)),
        {"op": "remove_group", "group_id": 2},
    )

    def down(request: httpx.Request) -> httpx.Response | None:
        if request.url.path.endswith("/layer-tree"):
            return httpx.Response(503, json={"detail": "down"})
        return None

    with pytest.raises(ServiceError):
        await _restore(state, record, core=_failing(state, down))
    [new] = set(state.groups) - {1}
    assert state.layers[40]["layer_project_group_id"] is None
    # The group is there: the next press takes it for the removed one and
    # puts it and its layers where they were.
    core = map_core(state)
    assert await _restore(state, record, core=core) == (_back(tree=True), [])
    assert [write[:2] for write in _writes(core)] == [("PUT", "/layer-tree")]
    assert state.groups == {1: before["groups"][1], new: before["groups"][2]}
    assert [state.layers[link]["layer_project_group_id"] for link in (40, 33, 41)] == [
        new,
        new,
        new,
    ]


async def test_a_group_of_the_same_name_is_not_taken_for_the_removed_one() -> None:
    state = MapState()
    twin = {
        "name": "Transport",
        "parent_id": None,
        "order": 9,
        "visible": True,
        "expanded": True,
    }
    # A group of that name the answer's trees list: it was there all along.
    state.groups[6] = dict(twin)
    record = await _changed(
        state,
        *(_move("layer", link) for link in (40, 33, 41)),
        {"op": "remove_group", "group_id": 2},
    )
    assert await _restore(state, record) == (_back(tree=True, groups=True), [])
    [new] = set(state.groups) - {1, 6}
    assert state.layers[40]["layer_project_group_id"] == new

    # An older group of that name, where the removal names its group and no
    # tree was written: the removed one has a newer id than it.
    state = MapState()
    state.groups[4], state.groups[5] = dict(twin), dict(twin)
    record = await _changed(state, {"op": "remove_group", "group_id": 5})
    assert await _restore(state, record) == (_back(groups=True), [])
    assert len(state.groups) == 4


async def test_a_removed_group_inside_a_group_gets_its_parent_back() -> None:
    state = MapState()
    state.groups[5] = {
        "name": "Rail",
        "parent_id": 2,
        "order": 7,
        "visible": True,
        "expanded": True,
    }
    record = await _changed(state, {"op": "remove_group", "group_id": 5})
    assert 5 not in state.groups
    assert await _restore(state, record) == (_back(groups=True), [])
    [new] = set(state.groups) - {1, 2}
    assert (state.groups[new]["name"], state.groups[new]["parent_id"]) == ("Rail", 2)
    # The group it was in is gone: nothing is left to put it into.
    record = await _changed(state, {"op": "remove_group", "group_id": new})
    for link in (40, 33, 41):
        state.remove_layer(link)
    del state.groups[2]
    core = map_core(state)
    assert await _restore(state, record, core=core) == (_back(), [])
    assert _writes(core) == []


def _top_level(state: MapState) -> list[tuple[str, Any]]:
    """The top level of the stored tree, top first, a group by its name."""
    found = [
        (row["order"], "layer", link)
        for link, row in state.layers.items()
        if row["layer_project_group_id"] is None
    ] + [
        (row["order"], "group", row["name"])
        for row in state.groups.values()
        if row["parent_id"] is None
    ]
    return [(kind, name) for _, kind, name in sorted(found, key=lambda item: item[0])]


async def test_a_removed_empty_group_comes_back_at_its_place() -> None:
    state = MapState()
    state.groups[5] = {
        "name": "Empty",
        "parent_id": None,
        "order": 9,
        "visible": True,
        "expanded": True,
    }
    record = await _changed(state, {"op": "remove_group", "group_id": 5})
    [removed] = record["changes"]
    order = removed["before"]["order"]
    placed = _top_level(state)
    assert await _restore(state, record) == (_back(groups=True), [])
    back = _top_level(state)
    assert back.index(("group", "Empty")) == order
    assert [item for item in back if item != ("group", "Empty")] == placed


async def test_a_group_the_answer_added_and_removed_is_not_created() -> None:
    state = MapState()
    before = state.snapshot()
    added = await _changed(state, {"op": "add_group", "name": "Schools"})
    [new] = set(state.groups) - {1, 2}
    removed = await _changed(state, {"op": "remove_group", "group_id": new})
    # The removal names the group it removed: the one the answer added.
    assert removed["changes"] == [
        {
            "object": "group_removed",
            "group_id": new,
            "before": {"name": "Schools", "parent_id": None, "order": 0},
        }
    ]
    core = map_core(state)
    assert await _restore(state, added, removed, core=core) == (_back(), [])
    assert _writes(core) == [] and state.snapshot() == before
    # Added, used and removed within one call, with a change that stays.
    record = await _changed(
        state,
        {"op": "add_group", "name": "Schools"},
        _move("layer", 37, group_id="new:0"),
        _move("layer", 37, after={"type": "layer", "id": 35}),
        {"op": "remove_group", "group_id": "new:0"},
    )
    assert set(state.groups) == {1, 2}
    core = map_core(state)
    assert await _restore(state, record, core=core) == (_back(tree=True), [])
    assert [write[:2] for write in _writes(core)] == [("PUT", "/layer-tree")]
    assert state.snapshot() == before


EMPTIED = (
    _move("layer", 38),
    *(_move("layer", link) for link in (40, 33, 41, 36, 34, 31, 39)),
    {"op": "remove_group", "group_id": 2},
    {"op": "remove_group", "group_id": 1},
)


async def test_two_emptied_groups_come_back_with_their_layers() -> None:
    """Both groups get new ids; the tree before names the old ones, and
    every layer goes back into the group that stands for its old one."""
    state = MapState()
    before = _places(state)
    record = await _changed(state, *EMPTIED)
    assert not state.groups
    assert [
        change.get("group_id")
        for change in record["changes"]
        if change["object"] == "group_removed"
    ] == [2, 1]
    core = map_core(state)
    assert await _restore(state, record, core=core) == (
        _back(tree=True, groups=True),
        [],
    )
    assert [write[:2] for write in _writes(core)] == [
        ("POST", "/group"),
        ("POST", "/group"),
        ("PUT", "/layer-tree"),
    ]
    names = {row["name"]: group_id for group_id, row in state.groups.items()}
    was = {1: names["Base data"], 2: names["Transport"], None: None}
    assert _places(state) == {
        (kind, was[item] if kind == "group" else item): (was[parent], order)
        for (kind, item), (parent, order) in before.items()
    }
    # A second press finds both groups and writes nothing.
    core = map_core(state)
    assert await _restore(state, record, core=core) == (_back(), [])
    assert _writes(core) == []


async def test_layers_never_go_into_a_group_that_is_not_there() -> None:
    """Removals that do not name their group: nothing says which of the
    groups held which layers. Both are created again, the layers stay where
    they are, and no item is sent under a group core does not have (core
    would refuse the whole tree)."""
    state = MapState()
    record = await _changed(state, *EMPTIED)
    assert not state.groups
    for change in record["changes"]:
        if change["object"] == "group_removed":
            del change["group_id"]
    core = map_core(state)
    assert await _restore(state, record, core=core) == (
        _back(tree=True, groups=True),
        [],
    )
    assert sorted(row["name"] for row in state.groups.values()) == [
        "Base data",
        "Transport",
    ]
    [*_, (method, path, body)] = _writes(core)
    assert (method, path) == ("PUT", "/layer-tree")
    assert {item["parent_id"] for item in body["items"]} == {None}
    # What the tree before placed at the top level is back in its order
    # (the layer moved to the top stands last again); the rest stays.
    names = {row["name"]: group_id for group_id, row in state.groups.items()}
    top = [
        ("group", names["Transport"]),
        ("group", names["Base data"]),
        *(("layer", link) for link in (39, 31, 34, 36, 41, 33, 40, 32, 35, 37, 38)),
    ]
    assert _places(state) == {item: (None, order) for order, item in enumerate(top)}


async def test_an_added_group_that_stays_does_not_keep_the_answer_from_being_undone() -> (
    None
):
    state = MapState()
    record = await _changed(state, {"op": "add_group", "name": "Schools"}, DARK)
    [new] = set(state.groups) - {1, 2}
    state.layers[38]["layer_project_group_id"] = new
    audit, run_id = await _audit(record)
    outcome = await _undo(audit, map_core(state), run_id)
    assert outcome.maps == [_back(basemap=True, not_restored=["group_in_use"])]
    assert outcome.not_restored == ["group_in_use"] and outcome.changed_map == []
    # Nothing is left to ask about: the rows are done with.
    assert undone(await audit.undo_records(run_id))


async def test_a_removed_layer_is_reported_as_not_restored() -> None:
    state = MapState()
    hidden = await _changed(state, HIDE_LAND_USE)
    state.remove_layer(39)
    removed = _map(
        {"object": "layer_removed", "layer_project_id": 39, "name": "Old boundaries"},
        {"object": "layer_removed", "layer_project_id": 38, "name": "Elevation"},
    )
    audit, run_id = await _audit(hidden, removed)
    core = map_core(state)
    outcome = await _undo(audit, core, run_id)
    assert outcome == UndoOutcome(
        restored=[],
        changed=[],
        maps=[_back(layers=[34], not_restored=["layer_removed"])],
        not_restored=["layer_removed"],
    )
    assert _writes(core) == [("PATCH", "/layer/34/map-state", {"visible": True})]
    assert 39 not in state.layers
    # Nothing is left to ask about: the answer reads undone.
    assert undone(await audit.undo_records(run_id))


# ---- writes that fail --------------------------------------------------------------------


def _failing(
    state: MapState, fails: Callable[[httpx.Request], httpx.Response | None]
) -> _Proxy:
    """The stand-in core, but ``fails`` answers a request in its place when
    it returns a response."""
    inner = map_core(state)

    def handler(request: httpx.Request) -> httpx.Response:
        refused = fails(request)
        if refused is not None:
            return refused
        response = inner.answer(request)
        assert response is not None, request.url.path
        return response

    return _Proxy(handler)


async def test_a_viewer_is_refused_and_nothing_is_marked() -> None:
    state = MapState()
    audit, run_id = await _audit(await _changed(state, HIDE_LAND_USE, DARK))

    def viewer(request: httpx.Request) -> httpx.Response | None:
        if request.method == "GET":
            return None
        return httpx.Response(403, json={"detail": {"code": "forbidden"}})

    with pytest.raises(UndoRefused) as raised:
        await _undo(audit, _failing(state, viewer), run_id)
    assert (raised.value.status, raised.value.code) == (403, "undo_not_allowed")
    records = await audit.undo_records(run_id)
    assert not any("undone_at" in r or "undoing_at" in r for _, r in records)
    # A user who can no longer open the project is refused the same way.
    closed = _Proxy(
        lambda request: httpx.Response(401, json={"detail": "Unauthorized"})
    )
    with pytest.raises(UndoRefused) as raised:
        await _undo(audit, closed, run_id)
    assert raised.value.code == "undo_not_allowed"
    assert closed.requests and all(r.method == "GET" for r in closed.requests)


async def test_a_project_that_is_gone_leaves_nothing_to_undo() -> None:
    state = MapState()
    record = await _changed(state, HIDE_LAND_USE)
    gone = _Proxy(lambda request: httpx.Response(404, json={"detail": "Not found"}))
    assert await _restore(state, record, core=gone) == (None, [])
    audit, run_id = await _audit(record)
    assert await _undo(audit, gone, run_id) == UndoOutcome(restored=[], changed=[])
    assert undone(await audit.undo_records(run_id))


async def test_a_failure_half_way_leaves_the_rows_free_and_the_next_press_goes_on() -> (
    None
):
    state = MapState()
    before = state.snapshot()
    audit, run_id = await _audit(await _changed(state, HIDE_LAND_USE, DARK))
    down = True

    def fails(request: httpx.Request) -> httpx.Response | None:
        if down and request.method == "PUT" and request.url.path == BASE:
            return httpx.Response(503, json={"detail": "down"})
        return None

    core = _failing(state, fails)
    with pytest.raises(UndoRefused) as raised:
        await _undo(audit, core, run_id)
    assert (raised.value.status, raised.value.code) == (503, "undo_unavailable")
    assert state.layers[34]["visible"] is True and state.basemap == "dark"
    records = await audit.undo_records(run_id)
    assert not any("undone_at" in r or "undoing_at" in r for _, r in records)
    down = False
    core = _failing(state, fails)
    outcome = await _undo(audit, core, run_id)
    # The layer went back with the first press and is not written again.
    assert outcome.maps == [_back(basemap=True)]
    assert _writes(core) == [("PUT", "", {"basemap": "light"})]
    assert state.snapshot() == before
    assert undone(await audit.undo_records(run_id))


def _refusing(state: MapState) -> _Proxy:
    """Core, which refuses a layer's filter, a scene and a new group for
    what they hold, whatever is sent."""

    def refuses(request: httpx.Request) -> httpx.Response | None:
        body = json.loads(request.content) if request.content else {}
        path = request.url.path[len(BASE) :]
        if request.method == "PUT" and path.startswith("/layer/") and "query" in body:
            return httpx.Response(422, json={"detail": "Invalid CQL query: no field"})
        if request.method == "PUT" and path == "" and "scene" in body:
            return httpx.Response(422, json={"detail": {"code": "invalid_scene"}})
        if request.method == "POST" and path == "/group":
            return httpx.Response(
                400, json={"detail": "Maximum nesting level reached (Max 2 levels)"}
            )
        return None

    return _failing(state, refuses)


async def test_a_write_core_refuses_for_good_is_left_out_and_the_rest_goes_on() -> None:
    state = MapState()
    state.groups[5] = {
        "name": "Rail",
        "parent_id": 2,
        "order": 7,
        "visible": True,
        "expanded": True,
    }
    record = await _changed(
        state,
        HIDE_LAND_USE,
        {"op": "remove_group", "group_id": 5},
        {
            "op": "set_scene",
            "operations": [{"op": "set", "path": "/buildings", "value": False}],
        },
        DARK,
    )
    filtered = _filtered(state, 33, SHOPS)
    core = _refusing(state)
    outcome = await _restore(state, record, filtered, core=core)
    # The group, the filter and the scene stay as they are, said once; the
    # layer and the basemap, written before and after them, went back.
    assert outcome == (
        _back(layers=[34], basemap=True, not_restored=["map_refused"]),
        [],
    )
    assert [write[:2] for write in _writes(core)] == [
        ("POST", "/group"),
        ("PATCH", "/layer/34/map-state"),
        ("PUT", "/layer/33"),
        ("PUT", ""),
        ("PUT", ""),
    ]
    assert state.layers[34]["visible"] is True and state.basemap == "light"
    assert state.layers[33]["query"] == SHOPS and state.scene == {"buildings": False}
    assert set(state.groups) == {1, 2}
    # Nothing is asked about: the rows are done with, and the answer reads
    # undone.
    audit, run_id = await _audit(record, filtered)
    state.layers[34]["visible"] = False
    state.basemap = "dark"
    outcome = await _undo(audit, _refusing(state), run_id)
    assert outcome.not_restored == ["map_refused"] and outcome.changed_map == []
    assert undone(await audit.undo_records(run_id))
    assert (
        await press_undo(audit, fake_clients(core=_refusing(state)), run_id)
        == "already_undone"
    )


async def test_a_layer_core_no_longer_finds_is_skipped() -> None:
    state = MapState()
    record = await _changed(state, {**HIDE_LAND_USE, "name": "Land"}, DARK)

    def gone(request: httpx.Request) -> httpx.Response | None:
        if request.method != "GET" and "/layer/34" in request.url.path:
            return httpx.Response(404, json={"detail": {"code": "not_found"}})
        return None

    core = _failing(state, gone)
    assert await _restore(state, record, core=core) == (_back(basemap=True), [])
    assert state.basemap == "light"


async def test_a_group_created_without_an_answer_is_found_by_reading() -> None:
    state = MapState()
    record = await _changed(
        state,
        *(_move("layer", link) for link in (40, 33, 41)),
        {"op": "remove_group", "group_id": 2},
    )
    with pytest.raises(ToolFailed):
        await _restore(state, record, core=_timing_out(state, landed=False))
    assert set(state.groups) == {1}
    assert await _restore(state, record, core=_timing_out(state, landed=True)) == (
        _back(tree=True, groups=True),
        [],
    )
    [new] = set(state.groups) - {1}
    assert state.groups[new]["name"] == "Transport"
    assert {state.layers[link]["layer_project_group_id"] for link in (40, 33, 41)} == {
        new
    }


def _timing_out(state: MapState, *, landed: bool) -> _Proxy:
    """Core, whose writes get no answer: after they were made, or without
    being made."""
    inner = map_core(state)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method != "GET":
            if landed:
                inner.answer(request)
            raise httpx.ReadTimeout("no answer", request=request)
        response = inner.answer(request)
        assert response is not None
        return response

    return _Proxy(handler)


async def test_a_write_without_an_answer_counts_when_it_landed() -> None:
    state = MapState()
    before = state.snapshot()
    record = await _changed(
        state,
        {**HIDE_LAND_USE, "name": "Land"},
        {"op": "add_group", "name": "Schools"},
        _move("layer", 37, group_id="new:1"),
        {"op": "set_group", "group_id": 2, "visible": False, "expanded": False},
        {"op": "rename_group", "group_id": 1, "name": "Basis"},
        DARK,
        {
            "op": "set_scene",
            "operations": [{"op": "set", "path": "/buildings", "value": False}],
        },
    )
    filtered = _filtered(state, 33, SHOPS)
    core = _timing_out(state, landed=True)
    assert await _restore(state, record, filtered, core=core) == (
        _back(layers=[33, 34], tree=True, groups=True, basemap=True, scene=True),
        [],
    )
    assert state.snapshot() == before

    # Not landed: the write failed as it did, and nothing is reported back.
    record = await _changed(state, HIDE_LAND_USE)
    with pytest.raises(ToolFailed) as raised:
        await _restore(state, record, core=_timing_out(state, landed=False))
    assert not isinstance(raised.value, ServiceError)
    assert state.layers[34]["visible"] is False
    audit, run_id = await _audit(record)
    with pytest.raises(UndoRefused) as refused:
        await _undo(audit, _timing_out(state, landed=False), run_id)
    assert (refused.value.status, refused.value.code) == (503, "undo_unavailable")


# ---- the whole answer ----------------------------------------------------------------------


async def test_an_answer_with_styles_and_map_changes_undoes_both_and_reads_undone() -> (
    None
):
    """A new style and a switch of the map to it, in one answer: the map's
    change is the newer, so its Undo goes first and puts back the style the
    layer drew before (which is not the first), and the new style is then
    removed."""
    state = MapState()
    default = state.active_style_id(31)
    old_look = _second_style(state, 31)
    state.layers[31]["active_style_id"] = old_look
    before = state.snapshot()
    made = await _styled(
        state,
        layer_project_id=31,
        new_style={"name": "Variant", "asked": "as a new style", "start": "current"},
        operations=[RED],
        make_active=False,
    )
    switched = await _changed(
        state,
        {
            "op": "set_layer",
            "layer_project_id": 31,
            "active_style_id": made["style_id"],
        },
        DARK,
    )
    assert state.active_style_id(31) == made["style_id"]
    audit, run_id = await _audit(made, switched)
    groups = undo_groups(await audit.undo_records(run_id))
    assert [type(group) for group in groups] == [MapChanges, CreatedStyle]
    assert not undone(await audit.undo_records(run_id))
    core = map_core(state)
    outcome = await _undo(audit, core, run_id)
    assert outcome == UndoOutcome(
        restored=[],
        changed=[],
        styles=[
            RestoredStyle(MAP_PROJECT_ID, 31, made["style_id"], None, removed=True)
        ],
        maps=[_back(layers=[31], basemap=True)],
    )
    assert default != old_look and state.active_style_id(31) == old_look
    assert state.snapshot() == before
    assert undone(await audit.undo_records(run_id))
    with pytest.raises(NothingToUndo) as raised:
        await _undo(audit, core, run_id)
    assert raised.value.undone
    assert await press_undo(audit, fake_clients(core=core), run_id) == "already_undone"


async def test_a_switch_and_then_a_new_active_style_both_go_back() -> None:
    """The map is switched to another style, and then a new style is made
    and drawn, in one answer: the style Undo goes back to the style the
    switch chose, and the map Undo from there to the one before."""
    state = MapState()
    default = state.active_style_id(31)
    other = _second_style(state, 31)
    before = state.snapshot()
    switched = await _changed(
        state, {"op": "set_layer", "layer_project_id": 31, "active_style_id": other}
    )
    made = await _styled(
        state,
        layer_project_id=31,
        new_style={"name": "Variant", "asked": "as a new style", "start": "current"},
        operations=[RED],
    )
    assert state.active_style_id(31) == made["style_id"]
    audit, run_id = await _audit(switched, made)
    outcome = await _undo(audit, map_core(state), run_id)
    assert outcome.changed_map == [] and outcome.maps == [_back(layers=[31])]
    assert state.active_style_id(31) == default
    assert state.snapshot() == before
    assert undone(await audit.undo_records(run_id))


async def test_the_eval_users_undo_says_when_the_map_was_changed_since() -> None:
    state = MapState()
    audit, run_id = await _audit(await _changed(state, HIDE_LAND_USE, DARK))
    state.basemap = "satellite"
    clients = fake_clients(core=map_core(state))
    assert await press_undo(audit, clients, run_id) == "changed_since"
    # Asked about: neither undone nor left under way.
    records = await audit.undo_records(run_id)
    assert not any("undone_at" in r or "undoing_at" in r for _, r in records)
    assert not undone(records)


# ---- the route -----------------------------------------------------------------------------


async def _mixed_answer(
    state: MapState, repo: Repository, project_id: UUID
) -> tuple[Core, str, UUID, UUID]:
    """An answer that edited a workflow, edited the districts' style, hid
    the land use, filtered the roads and switched the basemap: core, the
    style, the conversation and the run."""
    core = Core(project_id, recorder=map_core(state))
    core.add("wf-1", Stored(config("15 min"), revision=5))
    edited = await _styled(state, layer_project_id=31, operations=[RED])
    changed = await _changed(state, HIDE_LAND_USE, DARK)
    filtered = _filtered(state, 33, SHOPS)
    conversation_id, run_id, _ = await answer(
        repo,
        project_id,
        [
            workflow_edit(project_id, "wf-1", 4, 5, "10 min"),
            edited,
            changed,
            filtered,
        ],
    )
    return core, edited["style_id"], conversation_id, run_id


async def test_the_route_answers_the_map_beside_workflows_and_styles(
    api: Api, repo: Repository, make_project: ProjectFactory
) -> None:
    project_id = await make_project()
    state = MapState()
    before = state.snapshot()
    core, style_id, conversation_id, run_id = await _mixed_answer(
        state, repo, project_id
    )
    async with api(tools=fake_clients(core=core.recorder)) as client:
        response = await client.post(url(conversation_id, run_id), json={})
        assert response.status_code == 200, response.text
        assert response.json() == {
            "workflows": [
                {"workflow_id": "wf-1", "project_id": str(project_id), "revision": 6}
            ],
            "styles": [
                {
                    "project_id": MAP_PROJECT_ID,
                    "layer_project_id": 31,
                    "style_id": style_id,
                    "revision": 3,
                    "removed": False,
                }
            ],
            "map": {
                "project_id": MAP_PROJECT_ID,
                "layers": [33, 34],
                "tree": False,
                "groups": False,
                "basemap": True,
                "scene": False,
            },
            "not_restored": [],
        }
        assert (await stored_answer(client, conversation_id))["metadata"][
            "undone"
        ] is True
        again = await client.post(url(conversation_id, run_id), json={})
        assert again.status_code == 409
        assert again.json()["detail"]["code"] == "already_undone"
    assert core.workflows["wf-1"].config == config("10 min")
    assert (state.layers, state.basemap) == (before["layers"], before["basemap"])


async def test_changed_since_carries_the_map_and_what_went_back_of_it(
    api: Api, repo: Repository, make_project: ProjectFactory
) -> None:
    project_id = await make_project()
    state = MapState()
    before = state.snapshot()
    core, style_id, conversation_id, run_id = await _mixed_answer(
        state, repo, project_id
    )
    # A person changed the roads' filter and the basemap after the answer.
    state.layers[33]["query"] = CAFES
    state.basemap = "satellite"
    async with api(tools=fake_clients(core=core.recorder)) as client:
        asked = await client.post(url(conversation_id, run_id), json={})
        assert asked.status_code == 409, asked.text
        detail = asked.json()["detail"]
        assert detail["code"] == "changed_since"
        assert detail["workflows"] == [] and detail["styles"] == []
        assert detail["map"] == [
            {"object": "filter", "layer_project_id": 33},
            {"object": "basemap"},
        ]
        assert len(detail["undone"]) == 1 and len(detail["undone_styles"]) == 1
        assert detail["undone_map"] == {
            "project_id": MAP_PROJECT_ID,
            "layers": [34],
            "tree": False,
            "groups": False,
            "basemap": False,
            "scene": False,
        }
        assert detail["not_restored"] == []
        assert state.layers[34]["visible"] is True and state.basemap == "satellite"
        assert (
            "undone" not in (await stored_answer(client, conversation_id))["metadata"]
        )

        forced = await client.post(url(conversation_id, run_id), json={"force": True})
        assert forced.status_code == 200, forced.text
        # Only what was left of the map.
        assert forced.json() == {
            "workflows": [],
            "styles": [],
            "map": {
                "project_id": MAP_PROJECT_ID,
                "layers": [33],
                "tree": False,
                "groups": False,
                "basemap": True,
                "scene": False,
            },
            "not_restored": [],
        }
        assert (await stored_answer(client, conversation_id))["metadata"][
            "undone"
        ] is True
    assert (state.layers, state.basemap) == (before["layers"], before["basemap"])


async def test_the_route_goes_on_past_a_filter_core_refuses(
    api: Api, repo: Repository, make_project: ProjectFactory
) -> None:
    project_id = await make_project()
    state = MapState()
    changed = await _changed(state, HIDE_LAND_USE)
    filtered = _filtered(state, 33, SHOPS)
    conversation_id, run_id, _ = await answer(repo, project_id, [changed, filtered])
    async with api(tools=fake_clients(core=_refusing(state))) as client:
        response = await client.post(url(conversation_id, run_id), json={})
        assert response.status_code == 200, response.text
        assert response.json() == {
            "workflows": [],
            "styles": [],
            "map": {
                "project_id": MAP_PROJECT_ID,
                "layers": [34],
                "tree": False,
                "groups": False,
                "basemap": False,
                "scene": False,
            },
            "not_restored": ["map_refused"],
        }
        assert state.layers[34]["visible"] is True
        assert state.layers[33]["query"] == SHOPS
        assert (await stored_answer(client, conversation_id))["metadata"][
            "undone"
        ] is True
        again = await client.post(url(conversation_id, run_id), json={})
        assert again.status_code == 409, again.text
        assert again.json()["detail"]["code"] == "already_undone"


async def test_an_answer_that_only_removed_a_layer_has_nothing_to_undo(
    api: Api, repo: Repository, make_project: ProjectFactory
) -> None:
    """A removed layer does not come back: such an answer offers nothing to
    undo, says so, and never reads as undone."""
    project_id = await make_project()
    state = MapState()
    state.remove_layer(39)
    removed = _map(
        {"object": "layer_removed", "layer_project_id": 39, "name": "Old boundaries"}
    )
    conversation_id, run_id, _ = await answer(repo, project_id, [removed])
    core = map_core(state)
    async with api(tools=fake_clients(core=core)) as client:
        response = await client.post(url(conversation_id, run_id), json={})
        assert response.status_code == 404, response.text
        detail = response.json()["detail"]
        assert detail["code"] == "nothing_to_undo"
        assert detail["message"] == "Removed layers do not come back."
        metadata = (await stored_answer(client, conversation_id))["metadata"]
        assert metadata.get("undone") is not True
        # The dock offers no Undo for it either.
        assert "undoable" not in metadata
    assert _writes(core) == []
    assert not undone(await repo.undo_records(run_id))


# ---- the eval user's Undo ------------------------------------------------------------------


@pytest.fixture(scope="module")
def backends(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Backends]:
    path = tmp_path_factory.mktemp("eval-catalog-undo-map")
    write_eval_catalog(path)
    backends = Backends(path)
    yield backends
    backends.close()


async def test_the_eval_users_undo_brings_the_map_back(
    backends: Backends, settings: Any
) -> None:
    task = next(t for t in load_tasks("map") if t.id == "map-31")
    call = {
        "operations": [
            HIDE_LAND_USE,
            {"op": "set_basemap", "basemap_id": "light"},
        ]
    }
    model = ScriptedModel(calls=[("map_update", call)], answer="Done.")
    transcript = await run_task(task, model.model, backends, settings)
    assert transcript.error is None, transcript.error
    assert transcript.undo == "undone"
    before, after, back = (
        transcript.map_before,
        transcript.map_after,
        transcript.map_undone,
    )
    assert before is not None and after is not None and back is not None
    assert (before["basemap"], after["basemap"]) == ("dark", "light")
    assert before["layers"][34]["visible"] and not after["layers"][34]["visible"]
    assert back == before
    grades = await grade(task, transcript, backends)
    [graded] = [g for g in grades if g.check == "map"]
    assert graded.passed is True, graded.detail
