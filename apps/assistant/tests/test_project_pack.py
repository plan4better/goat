"""The read-only project pack (spec §7.2, §9.1.1) against recorded services."""

import json
from datetime import datetime
from typing import Any
from uuid import UUID

import httpx
import pytest
from pydantic import ValidationError
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
    GROUP_STATISTICS,
    PROJECT_SURFACES,
    PROJECT_TOOLS,
    PROPOSE_VIEW,
    SAMPLE_FEATURES,
    STILL_COPYING,
)
from assistant.tools.proposals import MapCamera, MapViewPayload
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


def _core() -> Recorder:
    base = f"/api/v2/project/{PROJECT}"
    return Recorder(
        {
            ("GET", base): {"id": str(PROJECT), "name": "Berlin cycling study"},
            ("GET", f"{base}/layer"): LAYERS,
            ("GET", f"{base}/group"): [
                {"id": 1, "name": "Verkehr", "parent_id": None, "order": 0}
            ],
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


def _processes(
    unique_total: int = 7,
    *,
    filtered_total: int | None = None,
    count: int = 42,
    extent: list[float] | None = None,
) -> Recorder:
    """``filtered_total``: the distinct count unique-values reports for a
    filtered request (``unique_total`` is the unfiltered one)."""

    def answer(process: str) -> Any:
        def respond(request: httpx.Request) -> httpx.Response:
            inputs = json.loads(request.content)["inputs"]
            if process == "feature-count":
                return httpx.Response(200, json={"count": count})
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
                # The first names are the categories the tests filter by, each
                # held by enough features for Restricted to allow the filter.
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
        "op": "=",
        "args": [{"property": "art"}, "Radweg"],
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
    with pytest.raises(ToolFailed, match="no access to its data"):
        await execute(PROPOSE_VIEW, env, {"title": "x", "fit_layer_project_id": 13})
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
            {"op": "<>", "args": [{"property": "art"}, "Weg"]},
            {"op": ">", "args": [{"property": "laenge"}, 2]},
            {"op": "isNull", "args": [{"property": "separation"}]},
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
            {"op": "not", "args": [{"op": "isNull", "args": [{"property": "notiz"}]}]},
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


async def test_restricted_class_breaks_use_quantiles() -> None:
    """Decision T20: mean-based breaks would reveal what Restricted withholds."""
    processes = _processes()
    env = _env(_core(), _geoapi(), processes, data_policy="restricted")
    await execute(
        FIELD_STATISTICS,
        env,
        {"layer_project_id": 11, "field": "laenge", "method": "standard_deviation"},
    )
    assert _calls(processes, "class-breaks")[0]["method"] == "quantile"


async def test_numeric_statistics_and_their_restricted_form() -> None:
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
    assert processes.bodies()[0]["inputs"] == {
        "collection": LINES,
        "attribute": "laenge",
        "method": "quantile",
        "breaks": 5,
    }
    # 42 features with a value allow 7 points (8 classes of 5); 5 were asked.
    processes = _processes()
    restricted = await execute(
        FIELD_STATISTICS,
        _env(_core(), _geoapi(), processes, data_policy="restricted"),
        {"layer_project_id": 11, "field": "laenge"},
    )
    assert "mean" not in restricted and "std_dev" not in restricted
    assert _calls(processes, "class-breaks")[0]["breaks"] == 5
    assert restricted["min"] == 0.1
    assert restricted["breaks"] == [1.0, 2.0, 3.0, 4.0, 5.0]


async def test_restricted_hides_values_of_high_cardinality_fields() -> None:
    """Review Focus 4."""
    many = await execute(
        FIELD_STATISTICS,
        _env(
            _core(), _geoapi(), _processes(unique_total=120), data_policy="restricted"
        ),
        {"layer_project_id": 11, "field": "art"},
    )
    assert many["kind"] == "categorical" and many["distinct_count"] == 120
    assert "values" not in many and "more than 50" in many["note"]
    few = await execute(
        FIELD_STATISTICS,
        _env(_core(), _geoapi(), _processes(unique_total=7), data_policy="restricted"),
        {"layer_project_id": 11, "field": "art"},
    )
    assert len(few["values"]) == 7
    standard = await execute(
        FIELD_STATISTICS,
        _env(_core(), _geoapi(), _processes(unique_total=120)),
        {"layer_project_id": 11, "field": "art"},
    )
    assert len(standard["values"]) == 50


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
    restricted = await execute(
        AREA_STATISTICS,
        _env(_core(), _geoapi(), _processes(), data_policy="restricted"),
        {"layer_project_id": 12},
    )
    assert "total_area" not in restricted and "mean_area" not in restricted
    assert restricted["min_area"] == 10.0
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


async def test_area_per_group_is_withheld_under_restricted() -> None:
    geoapi, processes = _areas_by_district()
    out = await execute(
        AREA_STATISTICS,
        _env(_core(), geoapi, processes, data_policy="restricted"),
        {"layer_project_id": 12, "group_by": "district"},
    )
    assert out.get("groups") is None
    assert "groups_total" not in out and "total_area" not in out
    assert "per group" in out["note"]


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


async def test_restricted_sample_is_withheld_without_reading_rows() -> None:
    """Review Focus 4: under Restricted, rows are not even fetched."""
    geoapi = _geoapi()
    result = await execute(
        SAMPLE_FEATURES,
        _env(_core(), geoapi, _processes(), data_policy="restricted"),
        {"layer_project_id": 11},
    )
    assert result["withheld"] is True
    assert all(not r.url.path.endswith("/items") for r in geoapi.requests)


async def test_propose_view_fits_a_layer_and_names_the_target() -> None:
    emitted: list[tuple[str, dict[str, Any]]] = []

    async def emit(name: str, data: dict[str, Any]) -> str:
        emitted.append((name, data))
        return "m1:3"

    processes = _processes()
    env = _env(_core(), _geoapi(), processes, emit_data=emit)
    shown = await execute(
        PROPOSE_VIEW, env, {"title": "Bezirke zeigen", "fit_layer_project_id": 12}
    )
    assert shown["proposal_id"] == "m1:3"
    [(name, data)] = emitted
    assert name == "proposal"
    assert data["kind"] == "map.view" and data["surface"] == "project.map"
    assert data["target"] == {
        "project_id": str(PROJECT),
        "name": "Berlin cycling study",
    }
    assert data["payload"] == {
        "project_id": str(PROJECT),
        "camera": None,
        "bbox": [13.08, 52.33, 13.76, 52.67],
        "layer_project_id": 12,
    }
    assert {"k": "layer", "v": "Bezirke"} in data["rows"]
    assert processes.bodies()[0]["inputs"] == {"collection": POLYGONS}


async def test_propose_view_takes_exactly_one_kind_of_view() -> None:
    async def emit(name: str, data: dict[str, Any]) -> str:
        return "m1:1"

    env = _env(_core(), _geoapi(), _processes(), emit_data=emit)
    camera = await execute(
        PROPOSE_VIEW, env, {"title": "Mitte", "center": [13.4, 52.52], "zoom": 13}
    )
    assert camera["status"] == "shown"
    for args in [
        {"title": "x"},
        {
            "title": "x",
            "bbox": [13.0, 52.0, 14.0, 53.0],
            "center": [13.4, 52.5],
            "zoom": 10,
        },
        {"title": "x", "center": [13.4, 52.5]},
        {"title": "x", "bbox": [14.0, 52.0, 13.0, 53.0]},
    ]:
        with pytest.raises(InputInvalid):
            await execute(PROPOSE_VIEW, env, args)


async def test_restricted_counts_still_reach_the_model() -> None:
    """Counts are allowed under Restricted: the reduction must not be mistaken
    for "nothing was reduced" and withheld."""
    env = _env(_core(), _geoapi(), _processes(), data_policy="restricted")
    result = await execute(COUNT_FEATURES, env, {"layer_project_id": 11})
    assert result["count"] == 42 and "withheld" not in result


async def test_restricted_never_carries_rows_means_or_long_value_lists() -> None:
    """Spec 4.7 for every data tool, with a field that has more than 50 values."""
    env = _env(
        _core(), _geoapi(), _processes(unique_total=120), data_policy="restricted"
    )
    numeric = await execute(
        FIELD_STATISTICS, env, {"layer_project_id": 11, "field": "laenge"}
    )
    categorical = await execute(
        FIELD_STATISTICS, env, {"layer_project_id": 11, "field": "art"}
    )
    area = await execute(AREA_STATISTICS, env, {"layer_project_id": 12})
    sample = await execute(SAMPLE_FEATURES, env, {"layer_project_id": 11})
    grouped = await execute(
        GROUP_STATISTICS,
        env,
        {"layer_project_id": 11, "operation": "count", "group_by": "art"},
    )
    for result in (numeric, categorical, area, sample, grouped):
        assert not {
            "mean",
            "std_dev",
            "total_area",
            "mean_area",
            "features",
            "values",
            "rows",
        } & set(result)
    assert {spec.wire_name for spec in PROJECT_TOOLS if spec.returns_data} == {
        "project_get_layers",
        "project_count_features",
        "project_field_statistics",
        "project_group_statistics",
        "project_area_statistics",
        "project_sample_features",
    }


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

    processes = Recorder({("POST", "/processes/unique-values/execution"): respond})
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


def test_map_view_payload_takes_exactly_one_of_camera_and_bbox() -> None:
    camera = MapCamera(center=(13.4, 52.5), zoom=10)
    box = (13.0, 52.0, 14.0, 53.0)
    assert MapViewPayload(project_id=PROJECT, camera=camera).bbox is None
    assert MapViewPayload(project_id=PROJECT, bbox=box).camera is None
    for both_or_none in ({}, {"camera": camera, "bbox": box}):
        with pytest.raises(ValidationError, match="exactly one of camera and bbox"):
            MapViewPayload(project_id=PROJECT, **both_or_none)


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


def test_the_pack_loads_where_projects_are_read() -> None:
    assert PROJECT_SURFACES == {
        "project.map",
        "project.workflows",
        "project.layouts",
        "project.dashboard",
        "none",
    }
    for spec in PROJECT_TOOLS:
        expected = {"project.map"} if spec is PROPOSE_VIEW else PROJECT_SURFACES
        assert spec.surfaces == expected, spec.wire_name


def _where(field: str, op: str, value: Any) -> dict[str, Any]:
    return {"conditions": [{"field": field, "op": op, "value": value}]}


async def test_restricted_layers_keep_that_a_filter_exists_not_its_text() -> None:
    standard = await execute(GET_LAYERS, _env(_core(), _geoapi(), _processes()), {})
    assert standard["layers"][0]["filter"]["args"][1] == "Radweg"
    assert "has_filter" not in standard["layers"][0]
    restricted = await execute(
        GET_LAYERS,
        _env(_core(), _geoapi(), _processes(), data_policy="restricted"),
        {},
    )
    first, second = restricted["layers"][:2]
    assert "filter" not in first and first["has_filter"] is True
    assert "filter" not in second and "has_filter" not in second
    assert '"Radweg"' not in json.dumps(restricted)
    assert restricted["layers"][0]["name"] == "Radwege"


async def test_restricted_cardinality_is_judged_on_the_whole_field() -> None:
    """A filter that isolates one row leaves one distinct value; that must not
    unlock a field with many. Under Restricted such a filter is refused before
    anything is computed: its own field has as many values."""
    processes = _processes(unique_total=120, filtered_total=1)
    env = _env(_core(), _geoapi(), processes, data_policy="restricted")
    with pytest.raises(InputInvalid, match="'separation' has more than 50 distinct"):
        await execute(
            FIELD_STATISTICS,
            env,
            {
                "layer_project_id": 11,
                "field": "art",
                "filter": _where("separation", "=", "Max"),
            },
        )
    # Only the whole-layer distinct count of the filter's field was asked for.
    [guard] = [body["inputs"] for body in processes.bodies()]
    assert guard["attribute"] == "separation" and "filter" not in guard
    # A field with few values over the whole layer keeps its (filtered) values.
    few = await execute(
        FIELD_STATISTICS,
        _env(
            _core(),
            _geoapi(),
            _processes(unique_total=7, filtered_total=1),
            data_policy="restricted",
        ),
        {
            "layer_project_id": 11,
            "field": "art",
            "filter": _where("separation", "=", "Max"),
        },
    )
    assert len(few["values"]) == 1


async def test_standard_policy_makes_no_extra_calls() -> None:
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
    assert len(processes.requests) == 1


async def test_restricted_small_filtered_groups_hide_extremes_and_breaks() -> None:
    """A filter that isolates a feature would make min, max and the breaks its
    own values."""
    args = {
        "layer_project_id": 11,
        "field": "laenge",
        "filter": _where("art", "=", "Radweg"),
    }
    processes = _processes(count=4)
    small = await execute(
        FIELD_STATISTICS,
        _env(_core(), _geoapi(), processes, data_policy="restricted"),
        args,
    )
    assert _calls(processes, "class-breaks")[0]["breaks"] == 2
    assert small["feature_count"] == 4
    assert "fewer than 5 features with a value" in small["note"]
    assert not {"min", "max", "breaks", "mean", "std_dev"} & set(small)
    # Large enough for the extremes; the breaks follow ruling 23a (two points,
    # three classes of five, need fifteen features).
    processes = _processes(count=15)
    enough = await execute(
        FIELD_STATISTICS,
        _env(_core(), _geoapi(), processes, data_policy="restricted"),
        args,
    )
    assert _calls(processes, "class-breaks")[0]["breaks"] == 2
    assert enough["min"] == 0.1 and enough["breaks"] == [1.0, 2.0]
    assert "mean" not in enough
    # Without a filter the whole layer is the group: the extremes stay, and only
    # the breaks depend on its size.
    processes = _processes(count=1)
    whole = await execute(
        FIELD_STATISTICS,
        _env(_core(), _geoapi(), processes, data_policy="restricted"),
        {"layer_project_id": 11, "field": "laenge"},
    )
    assert whole["min"] == 0.1 and "breaks" not in whole
    assert "feature_count" not in whole
    assert _calls(processes, "class-breaks")[0]["breaks"] == 2


async def test_restricted_small_filtered_area_groups_hide_extremes() -> None:
    def areas(count: int) -> Recorder:
        def respond(request: httpx.Request) -> httpx.Response:
            operation = json.loads(request.content)["inputs"]["operation"]
            return httpx.Response(
                200,
                json={
                    "result": {"sum": 50.0, "min": 10.0, "max": 40.0}[operation],
                    "total_area": 50.0,
                    "feature_count": count,
                    "unit": "m²",
                },
            )

        # "art" is a category field: a few distinct values over the layer.
        categories = httpx.Response(
            200,
            json={
                "attribute": "art",
                "total": 3,
                "values": [{"value": "Park", "count": 9}],
            },
        )
        return Recorder(
            {
                ("POST", "/processes/area-statistics/execution"): respond,
                ("POST", "/processes/unique-values/execution"): categories,
            }
        )

    args = {"layer_project_id": 12, "filter": _where("art", "=", "Park")}
    small = await execute(
        AREA_STATISTICS,
        _env(_core(), _geoapi(), areas(2), data_policy="restricted"),
        args,
    )
    assert small["feature_count"] == 2 and "fewer than 5" in small["note"]
    assert not {"total_area", "mean_area", "min_area", "max_area"} & set(small)
    # Not small: the extremes stay. Not filtered: any size stays.
    big = await execute(
        AREA_STATISTICS,
        _env(_core(), _geoapi(), areas(5), data_policy="restricted"),
        args,
    )
    assert big["min_area"] == 10.0 and "total_area" not in big
    unfiltered = await execute(
        AREA_STATISTICS,
        _env(_core(), _geoapi(), areas(2), data_policy="restricted"),
        {"layer_project_id": 12},
    )
    assert unfiltered["max_area"] == 40.0


async def test_restricted_numeric_breaks_of_other_methods_are_dropped() -> None:
    from assistant.tools.project import FieldStatistics

    stats = FieldStatistics(
        layer="x",
        field="f",
        kind="numeric",
        filter="none (all features)",
        method="standard_deviation",
        breaks=[1.0, 2.0],
        min=0.0,
        max=3.0,
    )
    reduced = stats.restricted()
    assert reduced.breaks is None and reduced.min == 0.0


async def test_propose_view_only_targets_the_open_project() -> None:
    other = UUID(int=501)
    core = Recorder(
        {
            **_core().routes,
            ("GET", f"/api/v2/project/{other}"): {"id": str(other), "name": "B"},
            ("GET", f"/api/v2/project/{other}/layer"): [
                {**LAYERS[1], "id": 77, "name": "Nur in B"}
            ],
        }
    )
    processes = _processes()

    async def emit(name: str, data: dict[str, Any]) -> str:
        return "m1:1"

    env = _env(core, _geoapi(), processes, emit_data=emit)
    with pytest.raises(InputInvalid, match="project_id"):
        await execute(
            PROPOSE_VIEW,
            env,
            {"title": "x", "project_id": str(other), "fit_layer_project_id": 77},
        )
    with pytest.raises(InputInvalid, match="project_get_layers"):
        await execute(PROPOSE_VIEW, env, {"title": "x", "fit_layer_project_id": 77})
    assert all(str(other) not in request.url.path for request in core.requests)
    assert processes.requests == []
    assert "other project" not in PROPOSE_VIEW.description
    assert "project_id" not in PROPOSE_VIEW.json_schema()["properties"]


async def test_propose_view_refuses_a_layer_without_geometry_before_any_service() -> (
    None
):
    """A table has no extent: the view is refused before any service is asked."""
    table = {
        **LAYERS[1],
        "id": 14,
        "layer_id": "44444444-4444-4444-4444-444444444444",
        "name": "Reisezeiten",
        "type": "table",
        "feature_layer_geometry_type": None,
    }
    core = Recorder(
        {
            **_core().routes,
            ("GET", f"/api/v2/project/{PROJECT}/layer"): [*LAYERS, table],
        }
    )
    geoapi, processes = _geoapi(), _processes()
    emitted: list[dict[str, Any]] = []

    async def emit(name: str, data: dict[str, Any]) -> str:
        emitted.append(data)
        return "m1:1"

    env = _env(core, geoapi, processes, emit_data=emit)
    for args in [
        {"title": "x", "fit_layer_project_id": 14},
        {
            "title": "x",
            "fit_layer_project_id": 14,
            "filter": _where("art", "=", "Radweg"),
        },
    ]:
        with pytest.raises(ToolFailed, match="'Reisezeiten' has no geometry to show"):
            await execute(PROPOSE_VIEW, env, args)
    assert geoapi.requests == [] and processes.requests == [] and emitted == []
    fit = PROPOSE_VIEW.json_schema()["properties"]["fit_layer_project_id"]
    assert "a layer with geometry, not a table" in fit["description"]


async def test_propose_view_widens_a_degenerate_extent() -> None:
    emitted: list[dict[str, Any]] = []

    async def emit(name: str, data: dict[str, Any]) -> str:
        emitted.append(data)
        return "m1:1"

    for extent in ([13.4, 52.5, 13.4, 52.5], [13.4, 52.0, 13.4, 53.0]):
        env = _env(_core(), _geoapi(), _processes(extent=extent), emit_data=emit)
        await execute(PROPOSE_VIEW, env, {"title": "x", "fit_layer_project_id": 12})
    west, south, east, north = emitted[0]["payload"]["bbox"]
    assert west < 13.4 < east and south < 52.5 < north
    assert emitted[1]["payload"]["bbox"][1:4:2] == [52.0, 53.0]
    assert emitted[1]["payload"]["bbox"][0] < 13.4 < emitted[1]["payload"]["bbox"][2]
    # The model's own bbox stays strict.
    with pytest.raises(InputInvalid):
        await execute(
            PROPOSE_VIEW, env, {"title": "x", "bbox": [13.4, 52.5, 13.4, 52.5]}
        )


async def test_propose_view_arguments_that_do_not_fit_the_view_are_refused() -> None:
    async def emit(name: str, data: dict[str, Any]) -> str:
        return "m1:1"

    env = _env(_core(), _geoapi(), _processes(), emit_data=emit)
    for args in [
        {
            "title": "x",
            "bbox": [13.0, 52.0, 14.0, 53.0],
            "filter": _where("art", "=", "a"),
        },
        {"title": "x", "bbox": [13.0, 52.0, 14.0, 53.0], "bearing": 30},
        {"title": "x", "fit_layer_project_id": 12, "pitch": 20},
        {"title": "x", "bbox": [13.0, 52.0, 14.0, 53.0], "zoom": 9},
    ]:
        with pytest.raises(InputInvalid):
            await execute(PROPOSE_VIEW, env, args)


async def test_restricted_group_size_counts_only_rows_with_a_value() -> None:
    """Breaks, minimum and maximum skip rows where the field is null. A filter
    padded with "or the field is null" must not look like a large group."""
    processes = _processes(count=3)
    env = _env(_core(), _geoapi(), processes, data_policy="restricted")
    padded = {
        "match": "any",
        "conditions": [
            {"field": "art", "op": "=", "value": "X"},
            {"field": "laenge", "op": "is_null"},
        ],
    }
    result = await execute(
        FIELD_STATISTICS,
        env,
        {"layer_project_id": 11, "field": "laenge", "filter": padded},
    )
    count_call = next(
        body["inputs"]
        for body, request in zip(processes.bodies(), processes.requests, strict=True)
        if request.url.path.endswith("/feature-count/execution")
    )
    assert json.loads(count_call["filter"]) == {
        "op": "and",
        "args": [
            {
                "op": "or",
                "args": [
                    {"op": "=", "args": [{"property": "art"}, "X"]},
                    {"op": "isNull", "args": [{"property": "laenge"}]},
                ],
            },
            {"op": "not", "args": [{"op": "isNull", "args": [{"property": "laenge"}]}]},
        ],
    }
    assert result["feature_count"] == 3
    assert not {"min", "max", "breaks"} & set(result)


async def test_a_missing_distinct_total_does_not_release_values() -> None:
    def no_total(request: httpx.Request) -> httpx.Response:
        inputs = json.loads(request.content)["inputs"]
        values = [{"value": "a", "count": 1}][: inputs["limit"]]
        body: dict[str, Any] = {"attribute": "art", "values": values}
        if "filter" in inputs:
            body["total"] = 1
        return httpx.Response(200, json=body)

    processes = Recorder({("POST", "/processes/unique-values/execution"): no_total})
    env = _env(_core(), _geoapi(), processes, data_policy="restricted")
    with pytest.raises(ToolFailed, match="distinct count"):
        await execute(
            FIELD_STATISTICS,
            env,
            {
                "layer_project_id": 11,
                "field": "art",
                "filter": _where("separation", "=", "Max"),
            },
        )
    # Unfiltered: the only answer is the one without a total.
    with pytest.raises(ToolFailed, match="distinct count"):
        await execute(FIELD_STATISTICS, env, {"layer_project_id": 11, "field": "art"})


def test_the_fit_layer_belongs_to_the_open_project() -> None:
    description = PROPOSE_VIEW.json_schema()["properties"]["fit_layer_project_id"][
        "description"
    ]
    assert "of the open project" in description


# -- ruling 23: every Restricted class holds at least MIN_RESTRICTED_GROUP --------


def _calls(processes: Recorder, process: str) -> list[dict[str, Any]]:
    return [
        body["inputs"]
        for body, request in zip(processes.bodies(), processes.requests, strict=True)
        if request.url.path == f"/processes/{process}/execution"
    ]


_NOT_NULL_LAENGE = {
    "op": "not",
    "args": [{"op": "isNull", "args": [{"property": "laenge"}]}],
}


async def test_restricted_breaks_of_a_small_layer_are_withheld() -> None:
    """10 features with a value and 10 points asked: one point (two classes
    of 5) at most, below the two the call needs, so no breaks at all. The
    whole layer is the group: min and max stay."""
    processes = _processes(count=10)
    env = _env(_core(), _geoapi(), processes, data_policy="restricted")
    result = await execute(
        FIELD_STATISTICS,
        env,
        {"layer_project_id": 11, "field": "laenge", "breaks": 10},
    )
    [count] = _calls(processes, "feature-count")
    assert json.loads(count["filter"]) == _NOT_NULL_LAENGE
    assert _calls(processes, "class-breaks")[0]["breaks"] == 2
    assert "breaks" not in result and "mean" not in result
    assert result["min"] == 0.1 and result["max"] == 9.9
    assert "at least 5 features" in result["note"]
    assert "feature_count" not in result


@pytest.mark.parametrize(("valued", "points"), [(15, 2), (25, 4), (54, 9)])
async def test_restricted_breaks_are_capped_to_classes_of_five(
    valued: int, points: int
) -> None:
    """k break points make k + 1 classes: each of them must hold 5 features
    with a value."""
    processes = _processes(count=valued)
    env = _env(_core(), _geoapi(), processes, data_policy="restricted")
    result = await execute(
        FIELD_STATISTICS,
        env,
        {"layer_project_id": 11, "field": "laenge", "breaks": 10},
    )
    [breaks] = _calls(processes, "class-breaks")
    assert breaks["breaks"] == points
    assert result["breaks"] == [float(i + 1) for i in range(points)]
    assert (points + 1) * 5 <= valued
    # Fewer points asked than the cap: the request is kept.
    processes = _processes(count=25)
    await execute(
        FIELD_STATISTICS,
        _env(_core(), _geoapi(), processes, data_policy="restricted"),
        {"layer_project_id": 11, "field": "laenge", "breaks": 3},
    )
    assert _calls(processes, "class-breaks")[0]["breaks"] == 3


@pytest.mark.parametrize("valued", [5, 10, 14])
async def test_restricted_small_filtered_groups_get_no_breaks(valued: int) -> None:
    processes = _processes(count=valued)
    env = _env(_core(), _geoapi(), processes, data_policy="restricted")
    result = await execute(
        FIELD_STATISTICS,
        env,
        {
            "layer_project_id": 11,
            "field": "laenge",
            "filter": _where("art", "=", "Radweg"),
        },
    )
    assert result["feature_count"] == valued
    assert _calls(processes, "class-breaks")[0]["breaks"] == 2
    assert "breaks" not in result and result["min"] == 0.1
    assert "at least 5 features" in result["note"]


async def test_standard_numeric_statistics_make_one_call_with_the_asked_breaks() -> (
    None
):
    processes = _processes(count=8)
    result = await execute(
        FIELD_STATISTICS,
        _env(_core(), _geoapi(), processes),
        {"layer_project_id": 11, "field": "laenge", "breaks": 10},
    )
    assert len(processes.requests) == 1
    assert _calls(processes, "class-breaks")[0]["breaks"] == 10
    assert result["breaks"] == [float(i + 1) for i in range(10)]
    assert "note" not in result


@pytest.mark.parametrize(
    "answer",
    [
        httpx.Response(200, json={}),
        httpx.Response(200, json={"count": "many"}),
        httpx.Response(500, json={"detail": "down"}),
    ],
)
async def test_restricted_breaks_fail_closed_without_a_count(
    answer: httpx.Response,
) -> None:
    processes = _processes()
    processes.routes[("POST", "/processes/feature-count/execution")] = answer
    env = _env(_core(), _geoapi(), processes, data_policy="restricted")
    with pytest.raises(ToolFailed):
        await execute(
            FIELD_STATISTICS, env, {"layer_project_id": 11, "field": "laenge"}
        )
    assert not _calls(processes, "class-breaks")


async def test_every_map_card_row_key_is_a_known_one() -> None:
    from typing import get_args

    from assistant.tools.proposals import ProposalRowKey

    emitted: list[dict[str, Any]] = []

    async def emit(name: str, data: dict[str, Any]) -> str:
        emitted.append(data)
        return "m:1"

    env = _env(_core(), _geoapi(), _processes(), emit_data=emit)
    for args in (
        {"title": "x", "center": [13.4, 52.52], "zoom": 13},
        {"title": "x", "bbox": [13.0, 52.0, 14.0, 53.0]},
        {
            "title": "x",
            "fit_layer_project_id": 12,
            "filter": _where("art", "=", "Park"),
        },
    ):
        await execute(PROPOSE_VIEW, env, args)
    keys = {row["k"] for data in emitted for row in data["rows"]}
    assert keys == {"project", "center", "zoom", "bbox", "layer", "filter"}
    assert keys <= set(get_args(ProposalRowKey))


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
        "map_propose_view",
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
    # Kept under Restricted: it names a layer, not data.
    env = _env(
        _core(), _geoapi(), _processes(), page=selected_page, data_policy="restricted"
    )
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


async def test_size_and_extent_stay_under_restricted() -> None:
    """A count and a whole layer's bounding box are the aggregates Restricted
    sends (counts, minimum and maximum), not features or their geometries."""
    env = _env(
        _core_with([_catalog_copy(21)]),
        _geoapi(),
        _processes(),
        data_policy="restricted",
    )
    [layer] = (await execute(GET_LAYERS, env, {}))["layers"]
    assert layer["feature_count"] == 934847
    assert layer["extent"] == [-31.26, 32.63, 34.38, 71.1]


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


# -- Restricted: filters pick categories, small filtered counts are withheld -----


@pytest.mark.parametrize(
    ("condition", "refused"),
    [
        # "How many with laenge >= X?", asked again and again, spells out values.
        (("laenge", ">=", 1.4), "'>='"),
        (("laenge", "<", 2), "'<'"),
        (("art", "like", "Rad%"), "'like'"),
        (("art", "contains", "Rad"), "'contains'"),
    ],
)
async def test_restricted_filters_cannot_compare_values(
    condition: tuple[str, str, Any], refused: str
) -> None:
    processes = _processes()
    env = _env(_core(), _geoapi(), processes, data_policy="restricted")
    with pytest.raises(InputInvalid, match=refused):
        await execute(
            COUNT_FEATURES, env, {"layer_project_id": 11, "filter": _where(*condition)}
        )
    # Refused before anything was counted.
    assert processes.bodies() == []


async def test_restricted_category_counts_below_the_group_size_are_withheld() -> None:
    args = {"layer_project_id": 11, "filter": _where("art", "=", "Radweg")}
    small = await execute(
        COUNT_FEATURES,
        _env(
            _core(),
            _geoapi(),
            _processes(unique_total=7, count=3),
            data_policy="restricted",
        ),
        args,
    )
    # The number is left out entirely; the note says why.
    assert "count" not in small and "fewer than 5" in small["note"]
    big = await execute(
        COUNT_FEATURES,
        _env(
            _core(),
            _geoapi(),
            _processes(unique_total=7, count=5),
            data_policy="restricted",
        ),
        args,
    )
    assert big["count"] == 5 and "note" not in big
    # A whole layer's count is not a group of individuals: it stays.
    unfiltered = await execute(
        COUNT_FEATURES,
        _env(_core(), _geoapi(), _processes(count=3), data_policy="restricted"),
        {"layer_project_id": 11},
    )
    assert unfiltered["count"] == 3


async def test_standard_policy_filters_and_counts_as_before() -> None:
    processes = _processes(count=1)
    result = await execute(
        COUNT_FEATURES,
        _env(_core(), _geoapi(), processes),
        {"layer_project_id": 11, "filter": _where("laenge", ">=", 1.4)},
    )
    assert result["count"] == 1
    # No category check: only the count itself was asked for.
    assert [body["inputs"].get("attribute") for body in processes.bodies()] == [None]
