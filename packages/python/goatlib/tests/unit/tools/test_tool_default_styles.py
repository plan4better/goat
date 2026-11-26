"""The default style of a tool result whose value is a number per feature follows
the kind of that number: ramp and direction, a legend title in plain words, a
unit, enough decimals for its classes, and grey for features without a value."""

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
from goatlib.style.colors import sample_colors
from goatlib.style.compute import same_ignoring_stamps
from goatlib.style.data import compute_into, describe
from goatlib.style.data_check import referenced_fields
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
from goatlib.tools.trip_count import TripCountToolRunner

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
