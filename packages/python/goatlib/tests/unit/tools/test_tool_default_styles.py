"""The default style of a tool result follows the kind of its value. A number per
feature gets its ramp and direction, a legend title in plain words, a unit,
enough decimals for its classes, and grey for features without a value; bands
of a distance or travel cost get a title, a unit and the first band on top;
names get a title; and the tools that pass their input through stay plain."""

import asyncio
import copy
import json
import math
from pathlib import Path
from typing import Any, Callable, Iterator
from unittest.mock import AsyncMock, MagicMock

import duckdb
import pytest
from goatlib.analysis.data_management.join import JoinTool
from goatlib.analysis.schemas.aggregate import AggregationAreaType
from goatlib.analysis.schemas.catchment_area_v2 import CostType
from goatlib.analysis.schemas.heatmap_v2 import HeatmapType
from goatlib.models.io import DatasetMetadata
from goatlib.style.colors import sample_colors
from goatlib.style.compute import same_ignoring_stamps
from goatlib.style.context import DataContext
from goatlib.style.data import compute_into, describe
from goatlib.style.data_check import referenced_fields
from goatlib.style.defaults import default_style
from goatlib.style.validate import validate
from goatlib.tools import style as tool_style
from goatlib.tools.aggregate_points import (
    AggregatePointsToolParams,
    AggregatePointsToolRunner,
)
from goatlib.tools.aggregate_polygon import (
    AggregatePolygonToolParams,
    AggregatePolygonToolRunner,
)
from goatlib.tools.base import BaseToolRunner
from goatlib.tools.buffer import BufferToolParams, BufferToolRunner
from goatlib.tools.catchment_area import (
    CatchmentAreaToolRunner,
    CatchmentAreaWindmillParams,
)
from goatlib.tools.catchment_area_v2 import (
    CatchmentAreaV2ToolRunner,
    CatchmentAreaV2WindmillParams,
)
from goatlib.tools.centroid import CentroidToolRunner
from goatlib.tools.clip import ClipToolRunner
from goatlib.tools.custom_sql import CustomSqlToolRunner
from goatlib.tools.difference import DifferenceToolRunner
from goatlib.tools.dissolve import DissolveToolParams, DissolveToolRunner
from goatlib.tools.finalize_layer import FinalizeLayerRunner
from goatlib.tools.geocoding import GeocodingToolRunner
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
from goatlib.tools.intersection import IntersectionToolRunner
from goatlib.tools.join import JoinToolParams, JoinToolRunner
from goatlib.tools.layer_create_filtered import LayerCreateFilteredToolRunner
from goatlib.tools.merge import MergeToolRunner
from goatlib.tools.oev_gueteklassen import OevGueteklassenToolRunner
from goatlib.tools.origin_destination import OriginDestinationToolRunner
from goatlib.tools.schemas import ToolInputBase
from goatlib.tools.spatial_clustering import ZonesClusteringToolRunner
from goatlib.tools.travel_cost_matrix import TravelCostMatrixToolRunner
from goatlib.tools.trip_count import TripCountToolRunner
from goatlib.tools.union import UnionToolRunner

pytestmark = pytest.mark.unit

U = "00000000-0000-0000-0000-000000000001"
IDS = {"user_id": U, "folder_id": U}
GREY = {"color": "#cccccc"}
ORANGES = "colorbrewer:Oranges"
TRANSLATIONS = Path(tool_style.__file__).parents[1] / "i18n" / "translations"

GEOMETRY_SQL = {
    "point": "ST_Point(i, 0)",
    "line": "ST_MakeLine(ST_Point(i, 0), ST_Point(i, 1))",
    "polygon": "ST_Buffer(ST_Point(i, 0), 0.4)",
}
PART = {"point": "marker", "line": "line", "polygon": "fill"}


@pytest.fixture
def con() -> Iterator[duckdb.DuckDBPyConnection]:
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    yield con
    con.close()


def runner_for(runner_class: type, con: duckdb.DuckDBPyConnection | None) -> Any:
    runner = runner_class()
    runner._duckdb_con = con
    return runner


def table(
    con: duckdb.DuckDBPyConnection,
    field: str,
    geometry: str,
    values: str,
    rows: int,
    name: str = "result",
    field_type: str = "DOUBLE",
) -> str:
    """A result of `geometry` whose `field` holds `values` for row `i`."""
    con.execute(
        f"""CREATE OR REPLACE TABLE {name} AS
        SELECT ({values})::{field_type} AS "{field}", {GEOMETRY_SQL[geometry]} AS geometry
        FROM range({rows}) t(i)"""
    )
    return name


def issues(
    con: duckdb.DuckDBPyConnection, relation: str, doc: dict[str, Any], geometry: str
) -> list[Any]:
    ctx = describe(con, relation, geometry=geometry, fields_used=referenced_fields(doc))  # type: ignore[arg-type]
    return validate(doc, ctx)


# --- The tools and the default each one writes -------------------------------

OPERATIONS = ["count", "sum", "mean", "min", "max", "standard_deviation"]

#: The English title of each statistic of the source field `value`.
STATISTIC_TITLES = {
    "count": "Count",
    "sum": "Sum of value",
    "mean": "Mean of value",
    "min": "Minimum of value",
    "max": "Maximum of value",
    "standard_deviation": "Standard deviation of value",
}


def _stat(operation: str, **extra: Any) -> dict[str, Any]:
    stat = {"operation": operation, **extra}
    if operation != "count":
        stat["field"] = "value"
    return stat


def _aggregate_points(**stat: Any) -> AggregatePointsToolParams:
    return AggregatePointsToolParams(
        **IDS,
        source_layer_id=U,
        area_type=AggregationAreaType.h3_grid,
        h3_resolution=8,
        column_statistics=[stat],
    )


def _aggregate_polygon(
    weighted: bool = False, areas: bool = False, **stat: Any
) -> AggregatePolygonToolParams:
    """Onto an H3 grid, or with `areas` onto a polygon area layer."""
    where = (
        {"area_type": AggregationAreaType.polygon, "area_layer_id": U}
        if areas
        else {"area_type": AggregationAreaType.h3_grid, "h3_resolution": 8}
    )
    return AggregatePolygonToolParams(
        **IDS,
        source_layer_id=U,
        weighted_by_intersecting_area=weighted,
        column_statistics=[stat],
        **where,
    )


#: The statistics the analysis weights by the intersecting area, on polygon
#: areas only: a sum and a mean of a field.
WEIGHTED = {"sum", "mean"}


def _dissolve(**stat: Any) -> DissolveToolParams:
    return DissolveToolParams(
        **IDS, input_layer_id=U, calculate_statistics=True, field_statistics=[stat]
    )


def _expected(
    field: str,
    palette: Any,
    title: str,
    geometry: str,
    *,
    count: int = 7,
    reverse: bool = False,
    unit: str | None = None,
) -> dict[str, Any]:
    out = {
        "field": field,
        "method": "quantile",
        "count": count,
        "palette": palette,
        "title": title,
        "no_data": {PART[geometry]: GREY},
    }
    if reverse:
        out["reverse"] = True
    if unit is not None:
        out["unit"] = unit
    return out


Build = Callable[[], dict[str, Any]]


def _own(runner_class: type, params: Any, geometry: str = "polygon") -> Build:
    return lambda: runner_class().get_layer_style(params, MagicMock(), geometry, "r")


def _v2(runner_class: type, kind: HeatmapType, cost: CostType = CostType.time) -> Build:
    return _own(runner_class, MagicMock(heatmap_type=kind, cost_type=cost))


def _od(geometry: str) -> Build:
    params = MagicMock(weight_column="trips")
    runner = OriginDestinationToolRunner()
    if geometry == "point":
        return lambda: runner.points_style(params)
    return lambda: runner.get_layer_style(params, MagicMock(), "line", "r")


def _cases() -> dict[str, tuple[Build, str, dict[str, Any]]]:
    """Per tool layer and option: how its default is built, its geometry, and
    the classification it asks for."""
    cases: dict[str, tuple[Build, str, dict[str, Any]]] = {}
    for op in OPERATIONS:
        title = STATISTIC_TITLES[op]
        points_field = "count" if op == "count" else f"value_{op}"
        first_field = "count" if op == "count" else f"{op}_value"
        cases[f"aggregate_points {op}"] = (
            _own(AggregatePointsToolRunner, _aggregate_points(**_stat(op))),
            "polygon",
            _expected(points_field, ORANGES, title, "polygon"),
        )
        cases[f"aggregate_polygon {op}"] = (
            _own(AggregatePolygonToolRunner, _aggregate_polygon(**_stat(op))),
            "polygon",
            _expected(first_field, ORANGES, title, "polygon"),
        )
        # An H3 grid is never weighted.
        cases[f"aggregate_polygon {op} weighted h3"] = (
            _own(
                AggregatePolygonToolRunner,
                _aggregate_polygon(weighted=True, **_stat(op)),
            ),
            "polygon",
            _expected(first_field, ORANGES, title, "polygon"),
        )
        weighted_title = f"{title} (area weighted)" if op in WEIGHTED else title
        cases[f"aggregate_polygon {op} weighted areas"] = (
            _own(
                AggregatePolygonToolRunner,
                _aggregate_polygon(weighted=True, areas=True, **_stat(op)),
            ),
            "polygon",
            _expected(first_field, ORANGES, weighted_title, "polygon"),
        )
        cases[f"aggregate_polygon {op} areas"] = (
            _own(
                AggregatePolygonToolRunner,
                _aggregate_polygon(areas=True, **_stat(op)),
            ),
            "polygon",
            _expected(first_field, ORANGES, title, "polygon"),
        )
        cases[f"dissolve {op}"] = (
            _own(DissolveToolRunner, _dissolve(**_stat(op))),
            "polygon",
            _expected(first_field, tool_style.TEAL, title, "polygon"),
        )
    # A custom result name is the title itself.
    named = {"result_name": "Residents"}
    cases["aggregate_points named"] = (
        _own(AggregatePointsToolRunner, _aggregate_points(**_stat("sum", **named))),
        "polygon",
        _expected("Residents", ORANGES, "Residents", "polygon"),
    )
    cases["aggregate_polygon named weighted"] = (
        _own(
            AggregatePolygonToolRunner,
            _aggregate_polygon(weighted=True, areas=True, **_stat("mean", **named)),
        ),
        "polygon",
        _expected("Residents", ORANGES, "Residents", "polygon"),
    )
    cases["dissolve named count"] = (
        _own(DissolveToolRunner, _dissolve(**_stat("count", **named))),
        "polygon",
        _expected("Residents", tool_style.TEAL, "Residents", "polygon"),
    )
    cases["origin_destination lines"] = (
        _od("line"),
        "line",
        _expected("weight", "colorbrewer:OrRd", "Sum of trips", "line", count=5),
    )
    cases["origin_destination points"] = (
        _od("point"),
        "point",
        _expected("weight", "colorbrewer:OrRd", "Sum of trips", "point", count=5),
    )
    gravity = "Accessibility (gravity)"
    closest_time = "Average travel time to the closest destinations"
    closest_distance = "Average distance to the closest destinations"
    area = "Area reached"
    supply = "Supply per demand"
    access = "total_accessibility"
    emrld, teal, sunset = tool_style.EMRLD, tool_style.TEAL, tool_style.SUNSET
    cases["heatmap_gravity_legacy"] = (
        _own(HeatmapGravityToolRunner, MagicMock()),
        "polygon",
        _expected(access, emrld, gravity, "polygon"),
    )
    cases["heatmap_gravity"] = (
        _v2(HeatmapGravityV2ToolRunner, HeatmapType.gravity),
        "polygon",
        _expected(access, emrld, gravity, "polygon"),
    )
    cases["heatmap_closest_average_legacy"] = (
        _own(HeatmapClosestAverageToolRunner, MagicMock()),
        "polygon",
        _expected(access, emrld, closest_time, "polygon", reverse=True, unit="min"),
    )
    cases["heatmap_closest_average time"] = (
        _v2(HeatmapClosestAverageV2ToolRunner, HeatmapType.closest_average),
        "polygon",
        _expected(access, emrld, closest_time, "polygon", reverse=True, unit="min"),
    )
    cases["heatmap_closest_average distance"] = (
        _v2(
            HeatmapClosestAverageV2ToolRunner,
            HeatmapType.closest_average,
            CostType.distance,
        ),
        "polygon",
        _expected(access, emrld, closest_distance, "polygon", reverse=True, unit="m"),
    )
    cases["heatmap_connectivity_legacy"] = (
        _own(HeatmapConnectivityToolRunner, MagicMock()),
        "polygon",
        _expected("accessibility", teal, area, "polygon", unit="m²"),
    )
    cases["heatmap_connectivity"] = (
        _v2(HeatmapConnectivityV2ToolRunner, HeatmapType.connectivity),
        "polygon",
        # The routing engine sums the reached cells' areas in square meters.
        _expected(access, emrld, area, "polygon", unit="m²"),
    )
    cases["heatmap_2sfca_legacy"] = (
        _own(Heatmap2SFCAToolRunner, MagicMock()),
        "polygon",
        _expected(access, sunset, supply, "polygon"),
    )
    cases["heatmap_2sfca"] = (
        _v2(Heatmap2SFCAV2ToolRunner, HeatmapType.two_sfca),
        "polygon",
        _expected(access, emrld, supply, "polygon"),
    )
    for name, runner_class in [
        ("huff_model_legacy", HuffModelToolRunner),
        ("huff_model", HuffModelV2ToolRunner),
    ]:
        cases[name] = (
            _own(runner_class, MagicMock(), "point"),
            "point",
            _expected("probability", teal, "Market share", "point", unit="%"),
        )
    cases["trip_count"] = (
        _own(TripCountToolRunner, MagicMock(), "point"),
        "point",
        _expected("total", "colorbrewer:BuPu", "Trips in the time window", "point"),
    )
    return cases


CASES = _cases()


@pytest.mark.parametrize("case", list(CASES))
def test_the_default_asks_for_what_its_kind_of_value_needs(case: str) -> None:
    build, geometry, expected = CASES[case]
    doc = build()
    [c] = doc["classify"]
    assert {k: c[k] for k in c if k != "id"} == expected
    # The color without a class: the palette's middle, in the result's main part.
    middle = sample_colors(expected["palette"], 1)[0]
    assert doc["symbol"][PART[geometry]]["color"] == middle


@pytest.mark.parametrize("case", list(CASES))
def test_the_default_and_its_computed_style_pass_the_check_without_a_note(
    con: duckdb.DuckDBPyConnection, case: str
) -> None:
    build, geometry, expected = CASES[case]
    intent = build()
    relation = table(
        con,
        expected["field"],
        geometry,
        "CASE WHEN i < 90 THEN (i + 1) * 0.37 END",
        100,
    )
    doc = runner_for(TripCountToolRunner, con).computed_style(
        intent,
        relation=relation,
        geometry=geometry,
        fingerprint="f:1",
        seed="L",
        fit=True,
    )
    assert issues(con, relation, intent, geometry) == []
    assert issues(con, relation, doc, geometry) == []
    [c] = doc["classify"]
    assert c["format"] == {"decimals": tool_style.decimals_for(bounds_of(c))}
    assert c["computed"]["no_data"] is True


def test_the_origin_destination_sizes_stay_linear() -> None:
    lines = CASES["origin_destination lines"][0]()
    points = CASES["origin_destination points"][0]()
    middle = sample_colors("colorbrewer:OrRd", 1)[0]
    assert lines["symbol"]["line"] == {
        "color": middle,
        "opacity": 0.8,
        "width": {"field": "weight", "range": [1, 10]},
    }
    assert points["symbol"]["marker"]["color"] == middle
    assert points["symbol"]["marker"]["opacity"] == 0.8
    assert points["symbol"]["marker"]["size"] == {"field": "weight", "range": [10, 50]}


def test_a_plain_origin_destination_point_keeps_the_palette_middle(
    con: duckdb.DuckDBPyConnection,
) -> None:
    """One weight for every point: no classes, and the points take the class
    ramp's middle color, not the new-layer color."""
    relation = table(con, "weight", "point", "5", 10)
    runner = runner_for(OriginDestinationToolRunner, con)
    intent = runner.points_style(MagicMock(weight_column="trips"))
    doc = runner.computed_style(
        intent,
        relation=relation,
        geometry="point",
        fingerprint="f:1",
        seed="L",
        fit=True,
    )
    assert "classify" not in doc
    marker = doc["symbol"]["marker"]
    assert marker["color"] == sample_colors("colorbrewer:OrRd", 1)[0]
    assert (marker["size"]["field"], marker["size"]["range"]) == ("weight", [10, 50])
    assert issues(con, relation, doc, "point") == []


def test_a_tool_part_entry_is_merged_with_the_middle_color() -> None:
    doc = tool_style.numeric_default(
        "v",
        ORANGES,
        "point",
        "Count",
        symbol={"marker": {"size": 4}, "outline": {"color": "#ffffff"}},
    )
    assert doc["symbol"]["marker"]["color"] == sample_colors(ORANGES, 1)[0]
    assert doc["symbol"]["marker"]["size"] == 4
    assert doc["symbol"]["outline"] == {"color": "#ffffff"}


# --- Data that only holds negative values ------------------------------------


@pytest.mark.parametrize(
    ("values", "reverse"),
    [
        ("-(i + 1)", True),  # all below 0: the value farthest from 0 is darkest
        ("CASE WHEN i < 5 THEN 0 ELSE -i END", True),
        ("i - 5", False),  # crosses 0: the sequential palette as it is
        ("i", False),
        ("0", False),
        ("NULL", False),
    ],
)
@pytest.mark.parametrize(
    ("runner_class", "params", "field"),
    [
        (AggregatePointsToolRunner, _aggregate_points(**_stat("sum")), "value_sum"),
        (AggregatePolygonToolRunner, _aggregate_polygon(**_stat("min")), "min_value"),
        (DissolveToolRunner, _dissolve(**_stat("mean")), "mean_value"),
    ],
)
def test_a_statistic_of_negative_values_turns_the_ramp_around(
    con: duckdb.DuckDBPyConnection,
    runner_class: type,
    params: Any,
    field: str,
    values: str,
    reverse: bool,
) -> None:
    relation = table(con, field, "polygon", values, 10)
    doc = runner_for(runner_class, con).get_layer_style(
        params, MagicMock(), "polygon", relation
    )
    [c] = doc["classify"]
    assert c.get("reverse", False) is reverse
    assert ("reverse" in c) is reverse


def test_a_result_that_cannot_be_read_keeps_the_ramp(
    con: duckdb.DuckDBPyConnection, caplog: pytest.LogCaptureFixture
) -> None:
    doc = runner_for(AggregatePointsToolRunner, con).get_layer_style(
        _aggregate_points(**_stat("sum")), MagicMock(), "polygon", "missing_table"
    )
    assert "reverse" not in doc["classify"][0]
    assert "Reading the result's value range failed" in caplog.text
    unread = AggregatePointsToolRunner().get_layer_style(
        _aggregate_points(**_stat("sum")), MagicMock(), "polygon", "r"
    )
    assert "reverse" not in unread["classify"][0]


# --- Titles in English and German --------------------------------------------


def _titles(language: str) -> dict[str, str]:
    return json.loads((TRANSLATIONS / f"{language}.json").read_text())["style_titles"]


def test_titles_exist_in_english_and_german_alike() -> None:
    en, de = _titles("en"), _titles("de")
    assert set(en) == set(de)
    assert de["count"] == "Anzahl"
    assert de["sum"] == "Summe von {field}"
    assert de["area_weighted"] == "{title} (flächengewichtet)"
    assert de["trip_count"] == "Fahrten im Zeitfenster"
    for text in [*en.values(), *de.values()]:
        assert "—" not in text and "–" not in text
    for key in ("sum", "mean", "min", "max", "standard_deviation"):
        assert "{field}" in en[key] and "{field}" in de[key]


def test_a_title_reads_the_english_text() -> None:
    assert tool_style.style_title("sum", field="population") == "Sum of population"
    assert tool_style.style_title("market_share") == "Market share"


def test_the_huff_docstrings_name_percent() -> None:
    for runner_class in (HuffModelToolRunner, HuffModelV2ToolRunner):
        assert "percent, 0 to 100" in runner_class.get_layer_style.__doc__
        assert "0 to 1)" not in runner_class.get_layer_style.__doc__


# --- Decimals from the computed classes --------------------------------------


def bounds_of(c: dict[str, Any]) -> list[float]:
    """The domain's minimum, every class break and the domain's maximum."""
    low, high = c["computed"]["domain"]
    return [low, *[k["from"] for k in c["classes"] if "from" in k], high]


@pytest.mark.parametrize(
    ("bounds", "decimals"),
    [
        ([0, 5, 10, 15, 20], 0),  # whole numbers
        ([0, 6.14285714286, 13.2857142857, 49], 0),
        ([120000000, 350000000, 900000000], 0),  # very large
        ([0, 0.43, 0.86, 1.29, 3], 1),
        ([1.001, 1.002, 1.5], 3),  # neighbours kept apart
        ([0.0000002, 0.0000013, 0.0000025, 0.00001], 7),  # tiny ratios
        ([0, 0.0000013, 0.0000025], 6),  # 0 may read 0
        ([-0.4, 0.3], 1),  # a value other than 0 never reads 0
        ([0.5, 1.5, 2.5], 0),  # halves round away from 0, as the legend prints
        ([1, 1 + 1e-12], 10),  # the format's limit
        ([0, 0, 1, 2, 2], 0),  # equal neighbours are one bound
        ([math.nan, 0, 1, math.inf, -math.inf], 0),  # not numbers are left out
        ([5], 0),
        ([], 0),
    ],
)
def test_the_decimals_keep_neighbouring_bounds_apart(
    bounds: list[float], decimals: int
) -> None:
    assert tool_style.decimals_for(bounds) == decimals


def _computed(
    con: duckdb.DuckDBPyConnection,
    intent: dict[str, Any],
    relation: str,
    geometry: str,
    fit: bool = True,
) -> dict[str, Any]:
    return runner_for(TripCountToolRunner, con).computed_style(
        intent,
        relation=relation,
        geometry=geometry,
        fingerprint="f:1",
        seed="L",
        fit=fit,
    )


@pytest.mark.parametrize(
    ("values", "field_type", "decimals"),
    [
        ("(i % 7) * 10", "INTEGER", 0),  # seven whole values, ten rows each
        # Supply per demand of a few cells: breaks 0.0000036 and 0.0000044 need 7.
        ("(i % 7 + 1) * 0.000001", "DOUBLE", 7),
        ("(i % 7 + 1) * 100000000", "DOUBLE", 0),
    ],
)
def test_the_tool_default_gets_the_decimals_its_classes_need(
    con: duckdb.DuckDBPyConnection, values: str, field_type: str, decimals: int
) -> None:
    relation = table(con, "total", "point", values, 70, field_type=field_type)
    intent = TripCountToolRunner().get_layer_style(
        MagicMock(), MagicMock(), "point", relation
    )
    doc = _computed(con, intent, relation, "point")
    [c] = doc["classify"]
    assert c["format"] == {"decimals": decimals}
    assert issues(con, relation, doc, "point") == []
    # Computed again on the same data, the document stays as it is.
    again, _ = compute_into(con, relation, doc, geometry="point", fingerprint="f:2")
    assert same_ignoring_stamps(again, doc)


def test_a_format_the_tool_writes_itself_is_kept(
    con: duckdb.DuckDBPyConnection,
) -> None:
    relation = table(con, "total", "point", "(i % 7 + 1) * 0.000001", 70)
    intent = tool_style.numeric_default("total", ORANGES, "point", "Count")
    intent["classify"][0]["format"] = {"decimals": 2, "suffix": " x"}
    doc = _computed(con, intent, relation, "point")
    assert doc["classify"][0]["format"] == {"decimals": 2, "suffix": " x"}


@pytest.mark.parametrize("values", ["5", "NULL"])
def test_without_classes_nothing_is_written(
    con: duckdb.DuckDBPyConnection, values: str
) -> None:
    relation = table(con, "total", "point", values, 10)
    intent = tool_style.numeric_default("total", ORANGES, "point", "Count")
    doc = _computed(con, intent, relation, "point")
    assert "format" not in json.dumps(doc)


def test_an_empty_result_gets_no_decimals(con: duckdb.DuckDBPyConnection) -> None:
    relation = table(con, "total", "point", "i", 0)
    intent = tool_style.numeric_default("total", ORANGES, "point", "Count")
    doc = _computed(con, intent, relation, "point")
    assert "format" not in doc["classify"][0]


def test_categories_get_no_decimals(con: duckdb.DuckDBPyConnection) -> None:
    relation = table(con, "total", "point", "i % 3", 9)
    intent = tool_style.categories("total", [0, 1, 2], "colorbrewer:YlGn", "point")
    doc = _computed(con, intent, relation, "point")
    assert "format" not in doc["classify"][0]


def test_a_decimals_step_that_fails_leaves_the_computed_style(
    con: duckdb.DuckDBPyConnection, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fail(*args: Any) -> Any:
        raise ValueError("unreadable")

    monkeypatch.setattr("goatlib.tools.base.with_decimals", fail)
    relation = table(con, "total", "point", "i", 70)
    intent = tool_style.numeric_default("total", ORANGES, "point", "Count")
    doc = _computed(con, intent, relation, "point")
    assert "format" not in doc["classify"][0]
    assert len(doc["classify"][0]["classes"]) == 7


# --- The gate: only the tool's own style of its run gets decimals ------------

#: A classification a user made by hand, without a number format.
USER_STYLE: dict[str, Any] = {
    "version": "1.0.0",
    "kind": "vector",
    "symbol": {"fill": {"color": "#fd8d3c"}},
    "classify": [
        {
            "id": "v",
            "field": "v",
            "method": "quantile",
            "count": 5,
            "palette": "colorbrewer:Oranges",
        }
    ],
}


def _tiny(con: duckdb.DuckDBPyConnection) -> str:
    return table(con, "v", "polygon", "(i % 7 + 1) * 0.000001", 70)


class TestHandedInStylesComputeAsBefore:
    def test_a_template_style_is_saved_without_decimals(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        relation = _tiny(con)
        saved = runner_for(FinalizeLayerRunner, con)._layer_style(
            USER_STYLE,
            geometry_type="POLYGON",
            relation=relation,
            data_snapshot=9,
            layer_id="L",
        )
        expected, _ = compute_into(
            con, relation, USER_STYLE, geometry="polygon", fingerprint="f:1"
        )
        assert saved is not None and "format" not in saved["classify"][0]
        assert same_ignoring_stamps(saved, expected)

    def test_a_filtered_copy_is_stored_without_decimals(
        self,
        con: duckdb.DuckDBPyConnection,
        monkeypatch: pytest.MonkeyPatch,
        runner_event_loop: asyncio.AbstractEventLoop,
    ) -> None:
        relation = _tiny(con)
        runner = runner_for(LayerCreateFilteredToolRunner, con)
        runner._source_style = USER_STYLE
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
        expected, _ = compute_into(
            con, relation, USER_STYLE, geometry="polygon", fingerprint="f:1"
        )
        assert "format" not in stored["classify"][0]
        assert same_ignoring_stamps(stored, expected)

    def test_a_tool_default_computed_without_fit_gets_no_decimals(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        relation = _tiny(con)
        intent = tool_style.numeric_default("v", ORANGES, "polygon", "Count")
        doc = _computed(con, intent, relation, "polygon", fit=False)
        assert "format" not in doc["classify"][0]

    def test_the_saved_workflow_result_keeps_the_decimals_of_its_preview(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        relation = _tiny(con)
        intent = tool_style.numeric_default("v", ORANGES, "polygon", "Count")
        preview = _computed(con, intent, relation, "polygon")
        saved = runner_for(FinalizeLayerRunner, con)._layer_style(
            preview,
            geometry_type="POLYGON",
            relation=relation,
            data_snapshot=9,
            layer_id="L",
        )
        assert saved is not None
        assert saved["classify"][0]["format"] == {"decimals": 7}
        assert same_ignoring_stamps(saved, preview)


class _OwnRunner(BaseToolRunner[ToolInputBase]):
    tool_class = object
    output_geometry_type = "polygon"
    default_output_name = "Result"

    def process(self, params: Any, temp_dir: Path) -> Any:
        raise NotImplementedError

    def get_layer_style(
        self, params: Any, metadata: Any, geometry: Any, relation: Any
    ) -> Any:
        return tool_style.numeric_default("v", ORANGES, geometry, "Count")


def test_the_toolbox_run_stores_the_decimals(
    con: duckdb.DuckDBPyConnection,
    monkeypatch: pytest.MonkeyPatch,
    runner_event_loop: asyncio.AbstractEventLoop,
) -> None:
    relation = _tiny(con)
    runner = runner_for(_OwnRunner, con)
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
    assert c["format"] == {"decimals": 7}
    assert c["title"] == "Count" and c["no_data"] == {"fill": GREY}


# --- Bands and names: today's classes with a title, units and an order -------

#: The draw order of bands: the first class, the smallest step, on top.
FIRST_CLASS_ON_TOP = {"by": "classes"}


def _plus(doc: dict[str, Any], order: bool = False, **keys: Any) -> dict[str, Any]:
    """`doc` with `keys` added to its classification and, with `order`, its
    first class drawn on top."""
    out = copy.deepcopy(doc)
    out["classify"][0].update(keys)
    if order:
        out["order"] = FIRST_CLASS_ON_TOP
    return out


def _catchment_params(kind: str, cost: str) -> CatchmentAreaV2WindmillParams:
    grid = {"point_grid_layer_id": U} if kind == "point_grid" else {}
    return CatchmentAreaV2WindmillParams(
        **IDS,
        routing_mode="walking",
        starting_points={"latitude": [48.1], "longitude": [11.5]},
        catchment_area_type=kind,
        cost_type=cost,
        max_cost=15 if cost == "time" else 1500,
        **grid,
    )


def _first_catchment_params(cost: str) -> CatchmentAreaWindmillParams:
    distance = {"max_distance": 1500} if cost == "distance" else {}
    return CatchmentAreaWindmillParams(
        **IDS,
        routing_mode="walking",
        starting_points={"latitude": [48.1], "longitude": [11.5]},
        measure_type=cost,
        **distance,
    )


CATCHMENT_GEOMETRY = {"polygon": "polygon", "network": "line", "point_grid": "point"}
CATCHMENT_TITLE = {"time": ("Travel time", "min"), "distance": ("Distance", "m")}

CategoryBuild = Callable[[duckdb.DuckDBPyConnection, str], dict[str, Any]]


def _category_cases() -> (
    dict[str, tuple[CategoryBuild, str, str, str, str, dict[str, Any], list[Any]]]
):
    """Per tool layer and option: how its default is built (from a connection
    and the result relation), its geometry, the styled field, the values of the
    synthetic result and their type, the document it writes, and the checker's
    notes on it (the same on the intent and on the computed style)."""
    cases: dict[
        str, tuple[CategoryBuild, str, str, str, str, dict[str, Any], list[Any]]
    ] = {}
    mismatch = [("info", "palette_kind_mismatch")]
    cases["buffer constant"] = (
        lambda con, rel: runner_for(BufferToolRunner, con).get_layer_style(
            BufferToolParams(**IDS, input_layer_id=U, distances=[100, 200, 300]),
            MagicMock(),
            "polygon",
            rel,
        ),
        "polygon",
        "buffer_distance",
        "(i % 3 + 1) * 100",
        "INTEGER",
        _plus(
            tool_style.categories(
                "buffer_distance",
                [100, 200, 300],
                "colorbrewer:OrRd",
                "polygon",
                symbol={"fill": {"opacity": 0.7}},
            ),
            order=True,
            title="Buffer distance",
            unit="m",
            format={"decimals": 0},
        ),
        mismatch,
    )
    # Kilometers are stored as whole meters.
    cases["buffer constant km"] = (
        lambda con, rel: runner_for(BufferToolRunner, con).get_layer_style(
            BufferToolParams(
                **IDS, input_layer_id=U, distances=[0.5, 1], units="kilometers"
            ),
            MagicMock(),
            "polygon",
            rel,
        ),
        "polygon",
        "buffer_distance",
        "(i % 2 + 1) * 500",
        "INTEGER",
        _plus(
            tool_style.categories(
                "buffer_distance",
                [500, 1000],
                "colorbrewer:OrRd",
                "polygon",
                symbol={"fill": {"opacity": 0.7}},
            ),
            order=True,
            title="Buffer distance",
            unit="m",
            format={"decimals": 0},
        ),
        mismatch,
    )
    for kind, geometry in CATCHMENT_GEOMETRY.items():
        for cost, (title, unit) in CATCHMENT_TITLE.items():
            step = 5 if cost == "time" else 500
            symbol = {"line": {"width": 3}} if kind == "network" else None
            cases[f"catchment {kind} {cost}"] = (
                lambda con, rel, kind=kind, cost=cost, geometry=geometry: runner_for(
                    CatchmentAreaV2ToolRunner, con
                ).get_layer_style(
                    _catchment_params(kind, cost), MagicMock(), geometry, rel
                ),
                geometry,
                "cost_step",
                f"(i % 3 + 1) * {step}",
                "INTEGER",
                _plus(
                    tool_style.categories(
                        "cost_step",
                        [step, 2 * step, 3 * step],
                        "colorbrewer:YlGn",
                        geometry,
                        symbol=symbol,
                    ),
                    order=True,
                    title=title,
                    unit=unit,
                    format={"decimals": 0},
                ),
                mismatch,
            )
    # The first runner names its cost type `measure_type`.
    for cost, (title, unit) in CATCHMENT_TITLE.items():
        step = 5 if cost == "time" else 500
        cases[f"catchment first runner {cost}"] = (
            lambda con, rel, cost=cost: runner_for(
                CatchmentAreaToolRunner, con
            ).get_layer_style(
                _first_catchment_params(cost), MagicMock(), "polygon", rel
            ),
            "polygon",
            "cost_step",
            f"(i % 3 + 1) * {step}",
            "INTEGER",
            _plus(
                tool_style.categories(
                    "cost_step",
                    [step, 2 * step, 3 * step],
                    "colorbrewer:YlGn",
                    "polygon",
                ),
                order=True,
                title=title,
                unit=unit,
                format={"decimals": 0},
            ),
            mismatch,
        )
    clusters = MagicMock(nb_cluster=5)
    cases["spatial_clustering features"] = (
        lambda con, rel: runner_for(ZonesClusteringToolRunner, con).get_layer_style(
            clusters, MagicMock(), "polygon", rel
        ),
        "polygon",
        "cluster_id",
        "i % 5",
        "INTEGER",
        _plus(
            tool_style.categories(
                "cluster_id", list(range(5)), "colorbrewer:Set3", "polygon"
            ),
            title="Zone",
        ),
        [],
    )
    cases["spatial_clustering feature points"] = (
        lambda con, rel: runner_for(ZonesClusteringToolRunner, con).get_layer_style(
            clusters, MagicMock(), "point", rel
        ),
        "point",
        "cluster_id",
        "i % 5",
        "INTEGER",
        _plus(
            tool_style.categories(
                "cluster_id",
                list(range(5)),
                "colorbrewer:Set3",
                "point",
                symbol={"marker": {"size": 8, "opacity": 0.8}},
            ),
            title="Zone",
        ),
        [],
    )
    cases["spatial_clustering summary"] = (
        lambda con, rel: runner_for(ZonesClusteringToolRunner, con)._get_summary_style(
            clusters
        ),
        "point",
        "cluster_id",
        "i % 5",
        "INTEGER",
        _plus(
            tool_style.categories(
                "cluster_id",
                list(range(5)),
                "colorbrewer:Set3",
                "point",
                symbol={"marker": {"size": 16, "opacity": 0.6}},
            ),
            title="Zone",
        ),
        [],
    )
    labels = ["A", "B", "C", "D", "E", "F"]
    cases["oev_gueteklassen classes"] = (
        lambda con, rel: runner_for(OevGueteklassenToolRunner, con).get_layer_style(
            MagicMock(station_config=None), MagicMock(), "polygon", rel
        ),
        "polygon",
        "pt_class_label",
        "chr(65 + (i % 6)::INTEGER)",
        "VARCHAR",
        _plus(
            tool_style.categories(
                "pt_class_label",
                labels,
                [tool_style.OEV_GUETEKLASSEN_COLORS[k] for k in labels],
                "polygon",
            ),
            title="Public transport quality class",
        ),
        [],
    )
    cases["oev_gueteklassen stations"] = (
        lambda con, rel: tool_style.oev_gueteklassen_stations_style(),
        "point",
        "station_category",
        "CASE WHEN i < 7 THEN i + 1 ELSE 999 END",
        "INTEGER",
        _plus(
            tool_style.categories(
                "station_category",
                [*range(1, 8), 999],
                ["#000000"] * 7 + ["#717171"],
                "point",
                symbol={"marker": {"color": "#000000", "size": 6}},
            ),
            title="Station category",
        ),
        [],
    )
    return cases


CATEGORY_CASES = _category_cases()


def _issue_codes(
    con: duckdb.DuckDBPyConnection, relation: str, doc: dict[str, Any], geometry: str
) -> list[Any]:
    return [(i.level, i.code) for i in issues(con, relation, doc, geometry)]


@pytest.mark.parametrize("case", list(CATEGORY_CASES))
def test_a_category_default_keeps_its_classes_and_names_them(
    con: duckdb.DuckDBPyConnection, case: str
) -> None:
    build, geometry, field, values, field_type, expected, _ = CATEGORY_CASES[case]
    relation = table(con, field, geometry, values, 12, field_type=field_type)
    assert build(con, relation) == expected


@pytest.mark.parametrize("case", list(CATEGORY_CASES))
def test_a_category_default_and_its_computed_style_pass_the_check(
    con: duckdb.DuckDBPyConnection, case: str
) -> None:
    build, geometry, field, values, field_type, expected, notes = CATEGORY_CASES[case]
    relation = table(con, field, geometry, values, 12, field_type=field_type)
    intent = build(con, relation)
    doc = _computed(con, intent, relation, geometry)
    assert _issue_codes(con, relation, intent, geometry) == notes
    assert _issue_codes(con, relation, doc, geometry) == notes
    # Fixed classes, a number format only where the tool writes one.
    [c] = doc["classify"]
    assert [k["values"] for k in c["classes"]] == [
        k["values"] for k in expected["classify"][0]["classes"]
    ]
    assert c.get("format") == expected["classify"][0].get("format")
    assert doc.get("order") == expected.get("order")


@pytest.mark.parametrize("kind", list(CATCHMENT_GEOMETRY))
def test_catchment_bands_read_from_the_params_without_a_result(kind: str) -> None:
    """Without a result to read, the bands come from the params: the title and
    unit follow the cost type all the same."""
    geometry = CATCHMENT_GEOMETRY[kind]
    doc = CatchmentAreaV2ToolRunner().get_layer_style(
        _catchment_params(kind, "distance"), MagicMock(), geometry, "r"
    )
    [c] = doc["classify"]
    assert (c["title"], c["unit"], c["format"]) == ("Distance", "m", {"decimals": 0})
    assert doc["order"] == FIRST_CLASS_ON_TOP
    assert [k["values"] for k in c["classes"]] == [[300], [600], [900], [1200], [1500]]


def test_the_catchment_starting_points_keep_their_pin() -> None:
    assert tool_style.starting_points_style() == {
        "version": "1.0.0",
        "kind": "vector",
        "symbol": {
            "marker": {
                "shape": "icon",
                "icon": "goat:foundation-marker",
                "color": "#000000",
                "size": 40,
                "anchor": "bottom",
                "allow_overlap": True,
            }
        },
    }


def test_category_titles_exist_in_english_and_german() -> None:
    en, de = _titles("en"), _titles("de")
    assert {k: (en[k], de[k]) for k in CATEGORY_TITLE_KEYS} == CATEGORY_TITLE_KEYS


#: The titles of bands and names, English and German.
CATEGORY_TITLE_KEYS = {
    "buffer_distance": ("Buffer distance", "Pufferabstand"),
    "travel_time": ("Travel time", "Reisezeit"),
    "distance": ("Distance", "Entfernung"),
    "zone": ("Zone", "Zone"),
    "pt_class": ("Public transport quality class", "ÖV-Güteklasse"),
    "station_category": ("Station category", "Haltestellenkategorie"),
}


# --- Join: a classified statistic where the user asked for one that varies ---

#: The column a join writes per statistic of the join layer's field `value`.
JOIN_COLUMNS = {op: "count" if op == "count" else f"value_{op}" for op in OPERATIONS}


def _join(
    *stats: dict[str, Any], calculate: bool = True, **options: Any
) -> JoinToolParams:
    relation = (
        {"use_spatial_relationship": True, "spatial_relationship": "intersects"}
        if "spatial_relationship" not in options
        else {"use_spatial_relationship": True}
    )
    return JoinToolParams(
        **IDS,
        target_layer_id=U,
        join_layer_id=U,
        use_attribute_relationship=False,
        calculate_statistics=calculate,
        column_statistics=list(stats) or None,
        **relation,
        **options,
    )


def join_result(
    con: duckdb.DuckDBPyConnection,
    appended: list[str],
    values: str,
    rows: int,
    geometry: str = "polygon",
    field_type: str = "DOUBLE",
) -> str:
    """A result as the join writes it: the target layer's columns (`name` and
    the geometry), then the columns the run appends (`match_count` without a
    count, one per statistic). The first statistic (after a `match_count`, else
    the first appended column) holds `values` for row `i`; every other appended
    column holds 1."""
    first = 1 if appended[0] == "match_count" and len(appended) > 1 else 0
    columns = ", ".join(
        f'({values if k == first else "1"})::{field_type} AS "{name}"'
        for k, name in enumerate(appended)
    )
    con.execute(
        f"""CREATE OR REPLACE TABLE result AS
        SELECT 'n' || i AS name, {GEOMETRY_SQL[geometry]} AS geometry, {columns}
        FROM range({rows}) t(i)"""
    )
    return "result"


def _appended(op: str) -> list[str]:
    """The columns a join with the one statistic `op` appends."""
    return ["count"] if op == "count" else ["match_count", JOIN_COLUMNS[op]]


def _join_style(
    con: duckdb.DuckDBPyConnection | None,
    params: JoinToolParams,
    relation: str,
    geometry: str | None = "polygon",
) -> dict[str, Any] | None:
    return runner_for(JoinToolRunner, con).get_layer_style(
        params, MagicMock(), geometry, relation
    )


@pytest.mark.parametrize("geometry", ["polygon", "point", "line"])
@pytest.mark.parametrize("op", OPERATIONS)
def test_a_join_statistic_that_varies_is_classified(
    con: duckdb.DuckDBPyConnection, op: str, geometry: str
) -> None:
    column = JOIN_COLUMNS[op]
    relation = join_result(
        con, _appended(op), "CASE WHEN i < 9 THEN i % 4 END", 10, geometry
    )
    doc = _join_style(con, _join(_stat(op)), relation, geometry)
    assert doc is not None
    [c] = doc["classify"]
    assert {k: c[k] for k in c if k != "id"} == _expected(
        column, ORANGES, STATISTIC_TITLES[op], geometry
    )
    assert doc["symbol"][PART[geometry]]["color"] == sample_colors(ORANGES, 1)[0]
    computed = _computed(con, doc, relation, geometry)
    assert issues(con, relation, doc, geometry) == []
    assert issues(con, relation, computed, geometry) == []


@pytest.mark.parametrize(
    ("values", "classes"),
    [
        ("i % 2", 2),
        # One feature apart: the fit of the tool's run leaves one class, which
        # draws in the palette's middle color.
        ("CASE WHEN i = 0 THEN 5 ELSE 1 END", 0),
    ],
)
def test_a_join_statistic_of_two_values_is_fitted_as_any_tool_default(
    con: duckdb.DuckDBPyConnection, values: str, classes: int
) -> None:
    relation = join_result(con, ["count"], values, 10, field_type="BIGINT")
    doc = _join_style(con, _join(_stat("count")), relation)
    assert doc is not None
    computed = _computed(con, doc, relation, "polygon")
    assert len((computed.get("classify") or [{}])[0].get("classes") or []) == classes
    assert computed["symbol"]["fill"]["color"] == sample_colors(ORANGES, 1)[0]
    assert issues(con, relation, computed, "polygon") == []


def test_a_join_statistic_with_a_result_name_takes_it_as_title(
    con: duckdb.DuckDBPyConnection,
) -> None:
    relation = join_result(con, ["Matches"], "i % 4", 10)
    doc = _join_style(con, _join(_stat("count", result_name="Matches")), relation)
    assert doc is not None
    [c] = doc["classify"]
    assert (c["field"], c["title"]) == ("Matches", "Matches")


def test_the_first_join_statistic_decides(con: duckdb.DuckDBPyConnection) -> None:
    relation = join_result(con, ["match_count", "value_mean", "value_sum"], "i % 4", 10)
    doc = _join_style(con, _join(_stat("mean"), _stat("sum")), relation)
    assert doc is not None
    assert doc["classify"][0]["field"] == "value_mean"


def test_a_join_statistic_of_negative_values_turns_the_ramp_around(
    con: duckdb.DuckDBPyConnection,
) -> None:
    relation = join_result(con, _appended("min"), "-(i % 4) - 1", 10)
    doc = _join_style(con, _join(_stat("min")), relation)
    assert doc is not None and doc["classify"][0]["reverse"] is True


@pytest.mark.parametrize(
    ("values", "rows"),
    [
        ("1", 10),  # a constant count: one-to-one matches
        ("CASE WHEN i = 0 THEN 3 END", 10),  # one value among missing ones
        ("NULL", 10),
        ("i", 0),  # an empty result
    ],
    ids=["constant", "one value", "no value", "empty"],
)
@pytest.mark.parametrize("op", ["count", "sum"])
def test_a_join_statistic_that_does_not_vary_stays_plain(
    con: duckdb.DuckDBPyConnection, op: str, values: str, rows: int
) -> None:
    relation = join_result(con, _appended(op), values, rows)
    assert _join_style(con, _join(_stat(op)), relation) is None


@pytest.mark.parametrize(
    "params",
    [
        _join(calculate=False),
        _join(_stat("count"), join_operation="one_to_many"),
        _join(_stat("count"), spatial_relationship="disjoint"),
    ],
    ids=["no statistic", "one to many", "disjoint"],
)
def test_a_join_without_a_statistic_column_stays_plain(
    con: duckdb.DuckDBPyConnection, params: JoinToolParams
) -> None:
    relation = join_result(con, ["count"], "i % 4", 10)
    assert _join_style(con, params, relation) is None


def test_a_join_onto_a_table_has_no_style(con: duckdb.DuckDBPyConnection) -> None:
    relation = join_result(con, ["count"], "i % 4", 10)
    assert _join_style(con, _join(_stat("count")), relation, None) is None


def test_a_join_result_that_cannot_be_read_stays_plain(
    con: duckdb.DuckDBPyConnection, caplog: pytest.LogCaptureFixture
) -> None:
    assert _join_style(con, _join(_stat("count")), "missing_table") is None
    assert "Reading the join's statistic failed" in caplog.text
    assert _join_style(None, _join(_stat("count")), "r") is None


def _run_join(tmp_path: Path, stats: list[dict[str, Any]]) -> str:
    """The join tool's analysis, run with the parameters the runner builds, on
    a target layer whose columns `count` and `pop` hold values of their own;
    its result as a relation."""
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute(
        "COPY (SELECT i AS zone, (i * 10)::BIGINT AS count, i * 3.0 AS pop, "
        "ST_Buffer(ST_Point(i, 0), 0.4) AS geometry FROM range(6) t(i)) "
        f"TO '{tmp_path / 'target.parquet'}' (FORMAT parquet)"
    )
    con.execute(
        "COPY (SELECT i % 4 AS zone, i::DOUBLE AS value, ST_Point(i, 0) AS geometry "
        f"FROM range(10) t(i)) TO '{tmp_path / 'join.parquet'}' (FORMAT parquet)"
    )
    con.close()
    params = JoinToolParams(
        **IDS,
        target_layer_id=U,
        join_layer_id=U,
        use_spatial_relationship=False,
        use_attribute_relationship=True,
        attribute_relationships=[{"target_field": "zone", "join_field": "zone"}],
        calculate_statistics=True,
        column_statistics=stats,
    )
    tool = JoinTool()
    try:
        out, _ = tool.run(
            JoinToolRunner.analysis_params(
                params,
                tmp_path / "target.parquet",
                tmp_path / "join.parquet",
                tmp_path / "out.parquet",
            )
        )[0]
    finally:
        tool.cleanup()
    return f"read_parquet('{out}')"


@pytest.mark.parametrize(
    ("stat", "column", "title"),
    [
        ({"operation": "count"}, "count_1", "Count"),
        ({"operation": "sum", "field": "value", "result_name": "pop"}, "pop_1", "pop"),
    ],
    ids=["default name", "result name"],
)
def test_a_join_statistic_named_as_a_target_column_classifies_the_one_written(
    con: duckdb.DuckDBPyConnection,
    tmp_path: Path,
    stat: dict[str, Any],
    column: str,
    title: str,
) -> None:
    """The target layer keeps its column; the database writes the statistic
    under the next free name, and that is the column classified."""
    relation = _run_join(tmp_path, [stat])
    doc = _join_style(con, _join(stat), relation)
    assert doc is not None
    [c] = doc["classify"]
    assert (c["field"], c["title"]) == (column, title)
    computed = _computed(con, doc, relation, "polygon")
    assert computed["classify"][0]["field"] == column
    assert issues(con, relation, computed, "polygon") == []


class _Recording:
    """A connection that records the statements run on it."""

    def __init__(self, con: duckdb.DuckDBPyConnection) -> None:
        self.con, self.statements = con, []

    def execute(self, sql: str, *args: Any) -> Any:
        self.statements.append(sql)
        return self.con.execute(sql, *args)


@pytest.mark.parametrize("op", ["count", "min"])
def test_the_join_reads_its_statistic_once(
    con: duckdb.DuckDBPyConnection, op: str
) -> None:
    """One read of the column's minimum and maximum tells whether it varies
    and whether it holds only negative values; the column list is metadata."""
    relation = join_result(con, _appended(op), "-(i % 4) - 1", 10)
    recording = _Recording(con)
    doc = runner_for(JoinToolRunner, recording).get_layer_style(  # type: ignore[arg-type]
        _join(_stat(op)), MagicMock(), "polygon", relation
    )
    assert doc is not None
    reads = [
        s for s in recording.statements if not s.lstrip().upper().startswith("DESCRIBE")
    ]
    assert len(reads) == 1
    assert doc["classify"][0].get("reverse", False) is (op != "count")


def test_a_result_that_does_not_match_the_join_stays_plain(
    con: duckdb.DuckDBPyConnection,
) -> None:
    """Columns other than the ones the run writes: the statistic's column
    cannot be told, so nothing is classified."""
    relation = table(con, "count", "polygon", "i % 4", 10)
    assert _join_style(con, _join(_stat("count")), relation) is None


def test_a_join_style_handed_in_is_not_read_against_the_result(
    con: duckdb.DuckDBPyConnection,
    monkeypatch: pytest.MonkeyPatch,
    runner_event_loop: asyncio.AbstractEventLoop,
) -> None:
    """With a style given to the layer record, the join's own default, and its
    read of the result, are not asked for."""
    relation = _tiny(con)
    runner = runner_for(JoinToolRunner, con)

    def own(*args: Any) -> Any:
        raise AssertionError("the join's own default was asked for")

    monkeypatch.setattr(runner, "get_layer_style", own)
    monkeypatch.setattr(runner, "_get_ducklake_snapshot_id", lambda *a: 3)
    monkeypatch.setattr("goatlib.tools.base.table_path_parts", lambda r: ("a", "b"))
    runner.db_service = MagicMock(create_layer=AsyncMock())
    runner_event_loop.run_until_complete(
        runner._create_db_records(
            output_layer_id="L",
            params=_join(_stat("count")),
            output_name="Join",
            metadata=DatasetMetadata(path="x", source_type="vector"),
            table_info={"table_name": relation, "geometry_type": "POLYGON"},
            style=USER_STYLE,
        )
    )
    stored = runner.db_service.create_layer.call_args.kwargs["style"]
    assert stored["classify"][0]["field"] == "v"
    assert "title" not in stored["classify"][0]


# --- Plain on purpose --------------------------------------------------------

#: Tools that pass their input's attributes through: the tool cannot know which
#: attribute matters, so the result takes the new-layer style.
PLAIN_RUNNERS = [
    ClipToolRunner,
    CentroidToolRunner,
    IntersectionToolRunner,
    UnionToolRunner,
    DifferenceToolRunner,
    MergeToolRunner,
    CustomSqlToolRunner,
    TravelCostMatrixToolRunner,
]


@pytest.mark.parametrize("runner_class", PLAIN_RUNNERS, ids=lambda r: r.__name__)
def test_a_tool_that_passes_its_input_through_stays_plain(
    con: duckdb.DuckDBPyConnection, runner_class: type
) -> None:
    assert runner_class.get_layer_style is BaseToolRunner.get_layer_style
    relation = table(con, "v", "point", "i", 10)
    for geometry in ("point", "line", "polygon", None):
        assert (
            runner_class().get_layer_style(MagicMock(), MagicMock(), geometry, relation)
            is None
        )
    doc = _computed(con, None, relation, "point")
    expected = default_style(DataContext(kind="vector", geometry="point"), seed="L")
    assert "classify" not in doc
    assert doc["symbol"] == expected["symbol"]


@pytest.mark.parametrize(
    "params",
    [
        DissolveToolParams(**IDS, input_layer_id=U),
        DissolveToolParams(**IDS, input_layer_id=U, dissolve_fields=["kind"]),
    ],
    ids=["nothing chosen", "fields without statistics"],
)
def test_a_dissolve_without_statistics_stays_plain(params: DissolveToolParams) -> None:
    assert (
        DissolveToolRunner().get_layer_style(params, MagicMock(), "polygon", "r")
        is None
    )


def test_a_buffer_with_distances_from_a_field_stays_plain() -> None:
    params = BufferToolParams(
        **IDS, input_layer_id=U, distance_type="field", distance_field="d"
    )
    assert (
        BufferToolRunner().get_layer_style(params, MagicMock(), "polygon", "r") is None
    )


def test_geocoding_keeps_its_fixed_look() -> None:
    doc = GeocodingToolRunner().get_layer_style(MagicMock(), MagicMock(), "point", "r")
    assert doc == tool_style.styled(
        "point",
        {
            "marker": {"color": "#3b82f6", "size": 12},
            "outline": {"color": "#ffffff", "width": 2},
        },
    )
    assert "classify" not in doc
