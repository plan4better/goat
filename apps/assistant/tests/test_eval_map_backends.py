"""The eval stand-ins for styles and the map: a style save runs core's own
steps with goatlib's check over the fixture's feature tables, and the map
routes keep their state where the graders read it."""

import copy
import json
from collections import Counter
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from goatlib.analysis.schemas.statistics import ClassBreakMethod
from goatlib.filter.convert import _row_of, convert_query
from goatlib.filter.validate import validate as validate_filter
from goatlib.style.context import DataContext
from goatlib.style.validate import validate

from evals.backends import (
    BREAK_METHODS,
    Backends,
    _process,
    matches,
    selected_features,
    write_eval_catalog,
)
from evals.map_backends import MapState, map_core
from evals.map_fixture import (
    MAP_LAYERS,
    MAP_PROJECT_ID,
    MAP_PROJECT_NAME,
    MAP_REPORT_LAYOUT,
    MAP_VIEW_PROJECT_ID,
    MAP_WORKFLOW,
    area_sum,
    map_layer,
)

BASE = f"/api/v2/project/{MAP_PROJECT_ID}"
VIEW_BASE = f"/api/v2/project/{MAP_VIEW_PROJECT_ID}"


def _call(
    core: Any,
    method: str,
    path: str,
    body: Any = None,
    params: dict[str, Any] | None = None,
) -> httpx.Response:
    request = httpx.Request(
        method,
        f"http://core{path}",
        params=params,
        content=json.dumps(body).encode() if body is not None else None,
        headers={"content-type": "application/json"} if body is not None else None,
    )
    response: httpx.Response = core(request)
    return response


def _style_path(layer_project_id: int, style_id: str = "") -> str:
    path = f"{BASE}/layer/{layer_project_id}/style"
    return f"{path}/{style_id}" if style_id else path


def _active(state: MapState, layer_project_id: int) -> tuple[str, dict[str, Any]]:
    style_id = state.active_style_id(layer_project_id)
    return style_id, copy.deepcopy(state.styles[style_id].document)


def _save(
    core: Any,
    layer_project_id: int,
    style_id: str,
    base_rev: int,
    document: dict[str, Any],
) -> httpx.Response:
    return _call(
        core,
        "PUT",
        _style_path(layer_project_id, style_id),
        {"base_rev": base_rev, "document": document},
    )


def _errors(issues: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [i for i in issues if i["level"] in ("error", "damaged")]


# ---- the fixture ---------------------------------------------------------------


def test_the_layers_are_shaped_on_purpose() -> None:
    counts = {
        layer.layer_project_id: len(layer.features)
        for layer in MAP_LAYERS
        if layer.layer_type == "feature"
    }
    assert counts == {
        31: 60,
        32: 900,
        33: 45,
        34: 300,
        35: 120,
        36: 800,
        39: 12,
        40: 70,
        41: 200,
    }
    assert {
        layer.layer_project_id for layer in MAP_LAYERS if layer.layer_type == "raster"
    } == {37, 38}
    categories = Counter(f["category"] for f in map_layer(32).features)
    assert len(categories) == 40
    assert sum(n for _, n in categories.most_common(5)) == 630
    buildings = map_layer(36).features
    assert sum(f["year_built"] is None for f in buildings) == 280
    assert sum(f["name"] is None for f in buildings) == 720
    density = sorted(f["density"] for f in map_layer(31).features)
    # A long right tail: the largest values lie far above the median.
    assert density[-1] > 3 * density[len(density) // 2]
    turnout = [f["turnout_change"] for f in map_layer(35).features]
    assert min(turnout) >= -15 and max(turnout) <= 15
    assert min(turnout) < 0 < max(turnout)


def test_every_layer_starts_with_one_valid_active_style() -> None:
    state = MapState()
    for layer in MAP_LAYERS:
        style_id = state.active_style_id(layer.layer_project_id)
        style = state.styles[style_id]
        assert (style.name, style.position, style.revision) == ("Default", 0, 1)
        assert style.revisions == {1: style.document}
        ctx = (
            DataContext(kind="raster")
            if layer.layer_type == "raster"
            else DataContext(kind="vector", geometry=layer.geometry)  # type: ignore[arg-type]
        )
        assert not _errors(
            [i.model_dump() for i in validate(style.document, ctx)]
        ), layer.name
    districts = state.styles[state.active_style_id(31)].document["symbol"]
    assert districts["fill"] and districts["outline"]
    [land_use] = state.styles[state.active_style_id(34)].document["classify"]
    assert (land_use["field"], land_use["method"]) == ("use", "categories")


def test_the_land_use_filter_is_the_panels_own() -> None:
    state = MapState()
    query = state.layers[34]["query"]
    fields = {"use": "string", "area_m2": "number"}
    # Already in the form the panel writes: converting it changes nothing.
    assert convert_query(query, fields).changes == []
    assert not [i for i in validate_filter(query["cql"]) if i.level == "error"]
    area, ordinary, custom = query["cql"]["args"]
    assert query["cql"]["op"] == "and"
    assert area["op"] == "s_intersects"
    polygon = area["args"][1]
    assert query["ui"]["area"]["sum"] == area_sum([polygon["coordinates"]])
    assert query["ui"]["area"]["pieces"][0]["kind"] == "shape"
    assert _row_of(ordinary, fields) is not None
    assert _row_of(custom, fields) is None
    [off] = query["ui"]["off"]
    assert off["at"] == 1 and _row_of(off["cql"], fields) is not None
    kept = [f for f in map_layer(34).features if matches(query["cql"], f)]
    assert 0 < len(kept) < 300


def test_the_filter_evaluator_reads_between_and_tests_an_area() -> None:
    """Without a geometry (a table) every feature is in an area; with one,
    the feature is in it when the two intersect, as the services test it."""
    between = {"op": "between", "args": [{"property": "n"}, 2, 4]}
    assert [matches(between, {"n": n}) for n in (1, 2, 4, 5, None)] == [
        False,
        True,
        True,
        False,
        False,
    ]
    square = [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]]
    area = {
        "op": "s_intersects",
        "args": [{"property": "geom"}, {"type": "Polygon", "coordinates": square}],
    }
    outside = {"op": "not", "args": [area]}
    assert matches(area, {}) and not matches(outside, {})
    inside = {"type": "Point", "coordinates": [1, 1]}
    far = {"type": "Point", "coordinates": [3, 3]}
    assert matches(area, {}, inside) and not matches(outside, {}, inside)
    assert not matches(area, {}, far) and matches(outside, {}, far)
    touching = {
        "type": "Polygon",
        "coordinates": [[[1.5, 1.5], [3, 1.5], [3, 3], [1.5, 3], [1.5, 1.5]]],
    }
    assert matches(area, {}, touching)


def test_the_land_use_filter_keeps_the_features_in_its_drawn_area() -> None:
    """The statistics routes apply the saved filter's area to the features'
    geometries: as drawn, the layer shows fewer features than its conditions
    alone keep."""
    land_use = map_layer(34)
    query = MapState().layers[34]["query"]
    area, *conditions = query["cql"]["args"]
    rows = json.dumps({"op": "and", "args": conditions})
    drawn = json.dumps(query["cql"])
    counted = [
        _process("feature-count", land_use, {"filter": f})["count"]
        for f in (None, rows, drawn)
    ]
    assert counted == [300, 69, 39]
    histogram = _process(
        "histogram",
        land_use,
        {"column": "area_m2", "num_bins": 1, "filter": drawn},
    )
    assert histogram["total_rows"] == 39


def test_old_boundaries_are_used_in_a_dashboard_a_workflow_and_a_layout() -> None:
    core = map_core(MapState())
    project = _call(core, "GET", BASE).json()
    assert project["name"] == MAP_PROJECT_NAME
    assert '"layer_project_id": 39' in json.dumps(project["builder_config"])
    [workflow] = _call(core, "GET", f"{BASE}/workflow").json()
    assert workflow == MAP_WORKFLOW
    assert 39 in [n["data"].get("projectLayerId") for n in workflow["config"]["nodes"]]
    [layout] = _call(core, "GET", f"{BASE}/report-layout").json()
    assert layout == MAP_REPORT_LAYOUT
    [element] = [e for e in layout["config"]["elements"] if e["type"] == "map"]
    assert 39 in element["config"]["locked_layer_ids"]


# ---- styles --------------------------------------------------------------------


def test_a_numeric_classification_gets_its_classes_from_the_data() -> None:
    state = MapState()
    core = map_core(state)
    style_id, document = _active(state, 31)
    document["classify"] = [
        {
            "field": "density",
            "method": "quantile",
            "count": 5,
            "palette": "colorbrewer:OrRd",
        }
    ]
    response = _save(core, 31, style_id, 1, document)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["revision"] == 2
    assert not _errors(body["issues"])
    [classification] = body["document"]["classify"]
    classes = classification["classes"]
    assert len(classes) == 5
    edges = [classes[0]["to"]]
    for previous, current in zip(classes, classes[1:], strict=False):
        assert current["from"] == previous["to"]
        if "to" in current:
            edges.append(current["to"])
    assert edges == sorted(edges)
    assert state.styles[style_id].revision == 2
    assert state.styles[style_id].document == body["document"]


def test_a_save_on_an_older_revision_merges() -> None:
    state = MapState()
    core = map_core(state)
    style_id, first = _active(state, 31)
    a = copy.deepcopy(first)
    a["symbol"]["fill"]["opacity"] = 0.4
    assert _save(core, 31, style_id, 1, a).json()["revision"] == 2
    b = copy.deepcopy(first)
    b["symbol"]["outline"]["width"] = 3
    body = _save(core, 31, style_id, 1, b).json()
    assert body["revision"] == 3
    symbol = state.styles[style_id].document["symbol"]
    assert symbol["fill"]["opacity"] == 0.4
    assert symbol["outline"]["width"] == 3


def test_a_change_with_an_error_keeps_the_stored_value() -> None:
    state = MapState()
    core = map_core(state)
    style_id, document = _active(state, 31)
    stored_label = copy.deepcopy(document["symbol"]["label"])
    document["symbol"]["label"]["text"] = "{no_such_field}"
    response = _save(core, 31, style_id, 1, document)
    assert response.status_code == 200
    body = response.json()
    assert {
        (i["code"], i["path"]) for i in body["issues"] if i["level"] == "error"
    } == {("unknown_field", "/symbol/label/text")}
    assert body["revision"] == 1
    assert state.styles[style_id].document["symbol"]["label"] == stored_label


def test_a_good_change_beside_a_bad_one_is_stored_alone() -> None:
    state = MapState()
    core = map_core(state)
    style_id, document = _active(state, 31)
    stored_label = copy.deepcopy(document["symbol"]["label"])
    document["symbol"]["label"]["text"] = "{no_such_field}"
    document["symbol"]["fill"]["opacity"] = 0.3
    body = _save(core, 31, style_id, 1, document).json()
    assert body["revision"] == 2
    assert ("unknown_field", "/symbol/label/text") in {
        (i["code"], i["path"]) for i in body["issues"] if i["level"] == "error"
    }
    symbol = state.styles[style_id].document["symbol"]
    assert symbol["fill"]["opacity"] == 0.3
    assert symbol["label"] == stored_label


def test_a_style_is_renamed_and_moved_on_its_revision() -> None:
    state = MapState()
    core = map_core(state)
    first = state.active_style_id(40)
    second = _call(core, "POST", _style_path(40), {"name": "Copy"}).json()
    response = _call(
        core, "PATCH", _style_path(40, second["id"]), {"name": "Lines", "position": 0}
    )
    assert response.status_code == 200
    assert (response.json()["name"], response.json()["position"]) == ("Lines", 0)
    assert response.json()["revision"] == 1
    assert [s.id for s in state.styles_of(40)] == [second["id"], first]
    # The active style stays the active one.
    assert state.active_style_id(40) == first


def test_a_style_read_with_check_reports_its_issues() -> None:
    state = MapState()
    core = map_core(state)
    style_id = state.active_style_id(34)
    state.styles[style_id].document["classify"][0]["field"] = "landuse"
    response = _call(core, "GET", _style_path(34, style_id), params={"check": "true"})
    assert response.status_code == 200
    assert ("damaged", "unknown_field") in {
        (i["level"], i["code"]) for i in response.json()["issues"]
    }
    plain = _call(core, "GET", _style_path(34, style_id)).json()
    assert plain["issues"] == []


def test_the_active_style_is_one_of_the_layers_own() -> None:
    state = MapState()
    core = map_core(state)
    created = _call(core, "POST", _style_path(31), {"name": "Dark"}).json()
    path = f"{BASE}/layer/31/map-state"
    assert (
        _call(core, "PATCH", path, {"active_style_id": created["id"]}).status_code
        == 204
    )
    assert state.active_style_id(31) == created["id"]
    other = state.active_style_id(32)
    response = _call(core, "PATCH", path, {"active_style_id": other})
    assert response.status_code == 422
    assert response.json() == {"detail": {"code": "style_not_on_layer"}}
    assert state.active_style_id(31) == created["id"]
    # A null for a column that cannot be null writes nothing.
    assert _call(core, "PATCH", path, {"visible": None}).status_code == 204
    assert state.layers[31]["visible"] is True
    assert _call(core, "PATCH", path, {"opacity": 1}).status_code == 422


def test_the_dataset_default_style_is_goatlibs_default() -> None:
    core = map_core(MapState())
    response = _call(core, "GET", f"/api/v2/layer/{map_layer(37).layer_id}/style")
    assert response.status_code == 200
    assert response.json()["document"] == {
        "version": "1.0.0",
        "kind": "raster",
        "render": {"type": "image"},
    }


def test_the_check_route_stores_nothing() -> None:
    state = MapState()
    core = map_core(state)
    before = state.snapshot()
    style_id, document = _active(state, 31)
    document["symbol"]["fill"]["color"] = "#ff0000"
    response = _call(
        core, "POST", f"{_style_path(31, style_id)}/check", {"document": document}
    )
    assert response.status_code == 200
    assert response.json()["document"]["symbol"]["fill"]["color"] == "#ff0000"
    assert state.snapshot() == before


def test_the_twenty_first_older_base_is_too_old() -> None:
    state = MapState()
    core = map_core(state)
    style_id, document = _active(state, 35)
    for n in range(20):
        document["symbol"]["marker"]["size"] = 4 + n * 0.5
        revision = state.styles[style_id].revision
        assert _save(core, 35, style_id, revision, document).json()["revision"] == (
            revision + 1
        )
    assert state.styles[style_id].revision == 21
    assert sorted(state.styles[style_id].revisions) == list(range(2, 22))
    response = _save(core, 35, style_id, 1, document)
    assert response.status_code == 409
    assert response.json() == {"detail": {"code": "base_too_old"}}
    assert _save(core, 35, style_id, 2, document).status_code == 200


def test_the_eleventh_style_is_refused() -> None:
    state = MapState()
    core = map_core(state)
    for n in range(9):
        response = _call(core, "POST", _style_path(32), {"name": f"Variant {n}"})
        assert response.status_code == 200, response.text
        assert response.json()["revision"] == 1
        assert response.json()["position"] == n + 1
    response = _call(core, "POST", _style_path(32), {"name": "One too many"})
    assert response.status_code == 409
    assert response.json() == {"detail": {"code": "too_many_styles"}}
    assert len(state.styles_of(32)) == 10


def test_deleting_the_active_style_hands_over_and_the_last_one_is_refused() -> None:
    state = MapState()
    core = map_core(state)
    first = state.active_style_id(33)
    created = _call(core, "POST", _style_path(33), {"name": "Night"}).json()
    assert state.active_style_id(33) == first
    assert _call(core, "DELETE", _style_path(33, first)).status_code == 204
    assert state.active_style_id(33) == created["id"]
    response = _call(core, "DELETE", _style_path(33, created["id"]))
    assert response.status_code == 409
    assert response.json() == {"detail": {"code": "last_style"}}


# ---- statistics ----------------------------------------------------------------


def test_a_histogram_with_custom_breaks_counts_the_filtered_features() -> None:
    buildings = map_layer(36)
    selection = json.dumps({"op": ">=", "args": [{"property": "floors"}, 3]})
    result = _process(
        "histogram",
        buildings,
        {
            "collection": buildings.layer_id,
            "column": "year_built",
            "method": "custom_breaks",
            "custom_breaks": [1950, 1980, 2000],
            "filter": selection,
        },
    )
    count = _process("feature-count", buildings, {"filter": selection})["count"]
    assert [b["range"][0] for b in result["bins"]][1:] == [1950, 1980, 2000]
    assert sum(b["count"] for b in result["bins"]) + result["missing_count"] == count
    assert result["total_rows"] == count
    assert result["missing_count"] > 0


def test_class_breaks_read_an_unknown_method_as_quantile() -> None:
    """As processes does: a method its ClassBreakMethod lacks (the style's
    std_dev) is computed and answered as quantile."""
    land_use = map_layer(34)
    inputs = {"collection": land_use.layer_id, "attribute": "area_m2", "breaks": 4}
    unknown = _process("class-breaks", land_use, {**inputs, "method": "std_dev"})
    quantile = _process("class-breaks", land_use, {**inputs, "method": "quantile"})
    assert unknown == quantile and unknown["method"] == "quantile"
    known = _process(
        "class-breaks", land_use, {**inputs, "method": "standard_deviation"}
    )
    assert known["method"] == "standard_deviation"
    assert {method.value for method in ClassBreakMethod} == BREAK_METHODS


def test_a_histogram_of_one_bin_counts_the_features_and_the_empty_ones() -> None:
    buildings = map_layer(36)
    result = _process(
        "histogram",
        buildings,
        {"collection": buildings.layer_id, "column": "year_built", "num_bins": 1},
    )
    assert result["total_rows"] == 800 and result["missing_count"] == 280


# ---- the map -------------------------------------------------------------------


def _entry(items: list[dict[str, Any]], kind: str, item_id: int) -> dict[str, Any]:
    for item in items:
        if item["type"] == kind and item["id"] == item_id:
            return item
        found = (
            _entry(item.get("children", []), kind, item_id)
            if item.get("children")
            else None
        )
        if found:
            return found
    return {}


def test_the_map_document_follows_the_state() -> None:
    state = MapState()
    core = map_core(state)
    response = _call(
        core,
        "PATCH",
        f"{BASE}/layer/32/map-state",
        {"visible": False, "position": "below_labels"},
    )
    assert response.status_code == 204
    transport = next(g for g, row in state.groups.items() if row["name"] == "Transport")
    response = _call(
        core,
        "PUT",
        f"{BASE}/layer-tree",
        {"items": [{"id": 35, "type": "layer", "order": -1, "parent_id": transport}]},
    )
    assert response.status_code == 204
    body = _call(core, "GET", f"{BASE}/map").json()
    pois = _entry(body["map"]["layers"], "layer", 32)
    assert (pois["visible"], pois["position"]) == (False, "below_labels")
    group = _entry(body["map"]["layers"], "group", transport)
    assert group["children"][0]["id"] == 35
    assert body["styles"]["32"]["active"]["id"] == state.active_style_id(32)
    assert body["map"]["basemap"] == {"id": state.basemap}


def test_a_removed_layer_takes_its_styles() -> None:
    state = MapState()
    core = map_core(state)
    style_id = state.active_style_id(36)
    response = _call(core, "DELETE", f"{BASE}/layer", params={"layer_project_id": 36})
    assert response.status_code == 204
    assert state.removed == [36]
    assert 36 not in state.layers and style_id not in state.styles
    assert 36 not in [row["id"] for row in _call(core, "GET", f"{BASE}/layer").json()]
    assert (
        _entry(_call(core, "GET", f"{BASE}/map").json()["map"]["layers"], "layer", 36)
        == {}
    )
    assert _call(core, "GET", _style_path(36, style_id)).status_code == 404


def test_a_project_update_keeps_basemap_and_scene() -> None:
    state = MapState()
    core = map_core(state)
    response = _call(core, "PUT", BASE, {"basemap": "dark"})
    assert response.status_code == 200
    assert state.basemap == "dark" and response.json()["basemap"] == "dark"
    assert _call(core, "PUT", BASE, {"scene": {}}).status_code == 200
    assert state.scene is None


def test_the_viewer_project_refuses_writes_as_core_does() -> None:
    state = MapState()
    core = map_core(state, read_only=True)
    before = state.snapshot()
    style_id = state.active_style_id(31)
    style = f"{VIEW_BASE}/layer/31/style"
    # The style and map-state routes check the role first (403 `forbidden`);
    # the others refuse in `auth_z`, which answers 401.
    forbidden = (403, {"detail": {"code": "forbidden"}})
    unauthorized = (401, {"detail": "Unauthorized"})
    writes: list[tuple[str, str, Any, dict[str, Any] | None, tuple[int, Any]]] = [
        ("POST", style, {"name": "Mine"}, None, forbidden),
        (
            "PUT",
            f"{style}/{style_id}",
            {"base_rev": 1, "document": {}},
            None,
            forbidden,
        ),
        ("PATCH", f"{style}/{style_id}", {"name": "Renamed"}, None, forbidden),
        ("DELETE", f"{style}/{style_id}", None, None, forbidden),
        (
            "PATCH",
            f"{VIEW_BASE}/layer/31/map-state",
            {"visible": False},
            None,
            forbidden,
        ),
        (
            "PATCH",
            f"{VIEW_BASE}/group/1/map-state",
            {"visible": False},
            None,
            forbidden,
        ),
        ("PUT", f"{VIEW_BASE}/layer/31", {"name": "Mine"}, None, unauthorized),
        ("DELETE", f"{VIEW_BASE}/layer", None, {"layer_project_id": 31}, unauthorized),
        ("PUT", f"{VIEW_BASE}/layer-tree", {"items": []}, None, unauthorized),
        ("POST", f"{VIEW_BASE}/group", {"name": "Mine"}, None, unauthorized),
        ("PUT", f"{VIEW_BASE}/group/1", {"name": "Mine"}, None, unauthorized),
        ("DELETE", f"{VIEW_BASE}/group/1", None, None, unauthorized),
        ("PUT", VIEW_BASE, {"basemap": "dark"}, None, unauthorized),
    ]
    for method, path, body, params, (status, reply) in writes:
        response = _call(core, method, path, body, params)
        assert (response.status_code, response.json()) == (status, reply), (
            method,
            path,
        )
    assert state.snapshot() == before
    assert _call(core, "GET", f"{VIEW_BASE}/map").status_code == 200
    assert _call(core, "GET", f"{style}/{style_id}").status_code == 200
    # A check stores nothing: project read is enough, so a viewer may run it.
    document = copy.deepcopy(state.styles[style_id].document)
    document["symbol"]["fill"]["color"] = "#ff0000"
    check = _call(core, "POST", f"{style}/{style_id}/check", {"document": document})
    assert check.status_code == 200
    assert check.json()["document"]["symbol"]["fill"]["color"] == "#ff0000"
    assert state.snapshot() == before


def test_a_layer_update_writes_the_name_and_a_checked_filter() -> None:
    state = MapState()
    core = map_core(state)
    query = {
        "cql": {
            "op": "and",
            "args": [{"op": "=", "args": [{"property": "use"}, "forest"]}],
        }
    }
    response = _call(core, "PUT", f"{BASE}/layer/34", {"name": "Areas", "query": query})
    assert response.status_code == 200
    assert response.json()["query"] == query
    assert (state.layers[34]["name"], state.layers[34]["query"]) == ("Areas", query)
    bad = {"cql": {"op": "nope", "args": [1]}}
    response = _call(core, "PUT", f"{BASE}/layer/34", {"query": bad})
    assert response.status_code == 422
    assert state.layers[34]["query"] == query
    response = _call(core, "PUT", f"{BASE}/layer/34", {"properties": {}})
    assert response.status_code == 422
    assert "style routes" in response.json()["detail"]
    assert _call(core, "PUT", f"{BASE}/layer/99", {"name": "x"}).status_code == 404


def test_groups_are_made_changed_and_removed_with_their_layers() -> None:
    state = MapState()
    core = map_core(state)
    created = _call(core, "POST", f"{BASE}/group", {"name": "Planning", "parent_id": 1})
    assert created.status_code == 201
    group = created.json()["id"]
    assert group not in (1, 2) and state.groups[group]["parent_id"] == 1
    too_deep = _call(
        core, "POST", f"{BASE}/group", {"name": "Deep", "parent_id": group}
    )
    assert too_deep.status_code == 400
    renamed = _call(core, "PUT", f"{BASE}/group/{group}", {"name": "Plans"})
    assert renamed.json()["name"] == "Plans"
    assert (
        _call(
            core, "PATCH", f"{BASE}/group/2/map-state", {"visible": False}
        ).status_code
        == 204
    )
    rows = {row["id"]: row for row in _call(core, "GET", f"{BASE}/group").json()}
    assert rows[2]["visible"] is False and rows[group]["name"] == "Plans"
    assert _call(
        core, "PATCH", f"{BASE}/group/99/map-state", {"visible": False}
    ).json() == {"detail": {"code": "not_found"}}
    styles = [state.active_style_id(link) for link in (31, 34, 36, 39)]
    assert _call(core, "DELETE", f"{BASE}/group/1").status_code == 204
    assert state.removed == [31, 34, 36, 39]
    assert 1 not in state.groups and group not in state.groups
    assert not set(styles) & set(state.styles)
    layers = _call(core, "GET", f"{BASE}/map").json()["map"]["layers"]
    assert _entry(layers, "group", 1) == {} and _entry(layers, "layer", 31) == {}


def test_a_scene_is_checked_before_it_is_stored() -> None:
    state = MapState()
    core = map_core(state)
    scene = {"terrain": {"exaggeration": 1.5}}
    assert _call(core, "PUT", BASE, {"scene": scene}).status_code == 200
    assert state.scene == scene
    response = _call(
        core, "PUT", BASE, {"scene": {"terrain": {"exaggeration": "high"}}}
    )
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "invalid_scene"
    assert state.scene == scene
    assert _call(core, "GET", f"{BASE}/map").json()["map"]["scene"] == scene


# ---- the backends of a task ----------------------------------------------------


@pytest.fixture(scope="module")
def backends(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Backends]:
    path: Path = tmp_path_factory.mktemp("eval-catalog-map")
    write_eval_catalog(path)
    backends = Backends(path)
    yield backends
    backends.close()


async def test_a_task_gets_the_map_projects_beside_the_fixture_project(
    backends: Backends,
) -> None:
    state = MapState()
    services, requests, _ = backends.clients(maps={MAP_PROJECT_ID: state})
    try:
        response = await services.core.patch(
            f"{BASE}/layer/41/map-state", json={"visible": False}
        )
        assert response.status_code == 204
        assert state.layers[41]["visible"] is False
        viewer = await services.core.patch(
            f"{VIEW_BASE}/layer/41/map-state", json={"visible": False}
        )
        assert viewer.status_code == 403
        old = await services.core.get(
            "/api/v2/project/00000000-0000-0000-0000-0000000005e1"
        )
        assert old.json()["name"] == "Radverkehr Leipzig"
        land_use = map_layer(34)
        queryables = await services.geoapi.get(
            f"/collections/{land_use.layer_id}/queryables"
        )
        assert set(queryables.json()["properties"]) >= {"use", "area_m2"}
        histogram = await services.processes.post(
            "/processes/histogram/execution",
            json={
                "inputs": {
                    "collection": land_use.layer_id,
                    "column": "area_m2",
                    "method": "custom_breaks",
                    "custom_breaks": [5000],
                    "filter": json.dumps(state.layers[34]["query"]["cql"]),
                }
            },
        )
        assert histogram.status_code == 200
        assert [r.url.path for r in requests["core"]][:2] == [
            f"{BASE}/layer/41/map-state",
            f"{VIEW_BASE}/layer/41/map-state",
        ]
    finally:
        await services.aclose()


async def test_field_statistics_on_the_stand_ins_count_the_values_and_the_empty_ones(
    backends: Backends,
) -> None:
    """Buildings: 280 of 800 have no year and 720 no name. A style's method
    name is answered as the style writes it."""
    from assistant.context import parse_context
    from assistant.tools.project import FIELD_STATISTICS
    from assistant.tools.runtime import execute
    from assistant.tools.testing import tool_env

    services, requests, _ = backends.clients()
    env = tool_env(
        services,
        page=parse_context({"surface": "project.map", "project_id": MAP_PROJECT_ID}),
    )
    years = await execute(
        FIELD_STATISTICS,
        env,
        {"layer_project_id": 36, "field": "year_built", "method": "std_dev"},
    )
    assert (years["count"], years["empty"], years["method"]) == (520, 280, "std_dev")
    names = await execute(
        FIELD_STATISTICS, env, {"layer_project_id": 36, "field": "name"}
    )
    assert (names["count"], names["empty"]) == (80, 720)
    assert names["distinct_count"] == 80


def _map_env(services: Any) -> Any:
    from assistant.context import parse_context
    from assistant.tools.testing import tool_env

    return tool_env(
        services,
        page=parse_context({"surface": "project.map", "project_id": MAP_PROJECT_ID}),
    )


#: Land use's saved filter as the map draws it, in words: the rows that are
#: on (the switched-off row 2 is left out) and the area.
LAND_USE_DRAWN = (
    "the layer's filter as the map draws it (area_m2 is greater than 5000 and "
    'custom; area: a drawn shape "Study area")'
)


async def test_statistics_as_drawn_read_the_features_the_map_shows(
    backends: Backends,
) -> None:
    """Land use keeps 39 of 300 features under its saved filter (rows and
    a drawn area). Without as_drawn the statistics read every feature; with
    it, those the map draws, and the answer says which filter applied."""
    from assistant.tools.project import FIELD_STATISTICS
    from assistant.tools.runtime import execute

    services, requests, _ = backends.clients()
    env = _map_env(services)
    asked = {"layer_project_id": 34, "field": "area_m2", "breaks": 4}
    whole = await execute(FIELD_STATISTICS, env, asked)
    assert (whole["count"], whole["filter"]) == (300, "none (all features)")
    drawn = await execute(FIELD_STATISTICS, env, {**asked, "as_drawn": True})
    assert (drawn["count"], drawn["filter"]) == (39, LAND_USE_DRAWN)
    assert drawn["breaks"] != whole["breaks"]
    # The saved CQL reaches processes as core stores it, area included.
    sent = [
        json.loads(json.loads(r.content)["inputs"]["filter"])
        for r in requests["processes"]
        if "filter" in json.loads(r.content)["inputs"]
    ]
    assert sent and all(f == MapState().layers[34]["query"]["cql"] for f in sent), sent
    # With a filter of its own, both apply.
    parks = {"conditions": [{"field": "use", "op": "=", "value": "park"}]}
    both = await execute(
        FIELD_STATISTICS, env, {**asked, "as_drawn": True, "filter": parks}
    )
    kept = selected_features(map_layer(34), MapState().layers[34]["query"]["cql"])
    assert both["count"] == sum(f["use"] == "park" for f in kept)
    assert both["filter"] == f"{LAND_USE_DRAWN} and use = 'park'"
    # A category field counts its values and the empty ones as drawn.
    uses = await execute(
        FIELD_STATISTICS,
        env,
        {"layer_project_id": 34, "field": "use", "as_drawn": True},
    )
    assert (uses["count"], uses["empty"]) == (39, 0)
    assert sum(v["count"] for v in uses["values"]) == 39


async def test_every_filtered_read_takes_as_drawn(backends: Backends) -> None:
    from assistant.tools.project import (
        AREA_STATISTICS,
        COUNT_FEATURES,
        GROUP_STATISTICS,
        SAMPLE_FEATURES,
    )
    from assistant.tools.runtime import execute

    services, _, _ = backends.clients()
    env = _map_env(services)
    drawn = {"layer_project_id": 34, "as_drawn": True}
    counted = await execute(COUNT_FEATURES, env, drawn)
    assert (counted["count"], counted["filter"]) == (39, LAND_USE_DRAWN)
    grouped = await execute(
        GROUP_STATISTICS, env, {**drawn, "operation": "count", "group_by": "use"}
    )
    assert grouped["filter"] == LAND_USE_DRAWN
    assert sum(row["value"] for row in grouped["rows"]) == 39
    areas = await execute(AREA_STATISTICS, env, drawn)
    assert (areas["feature_count"], areas["filter"]) == (39, LAND_USE_DRAWN)
    sample = await execute(SAMPLE_FEATURES, env, drawn)
    assert (sample["number_matched"], sample["filter"]) == (39, LAND_USE_DRAWN)
    # A layer without a saved filter is read whole.
    plain = await execute(
        COUNT_FEATURES, env, {"layer_project_id": 31, "as_drawn": True}
    )
    assert (plain["count"], plain["filter"]) == (60, "none (all features)")


async def test_switched_off_parts_of_a_filter_are_not_applied(
    backends: Backends,
) -> None:
    """As on the map: a filter whose rows and area are all switched off
    draws every feature."""
    from assistant.tools.project import COUNT_FEATURES
    from assistant.tools.runtime import execute

    state = MapState()
    query = state.layers[34]["query"]
    area = query["cql"]["args"][0]
    state.layers[34]["query"] = {
        "ui": {
            "v": 1,
            "off": [{"at": 0, "cql": query["cql"]["args"][1]}],
            "area": {**query["ui"]["area"], "off": area},
        }
    }
    services, _, _ = backends.clients(maps={MAP_PROJECT_ID: state})
    counted = await execute(
        COUNT_FEATURES, _map_env(services), {"layer_project_id": 34, "as_drawn": True}
    )
    assert (counted["count"], counted["filter"]) == (300, "none (all features)")


async def test_the_catalogs_regions_set_an_area_through_map_update(
    backends: Backends,
) -> None:
    """The invented regions where the map project's data lies are found by
    name and their outlines set a layer's area; the detailed one is
    simplified to fit, as the filter panel simplifies it."""
    from goatlib.filter.areas import read_area
    from goatlib.filter.limits import MAX_POINTS
    from goatlib.filter.rows import read_rows

    from assistant.context import parse_context
    from assistant.tools.catalog import FIND_REGION
    from assistant.tools.map_edits import MAP_UPDATE
    from assistant.tools.runtime import execute
    from assistant.tools.testing import tool_env

    state = MapState()
    services, _, _ = backends.clients(maps={MAP_PROJECT_ID: state})
    try:
        env = tool_env(
            services,
            page=parse_context(
                {"surface": "project.map", "project_id": MAP_PROJECT_ID}
            ),
        )
        found = await execute(FIND_REGION, env, {"name": "Auental"})
        assert [r["nuts_id"] for r in found["regions"]] == ["DEZ01"]
        result = await execute(
            MAP_UPDATE,
            env,
            {
                "operations": [
                    {
                        "op": "filter",
                        "layer_project_id": 32,
                        "area": {"regions": ["DEZ01", "DEZ02"]},
                    }
                ]
            },
        )
        [applied] = result["applied"]
        assert 'regions: "Bergfeld" (DEZ02), "Auental" (DEZ01)' in applied["summary"]
        assert "was simplified" in applied["summary"]
        rows = read_rows(state.layers[32]["query"], None)
        area = read_area(rows.area, rows.area_notes)
        assert area is not None
        [piece] = area.pieces
        assert (
            sum(len(ring) for polygon in piece.polygons for ring in polygon)
            <= MAX_POINTS
        )
    finally:
        await services.aclose()
