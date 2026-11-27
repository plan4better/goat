"""A tool's default style fits the result it was made for: its numeric
classes are fitted to the data on every compute (`fit`): no more classes than
the classified field has values, every class holding a feature, one class for
a field with one value. A numeric classification without `fit` asked for in a
tool's run is fitted once (`fit_classes`). A point style for a point result,
distinct colors for cluster ids."""

import asyncio
import json
import math
from pathlib import Path
from typing import Any, Callable, Iterator
from unittest.mock import AsyncMock, MagicMock

import duckdb
import pytest
from goatlib.analysis.schemas.aggregate import AggregationAreaType
from goatlib.analysis.schemas.catchment_area_v2 import CostType
from goatlib.analysis.schemas.heatmap_v2 import HeatmapType
from goatlib.models.io import DatasetMetadata
from goatlib.style.check import MAIN_COLOR
from goatlib.style.compute import same_ignoring_stamps, stable
from goatlib.style.data import compute_into, describe
from goatlib.style.data_check import referenced_fields
from goatlib.style.validate import validate
from goatlib.tools import style as tool_style
from goatlib.tools import temp_writer
from goatlib.tools.aggregate_points import (
    AggregatePointsToolParams,
    AggregatePointsToolRunner,
)
from goatlib.tools.aggregate_polygon import (
    AggregatePolygonToolParams,
    AggregatePolygonToolRunner,
)
from goatlib.tools.base import BaseToolRunner
from goatlib.tools.catchment_area import CatchmentAreaToolRunner
from goatlib.tools.dissolve import DissolveToolParams, DissolveToolRunner
from goatlib.tools.finalize_layer import FinalizeLayerRunner
from goatlib.tools.heatmap_2sfca import Heatmap2SFCAToolRunner
from goatlib.tools.heatmap_closest_average import HeatmapClosestAverageToolRunner
from goatlib.tools.heatmap_connectivity import HeatmapConnectivityToolRunner
from goatlib.tools.heatmap_gravity import HeatmapGravityToolRunner
from goatlib.tools.heatmap_v2 import (
    Heatmap2SFCAV2ToolRunner,
    HeatmapClosestAverageV2ToolRunner,
    HeatmapConnectivityV2ToolRunner,
    HeatmapGravityV2ToolRunner,
)
from goatlib.tools.huff_model import HuffModelToolRunner
from goatlib.tools.huff_model_v2 import HuffModelV2ToolRunner
from goatlib.tools.layer_create_filtered import LayerCreateFilteredToolRunner
from goatlib.tools.origin_destination import OriginDestinationToolRunner
from goatlib.tools.schemas import ToolInputBase
from goatlib.tools.spatial_clustering import ZonesClusteringToolRunner
from goatlib.tools.trip_count import TripCountToolRunner

pytestmark = pytest.mark.unit

U = "00000000-0000-0000-0000-000000000001"
IDS = {"user_id": U, "folder_id": U}


def listed(*counts: tuple[float, int]) -> tuple[str, int]:
    """Values with the number of rows holding each, as a distribution."""
    values = [v for v, n in counts for _ in range(n)]
    return f"[{', '.join(map(repr, values))}][i + 1]", len(values)


#: The classified field's values per row `i`, and the number of rows.
DISTRIBUTIONS: dict[str, tuple[str, int]] = {
    "many_values": ("i + 1", 100),
    "three_values": ("i % 3", 30),
    "two_rows": ("i + 1", 2),
    "constant": ("5", 20),
    "all_null": ("NULL", 20),
    "half_zeros_long_tail": ("CASE WHEN i < 50 THEN 0 ELSE pow(1.2, i - 50) END", 100),
    "a_value_holds_over_a_third": ("CASE WHEN i < 40 THEN 1 ELSE i END", 100),
    "a_value_holds_most": ("CASE WHEN i < 60 THEN 0 ELSE i END", 100),
    # Fewer values than classes wished for, and ties among them.
    "three_values_tied": listed((1, 10), (2, 3), (3, 1)),
    "four_values_tied": listed((0, 20), (1, 5), (2, 2), (5, 1)),
    "five_values_tied": listed((1, 30), (2, 10), (3, 5), (4, 2), (6, 1)),
    "two_values_in_three_rows": listed((0, 2), (1, 1)),
    "four_values_two_tied": listed((0, 1), (1, 1), (2, 3), (3, 3)),
    "three_values_in_five_rows": listed((0, 2), (1, 2), (2, 1)),
    # Values the stored numbers (12 significant digits) do not tell apart.
    "values_beyond_12_digits": ("1 + i * 1e-14", 3),
    "nan_beside_a_constant": ("CASE WHEN i = 0 THEN 'nan'::DOUBLE ELSE 5 END", 20),
    "infinity_beside_a_constant": (
        "CASE WHEN i = 0 THEN 'infinity'::DOUBLE ELSE 5 END",
        20,
    ),
}

GEOMETRY_SQL = {
    "point": "ST_Point(i, 0)",
    "line": "ST_MakeLine(ST_Point(i, 0), ST_Point(i, 1))",
    "polygon": "ST_Buffer(ST_Point(i, 0), 0.4)",
}


def _aggregate_points() -> AggregatePointsToolParams:
    return AggregatePointsToolParams(
        **IDS,
        source_layer_id=U,
        area_type=AggregationAreaType.h3_grid,
        h3_resolution=8,
        column_statistics=[{"operation": "sum", "field": "value"}],
    )


def _aggregate_polygon() -> AggregatePolygonToolParams:
    return AggregatePolygonToolParams(
        **IDS,
        source_layer_id=U,
        area_type=AggregationAreaType.h3_grid,
        h3_resolution=8,
        column_statistics=[{"operation": "sum", "field": "value"}],
    )


def _dissolve() -> DissolveToolParams:
    return DissolveToolParams(
        **IDS,
        input_layer_id=U,
        calculate_statistics=True,
        field_statistics=[{"operation": "sum", "field": "value"}],
    )


def _own(runner_class: type, params: Callable[[], Any] | None = None) -> Any:
    """The tool's own `get_layer_style`."""

    def style(runner: BaseToolRunner, geometry: str, relation: str) -> Any:
        given = params() if params else MagicMock()
        return runner.get_layer_style(given, MagicMock(), geometry, relation)

    return runner_class, style


def _od() -> Any:
    return MagicMock(weight_column="trips")


def _od_points(
    runner: OriginDestinationToolRunner, geometry: str, relation: str
) -> Any:
    return runner.points_style(_od())


def _v2(kind: HeatmapType) -> Callable[[], Any]:
    return lambda: MagicMock(heatmap_type=kind, cost_type=CostType.time)


#: Every tool that asks for a classification: its runner, how it builds its
#: default, the field it classifies, the result's geometry and the classes it
#: wishes for.
TOOLS: dict[str, tuple[type, Callable[..., Any], str, str, int]] = {
    "dissolve": (*_own(DissolveToolRunner, _dissolve), "sum_value", "polygon", 7),
    "aggregate_points": (
        *_own(AggregatePointsToolRunner, _aggregate_points),
        "value_sum",
        "polygon",
        7,
    ),
    "aggregate_polygon": (
        *_own(AggregatePolygonToolRunner, _aggregate_polygon),
        "sum_value",
        "polygon",
        7,
    ),
    "origin_destination_lines": (
        *_own(OriginDestinationToolRunner, _od),
        "weight",
        "line",
        5,
    ),
    "origin_destination_points": (
        OriginDestinationToolRunner,
        _od_points,
        "weight",
        "point",
        5,
    ),
    "heatmap_gravity_legacy": (
        *_own(HeatmapGravityToolRunner),
        "total_accessibility",
        "polygon",
        7,
    ),
    "heatmap_closest_average_legacy": (
        *_own(HeatmapClosestAverageToolRunner),
        "total_accessibility",
        "polygon",
        7,
    ),
    "heatmap_connectivity_legacy": (
        *_own(HeatmapConnectivityToolRunner),
        "accessibility",
        "polygon",
        7,
    ),
    "heatmap_2sfca_legacy": (
        *_own(Heatmap2SFCAToolRunner),
        "total_accessibility",
        "polygon",
        7,
    ),
    "heatmap_gravity": (
        *_own(HeatmapGravityV2ToolRunner, _v2(HeatmapType.gravity)),
        "total_accessibility",
        "polygon",
        7,
    ),
    "heatmap_closest_average": (
        *_own(HeatmapClosestAverageV2ToolRunner, _v2(HeatmapType.closest_average)),
        "total_accessibility",
        "polygon",
        7,
    ),
    "heatmap_connectivity": (
        *_own(HeatmapConnectivityV2ToolRunner, _v2(HeatmapType.connectivity)),
        "total_accessibility",
        "polygon",
        7,
    ),
    "heatmap_2sfca": (
        *_own(Heatmap2SFCAV2ToolRunner, _v2(HeatmapType.two_sfca)),
        "total_accessibility",
        "polygon",
        7,
    ),
    "huff_model_legacy": (*_own(HuffModelToolRunner), "probability", "point", 7),
    "huff_model": (*_own(HuffModelV2ToolRunner), "probability", "point", 7),
    "trip_count": (*_own(TripCountToolRunner), "total", "point", 7),
}


@pytest.fixture
def con() -> Iterator[duckdb.DuckDBPyConnection]:
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    yield con
    con.close()


def result_table(
    con: duckdb.DuckDBPyConnection,
    field: str,
    geometry: str,
    distribution: str,
    name: str = "result",
    field_type: str = "DOUBLE",
) -> str:
    """A result of `geometry` whose `field` follows the distribution."""
    values, rows = DISTRIBUTIONS[distribution]
    con.execute(
        f"""CREATE OR REPLACE TABLE {name} AS
        SELECT ({values})::DOUBLE::{field_type} AS "{field}",
               {GEOMETRY_SQL[geometry]} AS geometry
        FROM range({rows}) t(i)"""
    )
    return name


def distinct_values(con: duckdb.DuckDBPyConnection, relation: str, field: str) -> int:
    return con.execute(f'SELECT count(DISTINCT "{field}") FROM {relation}').fetchone()[
        0
    ]


def issues(
    con: duckdb.DuckDBPyConnection, relation: str, doc: dict[str, Any], geometry: str
) -> list[Any]:
    """What the style check reports: the document against the data it draws."""
    ctx = describe(
        con,
        relation,
        geometry=geometry,  # type: ignore[arg-type]
        fields_used=referenced_fields(doc),
    )
    return validate(doc, ctx)


def errors(
    con: duckdb.DuckDBPyConnection, relation: str, doc: dict[str, Any], geometry: str
) -> list[Any]:
    return [i for i in issues(con, relation, doc, geometry) if i.level == "error"]


def runner_for(runner_class: type, con: duckdb.DuckDBPyConnection) -> Any:
    runner = runner_class()
    runner._duckdb_con = con
    return runner


def today(
    con: duckdb.DuckDBPyConnection, relation: str, intent: dict[str, Any], geometry: str
) -> dict[str, Any]:
    """The tool's default as the result got it before the fit: its intent
    computed over the data as it is."""
    doc, _ = compute_into(con, relation, intent, geometry=geometry, fingerprint="f:1")
    return doc


def unfitted(
    con: duckdb.DuckDBPyConnection, relation: str, intent: dict[str, Any], geometry: str
) -> dict[str, Any]:
    """The tool's default as a style without `fit` gets it: its intent without
    the key computed over the data as it is."""
    plain = {
        **intent,
        "classify": [
            {k: v for k, v in c.items() if k != "fit"} for c in intent["classify"]
        ],
    }
    return today(con, relation, plain, geometry)


def values_read(con: duckdb.DuckDBPyConnection, relation: str, field: str) -> int:
    """The field's finite values, those alike to 12 digits counted once."""
    rows = con.execute(
        f'SELECT DISTINCT "{field}"::DOUBLE FROM {relation} '
        f'WHERE "{field}" IS NOT NULL AND isfinite("{field}")'
    ).fetchall()
    return len({stable(v) for (v,) in rows})


def tool_default(
    runner: BaseToolRunner,
    intent: dict[str, Any],
    relation: str,
    geometry: str,
    fingerprint: str = "f:1",
) -> dict[str, Any]:
    """The style the tool's own default gets after its run."""
    return runner.computed_style(
        intent,
        relation=relation,
        geometry=geometry,
        fingerprint=fingerprint,
        seed="L",
        fit=True,
    )


def decimals_for(c: dict[str, Any]) -> int:
    """The decimals the computed classes need: their domain's ends, breaks
    and single values apart."""
    breaks = [k["from"] for k in c["classes"] if "from" in k]
    breaks += list((c["computed"].get("single") or {}).values())
    return tool_style.decimals_for(breaks, c["computed"]["domain"])


def without_format(doc: dict[str, Any]) -> dict[str, Any]:
    """The style without the number format the tool's own run writes."""
    return {
        **doc,
        "classify": [
            {k: v for k, v in c.items() if k != "format"} for c in doc["classify"]
        ],
    }


def classes_of(doc: dict[str, Any]) -> int:
    """The number of classes the layer is drawn in: 1 without a classification."""
    if "classify" not in doc:
        return 1
    [c] = doc["classify"]
    return len(c["classes"])


#: Distributions whose values hold no ties the class breaks fall on.
WITHOUT_TIES = {"many_values", "three_values", "two_rows"}


def drawn(doc: dict[str, Any]) -> int:
    """The number of classes the layer lists: its classes, else one."""
    if "classify" not in doc:
        return 1
    return len(doc["classify"][0].get("classes") or []) or 1


def holding(
    con: duckdb.DuckDBPyConnection, relation: str, field: str, doc: dict[str, Any]
) -> int:
    """The number of classes that hold a feature (from inclusive, to exclusive):
    the colors the map shows."""
    if "classify" not in doc or not doc["classify"][0].get("classes"):
        return 1
    held = 0
    for k in doc["classify"][0]["classes"]:
        low = k.get("from", float("-inf"))
        high = k.get("to")
        where = f'"{field}" >= ?' + (f' AND "{field}" < ?' if high is not None else "")
        args = [low] + ([high] if high is not None else [])
        found = con.execute(
            f"SELECT count(*) FROM {relation} WHERE {where}", args
        ).fetchone()[0]
        held += found > 0
    return held


def has_rows_without_value(
    con: duckdb.DuckDBPyConnection, relation: str, field: str
) -> bool:
    return con.execute(
        f'SELECT count(*) > 0 FROM {relation} WHERE "{field}" IS NULL'
    ).fetchone()[0]


def check_fit(
    con: duckdb.DuckDBPyConnection,
    runner: BaseToolRunner,
    intent: dict[str, Any],
    relation: str,
    geometry: str,
    field: str,
    tied: bool = True,
) -> dict[str, Any]:
    """The invariants of a fitted default, against the unchanged behaviour (the
    shared break code at the tool's wish)."""
    if intent["classify"][0].get("fit") is True:
        return check_fitted(con, runner, intent, relation, geometry, field)
    wish = intent["classify"][0]["count"]
    doc = tool_default(runner, intent, relation, geometry)
    assert errors(con, relation, doc, geometry) == []
    values = distinct_values(con, relation, field)
    before = today(con, relation, intent, geometry)
    if "classify" not in doc:
        # One color, the tool's own: one value, or no count draws two classes;
        # every row has a value.
        assert values <= 1 or holding(con, relation, field, before) <= 1
        assert not has_rows_without_value(con, relation, field)
        part, key = MAIN_COLOR[geometry].split(".")
        assert doc["symbol"][part][key] == intent["symbol"][part][key]
    elif values <= 1:
        # One value or none beside rows without a value: a class for the value
        # (none without one) and the rows listed as no data.
        [c] = doc["classify"]
        assert c["count"] == 1
        assert len(c.get("classes") or []) == values
        assert c["computed"]["no_data"] is True
    else:
        [c] = doc["classify"]
        n = len(c["classes"])
        breaks = [k["to"] for k in c["classes"] if "to" in k]
        assert n == len(breaks) + 1 >= 2
        assert min(wish, values) <= c["count"] <= wish
        if not tied:
            assert c["count"] == n <= values
        # Never fewer classes holding a feature than today; as many, then no
        # more empty classes.
        now = holding(con, relation, field, doc)
        then = holding(con, relation, field, before)
        assert (now, now - n) >= (then, then - drawn(before))
        # The decimals its classes need, and the rest of the default as asked.
        assert c["format"] == {"decimals": decimals_for(c)}
        asked = {k: v for k, v in intent["classify"][0].items() if k != "count"}
        assert {k: c.get(k) for k in asked} == asked
    # The style check computes it again when the data's stamp changes: on the
    # same data it gives the same document.
    again, _ = compute_into(con, relation, doc, geometry=geometry, fingerprint="f:2")
    assert same_ignoring_stamps(again, doc)
    return doc


def check_fitted(
    con: duckdb.DuckDBPyConnection,
    runner: BaseToolRunner,
    intent: dict[str, Any],
    relation: str,
    geometry: str,
    field: str,
) -> dict[str, Any]:
    """The invariants of a default with `fit`: the stored count is the wish and
    the classes at most the wish, one class per value where the field has no
    more, every class holding a feature, one class only for one value, and
    never fewer classes holding a feature than without the key."""
    wish = intent["classify"][0]["count"]
    doc = tool_default(runner, intent, relation, geometry)
    assert errors(con, relation, doc, geometry) == []
    [c] = doc["classify"]
    assert c["count"] == wish and c["fit"] is True
    values = values_read(con, relation, field)
    n = len(c.get("classes") or [])
    if values <= wish:
        assert n == values
    else:
        assert 2 <= n <= wish
    if n:
        assert holding(con, relation, field, doc) == n
        then = holding(con, relation, field, unfitted(con, relation, intent, geometry))
        assert n >= then
    if n >= 2:
        assert c["format"] == {"decimals": decimals_for(c)}
    if has_rows_without_value(con, relation, field):
        assert c["computed"]["no_data"] is True
    asked = intent["classify"][0]
    assert {k: c.get(k) for k in asked} == asked
    again, _ = compute_into(con, relation, doc, geometry=geometry, fingerprint="f:2")
    assert same_ignoring_stamps(again, doc)
    return doc


@pytest.mark.parametrize("distribution", list(DISTRIBUTIONS))
@pytest.mark.parametrize("tool", list(TOOLS))
def test_the_default_fits_the_classified_field(
    con: duckdb.DuckDBPyConnection, tool: str, distribution: str
) -> None:
    runner_class, build, field, geometry, wish = TOOLS[tool]
    runner = runner_for(runner_class, con)
    relation = result_table(con, field, geometry, distribution)
    intent = build(runner, geometry, relation)
    assert intent["classify"][0]["count"] == wish  # the tool keeps stating its wish
    check_fit(
        con,
        runner,
        intent,
        relation,
        geometry,
        field,
        tied=distribution not in WITHOUT_TIES,
    )


INTEGER_DISTRIBUTIONS = [
    d
    for d in DISTRIBUTIONS
    if d not in ("values_beyond_12_digits", "nan_beside_a_constant")
    and d != "infinity_beside_a_constant"
]


@pytest.mark.parametrize("distribution", INTEGER_DISTRIBUTIONS)
@pytest.mark.parametrize("tool", ["trip_count", "aggregate_points"])
def test_an_integer_field_fits_alike(
    con: duckdb.DuckDBPyConnection, tool: str, distribution: str
) -> None:
    runner_class, build, field, geometry, _ = TOOLS[tool]
    runner = runner_for(runner_class, con)
    relation = result_table(con, field, geometry, distribution, field_type="INTEGER")
    check_fit(
        con,
        runner,
        build(runner, geometry, relation),
        relation,
        geometry,
        field,
        tied=distribution not in WITHOUT_TIES,
    )


@pytest.mark.parametrize("wish", [7, 5])
def test_random_small_tied_results_never_draw_fewer_classes(
    con: duckdb.DuckDBPyConnection, wish: int
) -> None:
    """Seeded random small results with few, repeated values: the invariants of
    `check_fit` hold for every one of them."""
    import random

    rng = random.Random(20261126 + wish)
    runner = runner_for(TripCountToolRunner, con)
    for _ in range(200):
        values = rng.sample(range(10), rng.randint(2, wish))
        rows = [rng.choice(values) for _ in range(rng.randint(2, 15))]
        con.execute(
            "CREATE OR REPLACE TABLE result AS SELECT r.v::DOUBLE AS total, "
            "ST_Point(r.i, 0) AS geometry FROM (SELECT unnest(?) AS v, "
            "unnest(range(len(?))) AS i) r",
            [rows, rows],
        )
        intent = tool_style.classified("total", "colorbrewer:BuPu", "point", count=wish)
        check_fit(con, runner, intent, "result", "point", "total")


@pytest.mark.parametrize(
    ("distribution", "before", "after", "fitted"),
    [
        # (classes listed, classes holding a feature): without the key, fitted
        # once in the run, and with `fit`
        ("three_values_tied", (3, 2), (2, 2), (3, 3)),
        ("four_values_tied", (3, 2), (2, 2), (4, 4)),
        ("five_values_tied", (3, 3), (3, 3), (5, 5)),
        ("two_values_in_three_rows", (4, 2), (2, 2), (2, 2)),
        ("four_values_two_tied", (3, 3), (3, 3), (4, 4)),
        ("three_values_in_five_rows", (5, 3), (4, 3), (3, 3)),
        ("three_values", (2, 2), (3, 3), (3, 3)),
        ("two_rows", (7, 2), (2, 2), (2, 2)),
    ],
)
def test_fewer_values_than_wished_keep_the_count_that_draws_more(
    con: duckdb.DuckDBPyConnection,
    distribution: str,
    before: tuple[int, int],
    after: tuple[int, int],
    fitted: tuple[int, int],
) -> None:
    runner = runner_for(TripCountToolRunner, con)
    relation = result_table(con, "total", "point", distribution)
    intent = runner.get_layer_style(MagicMock(), MagicMock(), "point", relation)
    plain = unfitted(con, relation, intent, "point")
    asked = tool_style.classified("total", "colorbrewer:BuPu", "point")
    for doc, expected in [
        (plain, before),
        (tool_default(runner, asked, relation, "point"), after),
        (tool_default(runner, intent, relation, "point"), fitted),
    ]:
        assert (drawn(doc), holding(con, relation, "total", doc)) == expected


@pytest.mark.parametrize(
    ("values", "count"),
    [
        # Three values: four classes hold all three, seven leave three empty.
        ([3, 2, 2, 1], 4),
        # Six and seven classes both hold all three values with one empty.
        ([5, 5, 5, 1, 1, 9], 6),
    ],
)
def test_tied_values_take_the_count_whose_classes_hold_the_most(
    con: duckdb.DuckDBPyConnection, values: list[int], count: int
) -> None:
    """Every count from the number of values up to the wish is compared: more
    classes holding a feature, then fewer empty ones, then the smaller count."""
    con.execute(
        "CREATE TABLE result AS SELECT r.v::DOUBLE AS total, "
        "ST_Point(r.i, 0) AS geometry FROM (SELECT unnest(?) AS v, "
        "unnest(range(len(?))) AS i) r",
        [values, values],
    )
    intent = tool_style.classified("total", "colorbrewer:BuPu", "point")
    fitted = tool_style.fit_classes(con, "result", intent)
    assert fitted["classify"][0]["count"] == count
    doc = tool_default(runner_for(TripCountToolRunner, con), intent, "result", "point")
    held = holding(con, "result", "total", doc)
    assert held == 3
    assert drawn(doc) - held <= 1


@pytest.mark.parametrize("tool", list(TOOLS))
def test_with_many_values_the_default_is_the_one_of_today(
    con: duckdb.DuckDBPyConnection, tool: str
) -> None:
    runner_class, build, field, geometry, wish = TOOLS[tool]
    runner = runner_for(runner_class, con)
    relation = result_table(con, field, geometry, "many_values")
    intent = build(runner, geometry, relation)
    doc = tool_default(runner, intent, relation, geometry)
    plain = unfitted(con, relation, intent, geometry)
    # The same rows per class, the breaks moved up onto the next value.
    assert classes_of(doc) == classes_of(plain) == wish
    assert rows_per_class(con, relation, field, doc) == rows_per_class(
        con, relation, field, plain
    )
    assert [k.get("from") for k in doc["classify"][0]["classes"]] == [
        None if k.get("from") is None else float(math.ceil(k["from"]))
        for k in plain["classify"][0]["classes"]
    ]
    assert doc["classify"][0]["format"] == {"decimals": 0}


def rows_per_class(
    con: duckdb.DuckDBPyConnection, relation: str, field: str, doc: dict[str, Any]
) -> list[int]:
    out = []
    for k in doc["classify"][0]["classes"]:
        low, high = k.get("from"), k.get("to")
        out.append(
            con.execute(
                f'SELECT count(*) FROM {relation} WHERE (? IS NULL OR "{field}" >= ?) '
                f'AND (? IS NULL OR "{field}" < ?)',
                [low, low, high, high],
            ).fetchone()[0]
        )
    return out


@pytest.mark.parametrize("tool", list(TOOLS))
def test_one_value_beside_rows_without_one_keeps_a_class_and_no_data(
    con: duckdb.DuckDBPyConnection, tool: str
) -> None:
    """A field with one value and rows without a value: one class for the
    value and the no-data look for the rest, so map and legend show both."""
    runner_class, build, field, geometry, wish = TOOLS[tool]
    runner = runner_for(runner_class, con)
    con.execute(
        f"""CREATE OR REPLACE TABLE result AS
        SELECT CASE WHEN i < 10 THEN 5.0 END AS "{field}",
               {GEOMETRY_SQL[geometry]} AS geometry
        FROM range(20) t(i)"""
    )
    doc = tool_default(runner, build(runner, geometry, "result"), "result", geometry)
    [c] = doc["classify"]
    assert c["count"] == wish
    assert len(c["classes"]) == 1
    assert "no_data" in c
    assert c["computed"]["no_data"] is True
    assert errors(con, "result", doc, geometry) == []


@pytest.mark.parametrize("tool", list(TOOLS))
def test_one_value_in_every_row_is_one_class(
    con: duckdb.DuckDBPyConnection, tool: str
) -> None:
    """With `fit` the classification stays, so the classes grow back when the
    data gains values."""
    runner_class, build, field, geometry, wish = TOOLS[tool]
    runner = runner_for(runner_class, con)
    relation = result_table(con, field, geometry, "constant")
    doc = tool_default(runner, build(runner, geometry, relation), relation, geometry)
    [c] = doc["classify"]
    assert c["count"] == wish and len(c["classes"]) == 1


def test_a_numeric_classification_without_fit_and_one_value_stays_plain(
    con: duckdb.DuckDBPyConnection,
) -> None:
    runner = runner_for(TripCountToolRunner, con)
    relation = result_table(con, "total", "point", "constant")
    asked = tool_style.classified("total", "colorbrewer:BuPu", "point")
    assert "classify" not in tool_default(runner, asked, relation, "point")


@pytest.mark.parametrize("distribution", ["constant", "all_null"])
def test_a_size_by_field_on_one_value_still_validates(
    con: duckdb.DuckDBPyConnection, distribution: str
) -> None:
    """The origin-destination width and size follow the weight; with one value
    its one class stays valid, and with none the lines are listed as no data,
    also valid."""
    runner = runner_for(OriginDestinationToolRunner, con)
    relation = result_table(con, "weight", "line", distribution)
    intent = runner.get_layer_style(_od(), MagicMock(), "line", relation)
    doc = tool_default(runner, intent, relation, "line")
    if distribution == "constant":
        [c] = doc["classify"]
        assert len(c["classes"]) == 1
    else:
        [c] = doc["classify"]
        assert "classes" not in c and c["computed"]["no_data"] is True
    assert doc["symbol"]["line"]["width"]["field"] == "weight"
    assert errors(con, relation, doc, "line") == []


def test_a_missing_field_gives_the_default_style(
    con: duckdb.DuckDBPyConnection,
) -> None:
    """The style contract's safety net (`test_style_contract.py`)."""
    runner = runner_for(TripCountToolRunner, con)
    relation = result_table(con, "other", "point", "three_values")
    intent = runner.get_layer_style(MagicMock(), MagicMock(), "point", relation)
    doc = tool_default(runner, intent, relation, "point")
    plain = runner.computed_style(
        None, relation=relation, geometry="point", fingerprint="f:1", seed="L"
    )
    assert same_ignoring_stamps(doc, plain)


def test_an_empty_result_keeps_the_classes_asked_for(
    con: duckdb.DuckDBPyConnection,
) -> None:
    """Without rows there is nothing to fit: the classes are computed when data
    arrives (a workflow export that appends to the layer keeps its style)."""
    runner = runner_for(OriginDestinationToolRunner, con)
    con.execute(
        "CREATE TABLE empty AS SELECT 1::DOUBLE AS weight, "
        "ST_MakeLine(ST_Point(0, 0), ST_Point(0, 1)) AS geometry LIMIT 0"
    )
    intent = runner.get_layer_style(_od(), MagicMock(), "line", "empty")
    doc = tool_default(runner, intent, "empty", "line")
    assert [c["count"] for c in doc["classify"]] == [5]
    assert same_ignoring_stamps(doc, today(con, "empty", intent, "line"))


@pytest.mark.parametrize("name", list(TOOLS))
def test_an_empty_result_keeps_the_tool_s_style(
    con: duckdb.DuckDBPyConnection, caplog: pytest.LogCaptureFixture, name: str
) -> None:
    """No row breaks no hard rule of the style contract: the safety net keeps
    the tool's classification (`test_style_contract.py`)."""
    runner_class, build, field, geometry, _ = TOOLS[name]
    runner = runner_for(runner_class, con)
    con.execute(
        f"""CREATE OR REPLACE TABLE empty AS SELECT i::DOUBLE AS "{field}",
        {GEOMETRY_SQL[geometry]} AS geometry FROM range(0) t(i)"""
    )
    intent = build(runner, geometry, "empty")
    caplog.clear()
    doc = tool_default(runner, intent, "empty", geometry)
    assert [c["field"] for c in doc["classify"]] == [field]
    assert not [r for r in caplog.records if "does not fit" in r.getMessage()]


def test_a_fit_that_fails_leaves_the_classes_of_today(
    con: duckdb.DuckDBPyConnection, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fail(*args: Any) -> Any:
        raise duckdb.Error("unreadable")

    monkeypatch.setattr("goatlib.tools.base.fit_classes", fail)
    runner = runner_for(TripCountToolRunner, con)
    relation = result_table(con, "total", "point", "three_values")
    intent = tool_style.classified("total", "colorbrewer:BuPu", "point")
    doc = tool_default(runner, intent, relation, "point")
    assert same_ignoring_stamps(
        without_format(doc), today(con, relation, intent, "point")
    )


def oranges(geometry: str | None) -> dict[str, Any]:
    """A tool's default on the field `v`: quantile, 7 classes."""
    return tool_style.classified("v", "colorbrewer:Oranges", geometry or "polygon")


class TestEveryPath:
    """The toolbox run, a workflow node's preview and its export end with the
    same fitted classes; processes' style check is tested in its own suite."""

    def _fitted_count(self, con: duckdb.DuckDBPyConnection) -> int:
        relation = result_table(con, "v", "polygon", "three_values")
        runner = runner_for(TripCountToolRunner, con)
        doc = tool_default(runner, oranges("polygon"), relation, "polygon")
        return doc["classify"][0]["count"]

    def test_the_toolbox_run_stores_the_fitted_default(
        self,
        con: duckdb.DuckDBPyConnection,
        monkeypatch: pytest.MonkeyPatch,
        runner_event_loop: asyncio.AbstractEventLoop,
    ) -> None:
        expected = self._fitted_count(con)
        assert expected < 7
        relation = result_table(con, "v", "polygon", "three_values")

        class Runner(BaseToolRunner[ToolInputBase]):
            tool_class = object
            output_geometry_type = "polygon"
            default_output_name = "Result"

            def process(self, params: Any, temp_dir: Path) -> Any:
                raise NotImplementedError

            def get_layer_style(
                self, params: Any, metadata: Any, geometry: Any, relation: Any
            ) -> Any:
                return oranges(geometry)

        runner = runner_for(Runner, con)
        monkeypatch.setattr(runner, "_get_ducklake_snapshot_id", lambda *a: 3)
        monkeypatch.setattr("goatlib.tools.base.table_path_parts", lambda r: ("a", "b"))
        runner.db_service = MagicMock(create_layer=AsyncMock())
        runner_event_loop.run_until_complete(
            runner._create_db_records(
                output_layer_id="L",
                params=ToolInputBase(**IDS),
                output_name="Result",
                metadata=DatasetMetadata(path="x", source_type="vector"),
                table_info={"table_name": relation, "geometry_type": "POLYGON"},
            )
        )
        stored = runner.db_service.create_layer.call_args.kwargs["style"]
        [c] = stored["classify"]
        assert c["count"] == len(c["classes"]) == expected

    def test_the_preview_and_the_saved_result_agree(
        self,
        con: duckdb.DuckDBPyConnection,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        expected = self._fitted_count(con)
        path = tmp_path / "out.parquet"
        relation = result_table(con, "v", "polygon", "three_values")
        con.execute(f"COPY {relation} TO '{path}' (FORMAT PARQUET)")

        class Writer(temp_writer.TempLayerWriter):
            def __init__(self, *args: Any, **kwargs: Any) -> None:
                super().__init__(*args, temp_data_root=tmp_path / "temp", **kwargs)

        monkeypatch.setattr(temp_writer, "TempLayerWriter", Writer)

        class Runner(BaseToolRunner[ToolInputBase]):
            tool_class = object
            output_geometry_type = None
            default_output_name = "Result"

            def process(self, params: Any, temp_dir: Path) -> Any:
                return path, DatasetMetadata(path=str(path), source_type="vector")

            def get_layer_style(
                self, params: Any, metadata: Any, geometry: Any, relation: Any
            ) -> Any:
                return oranges(geometry)

        runner = runner_for(Runner, con)
        runner.settings = MagicMock(pmtiles_enabled=False, pmtiles_max_zoom=14)

        async def nothing() -> None:
            return None

        runner._init_db_service = nothing
        runner._close_db_service = nothing
        result = runner.run(
            ToolInputBase(user_id=U, temp_mode=True, workflow_id="w1", node_id="n1")
        )
        preview = result["style"]
        [c] = preview["classify"]
        assert c["count"] == len(c["classes"]) == expected
        [meta_path] = (tmp_path / "temp").rglob("metadata.json")
        assert json.loads(meta_path.read_text())["style"] == preview

        finalize = runner_for(FinalizeLayerRunner, con)
        saved = finalize._layer_style(
            preview,
            geometry_type="POLYGON",
            relation=f"read_parquet('{path}')",
            data_snapshot=9,
            layer_id="L",
        )
        assert saved is not None and saved["classify"][0]["computed"]["data"] == (
            "ducklake:9"
        )
        assert same_ignoring_stamps(saved, preview)

    def test_the_export_fits_a_tool_default_again(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        """A default with `fit` carries the key: the saved result's classes
        follow its data, also when it holds more values than the preview."""
        runner = runner_for(TripCountToolRunner, con)
        small = result_table(con, "total", "point", "three_values")
        intent = runner.get_layer_style(MagicMock(), MagicMock(), "point", small)
        preview = tool_default(runner, intent, small, "point")
        assert len(preview["classify"][0]["classes"]) == 3
        many = result_table(con, "total", "point", "many_values", name="many")
        saved = runner_for(FinalizeLayerRunner, con)._layer_style(
            preview,
            geometry_type="POINT",
            relation=many,
            data_snapshot=9,
            layer_id="L",
        )
        assert saved is not None
        [c] = saved["classify"]
        assert len(c["classes"]) == c["count"] == 7 and c["fit"] is True


class TestUserStylesStayAsTheyAre:
    """Only the style the tool itself asks for in its run is fitted: a style
    handed in from outside is computed as asked, also with a count and no
    classes computed yet."""

    def test_a_template_style_asking_for_classes_is_saved_as_asked(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        relation = result_table(con, "v", "polygon", "three_values")
        remembered = tool_style.classified(
            "v", "colorbrewer:Oranges", "polygon", count=5
        )
        saved = runner_for(FinalizeLayerRunner, con)._layer_style(
            remembered,
            geometry_type="POLYGON",
            relation=relation,
            data_snapshot=9,
            layer_id="L",
        )
        assert saved is not None and saved["classify"][0]["count"] == 5
        assert same_ignoring_stamps(saved, today(con, relation, remembered, "polygon"))

    def test_a_filtered_copy_of_a_style_asking_for_classes_is_stored_as_asked(
        self,
        con: duckdb.DuckDBPyConnection,
        monkeypatch: pytest.MonkeyPatch,
        runner_event_loop: asyncio.AbstractEventLoop,
    ) -> None:
        relation = result_table(con, "v", "polygon", "three_values")
        source = oranges("polygon")
        runner = runner_for(LayerCreateFilteredToolRunner, con)
        runner._source_style = source
        monkeypatch.setattr(runner, "_get_ducklake_snapshot_id", lambda *a: 3)
        monkeypatch.setattr("goatlib.tools.base.table_path_parts", lambda r: ("a", "b"))
        runner.db_service = MagicMock(create_layer=AsyncMock())
        runner_event_loop.run_until_complete(
            runner._create_db_records(
                output_layer_id="L",
                params=ToolInputBase(**IDS),
                output_name="Copy",
                metadata=DatasetMetadata(path="x", source_type="vector"),
                table_info={"table_name": relation, "geometry_type": "POLYGON"},
            )
        )
        stored = runner.db_service.create_layer.call_args.kwargs["style"]
        assert stored["classify"][0]["count"] == 7
        assert same_ignoring_stamps(stored, today(con, relation, source, "polygon"))

    def _user_style(
        self, con: duckdb.DuckDBPyConnection, relation: str
    ) -> dict[str, Any]:
        intent = tool_style.classified("v", "colorbrewer:Oranges", "polygon")
        return today(con, relation, intent, "polygon")

    def test_a_template_style_is_saved_as_today(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        relation = result_table(con, "v", "polygon", "three_values")
        remembered = self._user_style(con, relation)
        assert remembered["classify"][0]["count"] == 7
        saved = runner_for(FinalizeLayerRunner, con)._layer_style(
            remembered,
            geometry_type="POLYGON",
            relation=relation,
            data_snapshot=9,
            layer_id="L",
        )
        assert same_ignoring_stamps(saved, remembered)
        assert saved["classify"][0]["count"] == 7

    def test_a_filtered_copy_keeps_the_source_style(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        relation = result_table(con, "v", "polygon", "three_values")
        source = self._user_style(con, relation)
        runner = runner_for(LayerCreateFilteredToolRunner, con)
        runner._source_style = source
        doc = runner.computed_style(
            runner.get_layer_style(MagicMock(), MagicMock(), "polygon", relation),
            relation=relation,
            geometry="polygon",
            fingerprint="f:2",
            seed="L",
        )
        assert same_ignoring_stamps(doc, source)
        assert doc["classify"][0]["count"] == 7

    def _missing_field_style(self) -> dict[str, Any]:
        return tool_style.classified("gone", "colorbrewer:Oranges", "polygon")

    def test_a_template_style_naming_a_missing_column_is_saved_as_today(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        """No safety net on a style handed in (`test_style_contract.py`)."""
        relation = result_table(con, "v", "polygon", "three_values")
        remembered = self._missing_field_style()
        saved = runner_for(FinalizeLayerRunner, con)._layer_style(
            remembered,
            geometry_type="POLYGON",
            relation=relation,
            data_snapshot=9,
            layer_id="L",
        )
        assert same_ignoring_stamps(saved, today(con, relation, remembered, "polygon"))

    def test_a_filtered_copy_naming_a_missing_column_keeps_it(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        relation = result_table(con, "v", "polygon", "three_values")
        source = self._missing_field_style()
        runner = runner_for(LayerCreateFilteredToolRunner, con)
        runner._source_style = source
        doc = runner.computed_style(
            runner.get_layer_style(MagicMock(), MagicMock(), "polygon", relation),
            relation=relation,
            geometry="polygon",
            fingerprint="f:1",
            seed="L",
            fit=runner.fits_result_style,
        )
        assert same_ignoring_stamps(doc, today(con, relation, source, "polygon"))


class TestFixedListsAsToday:
    """Category lists (catchment bands, buffer distances, public transport
    classes) are not fitted: they come out as before."""

    @pytest.mark.parametrize(
        "intent",
        [
            tool_style.categories("v", [1, 2, 3], "colorbrewer:YlGn", "polygon"),
            tool_style.categories(
                "v",
                [1, 2, 3],
                "colorbrewer:OrRd",
                "polygon",
                symbol={"fill": {"opacity": 0.7}},
            ),
            tool_style.oev_gueteklassen_style(),
        ],
    )
    def test_a_category_list_is_computed_as_today(
        self, con: duckdb.DuckDBPyConnection, intent: dict[str, Any]
    ) -> None:
        relation = result_table(con, "v", "polygon", "three_values")
        field = intent["classify"][0]["field"]
        if field != "v":  # the public transport classes: their labels
            con.execute(
                f"CREATE OR REPLACE TABLE {relation} AS SELECT "
                f"chr(65 + v::INTEGER) AS {field}, geometry FROM {relation}"
            )
        doc = tool_default(
            runner_for(TripCountToolRunner, con), intent, relation, "polygon"
        )
        assert same_ignoring_stamps(doc, today(con, relation, intent, "polygon"))

    def test_buffer_distances_get_the_classes_of_today(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        from goatlib.tools.buffer import BufferToolParams, BufferToolRunner

        con.execute(
            "CREATE TABLE rings AS SELECT (i % 3 + 1) * 100 AS buffer_distance, "
            "ST_Buffer(ST_Point(i, 0), 0.4) AS geometry FROM range(9) t(i)"
        )
        runner = runner_for(BufferToolRunner, con)
        params = BufferToolParams(**IDS, input_layer_id=U, distances=[100, 200, 300])
        intent = runner.get_layer_style(params, MagicMock(), "polygon", "rings")
        assert intent == tool_style.bands(
            "buffer_distance",
            [100, 200, 300],
            "colorbrewer:OrRd",
            "polygon",
            "Buffer distance",
            "m",
            symbol={"fill": {"opacity": 0.7}},
        )
        doc = tool_default(runner, intent, "rings", "polygon")
        assert same_ignoring_stamps(doc, today(con, "rings", intent, "polygon"))

    def test_catchment_polygons_get_the_bands_of_today(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        con.execute(
            "CREATE TABLE bands AS SELECT (i % 3 + 1) * 5 AS cost_step, "
            "ST_Buffer(ST_Point(i, 0), 0.4) AS geometry FROM range(9) t(i)"
        )
        runner = runner_for(CatchmentAreaToolRunner, con)
        params = MagicMock(catchment_area_type="polygon")
        doc = runner.get_layer_style(params, MagicMock(), "polygon", "bands")
        assert doc == tool_style.bands(
            "cost_step",
            [5, 10, 15],
            "colorbrewer:YlGn",
            "polygon",
            "Travel time",
            "min",
            reverse=True,
        )
        computed = tool_default(runner, doc, "bands", "polygon")
        assert same_ignoring_stamps(computed, today(con, "bands", doc, "polygon"))


def test_a_point_grid_catchment_draws_its_points_in_the_band_colors(
    con: duckdb.DuckDBPyConnection,
) -> None:
    con.execute(
        "CREATE TABLE grid AS SELECT (i % 3 + 1) * 5 AS cost_step, i::DOUBLE AS cost, "
        "ST_Point(i, 0) AS geometry FROM range(9) t(i)"
    )
    runner = runner_for(CatchmentAreaToolRunner, con)
    params = MagicMock(catchment_area_type="point_grid")
    points = runner.get_layer_style(params, MagicMock(), "point", "grid")
    polygons = tool_style.categories(
        "cost_step", [5, 10, 15], "colorbrewer:YlGn", "polygon", reverse=True
    )
    assert errors(con, "grid", points, "point") == []
    assert "fill" not in points["symbol"]
    [c] = points["classify"]
    [p] = polygons["classify"]
    assert [k["values"] for k in c["classes"]] == [k["values"] for k in p["classes"]]
    assert [k["marker"]["color"] for k in c["classes"]] == [
        k["fill"]["color"] for k in p["classes"]
    ]


@pytest.mark.parametrize("clusters", [9, 10, 20])
def test_cluster_ids_get_distinct_colors_from_a_categorical_palette(
    con: duckdb.DuckDBPyConnection, clusters: int
) -> None:
    from goatlib.style.catalog import palettes

    runner = runner_for(ZonesClusteringToolRunner, con)
    params = MagicMock(nb_cluster=clusters)
    con.execute(
        f"CREATE TABLE zones AS SELECT i % {clusters} AS cluster_id, "
        "ST_Buffer(ST_Point(i, 0), 0.4) AS geometry FROM range(40) t(i)"
    )
    con.execute(
        f"CREATE TABLE summary AS SELECT i AS cluster_id, ST_Point(i, 0) AS geometry "
        f"FROM range({clusters}) t(i)"
    )
    for doc, relation, geometry, part in [
        (
            runner.get_layer_style(params, MagicMock(), "polygon", "zones"),
            "zones",
            "polygon",
            "fill",
        ),
        (runner._get_summary_style(params), "summary", "point", "marker"),
    ]:
        assert errors(con, relation, doc, geometry) == []
        [c] = doc["classify"]
        assert palettes()[c["palette"]].kind == "qualitative"
        # The default for categories is shorter than the default of 10 clusters:
        # a categorical palette of the catalogue's greatest length.
        from goatlib.style.colors import DEFAULT_CLASSIFY_PALETTE

        assert len(palettes()[DEFAULT_CLASSIFY_PALETTE["categories"]].colors) < 10
        assert len(palettes()[c["palette"]].colors) == max(
            len(p.colors) for p in palettes().values() if p.kind == "qualitative"
        )
        catalogue = set(palettes()[c["palette"]].colors)
        colors = [k[part]["color"] for k in c["classes"]]
        assert [k["values"] for k in c["classes"]] == [[i] for i in range(clusters)]
        assert set(colors) <= catalogue
        assert all(a != b for a, b in zip(colors, colors[1:]))
        if clusters <= 10:  # the tool's default: every cluster its own color
            assert len(set(colors)) == clusters
