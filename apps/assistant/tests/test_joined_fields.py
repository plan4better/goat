"""Field names without the ``join_`` prefix in the project statistics tools.

A join's result names the fields it carries over from the joined layer
``join_<name>``. The statistics tools read ``join_x`` for a field ``x`` the
layer does not have, and say so in the result's note; under Restricted the
read is checked exactly as a read of ``join_x`` is."""

import json
from typing import Any

import httpx
import pytest

from assistant.context import parse_context
from assistant.tools.project import (
    AREA_STATISTICS,
    COUNT_FEATURES,
    FIELD_STATISTICS,
    GROUP_STATISTICS,
)
from assistant.tools.runtime import InputInvalid, ToolEnv, execute
from assistant.tools.testing import Recorder, fake_clients, tool_env

PROJECT = "00000000-0000-0000-0000-0000000007a1"
PAGE = parse_context({"surface": "project.map", "project_id": PROJECT})
JOINED = "a7000000-0000-0000-0000-000000000001"
PEOPLE = "a7000000-0000-0000-0000-000000000002"
LAYERS = [
    {
        "id": 1,
        "layer_id": JOINED,
        "name": "Stadtteile mit Güte",
        "type": "feature",
        "feature_layer_geometry_type": "polygon",
    },
    {
        "id": 2,
        "layer_id": PEOPLE,
        "name": "Einwohner",
        "type": "feature",
        "feature_layer_geometry_type": "polygon",
    },
]
QUERYABLES = {
    JOINED: {
        "properties": {
            "name": {"type": "string"},
            "join_oev_guete_mittel": {"type": "number"},
            "join_klasse": {"type": "string"},
            "wert": {"type": "number"},
            "join_wert": {"type": "number"},
            "geom": {"$ref": "https://geojson.org/schema/Geometry.json"},
        }
    },
    PEOPLE: {
        "properties": {
            "join_name": {"type": "string"},
            "join_einwohner": {"type": "integer"},
        }
    },
}


def _services(
    distinct: int = 6, count: int = 40
) -> tuple[Recorder, Recorder, Recorder]:
    """``distinct``: the distinct values unique-values reports for any field;
    ``count``: the features feature-count reports."""
    core = Recorder({("GET", f"/api/v2/project/{PROJECT}/layer"): LAYERS})
    geoapi = Recorder(
        {
            ("GET", f"/collections/{layer}/queryables"): doc
            for layer, doc in QUERYABLES.items()
        }
    )

    def respond(process: str) -> Any:
        def answer(request: httpx.Request) -> httpx.Response:
            inputs = json.loads(request.content)["inputs"]
            if process == "feature-count":
                return httpx.Response(200, json={"count": count})
            if process == "class-breaks":
                return httpx.Response(
                    200,
                    json={
                        "method": inputs["method"],
                        "breaks": [float(i + 1) for i in range(inputs["breaks"])],
                        "min": 1.0,
                        "max": 6.0,
                        "mean": 3.2,
                        "std_dev": 1.1,
                    },
                )
            if process == "unique-values":
                values = ["A", "B", "C", "D", "E", "F"] + [
                    f"v{i}" for i in range(max(distinct - 6, 0))
                ]
                return httpx.Response(
                    200,
                    json={
                        "total": distinct,
                        "values": [
                            {"value": value, "count": 20}
                            for value in values[: min(distinct, inputs["limit"])]
                        ],
                    },
                )
            if process == "area-statistics":
                return httpx.Response(
                    200,
                    json={
                        "result": 10.0,
                        "total_area": 900.0,
                        "feature_count": count,
                        "unit": "m²",
                        "groups": [
                            {
                                "grouped_value": "A",
                                "feature_count": 30,
                                "total_area": 600.0,
                            },
                            {
                                "grouped_value": "B",
                                "feature_count": 10,
                                "total_area": 300.0,
                            },
                        ],
                        "total_groups": 2,
                    },
                )
            if process == "aggregation-stats":
                return httpx.Response(
                    200,
                    json={
                        "items": [
                            {
                                "grouped_value": "Mitte",
                                "grouped_secondary_value": None,
                                "operation_value": 30,
                            },
                            {
                                "grouped_value": "Nord",
                                "grouped_secondary_value": None,
                                "operation_value": 10,
                            },
                        ],
                        "total_items": 2,
                        "total_count": count,
                    },
                )
            raise AssertionError(process)

        return answer

    processes = Recorder(
        {
            ("POST", f"/processes/{name}/execution"): respond(name)
            for name in (
                "feature-count",
                "class-breaks",
                "unique-values",
                "area-statistics",
                "aggregation-stats",
            )
        }
    )
    return core, geoapi, processes


def _env(
    services: tuple[Recorder, Recorder, Recorder], policy: str = "standard"
) -> ToolEnv:
    core, geoapi, processes = services
    return tool_env(
        fake_clients(core=core, geoapi=geoapi, processes=processes),
        page=PAGE,
        data_policy=policy,  # type: ignore[arg-type]
    )


def _bodies(processes: Recorder, process: str) -> list[dict[str, Any]]:
    return [
        json.loads(request.content)["inputs"]
        for request in processes.requests
        if request.url.path == f"/processes/{process}/execution"
    ]


def _where(field: str, op: str, value: Any = None) -> dict[str, Any]:
    condition: dict[str, Any] = {"field": field, "op": op}
    if value is not None:
        condition["value"] = value
    return {"conditions": [condition]}


def _read(name: str) -> str:
    return f"read 'join_{name}'"


async def test_field_statistics_read_the_joined_field() -> None:
    services = _services()
    out = await execute(
        FIELD_STATISTICS,
        _env(services),
        {"layer_project_id": 1, "field": "oev_guete_mittel"},
    )
    [breaks] = _bodies(services[2], "class-breaks")
    assert breaks["attribute"] == "join_oev_guete_mittel"
    assert out["field"] == "join_oev_guete_mittel" and out["mean"] == 3.2
    assert _read("oev_guete_mittel") in out["note"]

    services = _services()
    out = await execute(
        FIELD_STATISTICS, _env(services), {"layer_project_id": 1, "field": "klasse"}
    )
    [values] = _bodies(services[2], "unique-values")
    assert values["attribute"] == "join_klasse"
    assert out["field"] == "join_klasse" and _read("klasse") in out["note"]


async def test_group_statistics_read_joined_fields_of_both_layers() -> None:
    services = _services()
    out = await execute(
        GROUP_STATISTICS,
        _env(services),
        {
            "layer_project_id": 1,
            "operation": "mean",
            "field": "oev_guete_mittel",
            "group_by": "klasse",
            "filter": _where("klasse", "!=", "F"),
            "share_of": {
                "layer_project_id": 2,
                "field": "einwohner",
                "group_by": "name",
                "filter": _where("name", "is_not_null"),
            },
        },
    )
    first, second = _bodies(services[2], "aggregation-stats")
    assert first["operation_column"] == "join_oev_guete_mittel"
    assert first["group_by_column"] == "join_klasse"
    assert json.loads(first["filter"])["args"][0] == {"property": "join_klasse"}
    assert second["collection"] == PEOPLE
    assert second["operation_column"] == "join_einwohner"
    assert second["group_by_column"] == "join_name"
    assert json.loads(second["filter"]) == {
        "op": "not",
        "args": [{"op": "isNull", "args": [{"property": "join_name"}]}],
    }
    assert (out["field"], out["group_by"]) == ("join_oev_guete_mittel", "join_klasse")
    assert out["filter"] == "join_klasse != 'F'"
    for name in ("oev_guete_mittel", "klasse", "einwohner", "name"):
        assert _read(name) in out["note"]
    # Each name once, however often it was named.
    assert out["note"].count(_read("klasse")) == 1


async def test_group_statistics_then_by_reads_the_joined_field() -> None:
    services = _services()
    out = await execute(
        GROUP_STATISTICS,
        _env(services),
        {
            "layer_project_id": 1,
            "operation": "count",
            "group_by": "name",
            "then_by": "klasse",
        },
    )
    [body] = _bodies(services[2], "aggregation-stats")
    assert body["group_by_column"] == "name"
    assert body["group_by_secondary_column"] == "join_klasse"
    assert out["then_by"] == "join_klasse"
    assert _read("klasse") in out["note"] and _read("name") not in out["note"]


async def test_area_statistics_group_by_and_filter_read_the_joined_field() -> None:
    services = _services()
    out = await execute(
        AREA_STATISTICS,
        _env(services),
        {
            "layer_project_id": 1,
            "group_by": "klasse",
            "filter": _where("oev_guete_mittel", ">", 3),
        },
    )
    bodies = _bodies(services[2], "area-statistics")
    assert {
        body["group_by_column"] for body in bodies if body["operation"] == "sum"
    } == {"join_klasse"}
    assert all(
        json.loads(body["filter"])["args"][0] == {"property": "join_oev_guete_mittel"}
        for body in bodies
    )
    assert out["filter"] == "join_oev_guete_mittel > 3"
    assert _read("klasse") in out["note"] and _read("oev_guete_mittel") in out["note"]


async def test_count_filter_reads_the_joined_field() -> None:
    services = _services()
    out = await execute(
        COUNT_FEATURES,
        _env(services),
        {"layer_project_id": 1, "filter": _where("klasse", "in", ["A", "B"])},
    )
    [body] = _bodies(services[2], "feature-count")
    assert json.loads(body["filter"])["args"][0] == {"property": "join_klasse"}
    assert out["count"] == 40 and out["filter"] == "join_klasse in ('A', 'B')"
    # The note names both and vouches for nothing: a source can have its own
    # join_ fields.
    assert out["note"] == (
        "'Stadtteile mit Güte' has no field 'klasse'; read 'join_klasse' in its place."
    )


async def test_a_count_reads_no_field_and_says_none_was_read() -> None:
    """A count takes no field: a stray one is neither resolved nor noted."""
    services = _services()
    out = await execute(
        GROUP_STATISTICS,
        _env(services),
        {
            "layer_project_id": 1,
            "operation": "count",
            "field": "oev_guete_mittel",
            "group_by": "klasse",
            "share_of": {
                "layer_project_id": 2,
                "operation": "count",
                "field": "einwohner",
            },
        },
    )
    first, second = _bodies(services[2], "aggregation-stats")
    assert "operation_column" not in first and "operation_column" not in second
    assert out["field"] == "oev_guete_mittel"
    assert _read("klasse") in out["note"]
    assert _read("oev_guete_mittel") not in out["note"]
    assert _read("einwohner") not in out["note"]


@pytest.mark.parametrize(
    ("spec", "args"),
    [
        (COUNT_FEATURES, {}),
        (FIELD_STATISTICS, {"field": "klasse"}),
        (GROUP_STATISTICS, {"operation": "count", "group_by": "klasse"}),
        (AREA_STATISTICS, {}),
    ],
)
async def test_restricted_names_an_unknown_filter_field_before_any_service(
    spec: Any, args: dict[str, Any]
) -> None:
    """The filter is checked against the layer's fields first: an unknown
    name gets its fixable message, and processes is not asked about it."""
    services = _services()
    with pytest.raises(InputInvalid, match="Field 'nichts' doesn't exist"):
        await execute(
            spec,
            _env(services, "restricted"),
            {"layer_project_id": 1, "filter": _where("nichts", "=", "A"), **args},
        )
    assert services[2].requests == []


async def test_a_field_the_layer_has_is_read_as_named() -> None:
    """``wert`` and ``join_wert`` both exist: ``wert`` is the field named."""
    services = _services()
    env = _env(services)
    stats = await execute(
        FIELD_STATISTICS, env, {"layer_project_id": 1, "field": "wert"}
    )
    groups = await execute(
        GROUP_STATISTICS,
        env,
        {
            "layer_project_id": 1,
            "operation": "sum",
            "field": "wert",
            "filter": _where("wert", ">", 1),
        },
    )
    count = await execute(
        COUNT_FEATURES, env, {"layer_project_id": 1, "filter": _where("wert", ">", 1)}
    )
    area = await execute(
        AREA_STATISTICS,
        env,
        {"layer_project_id": 1, "group_by": "wert", "filter": _where("wert", ">", 1)},
    )
    assert _bodies(services[2], "class-breaks")[0]["attribute"] == "wert"
    assert _bodies(services[2], "aggregation-stats")[0]["operation_column"] == "wert"
    assert {
        body["group_by_column"]
        for body in _bodies(services[2], "area-statistics")
        if body["operation"] == "sum"
    } == {"wert"}
    filters = [
        json.loads(body["inputs"]["filter"])
        for body in services[2].bodies()
        if body["inputs"].get("filter")
    ]
    assert len(filters) == 5
    assert all(f["args"][0] == {"property": "wert"} for f in filters)
    assert stats["field"] == "wert" and groups["field"] == "wert"
    for out in (stats, groups, count, area):
        assert "join_wert" not in json.dumps(out)


@pytest.mark.parametrize(
    ("spec", "args"),
    [
        (FIELD_STATISTICS, {"field": "nichts"}),
        (GROUP_STATISTICS, {"operation": "sum", "field": "nichts"}),
        (GROUP_STATISTICS, {"operation": "count", "group_by": "nichts"}),
        (
            GROUP_STATISTICS,
            {
                "operation": "count",
                "group_by": "name",
                "share_of": {
                    "layer_project_id": 2,
                    "operation": "count",
                    "group_by": "nichts",
                },
            },
        ),
        (AREA_STATISTICS, {"group_by": "nichts"}),
        (COUNT_FEATURES, {"filter": _where("nichts", "=", "A")}),
        (AREA_STATISTICS, {"filter": _where("nichts", "=", "A")}),
    ],
)
async def test_a_name_with_neither_field_still_fails(
    spec: Any, args: dict[str, Any]
) -> None:
    with pytest.raises(InputInvalid, match="nichts"):
        await execute(spec, _env(_services()), {"layer_project_id": 1, **args})


async def test_restricted_checks_the_joined_field_of_a_filter() -> None:
    """The filter is checked on ``join_klasse``, as one naming it is: a field
    with more than 50 distinct values cannot pick features."""
    for name in ("klasse", "join_klasse"):
        services = _services(distinct=80)
        with pytest.raises(InputInvalid, match="'join_klasse' has more than 50"):
            await execute(
                COUNT_FEATURES,
                _env(services, "restricted"),
                {"layer_project_id": 1, "filter": _where(name, "=", "A")},
            )
        assert [b["attribute"] for b in _bodies(services[2], "unique-values")] == [
            "join_klasse"
        ]
        assert _bodies(services[2], "feature-count") == []


async def test_restricted_results_keep_the_note_and_withhold_as_before() -> None:
    env_args = {"layer_project_id": 1}
    # Field statistics: the group size is counted on the joined field.
    services = _services(count=3)
    stats = await execute(
        FIELD_STATISTICS,
        _env(services, "restricted"),
        {**env_args, "field": "oev_guete_mittel", "filter": _where("klasse", "=", "A")},
    )
    [counted] = _bodies(services[2], "feature-count")
    assert json.loads(counted["filter"])["args"][1] == {
        "op": "not",
        "args": [{"op": "isNull", "args": [{"property": "join_oev_guete_mittel"}]}],
    }
    assert "mean" not in stats and "min" not in stats and "breaks" not in stats
    assert _read("oev_guete_mittel") in stats["note"] and "withheld" in stats["note"]
    # A categorical field with many values: its values stay withheld.
    services = _services(distinct=80)
    values = await execute(
        FIELD_STATISTICS, _env(services, "restricted"), {**env_args, "field": "klasse"}
    )
    assert "values" not in values
    assert _read("klasse") in values["note"] and "withheld" in values["note"]
    # A small filtered count.
    count = await execute(
        COUNT_FEATURES,
        _env(_services(count=3), "restricted"),
        {**env_args, "filter": _where("klasse", "=", "A")},
    )
    assert "count" not in count
    assert _read("klasse") in count["note"] and "withholds" in count["note"]
    # Counts per group: sent with the note; a sum: withheld whole.
    services = _services()
    groups = await execute(
        GROUP_STATISTICS,
        _env(services, "restricted"),
        {**env_args, "operation": "count", "group_by": "klasse"},
    )
    assert [row["value"] for row in groups["rows"]] == [30.0, 10.0]
    assert _read("klasse") in groups["note"]
    summed = await execute(
        GROUP_STATISTICS,
        _env(_services(), "restricted"),
        {**env_args, "operation": "sum", "field": "oev_guete_mittel"},
    )
    assert summed["withheld"] is True
    # Area per group: withheld, the note says which field was read.
    area = await execute(
        AREA_STATISTICS,
        _env(_services(), "restricted"),
        {**env_args, "group_by": "klasse"},
    )
    assert "groups" not in area and "total_area" not in area
    assert _read("klasse") in area["note"] and "withheld" in area["note"]


async def test_restricted_group_statistics_judge_the_joined_field_on_the_whole_layer() -> (
    None
):
    services = _services(distinct=80)
    out = await execute(
        GROUP_STATISTICS,
        _env(services, "restricted"),
        {
            "layer_project_id": 1,
            "operation": "count",
            "group_by": "klasse",
            "filter": _where("name", "is_not_null"),
        },
    )
    assert out["withheld"] is True
    assert [b["attribute"] for b in _bodies(services[2], "unique-values")] == [
        "join_klasse"
    ]
