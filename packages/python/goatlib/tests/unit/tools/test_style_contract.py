"""The style contract: a tool's default style fits the result it styles. Each
rule on a designed result that breaks it and on one that keeps it, the
assertion the tool tests call, and the safety net of a run: a tool's own
style that breaks a hard rule gives the layer the default style of its
geometry and one warning; a style handed in from outside is stored as
given."""

import asyncio
import logging
from typing import Any, Iterator
from unittest.mock import AsyncMock, MagicMock

import duckdb
import pytest
from goatlib.analysis.schemas.aggregate import AggregationAreaType
from goatlib.models.io import DatasetMetadata
from goatlib.style.compute import same_ignoring_stamps
from goatlib.style.data import compute_into
from goatlib.tools import style as tool_style
from goatlib.tools.aggregate_points import (
    AggregatePointsToolParams,
    AggregatePointsToolRunner,
)
from goatlib.tools.base import BaseToolRunner
from goatlib.tools.catchment_area_v2 import (
    CatchmentAreaV2ToolRunner,
    CatchmentAreaV2WindmillParams,
)
from goatlib.tools.finalize_layer import FinalizeLayerRunner
from goatlib.tools.layer_create_filtered import LayerCreateFilteredToolRunner
from goatlib.tools.origin_destination import OriginDestinationToolRunner
from goatlib.tools.schemas import ToolInputBase
from goatlib.tools.spatial_clustering import (
    ClusteringZonesToolParams,
    ZonesClusteringToolRunner,
)
from goatlib.tools.style_contract import (
    Expectation,
    StyleContractError,
    StyleContractNote,
    assert_style_contract,
    assert_tool_style,
    hard_problems,
    style_contract,
    tool_default_style,
)

pytestmark = pytest.mark.unit

U = "00000000-0000-0000-0000-000000000001"
IDS = {"user_id": U, "folder_id": U}
ORANGES = "colorbrewer:Oranges"

GEOMETRY_SQL = {
    "point": "ST_Point(i, 0)",
    "line": "ST_MakeLine(ST_Point(i, 0), ST_Point(i, 1))",
    "polygon": "ST_Buffer(ST_Point(i, 0), 0.4)",
}

#: The colors of a sequential palette, seven of them: too few for ten clusters.
SEVEN_COLORS = tool_style.SUNSET


@pytest.fixture
def con() -> Iterator[duckdb.DuckDBPyConnection]:
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    yield con
    con.close()


def table(
    con: duckdb.DuckDBPyConnection,
    columns: dict[str, str],
    geometry: str,
    rows: int,
    name: str = "result",
) -> str:
    """A result of `geometry` with one column per entry of `columns` (name to
    SQL of row `i`)."""
    selects = ", ".join(f'({sql}) AS "{column}"' for column, sql in columns.items())
    con.execute(
        f"""CREATE OR REPLACE TABLE {name} AS
        SELECT {selects}{", " if selects else ""}{GEOMETRY_SQL[geometry]} AS geometry
        FROM range({rows}) t(i)"""
    )
    return name


def computed(
    con: duckdb.DuckDBPyConnection, relation: str, doc: dict[str, Any], geometry: str
) -> dict[str, Any]:
    out, _ = compute_into(con, relation, doc, geometry=geometry, fingerprint="f:1")
    return out


def rules(problems: list[Any]) -> list[str]:
    return [p.rule for p in problems]


def runner_for(runner_class: type, con: duckdb.DuckDBPyConnection) -> Any:
    runner = runner_class()
    runner._duckdb_con = con
    return runner


def _aggregate_sum(field: str = "x") -> AggregatePointsToolParams:
    return AggregatePointsToolParams(
        **IDS,
        source_layer_id=U,
        area_type=AggregationAreaType.h3_grid,
        h3_resolution=8,
        column_statistics=[{"operation": "sum", "field": field}],
    )


def _point_grid() -> CatchmentAreaV2WindmillParams:
    return CatchmentAreaV2WindmillParams(
        **IDS,
        routing_mode="walking",
        starting_points={"latitude": [48.137], "longitude": [11.576]},
        catchment_area_type="point_grid",
        point_grid_layer_id=U,
    )


# --- The rules, each on a result that breaks it and on one that keeps it ------


class TestFieldInTheResult:
    def test_a_style_naming_a_column_the_run_did_not_write_fails(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        """An aggregate whose style names `x_sum` on a result that holds `sum_x`."""
        relation = table(con, {"sum_x": "i % 9"}, "polygon", 30)
        doc = tool_style.numeric_default("x_sum", ORANGES, "polygon", "Sum of x")
        problems = style_contract(doc, con, relation, "polygon")
        assert "field_missing" in rules(problems)
        [missing] = [p for p in problems if p.rule == "field_missing"]
        assert missing.level == "error"
        assert "x_sum" in missing.message
        assert "unknown_field" in missing.codes

    def test_the_column_the_run_wrote_passes(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        relation = table(con, {"x_sum": "i % 9"}, "polygon", 30)
        doc = computed(
            con,
            relation,
            tool_style.numeric_default("x_sum", ORANGES, "polygon", "Sum of x"),
            "polygon",
        )
        assert style_contract(doc, con, relation, "polygon") == []

    def test_a_field_read_by_a_value_form_counts_too(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        relation = table(con, {"weight": "i"}, "line", 10)
        doc = tool_style.styled(
            "line", {"line": {"width": {"field": "flow", "range": [1, 10]}}}
        )
        assert "field_missing" in rules(style_contract(doc, con, relation, "line"))


class TestPartsFitTheGeometry:
    def test_a_polygon_style_on_points_fails(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        """A catchment computed as a point grid with the bands of polygons."""
        relation = table(con, {"cost_step": "(i % 3 + 1) * 5"}, "point", 30)
        doc = tool_style.bands(
            "cost_step",
            [5, 10, 15],
            "colorbrewer:YlGn",
            "polygon",
            "Travel time",
            "min",
        )
        problems = style_contract(doc, con, relation, "point")
        assert "invalid" in rules(problems)
        codes = {c for p in problems for c in p.codes}
        assert "part_not_for_geometry" in codes
        assert all(p.level == "error" for p in problems if p.rule == "invalid")

    def test_the_point_style_of_a_point_grid_passes(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        relation = table(con, {"cost_step": "(i % 3 + 1) * 5"}, "point", 30)
        doc = tool_style.bands(
            "cost_step", [5, 10, 15], "colorbrewer:YlGn", "point", "Travel time", "min"
        )
        assert style_contract(doc, con, relation, "point") == []


class TestTheDocumentValidates:
    def test_a_palette_shorter_than_the_clusters_fails(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        """Ten clusters, the tool's default, on a palette of seven colors."""
        relation = table(con, {"cluster_id": "i % 10"}, "point", 40)
        doc = tool_style.categories(
            "cluster_id", list(range(10)), SEVEN_COLORS, "point", title="Zone"
        )
        problems = style_contract(doc, con, relation, "point")
        assert "palette_too_short" in {c for p in problems for c in p.codes}

    @pytest.mark.parametrize("clusters", [None, 20, 54])
    @pytest.mark.parametrize("geometry", ["point", "polygon"])
    def test_clusters_on_the_tool_s_palette_pass(
        self, con: duckdb.DuckDBPyConnection, clusters: int | None, geometry: str
    ) -> None:
        """The default of ten clusters, and more clusters than the palette
        has colors: the colors repeat, the style stays valid."""
        count = clusters or 10
        relation = table(con, {"cluster_id": f"i % {count}"}, geometry, count * 3)
        chosen = {} if clusters is None else {"nb_cluster": clusters}
        params = ClusteringZonesToolParams(**IDS, input_layer_id=U, **chosen)
        assert params.nb_cluster == count
        runner = runner_for(ZonesClusteringToolRunner, con)
        doc = tool_default_style(runner, params, relation, geometry)
        assert style_contract(doc, con, relation, geometry) == []
        if geometry == "point":  # the summary: one point per cluster
            summary = tool_default_style(
                runner,
                params,
                relation,
                "point",
                document=runner._get_summary_style(params),
            )
            assert style_contract(summary, con, relation, "point") == []

    def test_an_invalid_document_fails(self, con: duckdb.DuckDBPyConnection) -> None:
        relation = table(con, {"v": "i"}, "point", 10)
        doc = tool_style.styled("point", {"marker": {"color": "not a color"}})
        problems = style_contract(doc, con, relation, "point")
        assert rules(problems) == ["invalid"]
        assert problems[0].level == "error"
        assert "invalid_value" in problems[0].codes

    def test_warnings_and_notes_of_the_check_are_no_problem(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        """Twenty bands draw (`too_many_categories`), and a sequential
        palette on categories is a note: neither breaks the style."""
        relation = table(con, {"cost_step": "i % 20 + 1"}, "polygon", 40)
        doc = tool_style.bands(
            "cost_step",
            list(range(1, 21)),
            "colorbrewer:YlGn",
            "polygon",
            "Travel time",
            "min",
        )
        assert style_contract(doc, con, relation, "polygon") == []


class TestClasses:
    def test_a_class_list_of_one_fails(self, con: duckdb.DuckDBPyConnection) -> None:
        relation = table(con, {"v": "3.0"}, "polygon", 10)
        doc = computed(
            con,
            relation,
            tool_style.numeric_default("v", ORANGES, "polygon", "Value"),
            "polygon",
        )
        assert len(doc["classify"][0]["classes"]) == 1
        problems = style_contract(doc, con, relation, "polygon")
        assert rules(problems) == ["single_class"]
        assert problems[0].level == "design"

    def test_several_classes_pass(self, con: duckdb.DuckDBPyConnection) -> None:
        relation = table(con, {"v": "i"}, "polygon", 30)
        doc = computed(
            con,
            relation,
            tool_style.numeric_default("v", ORANGES, "polygon", "Value"),
            "polygon",
        )
        assert len(doc["classify"][0]["classes"]) == 7
        assert style_contract(doc, con, relation, "polygon") == []

    def test_one_category_is_no_class_list_of_one(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        """A buffer of one distance draws one band: a fixed list the tool's
        options give, not classes computed from the data."""
        relation = table(con, {"buffer_distance": "500"}, "polygon", 5)
        doc = tool_style.bands(
            "buffer_distance", [500], "colorbrewer:OrRd", "polygon", "Buffer", "m"
        )
        assert style_contract(doc, con, relation, "polygon") == []

    def _with_breaks(self, doc: dict[str, Any], breaks: list[float]) -> dict[str, Any]:
        """`doc` with one class per interval of `breaks`, in Oranges."""
        c = doc["classify"][0]
        colors = tool_style.sample_colors(ORANGES, len(breaks) + 1)
        classes = []
        for i, color in enumerate(colors):
            k: dict[str, Any] = {"id": f"c{i + 1}", "fill": {"color": color}}
            if i > 0:
                k["from"] = breaks[i - 1]
            if i < len(breaks):
                k["to"] = breaks[i]
            classes.append(k)
        return {**doc, "classify": [{**c, "classes": classes}]}

    def test_a_class_without_a_feature_fails_where_the_field_has_enough_values(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        relation = table(con, {"v": "i % 10"}, "polygon", 30)
        doc = computed(
            con,
            relation,
            tool_style.numeric_default("v", ORANGES, "polygon", "Value", count=3),
            "polygon",
        )
        empty = self._with_breaks(doc, [5, 50])
        problems = style_contract(empty, con, relation, "polygon")
        assert rules(problems) == ["empty_class"]
        assert problems[0].level == "design"
        assert style_contract(doc, con, relation, "polygon") == []

    def test_an_empty_class_on_fewer_values_than_classes_is_no_problem(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        """Two values cannot fill three classes: the count is the tool's wish."""
        relation = table(con, {"v": "i % 2"}, "polygon", 30)
        doc = computed(
            con,
            relation,
            tool_style.numeric_default("v", ORANGES, "polygon", "Value", count=3),
            "polygon",
        )
        empty = self._with_breaks(doc, [0.5, 50])
        assert style_contract(empty, con, relation, "polygon") == []


class TestNamesAndUnits:
    def test_a_classification_without_a_title_fails(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        relation = table(con, {"v": "i"}, "polygon", 30)
        doc = tool_style.classified("v", ORANGES, "polygon")
        problems = style_contract(
            computed(con, relation, doc, "polygon"), con, relation, "polygon"
        )
        assert "title_missing" in rules(problems)
        assert all(p.level == "design" for p in problems)

    def test_a_numeric_classification_without_a_no_data_color_fails(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        relation = table(con, {"v": "i"}, "polygon", 30)
        doc = tool_style.classified("v", ORANGES, "polygon")
        doc["classify"][0]["title"] = "Value"
        problems = style_contract(
            computed(con, relation, doc, "polygon"), con, relation, "polygon"
        )
        assert rules(problems) == ["no_data_missing"]

    def test_categories_need_a_title_but_no_no_data_color(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        relation = table(con, {"cluster_id": "i % 3"}, "point", 9)
        untitled = tool_style.categories(
            "cluster_id", [0, 1, 2], "colorbrewer:Set3", "point"
        )
        assert rules(style_contract(untitled, con, relation, "point")) == [
            "title_missing"
        ]
        titled = tool_style.categories(
            "cluster_id", [0, 1, 2], "colorbrewer:Set3", "point", title="Zone"
        )
        assert style_contract(titled, con, relation, "point") == []

    def test_a_unit_the_kind_asks_for_must_be_set(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        relation = table(con, {"v": "i"}, "polygon", 30)
        doc = computed(
            con,
            relation,
            tool_style.numeric_default("v", ORANGES, "polygon", "Travel time"),
            "polygon",
        )
        problems = style_contract(
            doc, con, relation, "polygon", expect=Expectation(unit="min")
        )
        assert rules(problems) == ["shape"]
        assert "unit" in problems[0].message
        with_unit = computed(
            con,
            relation,
            tool_style.numeric_default(
                "v", ORANGES, "polygon", "Travel time", unit="min"
            ),
            "polygon",
        )
        assert (
            style_contract(
                with_unit, con, relation, "polygon", expect=Expectation(unit="min")
            )
            == []
        )


class TestTheToolsPinnedShape:
    def test_a_join_statistic_styling_the_target_s_column_fails(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        """The target layer has `count`; the run wrote its count statistic as
        `count_1`. A style on `count` is valid for the result, so only the
        column the run wrote tells it apart."""
        relation = table(con, {"count": "i % 4", "count_1": "i % 9"}, "polygon", 30)
        doc = computed(
            con,
            relation,
            tool_style.numeric_default("count", ORANGES, "polygon", "Count"),
            "polygon",
        )
        assert style_contract(doc, con, relation, "polygon") == []
        problems = style_contract(
            doc, con, relation, "polygon", expect=Expectation(field="count_1")
        )
        assert rules(problems) == ["field_expected"]
        assert "count_1" in problems[0].message
        assert hard_problems(doc, con, relation, "polygon") == []

    def test_palette_direction_and_method_are_compared_when_given(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        relation = table(con, {"v": "i"}, "polygon", 30)
        doc = computed(
            con,
            relation,
            tool_style.numeric_default("v", ORANGES, "polygon", "Value"),
            "polygon",
        )
        right = Expectation(
            field="v", method="quantile", palette=ORANGES, reverse=False
        )
        assert style_contract(doc, con, relation, "polygon", expect=right) == []
        wrong = Expectation(palette="colorbrewer:Blues", reverse=True, method="jenks")
        problems = style_contract(doc, con, relation, "polygon", expect=wrong)
        assert rules(problems) == ["shape", "shape", "shape"]

    def test_an_expected_classification_on_a_plain_style_fails(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        relation = table(con, {"v": "i"}, "polygon", 30)
        doc = tool_style.styled("polygon")
        problems = style_contract(
            doc, con, relation, "polygon", expect=Expectation(field="v")
        )
        assert rules(problems) == ["field_expected"]


class TestPlainAndEmpty:
    @pytest.mark.parametrize("geometry", ["point", "line", "polygon"])
    def test_the_default_style_of_the_geometry_passes(
        self, con: duckdb.DuckDBPyConnection, geometry: str
    ) -> None:
        relation = table(con, {"v": "i"}, geometry, 5)
        doc = tool_style.styled(geometry)
        assert style_contract(doc, con, relation, geometry) == []

    def test_an_empty_result_passes_with_its_own_style(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        relation = table(con, {"v": "i::DOUBLE"}, "polygon", 0)
        doc = computed(
            con,
            relation,
            tool_style.numeric_default("v", ORANGES, "polygon", "Value"),
            "polygon",
        )
        assert style_contract(doc, con, relation, "polygon") == []

    def test_an_empty_result_still_needs_the_column(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        relation = table(con, {"other": "i::DOUBLE"}, "polygon", 0)
        doc = tool_style.numeric_default("v", ORANGES, "polygon", "Value")
        assert "field_missing" in rules(style_contract(doc, con, relation, "polygon"))


class TestHardProblems:
    def test_only_errors_count(self, con: duckdb.DuckDBPyConnection) -> None:
        """A missing title, a missing no-data color, a class list of one: the
        tool tests catch them, a run keeps the style."""
        relation = table(con, {"v": "3.0"}, "polygon", 10)
        doc = computed(
            con, relation, tool_style.classified("v", ORANGES, "polygon"), "polygon"
        )
        assert style_contract(doc, con, relation, "polygon") != []
        assert hard_problems(doc, con, relation, "polygon") == []

    def test_a_missing_field_and_a_wrong_part_are_hard(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        relation = table(con, {"v": "i"}, "point", 10)
        missing = tool_style.numeric_default("w", ORANGES, "point", "W")
        wrong_part = tool_style.numeric_default("v", ORANGES, "polygon", "V")
        assert hard_problems(missing, con, relation, "point") != []
        assert hard_problems(wrong_part, con, relation, "point") != []


class TestNotesInTheToolTests:
    """Without `strict`, as the tool tests call it: the rules that depend on
    the data are notes; the hard rules, a class list of one and the column
    the run wrote fail."""

    def _empty_class(self, con: duckdb.DuckDBPyConnection) -> tuple[str, Any]:
        relation = table(con, {"v": "i % 10"}, "polygon", 30)
        doc = computed(
            con,
            relation,
            tool_style.numeric_default("v", ORANGES, "polygon", "Value", count=3),
            "polygon",
        )
        c = doc["classify"][0]
        classes = [dict(k) for k in c["classes"]]
        classes[1]["from"], classes[1]["to"], classes[2]["from"] = 5, 50, 50
        classes[0]["to"] = 5
        return relation, {**doc, "classify": [{**c, "classes": classes}]}

    def test_an_empty_class_is_a_note(self, con: duckdb.DuckDBPyConnection) -> None:
        relation, doc = self._empty_class(con)
        with pytest.warns(StyleContractNote, match="empty_class"):
            notes = assert_style_contract(
                doc, con, relation, "polygon", tool="t", strict=False
            )
        assert rules(notes) == ["empty_class"]
        with pytest.raises(StyleContractError, match="empty_class"):
            assert_style_contract(doc, con, relation, "polygon", tool="t")

    def test_a_missing_title_and_unit_are_notes(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        relation = table(con, {"v": "i"}, "polygon", 30)
        doc = computed(
            con, relation, tool_style.classified("v", ORANGES, "polygon"), "polygon"
        )
        with pytest.warns(StyleContractNote):
            notes = assert_style_contract(
                doc,
                con,
                relation,
                "polygon",
                tool="t",
                expect=Expectation(unit="min"),
                strict=False,
            )
        assert sorted(rules(notes)) == ["no_data_missing", "shape", "title_missing"]

    @pytest.mark.parametrize(
        ("columns", "doc", "expect", "rule"),
        [
            (
                {"sum_x": "i % 9"},
                tool_style.numeric_default("x_sum", ORANGES, "polygon", "S"),
                None,
                "field_missing",
            ),
            (
                {"v": "i"},
                tool_style.numeric_default("v", ORANGES, "line", "V"),
                None,
                "invalid",
            ),
            (
                {"count": "i % 4", "count_1": "i % 9"},
                tool_style.numeric_default("count", ORANGES, "polygon", "Count"),
                Expectation(field="count_1"),
                "field_expected",
            ),
        ],
        ids=["field missing", "part for another geometry", "another column"],
    )
    def test_the_hard_rules_fail(
        self,
        con: duckdb.DuckDBPyConnection,
        columns: dict[str, str],
        doc: dict[str, Any],
        expect: Expectation | None,
        rule: str,
    ) -> None:
        relation = table(con, columns, "polygon", 30)
        styled = computed(con, relation, doc, "polygon")
        with pytest.raises(StyleContractError, match=rule):
            assert_style_contract(
                styled, con, relation, "polygon", tool="t", expect=expect, strict=False
            )

    def test_a_class_list_of_one_fails(self, con: duckdb.DuckDBPyConnection) -> None:
        relation = table(con, {"v": "3.0"}, "polygon", 10)
        doc = computed(
            con,
            relation,
            tool_style.numeric_default("v", ORANGES, "polygon", "Value"),
            "polygon",
        )
        with pytest.raises(StyleContractError, match="single_class"):
            assert_style_contract(doc, con, relation, "polygon", tool="t", strict=False)


class TestTheAssertion:
    def test_the_message_names_the_tool_and_the_broken_rule(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        relation = table(con, {"sum_x": "i % 9"}, "polygon", 30)
        doc = tool_style.numeric_default("x_sum", ORANGES, "polygon", "Sum of x")
        with pytest.raises(StyleContractError) as raised:
            assert_style_contract(
                doc, con, relation, "polygon", tool="aggregate_points"
            )
        message = str(raised.value)
        assert "aggregate_points" in message
        assert "field_missing" in message
        assert "x_sum" in message

    def test_a_style_that_keeps_the_contract_passes(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        relation = table(con, {"v": "i"}, "polygon", 30)
        doc = computed(
            con,
            relation,
            tool_style.numeric_default("v", ORANGES, "polygon", "Value"),
            "polygon",
        )
        assert_style_contract(doc, con, relation, "polygon", tool="some_tool")


class TestTheToolsOwnStyle:
    """`assert_tool_style` checks the style the tool's run would store for a
    result: its own default for the result, fitted and computed, before the
    safety net could replace it."""

    def test_an_aggregate_whose_style_names_a_column_it_did_not_write_fails(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        relation = table(con, {"sum_x": "i % 9"}, "polygon", 30)
        runner = AggregatePointsToolRunner()
        with pytest.raises(AssertionError) as raised:
            assert_tool_style(runner, _aggregate_sum(), relation, con=con, strict=True)
        assert "aggregate_points" in str(raised.value)
        assert "field_missing" in str(raised.value)

    def test_the_aggregate_on_the_column_it_wrote_passes(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        relation = table(con, {"x_sum": "i % 9"}, "polygon", 30)
        doc = assert_tool_style(
            AggregatePointsToolRunner(),
            _aggregate_sum(),
            relation,
            con=con,
            strict=True,
        )
        assert doc["classify"][0]["field"] == "x_sum"
        assert doc["classify"][0]["classes"]

    def test_the_geometry_is_read_from_the_rows(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        """A point grid result: the tool's style is the one for points."""
        relation = table(con, {"cost_step": "(i % 3 + 1) * 5"}, "point", 30)
        doc = assert_tool_style(
            CatchmentAreaV2ToolRunner(), _point_grid(), relation, con=con, strict=True
        )
        assert "marker" in doc["symbol"] and "fill" not in doc["symbol"]

    def test_a_point_grid_given_a_polygon_style_fails(
        self, con: duckdb.DuckDBPyConnection, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        relation = table(con, {"cost_step": "(i % 3 + 1) * 5"}, "point", 30)
        runner = CatchmentAreaV2ToolRunner()
        polygon_bands = tool_style.bands(
            "cost_step",
            [5, 10, 15],
            "colorbrewer:YlGn",
            "polygon",
            "Travel time",
            "min",
        )
        monkeypatch.setattr(runner, "get_layer_style", lambda *a: polygon_bands)
        with pytest.raises(AssertionError) as raised:
            assert_tool_style(runner, _point_grid(), relation, con=con, strict=True)
        assert "part_not_for_geometry" in str(raised.value)

    def test_a_second_layer_s_style_is_passed_as_the_document(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        """The clustering summary on a palette shorter than its clusters."""
        relation = table(con, {"cluster_id": "i % 10"}, "point", 40)
        params = ClusteringZonesToolParams(**IDS, input_layer_id=U)
        runner = ZonesClusteringToolRunner()
        short = tool_style.categories(
            "cluster_id", list(range(10)), SEVEN_COLORS, "point", title="Zone"
        )
        with pytest.raises(AssertionError) as raised:
            assert_tool_style(
                runner, params, relation, con=con, strict=True, document=short
            )
        assert "palette_too_short" in str(raised.value)
        assert_tool_style(
            runner,
            params,
            relation,
            con=con,
            strict=True,
            document=runner._get_summary_style(params),
        )

    def test_an_empty_result_needs_its_geometry(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        relation = table(con, {"x_sum": "i::DOUBLE"}, "polygon", 0)
        runner = AggregatePointsToolRunner()
        with pytest.raises(ValueError):
            assert_tool_style(runner, _aggregate_sum(), relation, con=con, strict=True)
        assert_tool_style(
            runner, _aggregate_sum(), relation, "polygon", con=con, strict=True
        )

    def test_the_safety_net_does_not_hide_a_broken_style(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        """The run would store the default style; the check sees the tool's."""
        relation = table(con, {"sum_x": "i % 9"}, "polygon", 30)
        runner = runner_for(AggregatePointsToolRunner, con)
        doc = tool_default_style(runner, _aggregate_sum(), relation, "polygon")
        assert doc["classify"][0]["field"] == "x_sum"


# --- The safety net of a run ---------------------------------------------------

SAFETY_NET = "does not fit its result"


def _stored(
    runner: BaseToolRunner,
    document: dict[str, Any] | None,
    relation: str,
    geometry: str,
    *,
    fit: bool = True,
) -> dict[str, Any]:
    return runner.computed_style(
        document,
        relation=relation,
        geometry=geometry,
        fingerprint="f:1",
        seed="L",
        fit=fit,
    )


def _warnings(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [r for r in caplog.records if r.levelno >= logging.WARNING]


class TestTheSafetyNet:
    @pytest.fixture
    def plain(self, con: duckdb.DuckDBPyConnection) -> Any:
        def build(relation: str, geometry: str) -> dict[str, Any]:
            runner = runner_for(AggregatePointsToolRunner, con)
            return _stored(runner, None, relation, geometry)

        return build

    def test_a_default_naming_a_missing_column_gives_the_default_style(
        self,
        con: duckdb.DuckDBPyConnection,
        caplog: pytest.LogCaptureFixture,
        plain: Any,
    ) -> None:
        """The tool's default and the run together log one warning, without a
        traceback."""
        relation = table(con, {"sum_x": "i % 9"}, "polygon", 30)
        runner = runner_for(AggregatePointsToolRunner, con)
        caplog.clear()
        with caplog.at_level(logging.WARNING):
            intent = runner.get_layer_style(
                _aggregate_sum(), MagicMock(), "polygon", relation
            )
            stored = _stored(runner, intent, relation, "polygon")
        assert same_ignoring_stamps(stored, plain(relation, "polygon"))
        [warning] = _warnings(caplog)
        assert SAFETY_NET in warning.getMessage()
        assert "aggregate_points" in warning.getMessage()
        assert "unknown_field" in warning.getMessage()
        assert warning.exc_info is None

    def test_a_further_layer_s_style_naming_a_missing_column_gives_the_default(
        self,
        con: duckdb.DuckDBPyConnection,
        caplog: pytest.LogCaptureFixture,
        monkeypatch: pytest.MonkeyPatch,
        runner_event_loop: asyncio.AbstractEventLoop,
        plain: Any,
    ) -> None:
        """A `style=` passed to the layer record is the tool's own style of a
        further result layer: checked like its default."""
        relation = table(con, {"weight": "i % 9"}, "point", 30)
        runner = runner_for(OriginDestinationToolRunner, con)
        monkeypatch.setattr(runner, "_get_ducklake_snapshot_id", lambda *a: 3)
        monkeypatch.setattr("goatlib.tools.base.table_path_parts", lambda r: ("a", "b"))
        runner.db_service = MagicMock(create_layer=AsyncMock())
        caplog.clear()
        with caplog.at_level(logging.WARNING):
            runner_event_loop.run_until_complete(
                runner._create_db_records(
                    output_layer_id="L",
                    params=ToolInputBase(**IDS),
                    output_name="Points",
                    metadata=DatasetMetadata(path="x", source_type="vector"),
                    table_info={"table_name": relation, "geometry_type": "POINT"},
                    style=tool_style.numeric_default("flow", ORANGES, "point", "Flow"),
                )
            )
        stored = runner.db_service.create_layer.call_args.kwargs["style"]
        expected = runner.computed_style(
            None, relation=relation, geometry="point", fingerprint="f:1", seed="L"
        )
        assert stored["symbol"] == expected["symbol"] and "classify" not in stored
        [warning] = _warnings(caplog)
        assert SAFETY_NET in warning.getMessage()
        assert "unknown_field" in warning.getMessage()

    def test_a_polygon_style_on_points_gives_the_point_default(
        self,
        con: duckdb.DuckDBPyConnection,
        caplog: pytest.LogCaptureFixture,
        plain: Any,
    ) -> None:
        relation = table(con, {"cost_step": "(i % 3 + 1) * 5"}, "point", 30)
        runner = runner_for(CatchmentAreaV2ToolRunner, con)
        polygon_bands = tool_style.bands(
            "cost_step",
            [5, 10, 15],
            "colorbrewer:YlGn",
            "polygon",
            "Travel time",
            "min",
        )
        caplog.clear()
        with caplog.at_level(logging.WARNING):
            stored = _stored(runner, polygon_bands, relation, "point")
        assert same_ignoring_stamps(stored, plain(relation, "point"))
        assert "marker" in stored["symbol"]
        [warning] = _warnings(caplog)
        assert "catchment_area" in warning.getMessage()
        assert "part_not_for_geometry" in warning.getMessage()

    def test_an_invalid_document_gives_the_default_style(
        self,
        con: duckdb.DuckDBPyConnection,
        caplog: pytest.LogCaptureFixture,
        plain: Any,
    ) -> None:
        relation = table(con, {"cluster_id": "i % 10"}, "point", 40)
        runner = runner_for(ZonesClusteringToolRunner, con)
        short = tool_style.categories(
            "cluster_id", list(range(10)), SEVEN_COLORS, "point", title="Zone"
        )
        caplog.clear()
        with caplog.at_level(logging.WARNING):
            stored = _stored(runner, short, relation, "point")
        assert same_ignoring_stamps(stored, plain(relation, "point"))
        [warning] = _warnings(caplog)
        assert "palette_too_short" in warning.getMessage()

    def test_a_soft_rule_keeps_the_tool_s_style(
        self, con: duckdb.DuckDBPyConnection, caplog: pytest.LogCaptureFixture
    ) -> None:
        """No title and no no-data color: the style is kept as the tool made it."""
        relation = table(con, {"v": "i"}, "polygon", 30)
        runner = runner_for(AggregatePointsToolRunner, con)
        intent = tool_style.classified("v", ORANGES, "polygon")
        caplog.clear()
        with caplog.at_level(logging.WARNING):
            stored = _stored(runner, intent, relation, "polygon")
        assert stored["classify"][0]["field"] == "v"
        assert stored["classify"][0]["classes"]
        assert _warnings(caplog) == []

    def test_a_tool_s_style_that_fits_is_kept(
        self, con: duckdb.DuckDBPyConnection, caplog: pytest.LogCaptureFixture
    ) -> None:
        relation = table(con, {"x_sum": "i % 9"}, "polygon", 30)
        runner = runner_for(AggregatePointsToolRunner, con)
        intent = runner.get_layer_style(
            _aggregate_sum(), MagicMock(), "polygon", relation
        )
        caplog.clear()
        with caplog.at_level(logging.WARNING):
            stored = _stored(runner, intent, relation, "polygon")
        assert same_ignoring_stamps(
            stored, tool_default_style(runner, _aggregate_sum(), relation, "polygon")
        )
        assert _warnings(caplog) == []

    def test_a_check_that_fails_keeps_the_style(
        self,
        con: duckdb.DuckDBPyConnection,
        caplog: pytest.LogCaptureFixture,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        def fail(*args: Any, **kwargs: Any) -> Any:
            raise duckdb.Error("unreadable")

        monkeypatch.setattr("goatlib.tools.base.hard_problems", fail)
        relation = table(con, {"sum_x": "i % 9"}, "polygon", 30)
        runner = runner_for(AggregatePointsToolRunner, con)
        intent = runner.get_layer_style(
            _aggregate_sum(), MagicMock(), "polygon", relation
        )
        caplog.clear()
        with caplog.at_level(logging.WARNING):
            stored = _stored(runner, intent, relation, "polygon")
        assert stored["classify"][0]["field"] == "x_sum"
        [warning] = _warnings(caplog)
        assert SAFETY_NET not in warning.getMessage()

    def test_without_fit_nothing_is_checked(
        self, con: duckdb.DuckDBPyConnection, caplog: pytest.LogCaptureFixture
    ) -> None:
        relation = table(con, {"sum_x": "i % 9"}, "polygon", 30)
        runner = runner_for(AggregatePointsToolRunner, con)
        intent = runner.get_layer_style(
            _aggregate_sum(), MagicMock(), "polygon", relation
        )
        caplog.clear()
        with caplog.at_level(logging.WARNING):
            stored = _stored(runner, intent, relation, "polygon", fit=False)
        assert stored["classify"][0]["field"] == "x_sum"
        assert _warnings(caplog) == []

    @pytest.mark.parametrize(
        ("runner_class", "params", "column", "geometry"),
        [
            (AggregatePointsToolRunner, _aggregate_sum(), "x_sum", "polygon"),
            (CatchmentAreaV2ToolRunner, _point_grid(), "cost_step", "point"),
            (
                ZonesClusteringToolRunner,
                ClusteringZonesToolParams(**IDS, input_layer_id=U),
                "cluster_id",
                "point",
            ),
        ],
        ids=["aggregate", "point grid", "clusters"],
    )
    def test_an_empty_result_keeps_the_tool_s_style(
        self,
        con: duckdb.DuckDBPyConnection,
        caplog: pytest.LogCaptureFixture,
        runner_class: type,
        params: Any,
        column: str,
        geometry: str,
    ) -> None:
        relation = table(con, {column: "i"}, geometry, 0)
        runner = runner_for(runner_class, con)
        intent = runner.get_layer_style(params, MagicMock(), geometry, relation)
        caplog.clear()
        with caplog.at_level(logging.WARNING):
            stored = _stored(runner, intent, relation, geometry)
        assert stored["classify"][0]["field"] == column
        assert not [r for r in _warnings(caplog) if SAFETY_NET in r.getMessage()]


class TestAStyleHandedInIsStoredAsGiven:
    """A template's remembered style and a filtered copy's source style are
    never checked or replaced, also when they name a missing column."""

    def _missing(self) -> dict[str, Any]:
        return tool_style.numeric_default("gone", ORANGES, "polygon", "Gone")

    def test_a_template_style_naming_a_missing_column(
        self, con: duckdb.DuckDBPyConnection, caplog: pytest.LogCaptureFixture
    ) -> None:
        relation = table(con, {"v": "i"}, "polygon", 30)
        remembered = self._missing()
        caplog.clear()
        with caplog.at_level(logging.WARNING):
            saved = runner_for(FinalizeLayerRunner, con)._layer_style(
                remembered,
                geometry_type="POLYGON",
                relation=relation,
                data_snapshot=9,
                layer_id="L",
            )
        assert saved is not None and saved["classify"][0]["field"] == "gone"
        assert not [r for r in _warnings(caplog) if SAFETY_NET in r.getMessage()]

    def test_a_filtered_copy_of_a_style_naming_a_missing_column(
        self, con: duckdb.DuckDBPyConnection, caplog: pytest.LogCaptureFixture
    ) -> None:
        relation = table(con, {"v": "i"}, "polygon", 30)
        runner = runner_for(LayerCreateFilteredToolRunner, con)
        runner._source_style = self._missing()
        caplog.clear()
        with caplog.at_level(logging.WARNING):
            doc = _stored(
                runner,
                runner.get_layer_style(MagicMock(), MagicMock(), "polygon", relation),
                relation,
                "polygon",
                fit=runner.fits_result_style,
            )
        assert doc["classify"][0]["field"] == "gone"
        assert not [r for r in _warnings(caplog) if SAFETY_NET in r.getMessage()]
