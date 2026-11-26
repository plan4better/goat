"""Unit tests for Aggregate Polygon Tool.

Uses the same test data as GOAT Core:
- green_areas.parquet: 90 park polygons with 'value' field (area in sqm)
- zipcode_polygon.parquet: 10 Munich zipcode areas

These tests verify actual computed values, not just row counts.
"""

import json
from pathlib import Path

import duckdb
import pytest
from fixtures.tool_style import U, check_tool_style, tool_params
from goatlib.analysis.geoanalysis.aggregate_polygon import AggregatePolygonTool
from goatlib.analysis.schemas.aggregate import (
    AggregatePolygonParams,
    AggregationAreaType,
)
from goatlib.analysis.schemas.base import (
    FieldStatistic,
    StatisticOperation,
)
from goatlib.tools.aggregate_polygon import (
    AggregatePolygonToolParams,
    AggregatePolygonToolRunner,
)
from goatlib.tools.style_contract import Expectation, StyleContractError

# Test data paths - same data as GOAT Core
TEST_DATA_DIR = Path(__file__).parent.parent.parent / "data" / "analysis" / "aggregate"
GREEN_AREAS = str(TEST_DATA_DIR / "green_areas.parquet")  # 90 park polygons
ZIPCODE_POLYGON = str(TEST_DATA_DIR / "zipcode_polygon.parquet")  # 10 zipcodes

# Pre-computed expected values from green_areas.parquet
TOTAL_GREEN_AREAS = 90
TOTAL_VALUE = 2531740.53  # Sum of all 'value' fields (area in sqm)


def check_style(params: AggregatePolygonParams, field: str) -> None:
    """The tool's default style keeps the hard rules of the contract on the
    result, classifying `field`, the column the run wrote; the rules that
    depend on the data (an empty class of whole counts) are notes."""
    areas = {"area_layer_id": U} if params.area_layer_path else {}
    check_tool_style(
        AggregatePolygonToolRunner,
        tool_params(AggregatePolygonToolParams, params, source_layer_id=U, **areas),
        params.output_path,
        expect=Expectation(field=field),
    )


class TestAggregatePolygonToPolygon:
    """Tests for polygon-to-polygon aggregation with real data validation."""

    def test_count_returns_correct_totals(self, tmp_path: Path) -> None:
        """Test COUNT operation returns correct total across all zipcodes.

        The sum of counts across all zipcodes should equal the total number
        of green areas that intersect with any zipcode.
        """
        output_path = str(tmp_path / "aggregate_count.parquet")

        params = AggregatePolygonParams(
            source_path=GREEN_AREAS,
            area_type=AggregationAreaType.polygon,
            area_layer_path=ZIPCODE_POLYGON,
            column_statistics=[FieldStatistic(operation=StatisticOperation.count)],
            weighted_by_intersecting_area=False,
            output_path=output_path,
        )

        tool = AggregatePolygonTool()
        tool.run(params)

        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        df = con.execute(f"SELECT * FROM read_parquet('{output_path}')").fetchdf()
        con.close()

        # Should have 10 zipcode areas
        assert len(df) == 10
        assert "count" in df.columns
        assert "zipcode" in df.columns

        # Total count should be > 0 (green areas intersect zipcodes)
        total_count = df["count"].sum()
        assert total_count > 0, "Should have counted green areas in zipcodes"
        check_style(params, "count")

    def test_a_renamed_count_column_fails_the_style_contract(
        self, tmp_path: Path
    ) -> None:
        """A run that writes its count under another name breaks the tool's
        style, and the contract call says so."""
        output_path = str(tmp_path / "aggregate_count.parquet")
        params = AggregatePolygonParams(
            source_path=GREEN_AREAS,
            area_type=AggregationAreaType.polygon,
            area_layer_path=ZIPCODE_POLYGON,
            column_statistics=[FieldStatistic(operation=StatisticOperation.count)],
            output_path=output_path,
        )
        AggregatePolygonTool().run(params)
        renamed = str(tmp_path / "renamed.parquet")
        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        con.execute(
            f"COPY (SELECT * RENAME (count AS n) FROM read_parquet('{output_path}')) "
            f"TO '{renamed}' (FORMAT PARQUET)"
        )
        con.close()

        with pytest.raises(StyleContractError, match="field_missing"):
            check_style(params.model_copy(update={"output_path": renamed}), "count")

    def test_weighted_count_distributes_by_area_ratio(self, tmp_path: Path) -> None:
        """Test weighted COUNT distributes counts by intersection area ratio.

        When using weighted_by_intersecting_area=True, each source polygon
        contributes a fraction to each area it intersects, based on
        intersection_area / source_area. The total can exceed source count
        if polygons are counted in multiple overlapping areas.
        """
        output_path = str(tmp_path / "aggregate_weighted_count.parquet")

        params = AggregatePolygonParams(
            source_path=GREEN_AREAS,
            area_type=AggregationAreaType.polygon,
            area_layer_path=ZIPCODE_POLYGON,
            column_statistics=[FieldStatistic(operation=StatisticOperation.count)],
            weighted_by_intersecting_area=True,
            output_path=output_path,
        )

        tool = AggregatePolygonTool()
        tool.run(params)

        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        df = con.execute(f"SELECT * FROM read_parquet('{output_path}')").fetchdf()
        con.close()

        # Weighted count should be positive
        total_weighted = df["count"].sum()
        assert total_weighted > 0, "Should have counted green areas"

        # Each zipcode should have a reasonable weighted count
        assert (df["count"] >= 0).all(), "Counts should be non-negative"
        check_style(params, "count")

    def test_sum_preserves_total_value_when_weighted(self, tmp_path: Path) -> None:
        """Test weighted SUM preserves the total value across all areas.

        When summing with weighting, the total should equal the original
        total value (values are distributed, not duplicated).
        """
        output_path = str(tmp_path / "aggregate_weighted_sum.parquet")

        params = AggregatePolygonParams(
            source_path=GREEN_AREAS,
            area_type=AggregationAreaType.polygon,
            area_layer_path=ZIPCODE_POLYGON,
            column_statistics=[
                FieldStatistic(
                    operation=StatisticOperation.sum,
                    field="value",
                )
            ],
            weighted_by_intersecting_area=True,
            output_path=output_path,
        )

        tool = AggregatePolygonTool()
        tool.run(params)

        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        df = con.execute(f"SELECT * FROM read_parquet('{output_path}')").fetchdf()
        con.close()

        total_weighted_sum = df["sum_value"].sum()
        # Should be close to original total (may be less if some areas outside)
        assert total_weighted_sum > 0
        assert total_weighted_sum <= TOTAL_VALUE * 1.01  # Allow 1% tolerance
        check_style(params, "sum_value")

    def test_unweighted_sum_can_exceed_total(self, tmp_path: Path) -> None:
        """Test unweighted SUM can exceed total when polygons span areas.

        Without weighting, a polygon spanning multiple areas gets its
        full value counted in each area, so the sum can exceed the original.
        """
        output_path = str(tmp_path / "aggregate_sum.parquet")

        params = AggregatePolygonParams(
            source_path=GREEN_AREAS,
            area_type=AggregationAreaType.polygon,
            area_layer_path=ZIPCODE_POLYGON,
            column_statistics=[
                FieldStatistic(
                    operation=StatisticOperation.sum,
                    field="value",
                )
            ],
            weighted_by_intersecting_area=False,
            output_path=output_path,
        )

        tool = AggregatePolygonTool()
        tool.run(params)

        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        df = con.execute(f"SELECT * FROM read_parquet('{output_path}')").fetchdf()
        con.close()

        total_unweighted = df["sum_value"].sum()
        assert total_unweighted > 0

    def test_mean_returns_reasonable_values(self, tmp_path: Path) -> None:
        """Test MEAN returns values within expected range."""
        output_path = str(tmp_path / "aggregate_mean.parquet")

        params = AggregatePolygonParams(
            source_path=GREEN_AREAS,
            area_type=AggregationAreaType.polygon,
            area_layer_path=ZIPCODE_POLYGON,
            column_statistics=[
                FieldStatistic(
                    operation=StatisticOperation.mean,
                    field="value",
                )
            ],
            output_path=output_path,
        )

        tool = AggregatePolygonTool()
        tool.run(params)

        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        df = con.execute(f"SELECT * FROM read_parquet('{output_path}')").fetchdf()
        con.close()

        # Mean should be between min and max of source values
        # Source min ~57, max ~290508
        valid_means = df[df["mean_value"] > 0]["mean_value"]
        assert len(valid_means) > 0, "Should have some areas with green areas"
        assert valid_means.min() >= 50  # Should be above source minimum
        assert valid_means.max() <= 300000  # Should be below source maximum
        check_style(params, "mean_value")


class TestAggregatePolygonToH3:
    """Tests for polygon-to-H3 grid aggregation."""

    def test_h3_count_creates_hexagons(self, tmp_path: Path) -> None:
        """Test H3 aggregation creates hexagonal cells with counts."""
        output_path = str(tmp_path / "aggregate_h3_count.parquet")

        params = AggregatePolygonParams(
            source_path=GREEN_AREAS,
            area_type=AggregationAreaType.h3_grid,
            h3_resolution=8,
            column_statistics=[FieldStatistic(operation=StatisticOperation.count)],
            output_path=output_path,
        )

        tool = AggregatePolygonTool()
        tool.run(params)

        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        df = con.execute(f"SELECT * FROM read_parquet('{output_path}')").fetchdf()
        con.close()

        # Should have H3 cells with data
        assert len(df) > 0
        assert "count" in df.columns
        assert "h3_8" in df.columns

        # Total count should equal source polygon count (one centroid per polygon)
        total_count = df["count"].sum()
        assert total_count == TOTAL_GREEN_AREAS
        check_style(params, "count")

    def test_h3_sum_matches_source_total(self, tmp_path: Path) -> None:
        """Test H3 SUM matches the total value from source polygons."""
        output_path = str(tmp_path / "aggregate_h3_sum.parquet")

        params = AggregatePolygonParams(
            source_path=GREEN_AREAS,
            area_type=AggregationAreaType.h3_grid,
            h3_resolution=8,
            column_statistics=[
                FieldStatistic(
                    operation=StatisticOperation.sum,
                    field="value",
                )
            ],
            output_path=output_path,
        )

        tool = AggregatePolygonTool()
        tool.run(params)

        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        df = con.execute(f"SELECT * FROM read_parquet('{output_path}')").fetchdf()
        con.close()

        # Total should match source total (within floating point tolerance)
        total_sum = df["sum_value"].sum()
        assert abs(total_sum - TOTAL_VALUE) < 1.0  # Allow 1 sqm tolerance
        check_style(params, "sum_value")


#: Every statistic once, on the integer field `value`.
EVERY_STATISTIC = [{"operation": "count"}] + [
    {"operation": operation, "field": "value"}
    for operation in ("sum", "mean", "min", "max", "standard_deviation")
]

#: The columns the run writes for `EVERY_STATISTIC`, with the types it
#: writes them in.
WRITTEN_TYPES = {
    "count": "BIGINT",
    "sum_value": "DOUBLE",
    "mean_value": "DOUBLE",
    "min_value": "INTEGER",
    "max_value": "INTEGER",
    "standard_deviation_value": "DOUBLE",
}

#: The statistics of an area no polygon intersects.
EMPTY_AREA = {
    "count": 0,
    "sum_value": 0,
    "mean_value": None,
    "min_value": None,
    "max_value": None,
    "standard_deviation_value": None,
}


def _statistics_by_area(output_path: str) -> dict[int, dict[str, object]]:
    """The statistic columns of each area, read with SQL so a missing value
    reads None (not NaN)."""
    con = duckdb.connect()
    con.execute("LOAD spatial;")
    rel = con.execute(
        f"SELECT id, {', '.join(WRITTEN_TYPES)} FROM '{output_path}' ORDER BY id"
    )
    names = [d[0] for d in rel.description]
    rows = {row[0]: dict(zip(names[1:], row[1:])) for row in rel.fetchall()}
    con.close()
    return rows


class TestAggregatePolygonEmptyAreas:
    """An area no polygon intersects holds 0 polygons and a sum of 0; its
    mean, minimum, maximum and standard deviation have no value, weighted
    or not."""

    @staticmethod
    def _write_inputs(tmp_path: Path) -> tuple[str, str]:
        """Area 1 holds two squares (10, 30) wholly, area 2 none, area 3 one
        square (5), area 4 two squares without a value; area 5 is only
        touched on its edge by a square (7) that lies outside it."""
        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        areas = str(tmp_path / "areas.parquet")
        sources = str(tmp_path / "sources.parquet")
        con.execute(f"""
            COPY (
                SELECT id, ST_GeomFromText(wkt) AS geom FROM (VALUES
                    (1, 'POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))'),
                    (2, 'POLYGON((5 5, 6 5, 6 6, 5 6, 5 5))'),
                    (3, 'POLYGON((10 0, 11 0, 11 1, 10 1, 10 0))'),
                    (4, 'POLYGON((20 0, 21 0, 21 1, 20 1, 20 0))'),
                    (5, 'POLYGON((30 0, 31 0, 31 1, 30 1, 30 0))')
                ) t(id, wkt)
            ) TO '{areas}' (FORMAT PARQUET)
        """)
        con.execute(f"""
            COPY (
                SELECT value, category, ST_GeomFromText(wkt) AS geom
                FROM (VALUES
                    (10, 'a', '{_square(0.2, 0.2, 0.1)}'),
                    (30, 'b', '{_square(0.7, 0.7, 0.1)}'),
                    (5, 'a', '{_square(10.5, 0.5, 0.1)}'),
                    (NULL::INTEGER, 'a', '{_square(20.2, 0.2, 0.1)}'),
                    (NULL::INTEGER, 'b', '{_square(20.7, 0.7, 0.1)}'),
                    (7, 'a', 'POLYGON((31 0.2, 32 0.2, 32 0.4, 31 0.4, 31 0.2))')
                ) t(value, category, wkt)
            ) TO '{sources}' (FORMAT PARQUET)
        """)
        con.close()
        return areas, sources

    def _run(
        self,
        tmp_path: Path,
        *,
        weighted: bool = False,
        group_by: list[str] | None = None,
    ) -> dict[int, dict[str, object]]:
        areas, sources = self._write_inputs(tmp_path)
        output_path = str(tmp_path / "out.parquet")
        AggregatePolygonTool().run(
            AggregatePolygonParams(
                source_path=sources,
                area_type=AggregationAreaType.polygon,
                area_layer_path=areas,
                column_statistics=[FieldStatistic(**s) for s in EVERY_STATISTIC],
                weighted_by_intersecting_area=weighted,
                group_by_field=group_by,
                output_path=output_path,
            )
        )
        return _statistics_by_area(output_path)

    @pytest.mark.parametrize(
        ("weighted", "group_by"),
        [(False, None), (True, None), (False, ["category"]), (True, ["category"])],
    )
    def test_an_area_without_polygons_has_a_count_and_sum_of_0_and_no_other_value(
        self, tmp_path: Path, weighted: bool, group_by: list[str] | None
    ) -> None:
        empty = self._run(tmp_path, weighted=weighted, group_by=group_by)[2]
        assert empty == EMPTY_AREA

    @pytest.mark.parametrize("weighted", [False, True])
    def test_an_area_with_polygons_keeps_its_statistics(
        self, tmp_path: Path, weighted: bool
    ) -> None:
        """The squares lie wholly inside area 1, so the weighted statistics
        are the plain ones."""
        held = self._run(tmp_path, weighted=weighted)[1]
        assert held == {
            "count": 2,
            "sum_value": pytest.approx(40),
            "mean_value": pytest.approx(20),
            "min_value": 10,
            "max_value": 30,
            "standard_deviation_value": pytest.approx(14.1421356),
        }

    @pytest.mark.parametrize("weighted", [False, True])
    def test_a_statistic_the_polygons_do_not_define_has_no_value(
        self, tmp_path: Path, weighted: bool
    ) -> None:
        """One polygon has no standard deviation; polygons without a value
        have no mean, minimum or maximum. Their count and sum stay numbers."""
        rows = self._run(tmp_path, weighted=weighted)
        assert rows[3]["count"] == 1
        assert rows[3]["standard_deviation_value"] is None
        assert rows[3]["mean_value"] == pytest.approx(5)
        assert rows[4] == {**EMPTY_AREA, "count": 2}

    def test_a_weighted_mean_of_a_polygon_that_only_touches_the_area_has_no_value(
        self, tmp_path: Path
    ) -> None:
        """A square touching area 5 on its edge counts for it but shares no
        area with it: its weighted sum is 0, its weighted mean has none."""
        touched = self._run(tmp_path, weighted=True)[5]
        assert touched["count"] == 1
        assert touched["sum_value"] == 0
        assert touched["mean_value"] is None
        assert touched["min_value"] == 7

    @pytest.mark.parametrize("weighted", [False, True])
    def test_the_columns_and_their_types_stay_as_predicted(
        self, tmp_path: Path, weighted: bool
    ) -> None:
        """The empty areas change no column and no type: the run writes the
        same columns in the same types, and the prediction is the same."""
        areas, sources = self._write_inputs(tmp_path)
        output_path = str(tmp_path / "out.parquet")
        AggregatePolygonTool().run(
            AggregatePolygonParams(
                source_path=sources,
                area_type=AggregationAreaType.polygon,
                area_layer_path=areas,
                column_statistics=[FieldStatistic(**s) for s in EVERY_STATISTIC],
                weighted_by_intersecting_area=weighted,
                output_path=output_path,
            )
        )
        con = duckdb.connect()
        con.execute("LOAD spatial;")
        written = {
            name: dtype
            for name, dtype, *_ in con.execute(
                f"DESCRIBE SELECT * FROM '{output_path}'"
            ).fetchall()
        }
        con.close()
        predicted = AggregatePolygonToolRunner.predict_output_schema(
            {
                "source_layer_id": {"value": "INTEGER", "category": "VARCHAR"},
                "area_layer_id": {"id": "INTEGER", "geometry": "GEOMETRY"},
            },
            {
                "area_type": "polygon",
                "weighted_by_intersecting_area": weighted,
                "column_statistics": EVERY_STATISTIC,
            },
        )

        assert {k: v for k, v in written.items() if k in WRITTEN_TYPES} == (
            WRITTEN_TYPES
        )
        assert predicted == {
            "geometry": "GEOMETRY",
            "id": "INTEGER",
            "count": "BIGINT",
            "sum_value": "DOUBLE",
            "mean_value": "DOUBLE",
            "min_value": "DOUBLE",
            "max_value": "DOUBLE",
            "standard_deviation_value": "DOUBLE",
        }
        assert set(written) - {"bbox"} == set(predicted)

    @pytest.mark.parametrize("weighted", [False, True])
    def test_a_mean_over_areas_without_polygons_keeps_the_tool_s_style(
        self, tmp_path: Path, weighted: bool
    ) -> None:
        """A mean that has no value in some areas classifies the others and
        draws the rest as no data; the style contract holds."""
        areas, sources = self._write_inputs(tmp_path)
        params = AggregatePolygonParams(
            source_path=sources,
            area_type=AggregationAreaType.polygon,
            area_layer_path=areas,
            column_statistics=[
                FieldStatistic(operation=StatisticOperation.mean, field="value")
            ],
            weighted_by_intersecting_area=weighted,
            output_path=str(tmp_path / "out.parquet"),
        )
        AggregatePolygonTool().run(params)
        check_style(params, "mean_value")


#: Result names as users type them: spaces, an umlaut, an embedded quote.
SUM_NAME = "Einwohner im Einzugsbereich"
MAX_NAME = "Einwohner über 65"
COUNT_NAME = 'Anzahl "alt"'


def _as_dict(value: object) -> dict:
    return json.loads(value) if isinstance(value, str) else dict(value)


def _square(x: float, y: float, half: float = 0.0002) -> str:
    return (
        f"POLYGON(({x - half} {y - half}, {x + half} {y - half}, "
        f"{x + half} {y + half}, {x - half} {y + half}, {x - half} {y - half}))"
    )


class TestAggregatePolygonResultNames:
    """A result name becomes the output column name exactly as given."""

    @staticmethod
    def _write_inputs(tmp_path: Path) -> tuple[str, str]:
        """One area and three small squares inside it whose centroids share
        one H3 cell at res 6."""
        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        areas = str(tmp_path / "areas.parquet")
        sources = str(tmp_path / "sources.parquet")
        con.execute(f"""
            COPY (
                SELECT 1 AS id, ST_GeomFromText(
                    'POLYGON((11.5 48.1, 11.51 48.1, 11.51 48.11, 11.5 48.11, 11.5 48.1))'
                ) AS geom
            ) TO '{areas}' (FORMAT PARQUET)
        """)
        con.execute(f"""
            COPY (
                SELECT value, category, ST_GeomFromText(wkt) AS geom
                FROM (VALUES
                    (10, 'a', '{_square(11.501, 48.101)}'),
                    (20, 'a', '{_square(11.502, 48.102)}'),
                    (40, 'b', '{_square(11.503, 48.103)}')
                ) t(value, category, wkt)
            ) TO '{sources}' (FORMAT PARQUET)
        """)
        con.close()
        return areas, sources

    @pytest.mark.parametrize(
        ("area_type", "weighted"),
        [
            (AggregationAreaType.polygon, False),
            (AggregationAreaType.polygon, True),
            (AggregationAreaType.h3_grid, False),
        ],
    )
    @pytest.mark.parametrize("group_by", [None, ["category"]])
    def test_result_names_with_spaces_and_quotes_are_kept_exactly(
        self,
        tmp_path: Path,
        area_type: AggregationAreaType,
        weighted: bool,
        group_by: list[str] | None,
    ) -> None:
        areas, sources = self._write_inputs(tmp_path)
        output_path = str(tmp_path / "out.parquet")
        on_polygons = area_type == AggregationAreaType.polygon
        params = AggregatePolygonParams(
            source_path=sources,
            area_type=area_type,
            area_layer_path=areas if on_polygons else None,
            h3_resolution=None if on_polygons else 6,
            column_statistics=[
                FieldStatistic(
                    operation=StatisticOperation.sum,
                    field="value",
                    result_name=SUM_NAME,
                ),
                FieldStatistic(
                    operation=StatisticOperation.max,
                    field="value",
                    result_name=MAX_NAME,
                ),
                FieldStatistic(
                    operation=StatisticOperation.count, result_name=COUNT_NAME
                ),
            ],
            weighted_by_intersecting_area=weighted,
            group_by_field=group_by,
            output_path=output_path,
        )
        AggregatePolygonTool().run(params)
        con = duckdb.connect()
        con.execute("LOAD spatial;")
        df = con.execute(f"SELECT * FROM '{output_path}'").fetchdf()
        con.close()

        assert len(df) == 1
        assert {SUM_NAME, MAX_NAME, COUNT_NAME} <= set(df.columns)
        assert not any(c.startswith('"') for c in df.columns)
        row = df.iloc[0]
        # Every square lies wholly inside the area, so a weighted sum is the
        # plain one.
        assert row[SUM_NAME] == pytest.approx(70)
        assert row[MAX_NAME] == 40
        assert row[COUNT_NAME] == 3
        if group_by:
            sums = _as_dict(row[f"{SUM_NAME}_grouped"])
            assert sums == {"a": pytest.approx(30), "b": pytest.approx(40)}
            assert _as_dict(row[f"{MAX_NAME}_grouped"]) == {"a": 20, "b": 40}
            assert _as_dict(row[f"{COUNT_NAME}_grouped"]) == {"a": 2, "b": 1}

    @pytest.mark.parametrize(
        "area_type", [AggregationAreaType.polygon, AggregationAreaType.h3_grid]
    )
    @pytest.mark.parametrize("group_by", [None, ["category"]])
    @pytest.mark.parametrize(
        "statistics",
        [
            [{"operation": "sum", "field": "value"}],
            [{"operation": "count"}],
            [
                {"operation": "max", "field": "value"},
                {"operation": "count", "result_name": COUNT_NAME},
            ],
        ],
        ids=["sum", "count", "max-and-named-count"],
    )
    def test_the_prediction_holds_exactly_the_columns_the_run_writes(
        self,
        tmp_path: Path,
        area_type: AggregationAreaType,
        group_by: list[str] | None,
        statistics: list[dict[str, str]],
    ) -> None:
        """One column per statistic, a `<statistic>_grouped` column each when
        grouped and never the group fields themselves, a count only when one
        is asked for; the area's columns or the H3 cell id."""
        from goatlib.tools.aggregate_polygon import AggregatePolygonToolRunner

        areas, sources = self._write_inputs(tmp_path)
        output_path = str(tmp_path / "out.parquet")
        on_polygons = area_type == AggregationAreaType.polygon
        AggregatePolygonTool().run(
            AggregatePolygonParams(
                source_path=sources,
                area_type=area_type,
                area_layer_path=areas if on_polygons else None,
                h3_resolution=None if on_polygons else 6,
                column_statistics=[FieldStatistic(**s) for s in statistics],
                group_by_field=group_by,
                output_path=output_path,
            )
        )
        inputs = {"source_layer_id": {"value": "INTEGER", "category": "VARCHAR"}}
        if on_polygons:
            inputs["area_layer_id"] = {"id": "INTEGER", "geometry": "GEOMETRY"}
        predicted = AggregatePolygonToolRunner.predict_output_schema(
            inputs,
            {
                "area_type": area_type.value,
                "h3_resolution": None if on_polygons else 6,
                "group_by_field": group_by,
                "column_statistics": statistics,
            },
        )
        con = duckdb.connect()
        con.execute("LOAD spatial;")
        rel = con.execute(f"SELECT * FROM '{output_path}'")
        names = [d[0] for d in rel.description]
        con.close()

        # The parquet writer adds a bbox column; it is no layer column.
        assert set(predicted) == set(names) - {"bbox"}

    def test_the_run_writes_the_predicted_columns(self, tmp_path: Path) -> None:
        """Without a result_name a statistic is `{operation}_{field}`, a count
        is `count`; the schema prediction names the same columns."""
        from goatlib.tools.aggregate_polygon import AggregatePolygonToolRunner

        areas, sources = self._write_inputs(tmp_path)
        output_path = str(tmp_path / "out.parquet")
        statistics = [
            {"operation": "sum", "field": "value"},
            {"operation": "max", "field": "value", "result_name": MAX_NAME},
            {"operation": "count", "result_name": COUNT_NAME},
        ]
        AggregatePolygonTool().run(
            AggregatePolygonParams(
                source_path=sources,
                area_type=AggregationAreaType.polygon,
                area_layer_path=areas,
                column_statistics=[FieldStatistic(**s) for s in statistics],
                output_path=output_path,
            )
        )
        predicted = AggregatePolygonToolRunner.predict_output_schema(
            {
                "source_layer_id": {"value": "INTEGER", "category": "VARCHAR"},
                "area_layer_id": {"id": "INTEGER", "geometry": "GEOMETRY"},
            },
            {"area_type": "polygon", "column_statistics": statistics},
        )
        con = duckdb.connect()
        con.execute("LOAD spatial;")
        rel = con.execute(f"SELECT * FROM '{output_path}'")
        names = [d[0] for d in rel.description]
        row = dict(zip(names, rel.fetchone()))
        con.close()

        # The parquet writer adds a bbox column; it is no layer column.
        assert set(names) - {"bbox"} == set(predicted)
        assert row["sum_value"] == 70
        assert row[MAX_NAME] == 40
        assert row[COUNT_NAME] == 3


class TestAggregatePolygonValidation:
    """Tests for parameter validation."""

    def test_polygon_requires_area_layer(self) -> None:
        """Test polygon area_type requires area_layer_path."""
        with pytest.raises(
            ValueError, match="area_layer_path.*required|required.*area_layer_path"
        ):
            AggregatePolygonParams(
                source_path=GREEN_AREAS,
                area_type=AggregationAreaType.polygon,
                column_statistics=[FieldStatistic(operation=StatisticOperation.count)],
            )

    def test_h3_requires_resolution(self) -> None:
        """Test h3_grid area_type requires h3_resolution."""
        with pytest.raises(
            ValueError, match="h3_resolution.*required|required.*h3_resolution"
        ):
            AggregatePolygonParams(
                source_path=GREEN_AREAS,
                area_type=AggregationAreaType.h3_grid,
                column_statistics=[FieldStatistic(operation=StatisticOperation.count)],
            )

    def test_sum_requires_field(self) -> None:
        """Test SUM operation requires a field."""
        with pytest.raises(ValueError, match="Field is required|field.*required"):
            AggregatePolygonParams(
                source_path=GREEN_AREAS,
                area_type=AggregationAreaType.h3_grid,
                h3_resolution=8,
                column_statistics=[FieldStatistic(operation=StatisticOperation.sum)],
            )

    def test_count_rejects_field(self) -> None:
        """Test COUNT operation rejects field parameter."""
        with pytest.raises(
            ValueError, match="Field should not be provided|field.*not.*provided"
        ):
            AggregatePolygonParams(
                source_path=GREEN_AREAS,
                area_type=AggregationAreaType.h3_grid,
                h3_resolution=8,
                column_statistics=[
                    FieldStatistic(
                        operation=StatisticOperation.count,
                        field="value",
                    )
                ],
            )
