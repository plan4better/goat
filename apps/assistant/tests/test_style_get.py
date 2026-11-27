"""style_get reads a layer's style: the document in compact form, its
revision, the check's issues, the fields it reads and the legend numbers.
Core, geoapi and processes are the eval stand-ins of the map project, which
answer as the services do."""

import copy
import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from goatlib.style.summary import summarize
from pydantic_ai.exceptions import ToolFailed

from assistant.context import parse_context
from assistant.maps.state import read_map
from assistant.styles.legend import (
    LEGEND_UNAVAILABLE,
    class_index,
    legend_numbers,
    number_text,
)
from assistant.styles.view import MAX_ISSUES, compact, issue_views
from assistant.tools.project import STILL_COPYING, _Layer
from assistant.tools.registry import BY_WIRE_NAME
from assistant.tools.runtime import InputInvalid, ToolEnv, execute
from assistant.tools.skills import SKILLS_LOAD
from assistant.tools.styles import GET_STYLE, SKILL_FIRST, STYLE_TOOLS
from assistant.tools.testing import Recorder, fake_clients, tool_env
from evals.backends import _layer_routes, _processes_routes, selected_features
from evals.map_backends import MapState, map_core
from evals.map_fixture import (
    MAP_LAYERS,
    MAP_LAYERS_BY_ID,
    MAP_PROJECT_ID,
    map_layer,
)

BASE = f"/api/v2/project/{MAP_PROJECT_ID}"
PAGE = {"surface": "project.map", "project_id": MAP_PROJECT_ID}
CATEGORIES = sorted({f["category"] for f in map_layer(32).features})


def _geoapi() -> Recorder:
    routes: dict[tuple[str, str], Any] = {}
    for layer in MAP_LAYERS:
        if layer.layer_type == "feature":
            routes.update(_layer_routes(layer))
    return Recorder(routes)


def _processes() -> Recorder:
    return Recorder(_processes_routes(MAP_LAYERS_BY_ID.get))


class _Services:
    def __init__(
        self,
        state: MapState,
        *,
        processes: Recorder | None = None,
        geoapi: Recorder | None = None,
        core: Any = None,
    ) -> None:
        self.core = core if core is not None else map_core(state)
        self.processes = processes if processes is not None else _processes()
        self.geoapi = geoapi if geoapi is not None else _geoapi()
        self.env: ToolEnv = tool_env(
            fake_clients(core=self.core, geoapi=self.geoapi, processes=self.processes),
            page=parse_context(PAGE),
        )

    def bodies(self, process: str) -> list[dict[str, Any]]:
        return [
            json.loads(r.content)["inputs"]
            for r in self.processes.requests
            if r.url.path == f"/processes/{process}/execution"
        ]


async def _get(services: _Services, **args: Any) -> dict[str, Any]:
    result: dict[str, Any] = await execute(GET_STYLE, services.env, args)
    return result


def _save(state: MapState, link: int, document: dict[str, Any]) -> dict[str, Any]:
    """Saves the layer's active style through core's route."""
    style_id = state.active_style_id(link)
    request = httpx.Request(
        "PUT",
        f"http://core{BASE}/layer/{link}/style/{style_id}",
        json={"base_rev": state.styles[style_id].revision, "document": document},
    )
    response = map_core(state).answer(request)
    assert response is not None and response.status_code == 200, response
    body: dict[str, Any] = response.json()
    assert not [i for i in body["issues"] if i["level"] == "error"], body["issues"]
    return body


def _active(state: MapState, link: int) -> dict[str, Any]:
    return copy.deepcopy(state.styles[state.active_style_id(link)].document)


def _quantile_districts(state: MapState) -> dict[str, Any]:
    document = _active(state, 31)
    document["classify"] = [
        {
            "field": "density",
            "method": "quantile",
            "count": 5,
            "palette": "colorbrewer:OrRd",
        }
    ]
    return _save(state, 31, document)


def _all_categories(state: MapState, values: list[str] | None = None) -> None:
    """Points of interest colored by category, one class per value."""
    document = _active(state, 32)
    document["classify"] = [
        {
            "field": "category",
            "method": "categories",
            "classes": [
                {"values": [value], "marker": {"color": f"#{(n * 6) % 256:02x}8040"}}
                for n, value in enumerate(values or CATEGORIES)
            ],
        }
    ]
    _save(state, 32, document)


def _layer(link: int) -> _Layer:
    fixture = map_layer(link)
    return _Layer(
        MAP_PROJECT_ID,  # type: ignore[arg-type]
        link,
        fixture.layer_id,
        fixture.name,
        fixture.geometry or None,
    )


# ---- the tool --------------------------------------------------------------------


def test_style_get_is_a_read_tool_of_the_map_page() -> None:
    assert GET_STYLE in STYLE_TOOLS
    assert BY_WIRE_NAME["style_get"] is GET_STYLE
    assert (GET_STYLE.risk, GET_STYLE.scope) == ("read", "goat:read")
    assert GET_STYLE.surfaces == frozenset({"project.map"})
    assert not GET_STYLE.mcp
    properties = GET_STYLE.json_schema()["properties"]
    assert set(properties) == {"project_id", "layer_project_id", "style_id", "part"}
    assert "before" in GET_STYLE.description and "part" in GET_STYLE.description


async def test_the_default_is_the_active_style_and_the_document_has_no_computed_objects() -> (
    None
):
    state = MapState()
    saved = _quantile_districts(state)
    stored = copy.deepcopy(state.styles[saved["id"]].document)
    services = _Services(state)
    result = await _get(services, layer_project_id=31)
    assert result["style_id"] == saved["id"] == state.active_style_id(31)
    assert (result["name"], result["active"], result["revision"]) == (
        "Default",
        True,
        2,
    )
    assert result["layer_project_id"] == 31
    assert "computed" not in json.dumps(result["document"])
    [classification] = result["document"]["classify"]
    assert len(classification["classes"]) == 5
    assert "cut" not in result or result["cut"] == []
    # The stored document keeps its computed values.
    assert state.styles[saved["id"]].document == stored
    assert "computed" in json.dumps(stored)
    # The check is asked for, and the document comes once.
    [read] = [r for r in services.core.requests if "/style/" in r.url.path]
    assert read.url.params["check"] == "true"
    assert json.dumps(result).count('"classify"') == 1
    assert result["fields"] == [
        {"name": "density", "type": "number"},
        {"name": "name", "type": "string"},
    ]


async def test_an_outline_in_auto_is_read_and_described_without_an_issue() -> None:
    # New polygon layers get an outline in a darker shade of their fill.
    state = MapState()
    document = _active(state, 31)
    document["symbol"] = {
        "fill": {"color": "#7f3c8d", "opacity": 0.8},
        "outline": {"color": "auto", "width": 1},
    }
    _save(state, 31, document)
    result = await _get(_Services(state), layer_project_id=31)
    assert result["document"]["symbol"]["outline"] == {"color": "auto", "width": 1}
    assert not [i for i in result.get("issues", []) if i["level"] == "error"]
    assert summarize(result["document"]).startswith("fill #7f3c8d")


async def test_another_named_style_reads_as_not_active() -> None:
    state = MapState()
    other = state.add_style(31, "Plain", _active(state, 31))
    result = await _get(_Services(state), layer_project_id=31, style_id=other.id)
    assert (result["style_id"], result["name"], result["active"]) == (
        other.id,
        "Plain",
        False,
    )


async def test_a_long_class_list_is_cut_to_twelve_and_says_so() -> None:
    state = MapState()
    _all_categories(state)
    assert len(CATEGORIES) == 40
    result = await _get(_Services(state), layer_project_id=32)
    assert result["cut"] == [
        {"path": "/classify/category/classes", "shown": 12, "total": 40}
    ]
    [classification] = result["document"]["classify"]
    assert len(classification["classes"]) == 12
    # The stored document is not cut.
    stored = state.styles[state.active_style_id(32)].document
    assert len(stored["classify"][0]["classes"]) == 40


async def test_the_largest_style_stays_small() -> None:
    state = MapState()
    _all_categories(state)
    result = await _get(_Services(state), layer_project_id=32)
    size = len(json.dumps(result, separators=(",", ":"), ensure_ascii=False).encode())
    assert size < 30_000


async def test_part_answers_that_part_in_full() -> None:
    state = MapState()
    _all_categories(state)
    services = _Services(state)
    result = await _get(services, layer_project_id=32, part="/classify/category")
    assert result["document"]["field"] == "category"
    assert len(result["document"]["classes"]) == 40
    assert "cut" not in result or result["cut"] == []
    classes = await _get(
        services, layer_project_id=32, part="/classify/category/classes"
    )
    assert list(classes["document"]) == ["classes"]
    assert len(classes["document"]["classes"]) == 40


async def test_a_part_leaves_computed_values_out() -> None:
    state = MapState()
    _quantile_districts(state)
    result = await _get(_Services(state), layer_project_id=31, part="/classify/density")
    assert result["document"]["method"] == "quantile"
    assert "computed" not in result["document"]
    with pytest.raises(InputInvalid, match="Computed values"):
        await _get(
            _Services(state), layer_project_id=31, part="/classify/density/computed"
        )


async def test_an_unknown_part_names_what_exists() -> None:
    state = MapState()
    with pytest.raises(InputInvalid) as raised:
        await _get(_Services(state), layer_project_id=31, part="/rules")
    assert "'/rules'" in raised.value.message
    assert "version, kind, symbol" in raised.value.message


async def test_issues_come_with_fix_and_allowed() -> None:
    state = MapState()
    style_id = state.active_style_id(31)
    # A stored style that names a field the layer does not have: the check
    # reports it as damage.
    document = state.styles[style_id].document
    document["classify"] = [
        {
            "id": "k",
            "field": "inhabitants",
            "method": "categories",
            "classes": [{"id": "c1", "values": ["a"], "fill": {"color": "#ff0000"}}],
        }
    ]
    result = await _get(_Services(state), layer_project_id=31)
    issues = result["issues"]
    assert issues, result
    levels = [issue["level"] for issue in issues]
    assert levels == sorted(
        levels, key=lambda level: {"error": 0, "damaged": 0, "warning": 1}.get(level, 2)
    )
    assert any(issue["level"] in ("error", "damaged") for issue in issues)
    for issue in issues:
        assert issue["code"] and issue["message"] and "path" in issue


def test_issue_views_keep_fix_and_allowed_and_put_errors_first() -> None:
    fix = {"op": "set", "path": "/symbol/fill/color", "value": "#000000"}
    views = issue_views(
        [
            {"level": "info", "code": "i", "path": "/a", "message": "m"},
            {"level": "warning", "code": "w", "path": "/b", "message": "m"},
            {
                "level": "error",
                "code": "e",
                "path": "/symbol/fill/color",
                "message": "m",
                "fix": fix,
                "allowed": ["#000000"],
            },
            {"level": "damaged", "code": "d", "path": "/c", "message": "m"},
        ]
    )
    assert [v.code for v in views] == ["e", "d", "w", "i"]
    assert (views[0].fix, views[0].allowed) == (fix, ["#000000"])
    many = [
        {"level": "info", "code": f"i{n}", "path": "/a", "message": "m"}
        for n in range(40)
    ]
    assert len(issue_views(many)) == MAX_ISSUES


async def test_issues_with_params_or_a_newer_key_read_as_before() -> None:
    """core passes on the issues' `params` (the panel words them from these) and
    any key a newer core adds: the tool reads the keys it knows and the model
    gets the English message."""
    state = MapState()
    issue = {
        "level": "info",
        "code": "classes_merged",
        "path": "/a",
        "message": "Many values are the same.",
    }

    def edit(request: httpx.Request) -> httpx.Response:
        response = map_core(state).answer(request)
        assert response is not None
        if "/style/" in request.url.path:
            body = response.json()
            body["issues"] = [
                issue,
                {**issue, "params": {"asked": 6, "made": 5}, "a_later_key": 1},
            ]
            return httpx.Response(200, json=body)
        return response

    result = await _get(_Services(state, core=_Proxy(edit)), layer_project_id=31)
    assert [i["message"] for i in result["issues"]] == [issue["message"]] * 2
    assert all("params" not in i and "a_later_key" not in i for i in result["issues"])


async def test_more_than_thirty_issues_say_how_many_were_left_out() -> None:
    state = MapState()

    def edit(request: httpx.Request) -> httpx.Response:
        response = map_core(state).answer(request)
        assert response is not None
        if "/style/" in request.url.path:
            body = response.json()
            body["issues"] = [
                {"level": "warning", "code": f"w{n}", "path": "/a", "message": "m"}
                for n in range(35)
            ]
            return httpx.Response(200, json=body)
        return response

    result = await _get(_Services(state, core=_Proxy(edit)), layer_project_id=31)
    assert len(result["issues"]) == 30
    assert "5 more issues" in result["note"]


class _Proxy(Recorder):
    """Answers every request with one handler, and records it."""

    def __init__(self, handler: Callable[[httpx.Request], httpx.Response]) -> None:
        super().__init__()
        self.handler = handler

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.handler(request)


async def test_a_stale_read_says_the_style_was_not_checked() -> None:
    state = MapState()

    def stale(request: httpx.Request) -> httpx.Response:
        response = map_core(state).answer(request)
        assert response is not None
        if "/style/" in request.url.path:
            return httpx.Response(200, json={**response.json(), "stale": True})
        return response

    result = await _get(_Services(state, core=_Proxy(stale)), layer_project_id=31)
    assert (
        result["note"] == "The style could not be checked against the data right now."
    )


# ---- the legend numbers ----------------------------------------------------------


async def test_legend_numbers_for_categories_count_the_rest_as_other() -> None:
    state = MapState()
    # Six of the eight land uses have a class; water and mixed fall in other.
    services = _Services(state)
    result = await _get(services, layer_project_id=34)
    [legend] = result["legend"]
    # The saved filter's conditions, and its drawn area as the stand-ins
    # test it against each feature's geometry.
    kept = [
        f
        for f in selected_features(map_layer(34), state.layers[34]["query"]["cql"])
        if f["area_m2"] > 5000
        and (f["use"] == "park" or 20000 <= f["area_m2"] <= 50000)
    ]
    assert len(kept) == 39
    assert legend["classification"] == "/classify/use"
    assert (legend["field"], legend["method"]) == ("use", "categories")
    assert legend["features"] == len(kept)
    counts = {c["label"]: c["count"] for c in legend["classes"]}
    for use in (
        "residential",
        "farmland",
        "forest",
        "park",
        "commercial",
        "industrial",
    ):
        assert counts[use] == sum(f["use"] == use for f in kept)
    assert legend["other"] == sum(f["use"] in ("water", "mixed") for f in kept)
    assert legend["without_value"] == 0
    # The layer's saved filter goes with every request, as JSON text.
    cql = json.dumps(state.layers[34]["query"]["cql"])
    [values] = services.bodies("unique-values")
    assert values == {
        "collection": map_layer(34).layer_id,
        "attribute": "use",
        "filter": cql,
        "limit": 1000,
        "order": "descendent",
    }
    counts_asked = services.bodies("feature-count")
    assert {"collection": map_layer(34).layer_id, "filter": cql} in counts_asked
    assert {
        "collection": map_layer(34).layer_id,
        "filter": json.dumps(
            {
                "op": "and",
                "args": [
                    state.layers[34]["query"]["cql"],
                    {"op": "isNull", "args": [{"property": "use"}]},
                ],
            }
        ),
    } in counts_asked


async def test_legend_numbers_for_classes_use_the_stored_limits_and_the_layers_filter() -> (
    None
):
    state = MapState()
    saved = _quantile_districts(state)
    state.layers[31]["query"] = {
        "cql": {"op": ">", "args": [{"property": "density"}, 0]}
    }
    services = _Services(state)
    result = await _get(services, layer_project_id=31)
    classes = saved["document"]["classify"][0]["classes"]
    limits = [c["to"] for c in classes[:-1]]
    [histogram] = services.bodies("histogram")
    assert histogram == {
        "collection": map_layer(31).layer_id,
        "column": "density",
        "method": "custom_breaks",
        "custom_breaks": limits,
        "filter": json.dumps(state.layers[31]["query"]["cql"]),
    }
    [legend] = result["legend"]
    densities = [f["density"] for f in map_layer(31).features]
    expected = [
        sum(
            (i == 0 or d >= limits[i - 1]) and (i == len(limits) or d < limits[i])
            for d in densities
        )
        for i in range(len(classes))
    ]
    assert [c["count"] for c in legend["classes"]] == expected
    assert [c["id"] for c in legend["classes"]] == ["c1", "c2", "c3", "c4", "c5"]
    assert legend["classes"][0]["label"] == f"below {number_text(limits[0])}"
    assert legend["classes"][1]["label"] == (
        f"{number_text(limits[0])} to {number_text(limits[1])}"
    )
    assert legend["classes"][-1]["label"] == f"{number_text(limits[-1])} and above"
    assert "other" not in legend
    assert legend["features"] == 60


async def test_a_class_that_holds_a_single_value_is_labelled_with_it() -> None:
    state = MapState()
    _quantile_districts(state)
    stored = state.styles[state.active_style_id(31)].document["classify"][0]
    first, last = stored["classes"][0]["id"], stored["classes"][-1]["id"]
    stored["computed"]["single"] = {first: 12.5, last: 9000.0, "zz": 1.0}
    result = await _get(_Services(state), layer_project_id=31)
    [legend] = result["legend"]
    assert legend["classes"][0]["label"] == number_text(12.5)
    assert legend["classes"][-1]["label"] == number_text(9000.0)
    assert " to " in legend["classes"][1]["label"]


async def test_shares_add_up_to_one_with_other_and_without_value() -> None:
    state = MapState()
    document = _active(state, 36)
    document["classify"] = [
        {
            "field": "year_built",
            "method": "categories",
            "classes": [
                {"values": [1900 + n], "fill": {"color": "#112233"}} for n in range(60)
            ],
        }
    ]
    _save(state, 36, document)
    result = await _get(_Services(state), layer_project_id=36)
    [legend] = result["legend"]
    assert legend["without_value"] == 280
    assert legend["features"] == 800
    assert legend["more"] == 48 and len(legend["classes"]) == 12
    stored = state.styles[state.active_style_id(36)].document["classify"][0]["classes"]
    in_classes = sum(
        f["year_built"] is not None and 1900 <= f["year_built"] < 1960
        for f in map_layer(36).features
    )
    assert legend["other"] == 800 - 280 - in_classes
    assert len(stored) == 60
    total = sum(
        f["year_built"] is not None and f["year_built"] == 1900 + n
        for f in map_layer(36).features
        for n in range(12)
    )
    assert sum(c["count"] for c in legend["classes"]) == total
    # The reader the write tool reuses answers the same numbers.
    numbers, note = await legend_numbers(
        _Services(state).env,
        _layer(36),
        None,
        state.styles[state.active_style_id(36)].document,
    )
    assert note is None
    assert [n.model_dump(exclude_none=True) for n in numbers] == [legend]
    # Every class (not only the twelve shown), other and no value make all.
    shares = sum(c["share"] for c in legend["classes"])
    assert shares == pytest.approx(total / 800, abs=0.01)
    assert in_classes + legend["other"] + legend["without_value"] == 800


async def test_shares_are_of_the_features_and_rounded() -> None:
    state = MapState()
    _quantile_districts(state)
    result = await _get(_Services(state), layer_project_id=31)
    [legend] = result["legend"]
    for c in legend["classes"]:
        assert c["share"] == round(c["count"] / 60, 3)
    assert sum(c["count"] for c in legend["classes"]) + legend["without_value"] == 60


async def test_a_failed_processes_call_gives_a_note_not_a_failure() -> None:
    state = MapState()
    _quantile_districts(state)
    processes = _processes()
    processes.routes[("POST", "/processes/histogram/execution")] = httpx.Response(
        500, json={"detail": "boom"}
    )
    result = await _get(_Services(state, processes=processes), layer_project_id=31)
    assert result.get("legend", []) == []
    assert result["legend_note"] == LEGEND_UNAVAILABLE
    assert result["document"]["classify"]


async def test_a_failed_feature_count_gives_no_numbers_at_all() -> None:
    state = MapState()
    processes = _processes()
    processes.routes[("POST", "/processes/feature-count/execution")] = httpx.Response(
        503, json={"detail": "down"}
    )
    result = await _get(_Services(state, processes=processes), layer_project_id=34)
    assert result.get("legend", []) == []
    assert result["legend_note"] == LEGEND_UNAVAILABLE


async def test_a_raster_answers_without_numbers() -> None:
    state = MapState()
    services = _Services(state)
    result = await _get(services, layer_project_id=37)
    assert result["document"]["kind"] == "raster"
    assert result.get("legend", []) == [] and "legend_note" not in result
    assert services.processes.requests == []
    # A raster's fields have no queryables to read.
    assert services.geoapi.requests == []


async def test_a_layer_being_copied_is_refused_as_the_project_tools_refuse_it() -> None:
    state = MapState()
    core = map_core(state)

    def copying(request: httpx.Request) -> httpx.Response:
        response = core.answer(request)
        assert response is not None
        if request.url.path == f"{BASE}/layer":
            rows = response.json()
            for row in rows:
                if row["id"] == 31:
                    row["other_properties"] = {
                        "catalog_materialize": {"status": "running"}
                    }
            return httpx.Response(200, json=rows)
        return response

    with pytest.raises(ToolFailed) as raised:
        await _get(_Services(state, core=_Proxy(copying)), layer_project_id=31)
    assert raised.value.message == STILL_COPYING


async def test_a_table_has_no_style_and_a_locked_layer_is_refused() -> None:
    state = MapState()
    core = map_core(state)

    def rows(request: httpx.Request) -> httpx.Response:
        response = core.answer(request)
        assert response is not None
        if request.url.path == f"{BASE}/layer":
            listed = response.json()
            for row in listed:
                if row["id"] == 39:
                    row["type"] = "table"
                if row["id"] in (33, 38):
                    row["locked"] = True
            return httpx.Response(200, json=listed)
        return response

    services = _Services(state, core=_Proxy(rows))
    with pytest.raises(ToolFailed, match="A table has no style."):
        await _get(services, layer_project_id=39)
    for link in (33, 38):
        with pytest.raises(ToolFailed, match="no access"):
            await _get(services, layer_project_id=link)


async def test_a_layer_without_a_style_says_so() -> None:
    state = MapState()
    core = map_core(state)

    def no_style(request: httpx.Request) -> httpx.Response:
        response = core.answer(request)
        assert response is not None
        if request.url.path == f"{BASE}/map":
            body = response.json()
            body["styles"].pop("31")
            for entry in body["map"]["layers"]:
                for child in entry.get("children", [entry]):
                    child.pop("style", None)
            return httpx.Response(200, json=body)
        return response

    with pytest.raises(ToolFailed, match="This layer has no style yet."):
        await _get(_Services(state, core=_Proxy(no_style)), layer_project_id=31)


async def test_a_style_of_another_layer_is_refused() -> None:
    state = MapState()
    services = _Services(state)
    with pytest.raises(ToolFailed) as raised:
        await _get(services, layer_project_id=32, style_id=state.active_style_id(31))
    assert raised.value.message == "This style does not belong to the layer."
    # A style id that is no id at all never reaches core.
    before = len(services.core.requests)
    with pytest.raises(ToolFailed, match="This style does not belong to the layer."):
        await _get(services, layer_project_id=32, style_id="active")
    assert not [r for r in services.core.requests[before:] if "/style/" in r.url.path]


async def test_core_refusing_a_locked_layers_style_says_no_access() -> None:
    state = MapState()

    def locked(request: httpx.Request) -> httpx.Response:
        if "/style/" in request.url.path:
            return httpx.Response(403, json={"detail": {"code": "locked"}})
        response = map_core(state).answer(request)
        assert response is not None
        return response

    with pytest.raises(ToolFailed, match="The user has no access to this layer."):
        await _get(_Services(state, core=_Proxy(locked)), layer_project_id=31)


async def test_a_failed_fields_read_gives_the_names_without_types() -> None:
    state = MapState()
    _quantile_districts(state)
    result = await _get(_Services(state, geoapi=Recorder()), layer_project_id=31)
    assert result["fields"] == [{"name": "density"}, {"name": "name"}]


async def test_at_most_three_classifications_are_counted() -> None:
    state = MapState()
    document = _active(state, 33)
    document["classify"] = [
        {
            "id": f"k{n}",
            "field": "line_class",
            "method": "categories",
            "target": f"line.{key}",
            "classes": [{"values": ["metro"], "line": {key: value}}],
        }
        for n, (key, value) in enumerate(
            (("color", "#ff0000"), ("width", 3), ("opacity", 0.5), ("blur", 1))
        )
    ]
    _save(state, 33, document)
    services = _Services(state)
    result = await _get(services, layer_project_id=33)
    assert [n["classification"] for n in result["legend"]] == [
        "/classify/k0",
        "/classify/k1",
        "/classify/k2",
    ]
    assert (
        "first 3" in result["legend_note"] and "/classify/k3" in result["legend_note"]
    )
    # A part in a classification counts that one.
    fourth = await _get(services, layer_project_id=33, part="/classify/k3/classes")
    assert [n["classification"] for n in fourth["legend"]] == ["/classify/k3"]
    assert "legend_note" not in fourth


def _manual(classes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {"field": "density", "method": "manual", "classes": classes},
    ]


def _densities() -> list[float]:
    return [f["density"] for f in map_layer(31).features]


async def _manual_legend(
    classes: list[dict[str, Any]],
) -> tuple[dict[str, Any], _Services]:
    state = MapState()
    document = _active(state, 31)
    document["classify"] = _manual(classes)
    _save(state, 31, document)
    services = _Services(state)
    result = await _get(services, layer_project_id=31)
    return result, services


async def test_an_empty_lowest_and_highest_class_count_zero() -> None:
    """The data under the filter reaches neither the lowest class nor the
    highest: the service drops those breaks and answers fewer bins, and the
    empty classes show as 0."""
    low, high = min(_densities()), max(_densities())
    result, services = await _manual_legend(
        [
            {"to": 100, "fill": {"color": "#ff0000"}},
            {"from": 100, "to": 3000, "fill": {"color": "#00ff00"}},
            {"from": 3000, "to": 20000, "fill": {"color": "#0000ff"}},
            {"from": 20000, "fill": {"color": "#000000"}},
        ]
    )
    assert low > 100 and high < 20000
    [histogram] = services.bodies("histogram")
    assert histogram["custom_breaks"] == [100, 3000, 20000]
    [legend] = result["legend"]
    expected = [
        0,
        sum(d < 3000 for d in _densities()),
        sum(d >= 3000 for d in _densities()),
        0,
    ]
    assert [c["count"] for c in legend["classes"]] == expected
    assert "other" not in legend and "legend_note" not in result
    assert sum(expected) + legend["without_value"] == legend["features"] == 60


async def test_data_outside_manual_classes_shows_as_other() -> None:
    result, services = await _manual_legend(
        [
            {"from": 1000, "to": 2000, "fill": {"color": "#ff0000"}},
            {"from": 2000, "to": 3000, "fill": {"color": "#00ff00"}},
            {"from": 3000, "to": 4000, "fill": {"color": "#0000ff"}},
        ]
    )
    # Every limit of the classes is a break, the outer ones too.
    [histogram] = services.bodies("histogram")
    assert histogram["custom_breaks"] == [1000, 2000, 3000, 4000]
    [legend] = result["legend"]
    bounds = [(1000, 2000), (2000, 3000), (3000, 4000)]
    assert [c["count"] for c in legend["classes"]] == [
        sum(lo <= d < hi for d in _densities()) for lo, hi in bounds
    ]
    assert legend["other"] == sum(d < 1000 or d >= 4000 for d in _densities())
    assert legend["other"] > 0 and "legend_note" not in result


async def test_a_value_on_a_limit_lands_in_the_upper_class() -> None:
    """As the web's legend classifier (``classifier``) reads it: a class
    holds its ``from`` and not its ``to``."""
    densities = sorted(_densities())
    limit = densities[20]
    result, _ = await _manual_legend(
        [
            {"to": limit, "fill": {"color": "#ff0000"}},
            {"from": limit, "fill": {"color": "#00ff00"}},
        ]
    )
    [legend] = result["legend"]
    assert [c["count"] for c in legend["classes"]] == [20, 40]


async def test_numbers_that_do_not_add_up_are_kept_with_a_note() -> None:
    state = MapState()
    _quantile_districts(state)
    processes = _processes()
    count = processes.routes[("POST", "/processes/feature-count/execution")]

    def more(request: httpx.Request) -> httpx.Response:
        body = count(request).json()
        return httpx.Response(200, json={"count": body["count"] + 3})

    processes.routes[("POST", "/processes/feature-count/execution")] = more
    result = await _get(_Services(state, processes=processes), layer_project_id=31)
    [legend] = result["legend"]
    assert legend["features"] == 63
    assert sum(c["count"] for c in legend["classes"]) == 60
    assert (
        result["legend_note"]
        == "The legend numbers do not add up to the feature count."
    )


async def test_an_unreadable_histogram_gives_no_numbers() -> None:
    state = MapState()
    _quantile_districts(state)
    processes = _processes()
    processes.routes[("POST", "/processes/histogram/execution")] = {
        "bins": [{"count": 60}],
        "missing_count": 0,
    }
    result = await _get(_Services(state, processes=processes), layer_project_id=31)
    assert result.get("legend", []) == []
    assert result["legend_note"] == LEGEND_UNAVAILABLE


# ---- the pieces ------------------------------------------------------------------


def test_compact_never_changes_its_input() -> None:
    document = {
        "classify": [
            {
                "id": "k",
                "classes": [{"id": f"c{n}"} for n in range(20)],
                "computed": {"at": "x"},
            }
        ],
        "render": {"classify": {"classes": list(range(13)), "computed": {}}},
    }
    before = copy.deepcopy(document)
    shown, cuts = compact(document)
    assert document == before
    assert [c.model_dump() for c in cuts] == [
        {"path": "/classify/k/classes", "shown": 12, "total": 20},
        {"path": "/render/classify/classes", "shown": 12, "total": 13},
    ]
    assert "computed" not in json.dumps(shown)


@pytest.mark.parametrize(
    ("value", "text"),
    [
        (1, "1"),
        (3.0, "3"),
        (0.5, "0.5"),
        (1e-05, "0.00001"),
        (1e-07, "1e-7"),
        (1.5e21, "1.5e+21"),
        (123456.789, "123456.789"),
        (-0.0, "0"),
    ],
)
def test_numbers_are_written_as_the_map_writes_them(value: float, text: str) -> None:
    assert number_text(value) == text


def test_category_values_match_as_the_map_matches_them() -> None:
    classes = [
        {"values": [1]},
        {"values": ["3.0"]},
        {"values": ["01067"]},
        {"values": [0.5, True]},
        {"values": ["7", "7.0"]},
    ]
    index = class_index(classes)
    # The service writes values as the database's text.
    assert index("1") == 0 and index(1) == 0 and index("1.0") == 0
    assert index("3.0") == 1 and index("3") == 1 and index(3) == 1
    assert index("01067") == 2 and index("1067") is None
    assert index("0.50") == 3 and index("true") == 3
    assert index("7.0") == 4 and index("7") == 4
    assert index("other") is None


async def test_legend_numbers_never_read_a_map_it_was_not_given() -> None:
    """legend_numbers takes the stored document and the layer's filter; it
    reads nothing of core."""
    state = MapState()
    services = _Services(state)
    read = await read_map(services.env, MAP_PROJECT_ID)  # type: ignore[arg-type]
    before = len(services.core.requests)
    numbers, note = await legend_numbers(
        services.env,
        _layer(34),
        read.rows[34]["query"]["cql"],
        state.styles[state.active_style_id(34)].document,
    )
    assert len(services.core.requests) == before
    assert note is None and numbers[0].classification == "/classify/use"


# ---- the skill is read before a change -------------------------------------------


async def test_a_read_without_the_skill_says_to_load_it_first() -> None:
    services = _Services(MapState())
    services.env.skills = set()
    result = await _get(services, layer_project_id=31)
    assert result["note"] == SKILL_FIRST
    assert SKILL_FIRST == (
        "Before you change this style, load the skill style-a-map with "
        "skills_load: it holds the forms and the rules."
    )
    # Every read says it until the skill is loaded.
    assert (await _get(services, layer_project_id=32))["note"] == SKILL_FIRST


async def test_a_skill_loaded_in_this_answer_or_earlier_drops_the_note() -> None:
    services = _Services(MapState())
    services.env.skills = set()
    loaded = await execute(SKILLS_LOAD, services.env, {"name": "style-a-map"})
    assert loaded["name"] == "style-a-map"
    assert services.env.skills == {"style-a-map"}
    assert "note" not in await _get(services, layer_project_id=31)
    # A reference file alone is not the skill's instructions.
    services.env.skills = set()
    await execute(
        SKILLS_LOAD, services.env, {"name": "style-a-map", "file": "rasters.md"}
    )
    assert services.env.skills == set()
    # Without a conversation (skills None) there is nothing to say.
    services.env.skills = None
    assert "note" not in await _get(services, layer_project_id=31)
