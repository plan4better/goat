"""The read-only project pack (spec §7.2, §9.1.1) against recorded services."""

import json
from datetime import datetime
from typing import Any, get_args
from uuid import UUID

import httpx
import pytest
from pydantic_ai.exceptions import ToolFailed
from pygeofilter.util import parse_datetime

from assistant.context import parse_context
from assistant.login import StaticLogin
from assistant.tools import project
from assistant.tools.filters import (
    CONDITION_EXAMPLE,
    FILTER_EXAMPLES,
    FeatureFilter,
    to_cql2,
)
from assistant.tools.http import SIGN_IN_EXPIRED
from assistant.tools.project import (
    AREA_STATISTICS,
    COUNT_FEATURES,
    FIELD_STATISTICS,
    GET_FIELDS,
    GET_LAYERS,
    PROJECT_SURFACES,
    PROJECT_TOOLS,
    SAMPLE_FEATURES,
    STILL_COPYING,
)
from assistant.tools.runtime import MAX_RESULT_BYTES, InputInvalid, ToolEnv, execute
from assistant.tools.testing import Recorder, fake_clients, signed_in, tool_env

PROJECT = UUID(int=500)
LINES = "11111111-1111-1111-1111-111111111111"
POLYGONS = "22222222-2222-2222-2222-222222222222"
LOCKED = "33333333-3333-3333-3333-333333333333"
LAYERS = [
    {
        "id": 11,
        "layer_id": LINES,
        "name": "Radwege",
        "type": "feature",
        "feature_layer_geometry_type": "line",
        "layer_project_group_id": 1,
        "order": 0,
        "locked": False,
        "query": {"cql": {"op": "=", "args": [{"property": "art"}, "Radweg"]}},
    },
    {
        "id": 12,
        "layer_id": POLYGONS,
        "name": "Bezirke",
        "type": "feature",
        "feature_layer_geometry_type": "polygon",
        "layer_project_group_id": None,
        "order": 1,
        "locked": False,
    },
    {
        "id": 13,
        "layer_id": LOCKED,
        "name": "Private Daten",
        "type": "feature",
        "feature_layer_geometry_type": "point",
        "layer_project_group_id": None,
        "order": 2,
        "locked": True,
    },
]
QUERYABLES = {
    "properties": {
        "art": {"name": "art", "type": "string"},
        "laenge": {"name": "laenge", "type": "number"},
        "separation": {"name": "separation", "type": "string"},
        "notiz": {"name": "notiz", "type": "string"},
        "aktiv": {"name": "aktiv", "type": "boolean"},
        "erfasst": {"name": "erfasst", "type": "string", "format": "date-time"},
        "tags": {"name": "tags", "type": "array"},
        "geom": {"$ref": "https://geojson.org/schema/Geometry.json"},
    }
}


#: Core's map request of a project whose map document lists no layer yet:
#: the layers come in core's order, without map state.
EMPTY_MAP = {"map": {"version": "1.0.0", "layers": []}, "styles": {}, "unpublished": []}


def _core() -> Recorder:
    base = f"/api/v2/project/{PROJECT}"
    return Recorder(
        {
            ("GET", base): {"id": str(PROJECT), "name": "Berlin cycling study"},
            ("GET", f"{base}/layer"): LAYERS,
            ("GET", f"{base}/group"): [
                {"id": 1, "name": "Verkehr", "parent_id": None, "order": 0}
            ],
            ("GET", f"{base}/map"): EMPTY_MAP,
        }
    )


def _geoapi() -> Recorder:
    items = {
        "type": "FeatureCollection",
        "numberMatched": 240,
        "features": [
            {
                "type": "Feature",
                "id": 1,
                "geometry": {"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
                "properties": {"art": "Radweg", "laenge": 1.5, "notiz": "x" * 500},
            },
        ],
    }
    return Recorder(
        {
            ("GET", f"/collections/{LINES}/queryables"): QUERYABLES,
            ("GET", f"/collections/{POLYGONS}/queryables"): QUERYABLES,
            ("GET", f"/collections/{LINES}/items"): items,
        }
    )


def _counts_empty(raw: str | None) -> bool:
    """Whether a count's filter is ``isNull(field)``, alone or added last
    under ``and``, as the statistics count the features without a value."""
    cql = json.loads(raw) if raw else {}
    last = cql["args"][-1] if cql.get("op") == "and" else cql
    return isinstance(last, dict) and last.get("op") == "isNull"


def _processes(
    unique_total: int = 7,
    *,
    filtered_total: int | None = None,
    count: int = 42,
    empty: int = 0,
    extent: list[float] | None = None,
) -> Recorder:
    """``filtered_total``: the distinct count unique-values reports for a
    filtered request (``unique_total`` is the unfiltered one). ``empty``: the
    features a count with ``isNull`` in its filter finds, and the histogram's
    ``missing_count`` (``count`` is every feature)."""

    def answer(process: str) -> Any:
        def respond(request: httpx.Request) -> httpx.Response:
            inputs = json.loads(request.content)["inputs"]
            if process == "feature-count":
                found = empty if _counts_empty(inputs.get("filter")) else count
                return httpx.Response(200, json={"count": found})
            if process == "histogram":
                return httpx.Response(
                    200,
                    json={"bins": [], "missing_count": empty, "total_rows": count},
                )
            if process == "class-breaks":
                return httpx.Response(
                    200,
                    json={
                        "attribute": inputs["attribute"],
                        "method": inputs["method"],
                        # As goatlib does: exactly `breaks` internal break
                        # points, which make breaks + 1 classes.
                        "breaks": [float(i + 1) for i in range(inputs["breaks"])],
                        "min": 0.1,
                        "max": 9.9,
                        "mean": 2.5,
                        "std_dev": 1.2,
                    },
                )
            if process == "unique-values":
                total = (
                    filtered_total
                    if "filter" in inputs and filtered_total is not None
                    else unique_total
                )
                # The first names are the categories the tests filter by.
                names = ["Radweg", "Max", "X", "Park"]
                values = [
                    {"value": names[i] if i < len(names) else f"v{i}", "count": 100 - i}
                    for i in range(min(total, inputs["limit"]))
                ]
                return httpx.Response(
                    200,
                    json={
                        "attribute": inputs["attribute"],
                        "total": total,
                        "values": values,
                    },
                )
            if process == "area-statistics":
                result = {"sum": 5000.0, "min": 10.0, "max": 900.0}[inputs["operation"]]
                return httpx.Response(
                    200,
                    json={
                        "result": result,
                        "total_area": 5000.0,
                        "feature_count": 12,
                        "unit": "m²",
                    },
                )
            if process == "aggregation-stats":
                # One group per distinct value, as many as the limit allows.
                return httpx.Response(
                    200,
                    json={
                        "items": [
                            {
                                "grouped_value": f"v{i}",
                                "grouped_secondary_value": None,
                                "operation_value": float(100 - i),
                            }
                            for i in range(min(unique_total, inputs["limit"]))
                        ],
                        "total_items": unique_total,
                        "total_count": count,
                    },
                )
            if process == "extent":
                return httpx.Response(
                    200,
                    json={
                        "bbox": extent or [13.08, 52.33, 13.76, 52.67],
                        "feature_count": 12,
                    },
                )
            raise AssertionError(process)

        return respond

    return Recorder(
        {
            ("POST", f"/processes/{name}/execution"): answer(name)
            for name in (
                "feature-count",
                "histogram",
                "class-breaks",
                "unique-values",
                "area-statistics",
                "aggregation-stats",
                "extent",
            )
        }
    )


MAP_PAGE = parse_context({"surface": "project.map", "project_id": str(PROJECT)})


def _env(
    core: Recorder, geoapi: Recorder, processes: Recorder, **fields: Any
) -> ToolEnv:
    fields.setdefault("page", MAP_PAGE)
    return tool_env(
        fake_clients(core=core, geoapi=geoapi, processes=processes), **fields
    )


async def test_get_layers_names_layers_and_groups_with_the_users_token() -> None:
    core = _core()
    env = _env(core, _geoapi(), _processes(), login=StaticLogin("user-token"))
    result = await execute(GET_LAYERS, env, {})
    assert result["name"] == "Berlin cycling study"
    assert [layer["name"] for layer in result["layers"]] == [
        "Radwege",
        "Bezirke",
        "Private Daten",
    ]
    assert result["layers"][0]["group"] == "Verkehr"
    assert result["layers"][0]["filter"] == {
        "match": "all",
        "rows": [{"row": 1, "text": 'art is "Radweg"', "on": True}],
    }
    assert result["layers"][2]["locked"] is True
    assert {r.headers["Authorization"] for r in core.requests} == {"Bearer user-token"}


async def test_the_project_defaults_to_the_open_one_and_must_exist_somewhere() -> None:
    env = _env(_core(), _geoapi(), _processes(), page=parse_context(None))
    with pytest.raises(InputInvalid, match="pass project_id"):
        await execute(GET_LAYERS, env, {})
    assert (await execute(GET_LAYERS, env, {"project_id": str(PROJECT)}))[
        "name"
    ] == "Berlin cycling study"


async def test_locked_layer_is_never_sent_to_the_services() -> None:
    """Review Focus 1: processes and geoapi do not check per layer, so a layer
    the user cannot read must not reach them at all."""
    geoapi, processes = _geoapi(), _processes()
    env = _env(_core(), geoapi, processes)
    for spec, args in [
        (COUNT_FEATURES, {}),
        (GET_FIELDS, {}),
        (SAMPLE_FEATURES, {}),
        (FIELD_STATISTICS, {"field": "art"}),
        (AREA_STATISTICS, {}),
    ]:
        with pytest.raises(ToolFailed, match="no access to its data"):
            await execute(spec, env, {"layer_project_id": 13, **args})
    assert geoapi.requests == [] and processes.requests == []


async def test_an_unknown_layer_is_a_fixable_error() -> None:
    env = _env(_core(), _geoapi(), _processes())
    with pytest.raises(InputInvalid, match="project_get_layers"):
        await execute(COUNT_FEATURES, env, {"layer_project_id": 99})


async def test_count_sends_the_layer_and_a_checked_filter() -> None:
    processes = _processes()
    env = _env(_core(), _geoapi(), processes)
    result = await execute(
        COUNT_FEATURES,
        env,
        {
            "layer_project_id": 11,
            "filter": {
                "match": "all",
                "conditions": [
                    {"field": "art", "op": "!=", "value": "Weg"},
                    {"field": "laenge", "op": ">", "value": 2},
                    {"field": "separation", "op": "is_null"},
                ],
            },
        },
    )
    assert result == {
        "layer": "Radwege",
        "filter": "art != 'Weg' and laenge > 2 and separation is null",
        "count": 42,
    }
    [body] = processes.bodies()
    assert body["inputs"]["collection"] == LINES
    assert json.loads(body["inputs"]["filter"]) == {
        "op": "and",
        "args": [
            {
                "op": "or",
                "args": [
                    {"op": "<>", "args": [{"property": "art"}, "Weg"]},
                    {"op": "isNull", "args": [{"property": "art"}]},
                ],
            },
            {"op": ">", "args": [{"property": "laenge"}, 2]},
            {
                "op": "or",
                "args": [
                    {"op": "isNull", "args": [{"property": "separation"}]},
                    {"op": "=", "args": [{"property": "separation"}, ""]},
                ],
            },
        ],
    }


@pytest.mark.parametrize("encodings", [1, 2])
async def test_a_filter_sent_as_json_text_counts_like_the_object(
    encodings: int,
) -> None:
    """Some models send the filter object as JSON text, sometimes encoded twice;
    refusing it made them give up without a number."""
    sent: Any = {"conditions": [{"field": "laenge", "op": ">", "value": 2}]}
    for _ in range(encodings):
        sent = json.dumps(sent)
    processes = _processes()
    env = _env(_core(), _geoapi(), processes)
    result = await execute(
        COUNT_FEATURES, env, {"layer_project_id": 11, "filter": sent}
    )
    assert result["filter"] == "laenge > 2"
    [body] = processes.bodies()
    assert json.loads(body["inputs"]["filter"]) == {
        "op": ">",
        "args": [{"property": "laenge"}, 2],
    }


async def test_misspelled_field_is_a_fixable_error_and_nothing_is_counted() -> None:
    """Review Focus 2: processes counts everything for a filter it cannot parse."""
    processes = _processes()
    env = _env(_core(), _geoapi(), processes)
    with pytest.raises(InputInvalid) as caught:
        await execute(
            COUNT_FEATURES,
            env,
            {
                "layer_project_id": 11,
                "filter": {
                    "conditions": [{"field": "seperation", "op": "=", "value": "x"}]
                },
            },
        )
    assert (
        caught.value.message
        == "Field 'seperation' doesn't exist on this layer. Did you mean 'separation'?"
    )
    with pytest.raises(InputInvalid, match="numeric"):
        await execute(
            COUNT_FEATURES,
            env,
            {
                "layer_project_id": 11,
                "filter": {
                    "conditions": [{"field": "laenge", "op": ">", "value": "lang"}]
                },
            },
        )
    assert processes.requests == []


async def test_values_must_fit_the_field_type() -> None:
    """Review Focus 2: a value of the wrong type is a fixable error, never sent."""
    processes = _processes()
    env = _env(_core(), _geoapi(), processes)

    def where(*conditions: dict[str, Any]) -> dict[str, Any]:
        return {"layer_project_id": 11, "filter": {"conditions": list(conditions)}}

    for condition, message in [
        ({"field": "art", "op": "=", "value": 3}, "is text"),
        ({"field": "laenge", "op": "in", "value": [1, "zwei"]}, "numeric"),
        ({"field": "aktiv", "op": ">", "value": True}, "true or false"),
        ({"field": "erfasst", "op": ">=", "value": "letzte Woche"}, "ISO 8601"),
        ({"field": "erfasst", "op": ">=", "value": 20240501}, "ISO 8601"),
        ({"field": "tags", "op": "=", "value": "x"}, "cannot be used in a filter"),
        ({"field": "laenge", "op": "like", "value": "1%"}, "text fields"),
    ]:
        with pytest.raises(InputInvalid, match=message):
            await execute(COUNT_FEATURES, env, where(condition))
    assert processes.requests == []

    await execute(
        COUNT_FEATURES,
        env,
        where(
            {"field": "erfasst", "op": ">=", "value": "2024-05-01T00:00:00Z"},
            {"field": "aktiv", "op": "=", "value": True},
            {"field": "laenge", "op": "in", "value": [1, 2.5]},
        ),
    )
    assert json.loads(processes.bodies()[0]["inputs"]["filter"])["args"] == [
        {
            "op": ">=",
            "args": [
                {"property": "erfasst"},
                {"timestamp": "2024-05-01T00:00:00+00:00"},
            ],
        },
        {"op": "=", "args": [{"property": "aktiv"}, True]},
        {"op": "in", "args": [{"property": "laenge"}, [1, 2.5]]},
    ]


async def test_date_times_are_sent_normalized() -> None:
    """The compact and week forms are accepted but sent as plain isoformat: the
    CQL2 parser downstream reads "2024-W18-3" as a different day."""
    processes = _processes()
    env = _env(_core(), _geoapi(), processes)
    sent = []
    for value in ["20240501", "2024-W18-3", "2024-05-01", "2024-05-01T10:00"]:
        await execute(
            COUNT_FEATURES,
            env,
            {
                "layer_project_id": 11,
                "filter": {
                    "conditions": [{"field": "erfasst", "op": ">=", "value": value}]
                },
            },
        )
        sent.append(
            json.loads(processes.bodies()[-1]["inputs"]["filter"])["args"][1][
                "timestamp"
            ]
        )
    assert sent == [
        "2024-05-01T00:00:00",
        "2024-05-01T00:00:00",
        "2024-05-01T00:00:00",
        "2024-05-01T10:00:00",
    ]
    # What goes out is what the downstream parser reads back unchanged.
    assert [parse_datetime(text) for text in sent] == [
        datetime(2024, 5, 1),
        datetime(2024, 5, 1),
        datetime(2024, 5, 1),
        datetime(2024, 5, 1, 10),
    ]


async def test_not_null_and_any_compile() -> None:
    processes = _processes()
    env = _env(_core(), _geoapi(), processes)
    await execute(
        COUNT_FEATURES,
        env,
        {
            "layer_project_id": 11,
            "filter": {
                "match": "any",
                "conditions": [
                    {"field": "notiz", "op": "is_not_null"},
                    {"field": "art", "op": "like", "value": "Rad%"},
                ],
            },
        },
    )
    assert json.loads(processes.bodies()[0]["inputs"]["filter"]) == {
        "op": "or",
        "args": [
            {
                "op": "and",
                "args": [
                    {
                        "op": "not",
                        "args": [{"op": "isNull", "args": [{"property": "notiz"}]}],
                    },
                    {"op": "<>", "args": [{"property": "notiz"}, ""]},
                ],
            },
            {"op": "like", "args": [{"property": "art"}, "Rad%"]},
        ],
    }


def test_contains_matches_text_anywhere() -> None:
    # The services' LIKE takes no escape character: a % or _ in the text stays
    # a wildcard, so it is sent as it is.
    cql = to_cql2(
        FeatureFilter.model_validate(
            {"conditions": [{"field": "name", "op": "contains", "value": "50%_off"}]}
        ),
        {"name": "string"},
    )
    assert cql == {"op": "like", "args": [{"property": "name"}, "%50%_off%"]}


def test_the_operator_description_names_contains() -> None:
    schema = COUNT_FEATURES.json_schema()["$defs"]["Condition"]["properties"]["op"]
    assert "contains" in schema["enum"]
    assert "'contains'" in schema["description"]


def test_contains_needs_a_text_field() -> None:
    with pytest.raises(InputInvalid, match="text"):
        to_cql2(
            FeatureFilter.model_validate(
                {"conditions": [{"field": "n", "op": "contains", "value": "1"}]}
            ),
            {"n": "integer"},
        )


async def test_project_tools_filter_with_contains() -> None:
    processes = _processes()
    env = _env(_core(), _geoapi(), processes)
    await execute(
        COUNT_FEATURES,
        env,
        {
            "layer_project_id": 11,
            "filter": {
                "conditions": [{"field": "art", "op": "contains", "value": "weg"}]
            },
        },
    )
    assert json.loads(processes.bodies()[0]["inputs"]["filter"]) == {
        "op": "like",
        "args": [{"property": "art"}, "%weg%"],
    }


async def test_fields_say_which_can_be_filtered() -> None:
    result = await execute(
        GET_FIELDS, _env(_core(), _geoapi(), _processes()), {"layer_project_id": 11}
    )
    by_name = {field["name"]: field for field in result["fields"]}
    assert by_name["erfasst"] == {
        "name": "erfasst",
        "type": "date-time",
        "filterable": True,
    }
    assert by_name["tags"]["filterable"] is False
    assert "geom" not in by_name


@pytest.mark.parametrize(
    "login", [StaticLogin(None), signed_in(-60)], ids=["no token", "expired token"]
)
async def test_an_expired_sign_in_is_named(login: StaticLogin) -> None:
    core = Recorder(
        {
            ("GET", f"/api/v2/project/{PROJECT}/layer"): httpx.Response(
                401, json={"detail": "x"}
            )
        }
    )
    with pytest.raises(ToolFailed, match="sign-in expired") as caught:
        await execute(
            COUNT_FEATURES,
            _env(core, _geoapi(), _processes(), login=login),
            {"layer_project_id": 11},
        )
    assert caught.value.message == SIGN_IN_EXPIRED


@pytest.mark.parametrize("status", [401, 403, 404])
async def test_a_project_the_user_cannot_open_is_named(status: int) -> None:
    """Core answers 401 also when its authorization denies the request: with
    a token that is still valid, that is no access, not an expired sign-in."""
    core = Recorder(
        {
            ("GET", f"/api/v2/project/{PROJECT}/layer"): httpx.Response(
                status, json={"detail": "x"}
            )
        }
    )
    with pytest.raises(ToolFailed) as caught:
        await execute(
            COUNT_FEATURES,
            _env(core, _geoapi(), _processes(), login=signed_in(300)),
            {"layer_project_id": 11},
        )
    assert caught.value.message == (
        "The project does not exist or the user cannot open it."
    )


@pytest.mark.parametrize("status", ["pending", "running"])
async def test_a_layer_being_copied_says_so(status: str) -> None:
    copying = {
        "id": 7,
        "layer_id": str(UUID(int=7)),
        "name": "Stops",
        "type": "feature",
        "feature_layer_geometry_type": "point",
        "other_properties": {"catalog_materialize": {"status": status}},
    }
    geoapi = _geoapi()
    with pytest.raises(ToolFailed, match="still being copied") as caught:
        await execute(
            COUNT_FEATURES,
            _env(_core_with([copying]), geoapi, _processes()),
            {"layer_project_id": 7},
        )
    assert caught.value.message == STILL_COPYING
    assert geoapi.requests == []


def _copying_then(statuses: list[str | None]) -> Recorder:
    """A core whose layer 7 is a catalog copy with the next of ``statuses``
    at each listing of the project's layers (the last one stays)."""
    core = _core_with([])
    listed = 0

    def layers(request: httpx.Request) -> httpx.Response:
        nonlocal listed
        status = statuses[min(listed, len(statuses) - 1)]
        listed += 1
        row = {
            "id": 7,
            "layer_id": LINES,
            "name": "Stops",
            "type": "feature",
            "feature_layer_geometry_type": "point",
            "other_properties": {"catalog_materialize": {"status": status}},
        }
        return httpx.Response(200, json=[row])

    core.routes[("GET", f"/api/v2/project/{PROJECT}/layer")] = layers
    return core


def _layer_listings(core: Recorder) -> int:
    return core.paths().count(f"/api/v2/project/{PROJECT}/layer")


async def test_the_fields_of_a_layer_being_copied_are_read_once_it_is_ready(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """project_get_fields waits a little for a copy that is under way: a
    workflow is written from the fields, and each read the model makes again
    resends the whole answer."""
    monkeypatch.setattr(project, "COPY_POLL_SECONDS", 0)
    core = _copying_then(["pending", "running", "ready"])
    result = await execute(
        GET_FIELDS, _env(core, _geoapi(), _processes()), {"layer_project_id": 7}
    )
    assert result["fields"]
    assert _layer_listings(core) == 3


async def test_a_copy_that_takes_longer_still_says_so(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The wait is bounded: then the read says the layer is still being
    copied, and the other reads do not wait."""
    assert project.COPY_POLLS * project.COPY_POLL_SECONDS <= 30
    monkeypatch.setattr(project, "COPY_POLL_SECONDS", 0)
    core = _copying_then(["running"])
    geoapi = _geoapi()
    with pytest.raises(ToolFailed) as caught:
        await execute(
            GET_FIELDS, _env(core, geoapi, _processes()), {"layer_project_id": 7}
        )
    assert caught.value.message == STILL_COPYING
    assert _layer_listings(core) == project.COPY_POLLS + 1
    assert geoapi.requests == []
    counting = _copying_then(["running"])
    with pytest.raises(ToolFailed):
        await execute(
            COUNT_FEATURES,
            _env(counting, _geoapi(), _processes()),
            {"layer_project_id": 7},
        )
    assert _layer_listings(counting) == 1


@pytest.mark.parametrize("status", ["ready", "failed", None])
async def test_a_copied_layer_is_read(status: str | None) -> None:
    row = {
        "id": 7,
        "layer_id": LINES,
        "name": "Stops",
        "type": "feature",
        "feature_layer_geometry_type": "point",
        "other_properties": {"catalog_materialize": {"status": status}},
    }
    result = await execute(
        COUNT_FEATURES,
        _env(_core_with([row]), _geoapi(), _processes()),
        {"layer_project_id": 7},
    )
    assert result["count"] == 42


async def test_home_needs_an_explicit_project() -> None:
    """Decision T16: on Home the project tools work with an explicit project_id."""
    env = _env(_core(), _geoapi(), _processes(), page=parse_context(None))
    with pytest.raises(InputInvalid, match="core_find"):
        await execute(COUNT_FEATURES, env, {"layer_project_id": 11})
    result = await execute(
        COUNT_FEATURES, env, {"project_id": str(PROJECT), "layer_project_id": 11}
    )
    assert result["count"] == 42


async def test_numeric_statistics() -> None:
    processes = _processes()
    standard = await execute(
        FIELD_STATISTICS,
        _env(_core(), _geoapi(), processes),
        {"layer_project_id": 11, "field": "laenge"},
    )
    assert standard["kind"] == "numeric"
    assert (
        standard["min"],
        standard["max"],
        standard["mean"],
        standard["std_dev"],
    ) == (0.1, 9.9, 2.5, 1.2)
    assert (
        standard["breaks"] == [1.0, 2.0, 3.0, 4.0, 5.0]
        and standard["method"] == "quantile"
    )
    assert _calls(processes, "class-breaks") == [
        {
            "collection": LINES,
            "attribute": "laenge",
            "method": "quantile",
            "breaks": 5,
        }
    ]


async def test_categorical_statistics_list_the_most_frequent_values() -> None:
    many = await execute(
        FIELD_STATISTICS,
        _env(_core(), _geoapi(), _processes(unique_total=120)),
        {"layer_project_id": 11, "field": "art"},
    )
    assert many["kind"] == "categorical" and many["distinct_count"] == 120
    assert len(many["values"]) == 50


async def test_area_statistics_for_polygons_only() -> None:
    processes = _processes()
    result = await execute(
        AREA_STATISTICS, _env(_core(), _geoapi(), processes), {"layer_project_id": 12}
    )
    assert result == {
        "layer": "Bezirke",
        "filter": "none (all features)",
        "feature_count": 12,
        "total_area": 5000.0,
        "mean_area": 5000.0 / 12,
        "min_area": 10.0,
        "max_area": 900.0,
        "unit": "m²",
    }
    assert sorted(body["inputs"]["operation"] for body in processes.bodies()) == [
        "max",
        "min",
        "sum",
    ]
    with pytest.raises(ToolFailed, match="polygon"):
        await execute(
            AREA_STATISTICS,
            _env(_core(), _geoapi(), _processes()),
            {"layer_project_id": 11},
        )


def _areas_by_district(*, null_group: bool = False) -> tuple[Recorder, Recorder]:
    """geoapi with a ``district`` field on the polygon layer, and processes
    answering area-statistics per district when asked to group by it;
    ``null_group`` adds the group of features without a district."""
    queryables = {
        "properties": {
            **QUERYABLES["properties"],
            "district": {"name": "district", "type": "string"},
        }
    }
    geoapi = Recorder({("GET", f"/collections/{POLYGONS}/queryables"): queryables})

    def area(request: httpx.Request) -> httpx.Response:
        inputs = json.loads(request.content)["inputs"]
        body: dict[str, Any] = {
            "result": 30.0,
            "total_area": 30.0,
            "feature_count": 3,
            "unit": "m²",
            "groups": [],
            "total_groups": None,
        }
        if inputs.get("group_by_column") == "district":
            body["groups"] = [
                {
                    "grouped_value": "A",
                    "result": 20.0,
                    "total_area": 20.0,
                    "feature_count": 2,
                },
                {
                    "grouped_value": "B",
                    "result": 10.0,
                    "total_area": 10.0,
                    "feature_count": 1,
                },
            ]
            body["total_groups"] = 2
            if null_group:
                body["groups"].append(
                    {
                        "grouped_value": None,
                        "result": 5.0,
                        "total_area": 5.0,
                        "feature_count": 1,
                    }
                )
                body["total_groups"] = 3
        return httpx.Response(200, json=body)

    processes = Recorder({("POST", "/processes/area-statistics/execution"): area})
    return geoapi, processes


async def test_area_per_group() -> None:
    """One area row per value of the group field, from one processes call."""
    geoapi, processes = _areas_by_district()
    out = await execute(
        AREA_STATISTICS,
        _env(_core(), geoapi, processes),
        {"layer_project_id": 12, "group_by": "district"},
    )
    assert [(g["group"], g["total_area"], g["mean_area"]) for g in out["groups"]] == [
        ("A", 20.0, 10.0),
        ("B", 10.0, 10.0),
    ]
    assert [g["feature_count"] for g in out["groups"]] == [2, 1]
    assert out["groups_total"] == 2
    assert out["total_area"] == 30.0
    # Only the sum is grouped; the smallest and largest stay whole-layer, and
    # no empty group column is ever sent.
    calls = _calls(processes, "area-statistics")
    assert {c["operation"]: c.get("group_by_column") for c in calls} == {
        "sum": "district",
        "min": None,
        "max": None,
    }
    assert sum("group_by_column" in c for c in calls) == 1


async def test_area_of_features_without_a_group_value_is_named() -> None:
    """The row of features without a value carries no group key, so it could
    pass for a total: the note names the field."""
    geoapi, processes = _areas_by_district(null_group=True)
    out = await execute(
        AREA_STATISTICS,
        _env(_core(), geoapi, processes),
        {"layer_project_id": 12, "group_by": "district"},
    )
    assert "group" not in out["groups"][-1] and out["groups_total"] == 3
    assert "no value in 'district'" in out["note"]


async def test_area_without_group_by_sends_no_group_column() -> None:
    geoapi, processes = _areas_by_district()
    out = await execute(
        AREA_STATISTICS, _env(_core(), geoapi, processes), {"layer_project_id": 12}
    )
    assert "groups" not in out and "groups_total" not in out
    assert not any("group_by_column" in c for c in _calls(processes, "area-statistics"))


async def test_area_per_group_needs_a_field_of_the_layer() -> None:
    geoapi, processes = _areas_by_district()
    with pytest.raises(InputInvalid, match="distrikt"):
        await execute(
            AREA_STATISTICS,
            _env(_core(), geoapi, processes),
            {"layer_project_id": 12, "group_by": "distrikt"},
        )
    assert processes.requests == []


async def test_sample_features_are_bounded_and_carry_no_geometry() -> None:
    geoapi = _geoapi()
    result = await execute(
        SAMPLE_FEATURES,
        _env(_core(), geoapi, _processes()),
        {"layer_project_id": 11, "fields": ["art", "notiz"], "limit": 50},
    )
    [feature] = result["features"]
    assert set(feature) == {"feature_id", "properties"}
    assert len(feature["properties"]["notiz"]) == 201
    items_request = geoapi.requests[-1]
    assert items_request.url.path == f"/collections/{LINES}/items"
    assert dict(items_request.url.params) == {"limit": "10", "properties": "art,notiz"}
    assert result["number_matched"] == 240


async def test_a_sample_names_the_row_id_apart_from_an_id_field() -> None:
    """The row id GOAT gives a feature and a field of the data named ``id``
    are different numbers: a filter on the field must not get the row id."""
    stops = {
        "type": "FeatureCollection",
        "numberMatched": 1,
        "features": [
            {
                "type": "Feature",
                "id": "128989",
                "geometry": None,
                "properties": {"id": 251821, "feature_id": "x7", "art": "Bahnhof"},
            }
        ],
    }
    geoapi = Recorder(
        {
            ("GET", f"/collections/{LINES}/queryables"): QUERYABLES,
            ("GET", f"/collections/{LINES}/items"): stops,
        }
    )
    result = await execute(
        SAMPLE_FEATURES, _env(_core(), geoapi, _processes()), {"layer_project_id": 11}
    )
    [feature] = result["features"]
    assert feature == {
        "feature_id": "128989",
        "properties": {"id": 251821, "feature_id": "x7", "art": "Bahnhof"},
    }
    assert "feature_id" in SAMPLE_FEATURES.description


async def test_unique_values_come_back_as_text() -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "attribute": "aktiv",
                "total": 2,
                "values": [{"value": True, "count": 3}, {"value": 7, "count": 1}],
            },
        )

    processes = Recorder(
        {
            ("POST", "/processes/unique-values/execution"): respond,
            ("POST", "/processes/feature-count/execution"): {"count": 4},
        }
    )
    result = await execute(
        FIELD_STATISTICS,
        _env(_core(), _geoapi(), processes),
        {"layer_project_id": 11, "field": "aktiv"},
    )
    assert result["values"] == [
        {"value": "True", "count": 3},
        {"value": "7", "count": 1},
    ]
    assert "text" in FIELD_STATISTICS.description


def test_breaks_are_described_as_break_points() -> None:
    description = FIELD_STATISTICS.json_schema()["properties"]["breaks"]["description"]
    assert (
        description
        == "Number of class break points (the values form breaks + 1 classes)."
    )


def test_every_project_argument_is_described() -> None:
    for spec in PROJECT_TOOLS:
        schema = spec.json_schema()
        groups = [schema, *schema.get("$defs", {}).values()]
        for group in groups:
            for name, sub in group.get("properties", {}).items():
                assert "description" in sub, f"{spec.wire_name}.{name}"


def test_every_filtered_read_takes_the_saved_filter_as_drawn() -> None:
    """The tools that take a filter take as_drawn, false by default; the
    count and the statistics point to it in one sentence."""
    filtered = [
        spec
        for spec in PROJECT_TOOLS
        if issubclass(spec.input_model, project.FilteredLayerInput)
    ]
    assert {spec.wire_name for spec in filtered} == {
        "project_count_features",
        "project_field_statistics",
        "project_group_statistics",
        "project_area_statistics",
        "project_sample_features",
    }
    for spec in filtered:
        drawn = spec.json_schema()["properties"]["as_drawn"]
        assert drawn["default"] is False, spec.wire_name
        assert "rows and area that are switched on" in drawn["description"]
    for spec in (
        project.COUNT_FEATURES,
        project.FIELD_STATISTICS,
        project.GROUP_STATISTICS,
    ):
        description = " ".join(spec.description.split())
        assert (
            "The layer's saved filter in the project applies only with as_drawn true"
            in description
        ), spec.wire_name
        assert "pass it as a filter" not in description, spec.wire_name


def test_the_pack_loads_where_projects_are_read() -> None:
    assert PROJECT_SURFACES == {
        "project.map",
        "project.workflows",
        "project.layouts",
        "project.dashboard",
        "none",
    }
    for spec in PROJECT_TOOLS:
        assert spec.surfaces == PROJECT_SURFACES, spec.wire_name


def _where(field: str, op: str, value: Any) -> dict[str, Any]:
    return {"conditions": [{"field": field, "op": op, "value": value}]}


async def test_layers_carry_their_filter() -> None:
    result = await execute(GET_LAYERS, _env(_core(), _geoapi(), _processes()), {})
    first, second = result["layers"][:2]
    assert [row["text"] for row in first["filter"]["rows"]] == ['art is "Radweg"']
    assert "filter" not in second


async def test_filtered_statistics_ask_for_the_values_once() -> None:
    processes = _processes()
    await execute(
        FIELD_STATISTICS,
        _env(_core(), _geoapi(), processes),
        {
            "layer_project_id": 11,
            "field": "art",
            "filter": _where("separation", "=", "Max"),
        },
    )
    assert len(_calls(processes, "unique-values")) == 1


@pytest.mark.parametrize("valued", [1, 4])
async def test_extremes_of_a_small_layer_are_sent(valued: int) -> None:
    """However few features a layer has, its minimum and maximum are read in
    one call and sent."""
    processes = _processes(count=valued)
    result = await execute(
        FIELD_STATISTICS,
        _env(_core(), _geoapi(), processes),
        {"layer_project_id": 11, "field": "laenge"},
    )
    assert (result["min"], result["max"]) == (0.1, 9.9)
    assert len(_calls(processes, "class-breaks")) == 1


async def test_a_missing_distinct_total_is_an_error() -> None:
    def no_total(request: httpx.Request) -> httpx.Response:
        values = [{"value": "a", "count": 1}]
        return httpx.Response(200, json={"attribute": "art", "values": values})

    processes = Recorder(
        {
            ("POST", "/processes/unique-values/execution"): no_total,
            ("POST", "/processes/feature-count/execution"): {"count": 4},
        }
    )
    env = _env(_core(), _geoapi(), processes)
    with pytest.raises(ToolFailed, match="distinct count"):
        await execute(FIELD_STATISTICS, env, {"layer_project_id": 11, "field": "art"})


# -- what the statistics tools ask processes for ---------------------------------


def _calls(processes: Recorder, process: str) -> list[dict[str, Any]]:
    return [
        body["inputs"]
        for body, request in zip(processes.bodies(), processes.requests, strict=True)
        if request.url.path == f"/processes/{process}/execution"
    ]


async def test_numeric_statistics_ask_for_the_breaks_once() -> None:
    processes = _processes(count=8)
    result = await execute(
        FIELD_STATISTICS,
        _env(_core(), _geoapi(), processes),
        {"layer_project_id": 11, "field": "laenge", "breaks": 10},
    )
    assert len(_calls(processes, "class-breaks")) == 1
    assert _calls(processes, "class-breaks")[0]["breaks"] == 10
    assert result["breaks"] == [float(i + 1) for i in range(10)]
    assert "note" not in result


@pytest.mark.parametrize(
    ("method", "sent", "answered"),
    [
        ("quantile", "quantile", "quantile"),
        ("equal_interval", "equal_interval", "equal_interval"),
        ("natural_breaks", "natural_breaks", "natural_breaks"),
        ("heads_and_tails", "heads_and_tails", "heads_and_tails"),
        ("geometric_interval", "geometric_interval", "geometric_interval"),
        ("std_dev", "standard_deviation", "std_dev"),
        ("standard_deviation", "standard_deviation", "std_dev"),
    ],
)
async def test_each_method_reaches_the_endpoint_in_its_spelling(
    method: str, sent: str, answered: str
) -> None:
    """The style's method names are taken and sent as processes names them
    (it reads a name it does not know as quantile); the answer names the
    method as a style does."""
    processes = _processes()
    result = await execute(
        FIELD_STATISTICS,
        _env(_core(), _geoapi(), processes),
        {"layer_project_id": 11, "field": "laenge", "method": method},
    )
    assert _calls(processes, "class-breaks")[0]["method"] == sent
    assert result["method"] == answered


async def test_an_unknown_method_is_refused_with_the_allowed_names() -> None:
    processes = _processes()
    with pytest.raises(InputInvalid) as refused:
        await execute(
            FIELD_STATISTICS,
            _env(_core(), _geoapi(), processes),
            {"layer_project_id": 11, "field": "laenge", "method": "jenks"},
        )
    for name in ("quantile", "natural_breaks", "std_dev", "geometric_interval"):
        assert name in refused.value.message, name
    assert not processes.requests


def test_the_methods_are_the_styles_and_the_endpoints() -> None:
    """Written out, since the analysis schemas import DuckDB, which the
    production assistant does not have."""
    from goatlib.analysis.schemas.statistics import ClassBreakMethod
    from goatlib.style.models.classify import NUMERIC_METHODS

    taken = set(get_args(project.StatisticsMethod))
    assert taken - {"standard_deviation"} == set(NUMERIC_METHODS)
    assert taken - {"std_dev"} == {m.value for m in ClassBreakMethod}
    description = FIELD_STATISTICS.json_schema()["properties"]["method"]["description"]
    assert "the style's method names" in description
    for name in NUMERIC_METHODS:
        assert name in description, name


async def test_numeric_statistics_count_the_values_and_the_empty_ones() -> None:
    processes = _processes(count=50, empty=8)
    where = _where("separation", "=", "Max")
    result = await execute(
        FIELD_STATISTICS,
        _env(_core(), _geoapi(), processes),
        {"layer_project_id": 11, "field": "laenge", "filter": where},
    )
    assert (result["count"], result["empty"]) == (42, 8)
    [histogram] = _calls(processes, "histogram")
    cql = to_cql2(FeatureFilter.model_validate(where), {"separation": "string"})
    assert histogram == {
        "collection": LINES,
        "column": "laenge",
        "num_bins": 1,
        "filter": json.dumps(cql),
    }
    assert json.loads(_calls(processes, "class-breaks")[0]["filter"]) == cql


async def test_categorical_statistics_count_the_values_and_the_empty_ones() -> None:
    processes = _processes(count=50, empty=8)
    result = await execute(
        FIELD_STATISTICS,
        _env(_core(), _geoapi(), processes),
        {"layer_project_id": 11, "field": "art"},
    )
    assert (result["count"], result["empty"]) == (42, 8)
    counted = [call.get("filter") for call in _calls(processes, "feature-count")]
    empty = json.dumps({"op": "isNull", "args": [{"property": "art"}]})
    assert sorted(counted, key=lambda f: f is None) == [empty, None]


async def test_categorical_counts_under_a_filter_keep_it() -> None:
    processes = _processes(count=50, empty=8)
    where = _where("separation", "=", "Max")
    await execute(
        FIELD_STATISTICS,
        _env(_core(), _geoapi(), processes),
        {"layer_project_id": 11, "field": "art", "filter": where},
    )
    cql = to_cql2(FeatureFilter.model_validate(where), {"separation": "string"})
    filters = {call["filter"] for call in _calls(processes, "feature-count")}
    empty = {"op": "isNull", "args": [{"property": "art"}]}
    assert filters == {json.dumps(cql), json.dumps({"op": "and", "args": [cql, empty]})}


def test_the_description_says_the_answer_carries_the_counts() -> None:
    description = " ".join(FIELD_STATISTICS.description.split())
    assert "count" in description and "empty" in description
    assert "no separate count is needed" in description


def test_proposal_rows_are_built_in_one_place() -> None:
    """Every row is built by proposals.proposal_row or proposals.facet_row, so its key
    is a ProposalRowKey or a facet's filter parameter."""
    from pathlib import Path

    import assistant.tools as package

    for source in Path(package.__path__[0]).glob("*.py"):
        if source.name != "proposals.py":
            assert "ProposalRow(" not in source.read_text(), source.name


def test_every_filter_argument_shows_a_condition_and_a_range() -> None:
    with_filter = [
        spec
        for spec in PROJECT_TOOLS
        if "filter" in spec.json_schema().get("properties", {})
    ]
    assert {spec.wire_name for spec in with_filter} == {
        "project_count_features",
        "project_field_statistics",
        "project_group_statistics",
        "project_area_statistics",
        "project_sample_features",
    }
    for spec in with_filter:
        description = spec.json_schema()["properties"]["filter"]["description"]
        assert CONDITION_EXAMPLE in description, spec.wire_name
        assert FILTER_EXAMPLES in description, spec.wire_name
    assert CONDITION_EXAMPLE == '{"field": "speed", "op": ">=", "value": 0.2}'
    assert '"op": "<", "value": 2020' in FILTER_EXAMPLES


async def test_a_filter_in_another_shape_is_refused_with_the_shape() -> None:
    """A real model wrote ``{"field": "geschwindi", ">=": 0.2}``: still refused,
    but the message says what a condition looks like."""
    core, processes = _core(), _processes()
    env = _env(core, _geoapi(), processes)
    with pytest.raises(InputInvalid) as caught:
        await execute(
            COUNT_FEATURES,
            env,
            {
                "layer_project_id": 11,
                "filter": {"conditions": [{"field": "laenge", ">=": 0.2}]},
            },
        )
    message = caught.value.message
    assert message.startswith("Invalid arguments: filter.conditions.0: ")
    assert CONDITION_EXAMPLE in message and "\n" not in message
    assert "Extra inputs" not in message
    for wrong in (
        {"field": "laenge", "op": ">=", "value": 0.2},
        [{"field": "laenge", "op": ">=", "value": 0.2}],
        {"conditions": [{"field": "laenge", "op": ">=", "value": 0.2}], "x": 1},
    ):
        with pytest.raises(InputInvalid) as caught:
            await execute(
                COUNT_FEATURES, env, {"layer_project_id": 11, "filter": wrong}
            )
        assert caught.value.message.startswith("Invalid arguments: filter: ")
        assert '"conditions": [' in caught.value.message
    assert core.requests == [] and processes.requests == []


async def test_get_layers_marks_the_layer_selected_on_the_map() -> None:
    selected_page = parse_context(
        {
            "surface": "project.map",
            "project_id": str(PROJECT),
            "selected_layer_project_id": 12,
        }
    )
    env = _env(_core(), _geoapi(), _processes(), page=selected_page)
    layers = (await execute(GET_LAYERS, env, {}))["layers"]
    assert [layer.get("selected") for layer in layers] == [None, True, None]


async def test_only_the_open_projects_selection_is_marked() -> None:
    other = UUID(int=501)
    base = f"/api/v2/project/{other}"
    core = Recorder(
        {
            ("GET", base): {"id": str(other), "name": "Source"},
            ("GET", f"{base}/layer"): LAYERS,
            ("GET", f"{base}/group"): [],
            ("GET", f"{base}/map"): EMPTY_MAP,
        }
    )
    page = parse_context(
        {
            "surface": "project.map",
            "project_id": str(PROJECT),
            "selected_layer_project_id": 12,
        }
    )
    env = _env(core, _geoapi(), _processes(), page=page)
    layers = (await execute(GET_LAYERS, env, {"project_id": str(other)}))["layers"]
    assert all("selected" not in layer for layer in layers)
    # No selection on the map, or no map: nothing is marked.
    for raw in (
        {"surface": "project.map", "project_id": str(PROJECT)},
        {"surface": "project.dashboard", "project_id": str(PROJECT)},
    ):
        env = _env(_core(), _geoapi(), _processes(), page=parse_context(raw))
        layers = (await execute(GET_LAYERS, env, {}))["layers"]
        assert all("selected" not in layer for layer in layers)


#: How core sends a layer's extent (``GeospatialAttributes``): WKT of a
#: multipolygon, coordinates at full precision.
EUROPE_WKT = (
    "MULTIPOLYGON (((-31.2626562 32.6346233, -31.2626562 71.099735, "
    "34.384889562985784 71.099735, 34.384889562985784 32.6346233, "
    "-31.2626562 32.6346233)))"
)
MUNICH_WKT = (
    "MULTIPOLYGON(((11.360777 48.061624,11.360777 48.248116,"
    "11.722908 48.248116,11.722908 48.061624,11.360777 48.061624)))"
)


def _sized_row(layer_project_id: int, **extra: Any) -> dict[str, Any]:
    return {
        "id": layer_project_id,
        "layer_id": f"00000000-0000-0000-0000-{layer_project_id:012d}",
        "name": f"Layer {layer_project_id}",
        "type": "feature",
        "feature_layer_geometry_type": "point",
        "layer_project_group_id": None,
        "order": layer_project_id,
        "locked": False,
        **extra,
    }


def _catalog_copy(layer_project_id: int, **extra: Any) -> dict[str, Any]:
    """A catalog layer's row: core serves its copy status from the layer."""
    return _sized_row(
        layer_project_id,
        extent=EUROPE_WKT,
        other_properties={
            "catalog_item": {"id": "osm-poi-shopping", "title": "POI Einkaufen"},
            "catalog_materialize": {"status": "ready", "feature_count": 934847},
        },
        **extra,
    )


def _core_with(rows: list[dict[str, Any]]) -> Recorder:
    base = f"/api/v2/project/{PROJECT}"
    return Recorder(
        {
            ("GET", base): {"id": str(PROJECT), "name": "Munich"},
            ("GET", f"{base}/layer"): rows,
            ("GET", f"{base}/group"): [],
            ("GET", f"{base}/map"): EMPTY_MAP,
        }
    )


async def test_get_layers_gives_the_size_and_extent_core_knows() -> None:
    """A catalog copy has both, another layer its extent only (core keeps no
    count for it), a table neither; the extent is a rounded bounding box."""
    rows = [
        _catalog_copy(21),
        _sized_row(22, extent=MUNICH_WKT, other_properties={"table_config": {}}),
        _sized_row(23, type="table", feature_layer_geometry_type=None),
        _sized_row(24, extent="MULTIPOLYGON EMPTY"),
        _sized_row(
            25,
            other_properties={"catalog_materialize": {"status": "pending"}},
        ),
    ]
    env = _env(_core_with(rows), _geoapi(), _processes())
    layers = {
        layer["layer_project_id"]: layer
        for layer in (await execute(GET_LAYERS, env, {}))["layers"]
    }
    assert layers[21]["feature_count"] == 934847
    assert layers[21]["extent"] == [-31.26, 32.63, 34.38, 71.1]
    assert layers[22]["extent"] == [11.36, 48.06, 11.72, 48.25]
    assert "feature_count" not in layers[22]
    for layer_project_id in (23, 24, 25):
        assert "extent" not in layers[layer_project_id]
        assert "feature_count" not in layers[layer_project_id]


async def test_a_locked_layer_shows_neither_size_nor_extent() -> None:
    """Core drops both from a locked row; the tool does not rely on it."""
    env = _env(_core_with([_catalog_copy(31, locked=True)]), _geoapi(), _processes())
    [layer] = (await execute(GET_LAYERS, env, {}))["layers"]
    assert layer["locked"] is True
    assert "feature_count" not in layer and "extent" not in layer


async def test_size_and_extent_keep_a_long_layer_list_small() -> None:
    """Both cost a few bytes per layer, so a project with many layers still
    fits a tool result."""
    many = 1000

    async def payload(rows: list[dict[str, Any]]) -> int:
        env = _env(_core_with(rows), _geoapi(), _processes())
        result = await execute(GET_LAYERS, env, {})
        assert len(result["layers"]) == many
        return len(json.dumps(result, separators=(",", ":")).encode())

    plain = await payload([_sized_row(i) for i in range(1, many + 1)])
    sized = await payload([_catalog_copy(i) for i in range(1, many + 1)])
    assert sized < MAX_RESULT_BYTES
    assert (sized - plain) / many <= 64


async def test_a_filtered_count_is_one_call() -> None:
    processes = _processes(count=1)
    result = await execute(
        COUNT_FEATURES,
        _env(_core(), _geoapi(), processes),
        {"layer_project_id": 11, "filter": _where("laenge", ">=", 1.4)},
    )
    assert result["count"] == 1
    assert [body["inputs"].get("attribute") for body in processes.bodies()] == [None]
