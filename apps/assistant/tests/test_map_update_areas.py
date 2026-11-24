"""map_update's filter operation sets and clears a layer's area: regions
from the catalog, features of another polygon layer of the project and the
map view, written as the web's filter panel writes them. Everything is read
and built before the first write; a refusal writes nothing. Core, geoapi and
processes are the eval stand-ins of the map project, the catalog a stand-in
of its region route."""

import asyncio
import copy
import hashlib
import json
import re
import threading
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
from goatlib.filter.areas import (
    REGION_SOURCE,
    add_feature,
    add_view,
    area_of,
    filter_fits,
    read_area,
)
from goatlib.filter.rows import Rows, read_rows, write_rows
from pydantic_ai.exceptions import ToolFailed

from assistant.context import parse_context
from assistant.maps import filter_rows
from assistant.maps.area_sources import (
    MAX_AREAS_PER_CALL,
    MAX_REGIONS_PER_CALL,
    NO_VIEW,
    OUTLINE_READS,
    name_column,
)
from assistant.maps.filter_area import MAX_REGIONS
from assistant.maps.operations import MapUpdateInput
from assistant.tools.catalog import FIND_REGION
from assistant.tools.map_edits import MAP_UPDATE, MapUpdated
from assistant.tools.project import GET_LAYERS
from assistant.tools.runtime import InputInvalid, ToolEnv, execute
from assistant.tools.testing import fake_clients, tool_env
from evals.backends import Backends, selected_features, write_eval_catalog
from evals.harness import ToolCall
from evals.map_backends import MapState, map_core
from evals.map_fixture import LAND_USE_QUERY, MAP_PROJECT_ID, map_layer
from evals.tasks import load_tasks
from tests.test_map_update import _graded_transcript, _passes
from tests.test_style_get import _geoapi, _processes, _Proxy
from tests.test_undo_map import _back, _restore

BASE = f"/api/v2/project/{MAP_PROJECT_ID}"
BOUNDS = [12.35, 51.32, 12.45, 51.38]
DISTRICTS = map_layer(31).layer_id


def _ring(west: float, south: float, east: float, north: float) -> list[list[float]]:
    return [[west, south], [east, south], [east, north], [west, north], [west, south]]


REGIONS: dict[str, dict[str, Any]] = {
    "DEZ01": {
        "type": "Feature",
        "properties": {"nuts_id": "DEZ01", "nuts_name": "Auental", "level": 3},
        "geometry": {"type": "Polygon", "coordinates": [_ring(12.3, 51.3, 12.4, 51.4)]},
    },
    "DEZ02": {
        "type": "Feature",
        "properties": {"nuts_id": "DEZ02", "nuts_name": "Bergfeld", "level": 3},
        "geometry": {
            "type": "MultiPolygon",
            "coordinates": [
                [_ring(12.4, 51.3, 12.45, 51.35)],
                [_ring(12.46, 51.3, 12.5, 51.35)],
            ],
        },
    },
}


def _catalog(regions: dict[str, dict[str, Any]] | None = None) -> _Proxy:
    """The catalog's region outline route: a known region's Feature, 404
    for any other id."""
    known = REGIONS if regions is None else regions

    def handler(request: httpx.Request) -> httpx.Response:
        found = re.fullmatch(r"/stac/nuts/([^/]+)/geometry", request.url.path)
        if found is None:
            return httpx.Response(599, json={"detail": "unexpected"})
        region = known.get(found.group(1))
        if region is None:
            return httpx.Response(404, json={"detail": "NUTS region not found"})
        return httpx.Response(200, json=region)

    return _Proxy(handler)


class _Services:
    def __init__(
        self,
        state: MapState,
        *,
        core: Any = None,
        geoapi: Any = None,
        catalog: Any = None,
        bbox: list[float] | None = BOUNDS,
    ) -> None:
        self.state = state
        self.core = core if core is not None else map_core(state)
        self.geoapi = geoapi if geoapi is not None else _geoapi()
        self.catalog = catalog if catalog is not None else _catalog()
        page: dict[str, Any] = {"surface": "project.map", "project_id": MAP_PROJECT_ID}
        if bbox is not None:
            page["viewport"] = {"center": [12.4, 51.35], "zoom": 12, "bbox": bbox}
        self.env: ToolEnv = tool_env(
            fake_clients(
                core=self.core,
                geoapi=self.geoapi,
                processes=_processes(),
                catalog=self.catalog,
            ),
            page=parse_context(page),
        )

    def writes(self) -> list[tuple[str, str, Any]]:
        return [
            (
                request.method,
                request.url.path[len(BASE) :],
                json.loads(request.content) if request.content else None,
            )
            for request in self.core.requests
            if request.method != "GET"
        ]

    def items(self) -> list[httpx.QueryParams]:
        return [
            request.url.params
            for request in self.geoapi.requests
            if request.url.path.endswith("/items")
        ]


async def _run(services: _Services, *operations: dict[str, Any]) -> MapUpdated:
    result = await MAP_UPDATE.run(
        services.env, MapUpdateInput.model_validate({"operations": list(operations)})
    )
    assert isinstance(result, MapUpdated)
    return result


def _area(link: int, **area: Any) -> dict[str, Any]:
    return {"op": "filter", "layer_project_id": link, "area": area}


def _expected(pieces: Any, rows: Rows | None = None, *, outside: bool = False) -> Any:
    cql, notes = area_of(pieces, outside=outside)
    base = rows or Rows(match="all", rows=())
    return write_rows(
        Rows(match=base.match, rows=base.rows, area=cql, area_notes=notes)
    )


# ---- regions ---------------------------------------------------------------------


async def test_a_region_is_written_as_the_panel_writes_it_and_said_in_words() -> None:
    state = MapState()
    services = _Services(state)
    result = await _run(services, _area(32, regions=["DEZ01"]))
    region = REGIONS["DEZ01"]
    added = add_feature(
        (),
        REGION_SOURCE,
        "DEZ01",
        region["geometry"],
        name="Auental",
        fits=filter_fits(),
    )
    assert added is not None
    expected = _expected(added.pieces)
    assert state.layers[32]["query"] == expected
    assert services.writes() == [("PUT", "/layer/32", {"query": expected})]
    [applied] = result.applied
    assert applied.summary == (
        "'Points of interest': the filter has no rows now. Area: regions: "
        '"Auental" (DEZ01).'
    )
    # The points of interest the region's simplified outline holds.
    inside = selected_features(map_layer(32), expected["cql"])
    assert applied.count_before == len(map_layer(32).features)
    assert applied.count_after == len(inside) and 0 < len(inside) < 900
    assert services.catalog.paths() == ["/stac/nuts/DEZ01/geometry"]
    dumped = json.dumps(result.model_dump(mode="json"))
    assert "12.3" not in dumped and "s_intersects" not in dumped
    # The layer list says the same.
    layers = await execute(GET_LAYERS, services.env, {})
    [row] = [layer for layer in layers["layers"] if layer["layer_project_id"] == 32]
    assert row["filter"] == {
        "match": "all",
        "rows": [],
        "area": 'regions: "Auental" (DEZ01)',
    }


async def test_two_regions_are_read_side_by_side_and_make_one_piece() -> None:
    state = MapState()
    services = _Services(state)
    await _run(services, _area(32, regions=["DEZ01", "DEZ02", "DEZ01"]))
    rows = read_rows(state.layers[32]["query"], {})
    area = read_area(rows.area, rows.area_notes)
    assert area is not None
    [piece] = area.pieces
    assert [(f.id, f.n) for f in piece.features] == [("DEZ01", 1), ("DEZ02", 2)]  # type: ignore[union-attr]
    assert sorted(services.catalog.paths()) == [
        "/stac/nuts/DEZ01/geometry",
        "/stac/nuts/DEZ02/geometry",
    ]


async def test_an_unknown_region_is_refused_with_the_lookup_hint_and_nothing_written() -> (
    None
):
    state = MapState()
    before = state.snapshot()
    services = _Services(state)
    hide = {"op": "set_layer", "layer_project_id": 33, "visible": False}
    with pytest.raises(InputInvalid) as raised:
        await _run(services, hide, _area(32, regions=["DEZ01", "DEZ99"]))
    assert raised.value.message == (
        "operations[1] (filter): Area: There is no region 'DEZ99'. "
        "Look the region's id up with catalog_find_region."
    )
    assert services.writes() == [] and state.snapshot() == before


async def test_a_region_read_that_fails_refuses_the_call() -> None:
    state = MapState()
    before = state.snapshot()
    down = _Proxy(lambda request: httpx.Response(503, json={"detail": "down"}))
    services = _Services(state, catalog=down)
    with pytest.raises(ToolFailed) as raised:
        await _run(services, _area(32, regions=["DEZ01"]))
    assert (
        "operations[0] (filter): Area: The region outlines could not be loaded"
        in raised.value.message
    )
    assert services.writes() == [] and state.snapshot() == before


async def test_a_detailed_region_is_simplified_and_the_result_says_so() -> None:
    import math

    ring = []
    for i in range(4999):
        angle = 2 * math.pi * i / 4999
        radius = 0.05 + 0.004 * math.sin(37 * angle)
        ring.append(
            [
                round(12.4 + radius * math.cos(angle), 7),
                round(51.35 + radius * math.sin(angle), 7),
            ]
        )
    ring.append(ring[0])
    detailed = {
        "type": "Feature",
        "properties": {"nuts_id": "DEZ03", "nuts_name": "Seenland"},
        "geometry": {"type": "Polygon", "coordinates": [ring]},
    }
    state = MapState()
    services = _Services(state, catalog=_catalog({"DEZ03": detailed}))
    calls: list[int] = []
    build = filter_rows.build_area

    def recorded(*args: Any, **kwargs: Any) -> Any:
        calls.append(threading.get_ident())
        return build(*args, **kwargs)

    filter_rows.build_area = recorded  # type: ignore[assignment]
    try:
        result = await _run(services, _area(32, regions=["DEZ03"]))
    finally:
        filter_rows.build_area = build  # type: ignore[assignment]
    # Built off the event loop.
    assert calls and calls[0] != threading.get_ident()
    [applied] = result.applied
    assert applied.summary.endswith(" m.")
    assert (
        'The outline of the region "Seenland" was simplified to fit the filter\'s '
        "size limit; it moved by up to "
    ) in applied.summary
    rows = read_rows(state.layers[32]["query"], {})
    assert sum(len(r) for r in rows.area["args"][1]["coordinates"]) <= 2000


# ---- features of another layer ------------------------------------------------------


NAMED = {
    "conditions": [{"field": "name", "op": "in", "value": ["District 4", "District 9"]}]
}


def _many_regions(count: int) -> dict[str, dict[str, Any]]:
    return {
        f"DEZ{n:02d}": {
            "type": "Feature",
            "properties": {"nuts_id": f"DEZ{n:02d}", "nuts_name": f"R{n}", "level": 3},
            "geometry": {
                "type": "Polygon",
                "coordinates": [
                    _ring(12.3 + n * 0.001, 51.3, 12.3005 + n * 0.001, 51.31)
                ],
            },
        }
        for n in range(count)
    }


async def test_one_call_reads_a_bounded_number_of_outlines() -> None:
    """Too many areas or regions in one call are refused before any outline
    is read."""
    state = MapState()
    services = _Services(state)
    many = [_area(40, view=True) for _ in range(MAX_AREAS_PER_CALL + 1)]
    with pytest.raises(InputInvalid, match=f"at most {MAX_AREAS_PER_CALL}"):
        await _run(services, *many)
    ids = sorted(_many_regions(MAX_REGIONS))
    wide = [_area(link, regions=ids) for link in (40, 34, 33)]
    with pytest.raises(InputInvalid, match=f"at most {MAX_REGIONS_PER_CALL} regions"):
        await _run(services, *wide)
    assert services.catalog.requests == [] and services.writes() == []


async def test_outlines_are_read_a_few_at_a_time() -> None:
    regions = _many_regions(MAX_REGIONS)
    running = {"now": 0, "most": 0}

    async def handler(request: httpx.Request) -> httpx.Response:
        running["now"] += 1
        running["most"] = max(running["most"], running["now"])
        await asyncio.sleep(0.001)
        running["now"] -= 1
        found = re.fullmatch(r"/stac/nuts/([^/]+)/geometry", request.url.path)
        assert found is not None
        return httpx.Response(200, json=regions[found.group(1)])

    state = MapState()
    services = _Services(state, catalog=httpx.MockTransport(handler))
    await _run(services, _area(40, regions=sorted(regions)))
    assert 1 < running["most"] <= OUTLINE_READS


async def test_features_of_a_layer_an_earlier_operation_filters_is_refused() -> None:
    """The outlines are read as the source layer's saved filter keeps them,
    before the call writes: one its own earlier operation changes is refused,
    with nothing written."""
    state = MapState()
    services = _Services(state)
    district = {"field": "name", "op": "=", "value": "District 4"}
    with pytest.raises(InputInvalid) as raised:
        await _run(
            services,
            {
                "op": "filter",
                "layer_project_id": 31,
                "rows": [{"do": "add", "conditions": [district]}],
            },
            _area(40, features_of={"layer_project_id": 31}),
        )
    assert "operations[1] (filter): Area:" in raised.value.message
    assert "new call" in raised.value.message
    assert services.writes() == []


async def test_features_of_another_layer_are_named_by_its_name_column() -> None:
    state = MapState()
    services = _Services(state)
    result = await _run(
        services, _area(40, features_of={"layer_project_id": 31, "filter": NAMED})
    )
    rows = read_rows(state.layers[40]["query"], {})
    area = read_area(rows.area, rows.area_notes)
    assert area is not None
    [piece] = area.pieces
    assert piece.source == DISTRICTS  # type: ignore[union-attr]
    names = {f.name for f in piece.features}  # type: ignore[union-attr]
    assert names == {"District 4", "District 9"}
    # The count, then the features, with the layer's name column only.
    counted, fetched = services.items()
    assert counted["limit"] == "1" and fetched["limit"] == "201"
    assert fetched["properties"] == "name"
    assert json.loads(fetched["filter"]) == {
        "op": "in",
        "args": [{"property": "name"}, ["District 4", "District 9"]],
    }
    [applied] = result.applied
    assert applied.summary.endswith('Area: features of layer "Districts" (31): 2.')
    assert DISTRICTS not in json.dumps(result.model_dump(mode="json"))
    layers = await execute(GET_LAYERS, services.env, {})
    [row] = [layer for layer in layers["layers"] if layer["layer_project_id"] == 40]
    assert row["filter"]["area"] == 'features of layer "Districts" (31): 2'
    assert DISTRICTS not in json.dumps(layers)
    # The stored query is the panel's for the same pieces.
    features = [
        f
        for f in json.loads(
            _geoapi()(
                httpx.Request(
                    "GET",
                    f"http://geoapi/collections/{DISTRICTS}/items",
                    params={
                        "limit": 201,
                        "properties": "name",
                        "filter": fetched["filter"],
                    },
                )
            ).content
        )["features"]
    ]
    pieces: Any = ()
    for feature in features:
        added = add_feature(
            pieces,
            DISTRICTS,
            str(feature["id"]),
            feature["geometry"],
            name=feature["properties"]["name"],
            fits=filter_fits(),
        )
        assert added is not None
        pieces = added.pieces
    assert state.layers[40]["query"] == _expected(pieces)


async def test_the_other_layers_saved_filter_limits_its_features_as_on_the_map() -> (
    None
):
    state = MapState()
    saved = {"op": ">", "args": [{"property": "density"}, 3000]}
    state.layers[31]["query"] = {"cql": saved}
    services = _Services(state)
    await _run(
        services, _area(40, features_of={"layer_project_id": 31, "filter": NAMED})
    )
    _, fetched = services.items()
    assert json.loads(fetched["filter"]) == {
        "op": "and",
        "args": [
            saved,
            {"op": "in", "args": [{"property": "name"}, ["District 4", "District 9"]]},
        ],
    }


@pytest.mark.parametrize(
    ("link", "error", "words"),
    [
        (32, InputInvalid, "'Points of interest' is not a polygon layer"),
        (
            36,
            InputInvalid,
            "800 features of 'Buildings' match, and an area takes at most 200. Narrow features_of.filter.",
        ),
        (99, InputInvalid, "There is no layer 99 in this project."),
        (34, InputInvalid, "features_of names the layer being filtered"),
        (37, InputInvalid, "'Elevation' is not a polygon layer"),
    ],
)
async def test_another_layer_the_panel_does_not_offer_is_refused(
    link: int, error: type[Exception], words: str
) -> None:
    state = MapState()
    before = state.snapshot()
    services = _Services(state)
    with pytest.raises(error) as raised:
        await _run(services, _area(34, features_of={"layer_project_id": link}))
    assert words in str(raised.value)
    assert str(raised.value).startswith("operations[0] (filter): Area: ")
    assert services.writes() == [] and state.snapshot() == before
    # More features than an area takes are refused before they are fetched.
    assert all(params["limit"] == "1" for params in services.items())


async def test_the_same_dataset_and_a_locked_layer_are_refused() -> None:
    state = MapState()
    base = map_core(state)

    def handler(request: httpx.Request) -> httpx.Response:
        response = base.answer(request)
        assert response is not None
        if request.method == "GET" and request.url.path == f"{BASE}/layer":
            rows = response.json()
            for row in rows:
                if row["id"] == 39:
                    row["locked"] = True
                if row["id"] == 36:
                    # Buildings holds the Districts' data a second time.
                    row["layer_id"] = DISTRICTS
            return httpx.Response(200, json=rows)
        return response

    services = _Services(state, core=_Proxy(handler))
    with pytest.raises(
        InputInvalid, match="holds the same data as the layer being filtered"
    ):
        await _run(services, _area(31, features_of={"layer_project_id": 36}))
    with pytest.raises(
        ToolFailed,
        match="'Old boundaries' is in the project, but the user has no access",
    ):
        await _run(services, _area(34, features_of={"layer_project_id": 39}))
    assert services.writes() == []


async def test_a_filter_on_the_other_layer_is_checked_against_its_fields() -> None:
    state = MapState()
    services = _Services(state)
    with pytest.raises(InputInvalid) as raised:
        await _run(
            services,
            _area(
                40,
                features_of={
                    "layer_project_id": 31,
                    "filter": {
                        "conditions": [{"field": "colour", "op": "=", "value": "red"}]
                    },
                },
            ),
        )
    assert "features_of.filter on 'Districts':" in raised.value.message
    assert "colour" in raised.value.message
    assert services.writes() == [] and services.items() == []


async def test_a_name_column_is_the_panels_likeliest_one() -> None:
    queryables = {
        "properties": {
            "id": {"type": "string"},
            "code": {"type": "string"},
            "updated": {"type": "string", "format": "date-time"},
            "street_label": {"type": "string"},
            "district_name": {"type": "string"},
            "population": {"type": "integer"},
        }
    }
    assert name_column(queryables) == "district_name"
    assert name_column({"properties": {"population": {"type": "integer"}}}) is None


# ---- the view, and the layer filtered -----------------------------------------------


async def test_the_view_is_the_pages_and_refused_without_it() -> None:
    state = MapState()
    services = _Services(state)
    await _run(services, _area(36, view=True))
    added = add_view((), BOUNDS, fits=filter_fits())
    assert added is not None
    assert state.layers[36]["query"] == _expected(added.pieces)
    before = state.snapshot()
    blind = _Services(state, bbox=None)
    with pytest.raises(ToolFailed) as raised:
        await _run(blind, _area(35, view=True))
    assert raised.value.message == f"operations[0] (filter): Area: {NO_VIEW}"
    assert blind.writes() == [] and state.snapshot() == before


async def test_a_raster_has_no_area() -> None:
    services = _Services(MapState())
    with pytest.raises(ToolFailed, match="raster layer"):
        await _run(services, _area(37, view=True))


async def test_add_keeps_the_drawn_shape_and_clearing_the_area_keeps_the_rows() -> None:
    state = MapState()
    services = _Services(state)
    result = await _run(services, _area(34, regions=["DEZ01"], add=True))
    summary = result.applied[0].summary
    assert 'Area: a drawn shape "Study area"; regions: "Auental" (DEZ01).' in summary
    rows = read_rows(state.layers[34]["query"], {})
    stored = read_rows(LAND_USE_QUERY, {})
    assert rows.rows == stored.rows
    cleared = await _run(
        services,
        {"op": "filter", "layer_project_id": 34, "area": "clear"},
    )
    after = read_rows(state.layers[34]["query"], {})
    assert after.area is None and after.rows == stored.rows
    assert "Area:" not in cleared.applied[0].summary


async def test_a_switched_off_area_stays_off_with_add() -> None:
    state = MapState()
    drawn = LAND_USE_QUERY["cql"]["args"][0]
    off = {"ui": {"v": 1, "area": {**LAND_USE_QUERY["ui"]["area"], "off": drawn}}}
    state.layers[36]["query"] = copy.deepcopy(off)
    services = _Services(state)
    layers = await execute(GET_LAYERS, services.env, {})
    [row] = [layer for layer in layers["layers"] if layer["layer_project_id"] == 36]
    assert row["filter"]["area"] == 'switched off: a drawn shape "Study area"'
    result = await _run(services, _area(36, view=True, add=True))
    rows = read_rows(state.layers[36]["query"], {})
    assert rows.area_notes["off"] == rows.area
    area = read_area(rows.area, rows.area_notes, enabled=False)
    assert area is not None and len(area.pieces) == 2
    assert "Area: switched off: " in result.applied[0].summary


async def test_core_refusing_the_area_answers_a_sentence_or_a_failed_step() -> None:
    """Core checks a saved filter again; a refusal of the area is the call's
    error as the first write, and a failed step after a landed write."""
    state = MapState()
    before = state.snapshot()
    base = map_core(state)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "PUT" and request.url.path == f"{BASE}/layer/32":
            return httpx.Response(
                422, json={"detail": "Invalid CQL query: The area crosses itself."}
            )
        response = base.answer(request)
        assert response is not None
        return response

    services = _Services(state, core=_Proxy(handler))
    with pytest.raises(ToolFailed) as raised:
        await _run(services, _area(32, regions=["DEZ01"]))
    assert raised.value.message == (
        "operations[0] (filter): The filter was not saved: Invalid CQL query: "
        "The area crosses itself."
    )
    assert state.snapshot() == before
    hide = {"op": "set_layer", "layer_project_id": 33, "visible": False}
    result = await _run(services, hide, _area(32, regions=["DEZ01"]))
    assert [a.op for a in result.applied] == ["set_layer"]
    assert result.failed is not None
    assert result.failed.reason.startswith("The filter was not saved:")
    assert result.undo() is not None


# ---- Undo ----------------------------------------------------------------------------


async def test_undo_puts_back_an_area_a_changed_area_and_a_cleared_area() -> None:
    state = MapState()
    before = state.snapshot()
    services = _Services(state)
    # An area where there was no filter, an area in place of the drawn one,
    # and then that area cleared.
    first = await _run(services, _area(32, regions=["DEZ01"]))
    changed = await _run(
        services, _area(34, features_of={"layer_project_id": 31, "filter": NAMED})
    )
    after_change = copy.deepcopy(state.layers[34]["query"])
    cleared = await _run(
        services,
        {"op": "filter", "layer_project_id": 34, "area": "clear"},
    )
    records = [json.loads(json.dumps(r.undo())) for r in (first, changed, cleared)]
    assert await _restore(state, records[2]) == (_back(layers=[34]), [])
    assert json.dumps(state.layers[34]["query"]) == json.dumps(after_change)
    assert await _restore(state, records[1]) == (_back(layers=[34]), [])
    assert json.dumps(state.layers[34]["query"]) == json.dumps(
        before["layers"][34]["query"]
    )
    assert await _restore(state, records[0]) == (_back(layers=[32]), [])
    assert state.layers[32]["query"] is None
    assert state.snapshot() == before


async def test_a_table_has_no_area() -> None:
    state = MapState()
    base = map_core(state)

    def handler(request: httpx.Request) -> httpx.Response:
        response = base.answer(request)
        assert response is not None
        if request.method == "GET" and request.url.path == f"{BASE}/layer":
            rows = response.json()
            for row in rows:
                if row["id"] == 35:
                    row["type"] = "table"
            return httpx.Response(200, json=rows)
        return response

    services = _Services(state, core=_Proxy(handler))
    with pytest.raises(ToolFailed) as raised:
        await _run(services, _area(35, view=True))
    assert raised.value.message == (
        "operations[0] (filter): 'Polling stations' is a table, which has no "
        "geometry an area could hold."
    )
    assert services.writes() == []


# ---- the eval tasks, met by the tool ---------------------------------------------------


@pytest.fixture(scope="module")
def map_backends(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Backends]:
    path = tmp_path_factory.mktemp("eval-catalog-area-tasks")
    write_eval_catalog(path)
    backends = Backends(path)
    yield backends
    backends.close()


AREA_TASKS = {
    "map-38": _area(32, regions=["DEZ01"]),
    "map-39": _area(
        40,
        features_of={
            "layer_project_id": 31,
            "filter": {
                "conditions": [
                    {"field": "name", "op": "in", "value": ["District 4", "District 9"]}
                ]
            },
        },
    ),
    "map-40": _area(36, view=True),
    "map-41": {"op": "filter", "layer_project_id": 34, "area": "clear"},
}


@pytest.mark.parametrize("task_id", sorted(AREA_TASKS))
async def test_the_area_tasks_are_met_by_the_tool(
    task_id: str, map_backends: Backends
) -> None:
    task = next(t for t in load_tasks("map") if t.id == task_id)
    state = MapState()
    services, _, _ = map_backends.clients(maps={MAP_PROJECT_ID: state})
    try:
        env = tool_env(services, page=parse_context(task.context))
        before = state.snapshot()
        calls = []
        if task_id == "map-38":
            found = await execute(FIND_REGION, env, {"name": "Auental"})
            calls.append(
                ToolCall("catalog_find_region", {"name": "Auental"}, found, False)
            )
        args = {"operations": [AREA_TASKS[task_id]]}
        result = await execute(MAP_UPDATE, env, args)
        calls.append(ToolCall("map_update", args, result, False))
        transcript = _graded_transcript(
            task_id, calls, before, state.snapshot(), "Done: the map shows it now."
        )
        await _passes(task_id, transcript, map_backends)
    finally:
        await services.aclose()


async def test_a_feature_added_later_keeps_its_own_id() -> None:
    """A feature's id is the same with any filter, so a district added to the
    area later is a second feature, not the first one again."""
    state = MapState()
    services = _Services(state)

    def one(name: str) -> dict[str, Any]:
        return {"conditions": [{"field": "name", "op": "=", "value": name}]}

    await _run(
        services,
        _area(40, features_of={"layer_project_id": 31, "filter": one("District 4")}),
    )
    await _run(
        services,
        _area(
            40,
            features_of={"layer_project_id": 31, "filter": one("District 9")},
            add=True,
        ),
    )
    rows = read_rows(state.layers[40]["query"], {})
    area = read_area(rows.area, rows.area_notes)
    assert area is not None
    [piece] = area.pieces
    assert [(f.id, f.name) for f in piece.features] == [  # type: ignore[union-attr]
        ("4", "District 4"),
        ("9", "District 9"),
    ]


async def test_a_joined_field_named_without_its_prefix_is_read_with_it() -> None:
    """As the project tools read a field: a name the layer lacks is read as
    its join_ field when the layer has that."""
    state = MapState()
    districts = map_layer(31)
    geoapi = _geoapi()
    queryables = copy.deepcopy(
        geoapi.routes[("GET", f"/collections/{DISTRICTS}/queryables")]
    )
    queryables["properties"]["join_name"] = queryables["properties"].pop("name")
    geoapi.routes[("GET", f"/collections/{DISTRICTS}/queryables")] = queryables
    services = _Services(state, geoapi=geoapi)
    with pytest.raises(InputInvalid):
        # The stand-in's features carry no join_name, so nothing matches; the
        # filter was read with the prefix.
        await _run(
            services, _area(40, features_of={"layer_project_id": 31, "filter": NAMED})
        )
    [counted] = services.items()
    assert json.loads(counted["filter"])["args"][0] == {"property": "join_name"}
    assert districts.layer_id == DISTRICTS


@pytest.mark.parametrize(
    ("status", "words"),
    [
        (403, "'Districts' is in the project, but the user has no access to its data."),
        (503, "The features of 'Districts' could not be read right now"),
    ],
)
async def test_a_failed_feature_read_refuses_the_call(status: int, words: str) -> None:
    state = MapState()
    before = state.snapshot()
    base = _geoapi()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/items"):
            return httpx.Response(status, json={"detail": "no"})
        return base(request)

    services = _Services(state, geoapi=_Proxy(handler))
    with pytest.raises(ToolFailed) as raised:
        await _run(services, _area(40, features_of={"layer_project_id": 31}))
    assert raised.value.message.startswith(f"operations[0] (filter): Area: {words}")
    assert services.writes() == [] and state.snapshot() == before


async def test_outlines_that_cannot_share_the_room_write_nothing() -> None:
    """Fifty regions of eleven small polygons each need more points than an
    area takes, even at four positions per ring: refused before any write."""
    islands = {
        "type": "MultiPolygon",
        "coordinates": [
            [_ring(12.0 + 0.01 * k, 51.0, 12.005 + 0.01 * k, 51.005)] for k in range(11)
        ],
    }
    ids = [f"DE{n:03d}" for n in range(50)]
    catalog = _catalog(
        {
            region_id: {
                "type": "Feature",
                "properties": {"nuts_name": region_id},
                "geometry": islands,
            }
            for region_id in ids
        }
    )
    state = MapState()
    before = state.snapshot()
    services = _Services(state, catalog=catalog)
    hide = {"op": "set_layer", "layer_project_id": 33, "visible": False}
    with pytest.raises(InputInvalid) as raised:
        await _run(services, hide, _area(32, regions=ids))
    assert raised.value.message == (
        "operations[1] (filter): Area: The 50 outlines asked for do "
        "not fit the filter's size limit together, also not each simplified to "
        "an equal share of it. Ask for fewer of them, or for larger units (a "
        "region one level up)."
    )
    assert services.writes() == [] and state.snapshot() == before


# ---- the call's shape: area beside rows -------------------------------------------

_PARK = {"field": "use", "op": "=", "value": "park"}
_OFF_36 = {
    "ui": {
        "v": 1,
        "area": {
            **LAND_USE_QUERY["ui"]["area"],
            "off": LAND_USE_QUERY["cql"]["args"][0],
        },
    }
}

#: Calls in the area-beside-rows shape: (layer, the layer's stored query at
#: the start (None: the eval fixture's), the filter operation's fields).
SHAPE_CASES: dict[str, tuple[int, Any, dict[str, Any]]] = {
    "region": (32, None, {"area": {"regions": ["DEZ01"]}}),
    "two_regions": (32, None, {"area": {"regions": ["DEZ01", "DEZ02"]}}),
    "features": (
        34,
        None,
        {"area": {"features_of": {"layer_project_id": 31, "filter": NAMED}}},
    ),
    "view": (36, None, {"area": {"view": True}}),
    "together": (
        40,
        None,
        {
            "area": {
                "regions": ["DEZ01"],
                "features_of": {"layer_project_id": 31, "filter": NAMED},
                "view": True,
            }
        },
    ),
    "add": (34, None, {"area": {"regions": ["DEZ01"], "add": True}}),
    "outside": (32, None, {"area": {"regions": ["DEZ01"], "outside": True}}),
    "replaces_off": (36, _OFF_36, {"area": {"view": True}}),
    "adds_to_off": (36, _OFF_36, {"area": {"view": True, "add": True}}),
    "clear": (34, None, {"area": "clear"}),
    "clear_off": (36, _OFF_36, {"area": "clear"}),
    "rows_and_area": (
        34,
        None,
        {
            "rows": [{"do": "add", "conditions": [_PARK]}],
            "area": {"regions": ["DEZ01"]},
        },
    ),
    "rows_cleared_and_area_cleared": (
        34,
        None,
        {"rows": [{"do": "clear"}], "area": "clear"},
    ),
}


def _digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value).encode()).hexdigest()[:24]


async def _shape_case(
    name: str, operation: dict[str, Any]
) -> tuple[str, list[str], str]:
    """The stored query's digest, the summaries and the undo record's digest
    of one case, the filter operation given whole."""
    link, start, _ = SHAPE_CASES[name]
    state = MapState()
    if start is not None:
        state.layers[link]["query"] = copy.deepcopy(start)
    services = _Services(state)
    result = await _run(services, operation)
    return (
        _digest(state.layers[link]["query"]),
        [applied.summary for applied in result.applied],
        _digest(result.undo()),
    )


#: The bytes each case stores, says and records for undo: the stored query
#: and the undo record as sha256 prefixes of their JSON, the summaries whole.
SHAPE_PINNED: dict[str, tuple[str, list[str], str]] = {
    "add": (
        "cefcc15d918bd88ae0baccbd",
        [
            '\'Land use\': the filter\'s rows are now 1. area_m2 is greater than 5000; 2. use is "industrial" (switched off); 3. custom (a feature passes every switched-on row). Area: a drawn shape "Study area"; regions: "Auental" (DEZ01).'
        ],
        "a589d871e4a7617c53eba33b",
    ),
    "adds_to_off": (
        "faf5b6e5adb3749720617e3d",
        [
            "'Buildings': the filter has no rows now. Area: switched off: a drawn shape \"Study area\"; the map view."
        ],
        "6bee7cdbed14983edf2a7457",
    ),
    "clear": (
        "285f7eb0fcb4da1e8e7125ad",
        [
            "'Land use': the filter's rows are now 1. area_m2 is greater than 5000; 2. use is \"industrial\" (switched off); 3. custom (a feature passes every switched-on row)."
        ],
        "9b0446bfe50197ccc9dcf4cc",
    ),
    "clear_off": (
        "74234e98afe7498fb5daf1f3",
        ["'Buildings' has no filter now: every feature is shown."],
        "0a2312d1a412a41646f0563f",
    ),
    "features": (
        "6b53c34234edb5e5f6dce2e4",
        [
            '\'Land use\': the filter\'s rows are now 1. area_m2 is greater than 5000; 2. use is "industrial" (switched off); 3. custom (a feature passes every switched-on row). Area: features of layer "Districts" (31): 2.'
        ],
        "f5cd95d5551fbf081f237d09",
    ),
    "outside": (
        "515df3d32852cf43974d2f07",
        [
            "'Points of interest': the filter has no rows now. Area: outside: regions: \"Auental\" (DEZ01)."
        ],
        "53169c4fcd1297ffe0702760",
    ),
    "region": (
        "a84e1d38e29d902636a897a5",
        [
            "'Points of interest': the filter has no rows now. Area: regions: \"Auental\" (DEZ01)."
        ],
        "f649faf6d34e4250263de9f1",
    ),
    "replaces_off": (
        "b443b1f06c0a63b9ea57da18",
        [
            "'Buildings': the filter has no rows now. Area: the map view. The area the filter had was switched off in the Filter tab; the new area replaces it and is switched on."
        ],
        "64e8b064b4e008ba5c4a443e",
    ),
    "rows_and_area": (
        "6e3ceaffa322f04ac435ebdf",
        [
            '\'Land use\': the filter\'s rows are now 1. area_m2 is greater than 5000; 2. use is "industrial" (switched off); 3. custom; 4. use is "park" (a feature passes every switched-on row). Area: regions: "Auental" (DEZ01).'
        ],
        "3f13a752a2536a472c979cdd",
    ),
    "rows_cleared_and_area_cleared": (
        "74234e98afe7498fb5daf1f3",
        ["'Land use' has no filter now: every feature is shown."],
        "f4531623fdf66e43ff460fad",
    ),
    "together": (
        "dab3d5ce4ae95a68dc78da00",
        [
            '\'Stations\': the filter has no rows now. Area: regions: "Auental" (DEZ01); features of layer "Districts" (31): 2; the map view.'
        ],
        "d0fac512c9ba062fb5a673f1",
    ),
    "two_regions": (
        "ba18c8c27b67b7c56a9686d9",
        [
            '\'Points of interest\': the filter has no rows now. Area: regions: "Auental" (DEZ01), "Bergfeld" (DEZ02).'
        ],
        "9dd4798d17d1a8bcb818fa6a",
    ),
    "view": (
        "b443b1f06c0a63b9ea57da18",
        ["'Buildings': the filter has no rows now. Area: the map view."],
        "b6347fd7a203520fccdcee02",
    ),
}


@pytest.mark.parametrize("name", sorted(SHAPE_CASES))
async def test_an_area_beside_the_rows_stores_says_and_records_the_pinned_bytes(
    name: str,
) -> None:
    link, _, fields = SHAPE_CASES[name]
    operation = {"op": "filter", "layer_project_id": link, **fields}
    assert await _shape_case(name, operation) == SHAPE_PINNED[name]
