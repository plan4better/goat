"""Unit tests for Aggregate Points Tool.

Tests aggregation of point features onto polygons and H3 grids
with various statistics operations.
"""

import json
from pathlib import Path

import duckdb
import pytest
from fixtures.tool_style import U, check_tool_style, tool_params
from goatlib.analysis.geoanalysis.aggregate_points import AggregatePointsTool
from goatlib.analysis.schemas.aggregate import (
    AggregatePointsParams,
    AggregationAreaType,
)
from goatlib.analysis.schemas.base import (
    FieldStatistic,
    StatisticOperation,
)
from goatlib.tools.aggregate_points import (
    AggregatePointsToolParams,
    AggregatePointsToolRunner,
)
from goatlib.tools.style_contract import Expectation

# Test data paths
TEST_DATA_DIR = Path(__file__).parent.parent.parent / "data" / "vector"
POINTS_WITH_CATEGORY = str(TEST_DATA_DIR / "points_with_category.parquet")
ZIPCODE_POLYGON = str(TEST_DATA_DIR / "zipcode_polygon.parquet")


def check_style(params: AggregatePointsParams, field: str | None) -> dict:
    """The tool's default style keeps the contract on the result, classifying
    `field`, the column the run wrote (None: drawn in one color, as a field
    with one value in every area is); returns the style."""
    areas = {"area_layer_id": U} if params.area_layer_path else {}
    return check_tool_style(
        AggregatePointsToolRunner,
        tool_params(AggregatePointsToolParams, params, source_layer_id=U, **areas),
        params.output_path,
        expect=Expectation(field=field),
    )


class TestAggregatePointsPolygon:
    """Tests for polygon-based point aggregation."""

    def test_aggregate_points_sum(self, tmp_path: Path) -> None:
        """Test aggregating points with SUM operation."""
        output_path = str(tmp_path / "aggregate_sum.parquet")

        params = AggregatePointsParams(
            source_path=POINTS_WITH_CATEGORY,
            area_type=AggregationAreaType.polygon,
            area_layer_path=ZIPCODE_POLYGON,
            column_statistics=[
                FieldStatistic(
                    operation=StatisticOperation.sum,
                    field="value",
                )
            ],
            output_path=output_path,
        )

        tool = AggregatePointsTool()
        results = tool.run(params)

        # Verify output file was created
        assert len(results) == 1
        assert Path(output_path).exists()

        # Verify results
        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        df = con.execute(f"SELECT * FROM read_parquet('{output_path}')").fetchdf()
        con.close()

        # Should have 10 polygons (zipcodes)
        assert len(df) == 10
        # Should have value_sum column
        assert "value_sum" in df.columns
        # All sum values should be >= 0
        assert (df["value_sum"] >= 0).all()
        check_style(params, "value_sum")

    def test_aggregate_points_count(self, tmp_path: Path) -> None:
        """Test aggregating points with COUNT operation."""
        output_path = str(tmp_path / "aggregate_count.parquet")

        params = AggregatePointsParams(
            source_path=POINTS_WITH_CATEGORY,
            area_type=AggregationAreaType.polygon,
            area_layer_path=ZIPCODE_POLYGON,
            column_statistics=[
                FieldStatistic(
                    operation=StatisticOperation.count,
                )
            ],
            output_path=output_path,
        )

        tool = AggregatePointsTool()
        results = tool.run(params)

        assert len(results) == 1
        assert Path(output_path).exists()

        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        df = con.execute(f"SELECT * FROM read_parquet('{output_path}')").fetchdf()
        con.close()

        assert len(df) == 10
        assert "count" in df.columns
        # Total count should equal source point count (550)
        assert df["count"].sum() <= 550  # Some points may not fall in any polygon
        check_style(params, "count")

    def test_aggregate_points_mean(self, tmp_path: Path) -> None:
        """Test aggregating points with MEAN operation."""
        output_path = str(tmp_path / "aggregate_mean.parquet")

        params = AggregatePointsParams(
            source_path=POINTS_WITH_CATEGORY,
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

        tool = AggregatePointsTool()
        results = tool.run(params)

        assert len(results) == 1

        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        df = con.execute(f"SELECT * FROM read_parquet('{output_path}')").fetchdf()
        con.close()

        assert len(df) == 10
        assert "value_mean" in df.columns
        check_style(params, "value_mean")

    def test_aggregate_points_with_custom_result_name(self, tmp_path: Path) -> None:
        """Test aggregating points with a custom result column name."""
        output_path = str(tmp_path / "aggregate_custom_name.parquet")

        params = AggregatePointsParams(
            source_path=POINTS_WITH_CATEGORY,
            area_type=AggregationAreaType.polygon,
            area_layer_path=ZIPCODE_POLYGON,
            column_statistics=[
                FieldStatistic(
                    operation=StatisticOperation.sum,
                    field="value",
                    result_name="total_value",
                )
            ],
            output_path=output_path,
        )

        tool = AggregatePointsTool()
        results = tool.run(params)

        assert len(results) == 1

        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        df = con.execute(f"SELECT * FROM read_parquet('{output_path}')").fetchdf()
        con.close()

        assert len(df) == 10
        # Should use the custom column name instead of default 'value_sum'
        assert "total_value" in df.columns
        assert "value_sum" not in df.columns
        # All values should be >= 0
        assert (df["total_value"] >= 0).all()
        check_style(params, "total_value")

    def test_aggregate_points_min_max(self, tmp_path: Path) -> None:
        """Test aggregating points with MIN and MAX operations."""
        output_path_min = str(tmp_path / "aggregate_min.parquet")
        output_path_max = str(tmp_path / "aggregate_max.parquet")

        # Test MIN
        params_min = AggregatePointsParams(
            source_path=POINTS_WITH_CATEGORY,
            area_type=AggregationAreaType.polygon,
            area_layer_path=ZIPCODE_POLYGON,
            column_statistics=[
                FieldStatistic(
                    operation=StatisticOperation.min,
                    field="value",
                )
            ],
            output_path=output_path_min,
        )

        tool = AggregatePointsTool()
        tool.run(params_min)

        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        df_min = con.execute(
            f"SELECT * FROM read_parquet('{output_path_min}')"
        ).fetchdf()

        assert "value_min" in df_min.columns

        # Test MAX
        params_max = AggregatePointsParams(
            source_path=POINTS_WITH_CATEGORY,
            area_type=AggregationAreaType.polygon,
            area_layer_path=ZIPCODE_POLYGON,
            column_statistics=[
                FieldStatistic(
                    operation=StatisticOperation.max,
                    field="value",
                )
            ],
            output_path=output_path_max,
        )

        tool = AggregatePointsTool()
        tool.run(params_max)

        df_max = con.execute(
            f"SELECT * FROM read_parquet('{output_path_max}')"
        ).fetchdf()
        con.close()

        assert "value_max" in df_max.columns

    def test_aggregate_points_with_group_by(self, tmp_path: Path) -> None:
        """Test aggregating points with GROUP BY on category field."""
        output_path = str(tmp_path / "aggregate_grouped.parquet")

        params = AggregatePointsParams(
            source_path=POINTS_WITH_CATEGORY,
            area_type=AggregationAreaType.polygon,
            area_layer_path=ZIPCODE_POLYGON,
            column_statistics=[
                FieldStatistic(
                    operation=StatisticOperation.sum,
                    field="value",
                )
            ],
            group_by_field=["category"],
            output_path=output_path,
        )

        tool = AggregatePointsTool()
        results = tool.run(params)

        assert len(results) == 1

        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        df = con.execute(f"SELECT * FROM read_parquet('{output_path}')").fetchdf()
        con.close()

        assert len(df) == 10
        # Should have total sum and grouped sum columns
        assert "value_sum" in df.columns
        assert "value_sum_grouped" in df.columns

    def test_aggregate_preserves_area_attributes(self, tmp_path: Path) -> None:
        """Test that aggregation preserves area layer attributes."""
        output_path = str(tmp_path / "aggregate_attrs.parquet")

        params = AggregatePointsParams(
            source_path=POINTS_WITH_CATEGORY,
            area_type=AggregationAreaType.polygon,
            area_layer_path=ZIPCODE_POLYGON,
            column_statistics=[
                FieldStatistic(
                    operation=StatisticOperation.count,
                )
            ],
            output_path=output_path,
        )

        tool = AggregatePointsTool()
        tool.run(params)

        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        df = con.execute(f"SELECT * FROM read_parquet('{output_path}')").fetchdf()
        con.close()

        # Original zipcode_polygon has: plz, note, zipcode columns
        assert "plz" in df.columns
        assert "zipcode" in df.columns
        assert "geometry" in df.columns


class TestAggregatePointsH3:
    """Tests for H3 grid-based point aggregation."""

    def test_aggregate_points_h3_sum(self, tmp_path: Path) -> None:
        """Test aggregating points to H3 grid with SUM."""
        output_path = str(tmp_path / "aggregate_h3_sum.parquet")

        params = AggregatePointsParams(
            source_path=POINTS_WITH_CATEGORY,
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

        tool = AggregatePointsTool()
        results = tool.run(params)

        assert len(results) == 1
        assert Path(output_path).exists()

        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        df = con.execute(f"SELECT * FROM read_parquet('{output_path}')").fetchdf()
        con.close()

        # Should have H3 index column and sum column
        assert "h3_8" in df.columns
        assert "value_sum" in df.columns
        assert "geometry" in df.columns
        # Should have some H3 cells
        assert len(df) > 0
        check_style(params, "value_sum")

    def test_aggregate_points_h3_count(self, tmp_path: Path) -> None:
        """Test aggregating points to H3 grid with COUNT."""
        output_path = str(tmp_path / "aggregate_h3_count.parquet")

        params = AggregatePointsParams(
            source_path=POINTS_WITH_CATEGORY,
            area_type=AggregationAreaType.h3_grid,
            h3_resolution=6,
            column_statistics=[
                FieldStatistic(
                    operation=StatisticOperation.count,
                )
            ],
            output_path=output_path,
        )

        tool = AggregatePointsTool()
        results = tool.run(params)

        assert len(results) == 1

        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        df = con.execute(f"SELECT * FROM read_parquet('{output_path}')").fetchdf()
        con.close()

        assert "h3_6" in df.columns
        assert "count" in df.columns
        # Total count should equal source points (550)
        assert df["count"].sum() == 550
        check_style(params, "count")

    def test_aggregate_points_h3_with_group_by(self, tmp_path: Path) -> None:
        """Test aggregating points to H3 grid with GROUP BY."""
        output_path = str(tmp_path / "aggregate_h3_grouped.parquet")

        params = AggregatePointsParams(
            source_path=POINTS_WITH_CATEGORY,
            area_type=AggregationAreaType.h3_grid,
            h3_resolution=7,
            column_statistics=[
                FieldStatistic(
                    operation=StatisticOperation.sum,
                    field="value",
                )
            ],
            group_by_field=["category"],
            output_path=output_path,
        )

        tool = AggregatePointsTool()
        results = tool.run(params)

        assert len(results) == 1

        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        df = con.execute(f"SELECT * FROM read_parquet('{output_path}')").fetchdf()
        con.close()

        assert "h3_7" in df.columns
        assert "value_sum" in df.columns
        assert "value_sum_grouped" in df.columns

    def test_aggregate_points_h3_different_resolutions(self, tmp_path: Path) -> None:
        """Test H3 aggregation at different resolutions."""
        for resolution in [5, 8, 10]:
            output_path = str(tmp_path / f"aggregate_h3_res{resolution}.parquet")

            params = AggregatePointsParams(
                source_path=POINTS_WITH_CATEGORY,
                area_type=AggregationAreaType.h3_grid,
                h3_resolution=resolution,
                column_statistics=[
                    FieldStatistic(
                        operation=StatisticOperation.count,
                    )
                ],
                output_path=output_path,
            )

            tool = AggregatePointsTool()
            tool.run(params)

            con = duckdb.connect()
            con.execute("INSTALL spatial; LOAD spatial;")
            df = con.execute(f"SELECT * FROM read_parquet('{output_path}')").fetchdf()
            con.close()

            assert f"h3_{resolution}" in df.columns
            # Higher resolution = more cells
            assert len(df) > 0


class TestAggregatePointsEdgeCases:
    """Edge case tests for aggregate points tool."""

    def test_no_points_in_polygon(self, tmp_path: Path) -> None:
        """Test behavior when no points fall within polygons."""
        # Create a polygon that doesn't contain any points
        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")

        empty_polygon_path = str(tmp_path / "empty_polygon.parquet")
        con.execute(f"""
            COPY (
                SELECT
                    1 AS id,
                    ST_GeomFromText('POLYGON((0 0, 0 1, 1 1, 1 0, 0 0))') AS geom
            ) TO '{empty_polygon_path}' (FORMAT PARQUET, COMPRESSION ZSTD)
        """)
        con.close()

        output_path = str(tmp_path / "aggregate_empty.parquet")

        params = AggregatePointsParams(
            source_path=POINTS_WITH_CATEGORY,
            area_type=AggregationAreaType.polygon,
            area_layer_path=empty_polygon_path,
            column_statistics=[
                FieldStatistic(
                    operation=StatisticOperation.count,
                )
            ],
            output_path=output_path,
        )

        tool = AggregatePointsTool()
        results = tool.run(params)

        assert len(results) == 1

        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        df = con.execute(f"SELECT * FROM read_parquet('{output_path}')").fetchdf()
        con.close()

        # Should have the polygon with count = 0
        assert len(df) == 1
        assert df["count"].iloc[0] == 0
        check_style(params, None)

    def test_output_path_auto_generated(self, tmp_path: Path) -> None:
        """Test that output path is auto-generated when not specified."""
        # Copy source to tmp_path so output goes there
        source_in_tmp = str(tmp_path / "source_points.parquet")

        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        con.execute(
            f"COPY (SELECT * FROM read_parquet('{POINTS_WITH_CATEGORY}')) "
            f"TO '{source_in_tmp}' (FORMAT PARQUET, COMPRESSION ZSTD)"
        )
        con.close()

        params = AggregatePointsParams(
            source_path=source_in_tmp,
            area_type=AggregationAreaType.h3_grid,
            h3_resolution=6,
            column_statistics=[
                FieldStatistic(
                    operation=StatisticOperation.count,
                )
            ],
            # No output_path specified
        )

        tool = AggregatePointsTool()
        results = tool.run(params)

        assert len(results) == 1
        output_path = results[0][0]
        assert output_path.exists()
        assert "aggregated" in output_path.name

    def test_context_manager_cleanup(self, tmp_path: Path) -> None:
        """Test that context manager properly cleans up resources."""
        output_path = str(tmp_path / "aggregate_ctx.parquet")

        params = AggregatePointsParams(
            source_path=POINTS_WITH_CATEGORY,
            area_type=AggregationAreaType.polygon,
            area_layer_path=ZIPCODE_POLYGON,
            column_statistics=[
                FieldStatistic(
                    operation=StatisticOperation.count,
                )
            ],
            output_path=output_path,
        )

        with AggregatePointsTool() as tool:
            results = tool.run(params)
            assert len(results) == 1

        # After context exit, connection should be closed
        # (tool.con will be None or closed)
        assert Path(output_path).exists()

    def test_a_multipolygon_counts_each_point_once(self, tmp_path: Path) -> None:
        """Two parts that share an edge, and a point on that edge: the point is
        counted once for the area, not once per part."""
        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        areas = str(tmp_path / "areas.parquet")
        points = str(tmp_path / "points.parquet")
        con.execute(f"""
            COPY (
                SELECT 1 AS id, ST_GeomFromText(
                    'MULTIPOLYGON(((0 0, 1 0, 1 1, 0 1, 0 0)), ((1 0, 2 0, 2 1, 1 1, 1 0)))'
                ) AS geom
            ) TO '{areas}' (FORMAT PARQUET)
        """)
        con.execute(f"""
            COPY (
                SELECT * FROM (VALUES
                    (10, ST_Point(0.5, 0.5)),
                    (20, ST_Point(1.5, 0.5)),
                    (40, ST_Point(1.0, 0.5)),
                    (80, ST_Point(5.0, 5.0))
                ) t(value, geom)
            ) TO '{points}' (FORMAT PARQUET)
        """)
        con.close()
        output_path = str(tmp_path / "out.parquet")
        params = AggregatePointsParams(
            source_path=points,
            area_type=AggregationAreaType.polygon,
            area_layer_path=areas,
            column_statistics=[
                FieldStatistic(operation=StatisticOperation.count),
                FieldStatistic(operation=StatisticOperation.sum, field="value"),
            ],
            output_path=output_path,
        )
        AggregatePointsTool().run(params)
        con = duckdb.connect()
        con.execute("LOAD spatial;")
        df = con.execute(f"SELECT * FROM '{output_path}'").fetchdf()
        con.close()
        assert len(df) == 1
        assert df["count"].iloc[0] == 3
        assert df["value_sum"].iloc[0] == 70

    def test_a_source_column_named_point_id_keeps_its_values(
        self, tmp_path: Path
    ) -> None:
        """A source column called point_id is aggregated with its own values,
        not with a row number the tool adds."""
        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        areas = str(tmp_path / "areas.parquet")
        points = str(tmp_path / "points.parquet")
        con.execute(f"""
            COPY (
                SELECT 1 AS id, ST_GeomFromText(
                    'POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))'
                ) AS geom
            ) TO '{areas}' (FORMAT PARQUET)
        """)
        con.execute(f"""
            COPY (
                SELECT * FROM (VALUES
                    (500, ST_Point(0.25, 0.5)),
                    (700, ST_Point(0.75, 0.5))
                ) t(point_id, geom)
            ) TO '{points}' (FORMAT PARQUET)
        """)
        con.close()
        output_path = str(tmp_path / "out.parquet")
        params = AggregatePointsParams(
            source_path=points,
            area_type=AggregationAreaType.polygon,
            area_layer_path=areas,
            column_statistics=[
                FieldStatistic(operation=StatisticOperation.sum, field="point_id"),
            ],
            output_path=output_path,
        )
        AggregatePointsTool().run(params)
        con = duckdb.connect()
        con.execute("LOAD spatial;")
        df = con.execute(f"SELECT * FROM '{output_path}'").fetchdf()
        con.close()
        assert len(df) == 1
        assert df["point_id_sum"].iloc[0] == 1200


#: Every statistic once, on the integer field `value`.
EVERY_STATISTIC = [{"operation": "count"}] + [
    {"operation": operation, "field": "value"}
    for operation in ("sum", "mean", "min", "max", "standard_deviation")
]

#: The columns the run writes for `EVERY_STATISTIC`, with the types it
#: writes them in.
WRITTEN_TYPES = {
    "count": "BIGINT",
    "value_sum": "DOUBLE",
    "value_mean": "DOUBLE",
    "value_min": "INTEGER",
    "value_max": "INTEGER",
    "value_standard_deviation": "DOUBLE",
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


class TestAggregatePointsEmptyAreas:
    """An area without points holds 0 points and a sum of 0; its mean,
    minimum, maximum and standard deviation have no value."""

    @staticmethod
    def _write_inputs(tmp_path: Path) -> tuple[str, str]:
        """Area 1 holds two points (10, 30), area 2 none, area 3 one point
        (5), area 4 two points without a value."""
        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        areas = str(tmp_path / "areas.parquet")
        points = str(tmp_path / "points.parquet")
        con.execute(f"""
            COPY (
                SELECT id, ST_GeomFromText(wkt) AS geom FROM (VALUES
                    (1, 'POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))'),
                    (2, 'POLYGON((5 5, 6 5, 6 6, 5 6, 5 5))'),
                    (3, 'POLYGON((10 0, 11 0, 11 1, 10 1, 10 0))'),
                    (4, 'POLYGON((20 0, 21 0, 21 1, 20 1, 20 0))')
                ) t(id, wkt)
            ) TO '{areas}' (FORMAT PARQUET)
        """)
        con.execute(f"""
            COPY (
                SELECT * FROM (VALUES
                    (10, 'a', ST_Point(0.2, 0.2)),
                    (30, 'b', ST_Point(0.7, 0.7)),
                    (5, 'a', ST_Point(10.5, 0.5)),
                    (NULL::INTEGER, 'a', ST_Point(20.2, 0.2)),
                    (NULL::INTEGER, 'b', ST_Point(20.7, 0.7))
                ) t(value, category, geom)
            ) TO '{points}' (FORMAT PARQUET)
        """)
        con.close()
        return areas, points

    def _run(
        self, tmp_path: Path, group_by: list[str] | None = None
    ) -> dict[int, dict[str, object]]:
        areas, points = self._write_inputs(tmp_path)
        output_path = str(tmp_path / "out.parquet")
        AggregatePointsTool().run(
            AggregatePointsParams(
                source_path=points,
                area_type=AggregationAreaType.polygon,
                area_layer_path=areas,
                column_statistics=[FieldStatistic(**s) for s in EVERY_STATISTIC],
                group_by_field=group_by,
                output_path=output_path,
            )
        )
        return _statistics_by_area(output_path)

    @pytest.mark.parametrize("group_by", [None, ["category"]])
    def test_an_area_without_points_has_a_count_and_sum_of_0_and_no_other_value(
        self, tmp_path: Path, group_by: list[str] | None
    ) -> None:
        empty = self._run(tmp_path, group_by)[2]
        assert empty == {
            "count": 0,
            "value_sum": 0,
            "value_mean": None,
            "value_min": None,
            "value_max": None,
            "value_standard_deviation": None,
        }

    @pytest.mark.parametrize("group_by", [None, ["category"]])
    def test_an_area_with_points_keeps_its_statistics(
        self, tmp_path: Path, group_by: list[str] | None
    ) -> None:
        held = self._run(tmp_path, group_by)[1]
        assert held == {
            "count": 2,
            "value_sum": 40,
            "value_mean": 20,
            "value_min": 10,
            "value_max": 30,
            "value_standard_deviation": pytest.approx(14.1421356),
        }

    def test_a_statistic_the_points_do_not_define_has_no_value(
        self, tmp_path: Path
    ) -> None:
        """One point has no standard deviation; points without a value have
        no mean, minimum or maximum. Their count and sum stay numbers."""
        rows = self._run(tmp_path)
        assert rows[3]["count"] == 1
        assert rows[3]["value_standard_deviation"] is None
        assert rows[3]["value_mean"] == 5
        assert rows[4] == {
            "count": 2,
            "value_sum": 0,
            "value_mean": None,
            "value_min": None,
            "value_max": None,
            "value_standard_deviation": None,
        }

    def test_the_columns_and_their_types_stay_as_predicted(
        self, tmp_path: Path
    ) -> None:
        """The empty areas change no column and no type: the run writes the
        same columns in the same types, and the prediction is the same."""
        areas, points = self._write_inputs(tmp_path)
        output_path = str(tmp_path / "out.parquet")
        AggregatePointsTool().run(
            AggregatePointsParams(
                source_path=points,
                area_type=AggregationAreaType.polygon,
                area_layer_path=areas,
                column_statistics=[FieldStatistic(**s) for s in EVERY_STATISTIC],
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
        predicted = AggregatePointsToolRunner.predict_output_schema(
            {
                "source_layer_id": {"value": "INTEGER", "category": "VARCHAR"},
                "area_layer_id": {"id": "INTEGER", "geometry": "GEOMETRY"},
            },
            {"area_type": "polygon", "column_statistics": EVERY_STATISTIC},
        )

        assert {k: v for k, v in written.items() if k in WRITTEN_TYPES} == (
            WRITTEN_TYPES
        )
        assert predicted == {
            "geometry": "GEOMETRY",
            "id": "INTEGER",
            "count": "BIGINT",
            "value_sum": "DOUBLE",
            "value_mean": "DOUBLE",
            "value_min": "DOUBLE",
            "value_max": "DOUBLE",
            "value_standard_deviation": "DOUBLE",
        }
        assert set(written) - {"bbox"} == set(predicted)

    def test_a_mean_over_areas_without_points_keeps_the_tool_s_style(
        self, tmp_path: Path
    ) -> None:
        """A mean that has no value in some areas classifies the others and
        draws the rest as no data; the style contract holds."""
        areas, points = self._write_inputs(tmp_path)
        params = AggregatePointsParams(
            source_path=points,
            area_type=AggregationAreaType.polygon,
            area_layer_path=areas,
            column_statistics=[
                FieldStatistic(operation=StatisticOperation.mean, field="value")
            ],
            output_path=str(tmp_path / "out.parquet"),
        )
        AggregatePointsTool().run(params)
        check_style(params, "value_mean")

    def test_a_mean_of_one_value_beside_areas_without_points_lists_no_data(
        self, tmp_path: Path
    ) -> None:
        """One point in one of four areas: its mean is the one value, the
        other areas have none. The style keeps one class for the value and
        the no-data look for the rest."""
        areas, _ = self._write_inputs(tmp_path)
        points = str(tmp_path / "one_point.parquet")
        con = duckdb.connect()
        con.execute("LOAD spatial;")
        con.execute(
            f"COPY (SELECT 5 AS value, ST_Point(10.5, 0.5) AS geom) "
            f"TO '{points}' (FORMAT PARQUET)"
        )
        con.close()
        params = AggregatePointsParams(
            source_path=points,
            area_type=AggregationAreaType.polygon,
            area_layer_path=areas,
            column_statistics=[
                FieldStatistic(operation=StatisticOperation.mean, field="value")
            ],
            output_path=str(tmp_path / "out.parquet"),
        )
        AggregatePointsTool().run(params)
        doc = check_style(params, "value_mean")
        [c] = doc["classify"]
        assert len(c["classes"]) == 1
        assert c["computed"]["no_data"] is True

    def test_a_mean_without_a_value_in_any_area_keeps_the_tool_s_style(
        self, tmp_path: Path
    ) -> None:
        """No point falls in any area: the mean column has no value at all.
        The classification stays without classes, so every area draws as no
        data and the legend says so."""
        areas, _ = self._write_inputs(tmp_path)
        params = AggregatePointsParams(
            source_path=POINTS_WITH_CATEGORY,
            area_type=AggregationAreaType.polygon,
            area_layer_path=areas,
            column_statistics=[
                FieldStatistic(operation=StatisticOperation.mean, field="value")
            ],
            output_path=str(tmp_path / "out.parquet"),
        )
        AggregatePointsTool().run(params)
        con = duckdb.connect()
        values = con.execute(
            f"SELECT DISTINCT value_mean FROM '{params.output_path}'"
        ).fetchall()
        con.close()
        assert values == [(None,)]
        [c] = check_style(params, "value_mean")["classify"]
        assert "classes" not in c
        assert c["computed"]["no_data"] is True


#: Result names as users type them: spaces, an umlaut, an embedded quote.
SUM_NAME = "Einwohner im Einzugsbereich"
MAX_NAME = "Einwohner über 65"
COUNT_NAME = 'Anzahl "alt"'


def _as_dict(value: object) -> dict:
    return json.loads(value) if isinstance(value, str) else dict(value)


class TestAggregatePointsResultNames:
    """A result name becomes the output column name exactly as given."""

    @staticmethod
    def _write_inputs(tmp_path: Path) -> tuple[str, str]:
        """One area and three points inside it, all in one H3 cell at res 6."""
        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        areas = str(tmp_path / "areas.parquet")
        points = str(tmp_path / "points.parquet")
        con.execute(f"""
            COPY (
                SELECT 1 AS id, ST_GeomFromText(
                    'POLYGON((11.5 48.1, 11.51 48.1, 11.51 48.11, 11.5 48.11, 11.5 48.1))'
                ) AS geom
            ) TO '{areas}' (FORMAT PARQUET)
        """)
        con.execute(f"""
            COPY (
                SELECT * FROM (VALUES
                    (10, 'a', ST_Point(11.501, 48.101)),
                    (20, 'a', ST_Point(11.502, 48.102)),
                    (40, 'b', ST_Point(11.503, 48.103))
                ) t(value, category, geom)
            ) TO '{points}' (FORMAT PARQUET)
        """)
        con.close()
        return areas, points

    @pytest.mark.parametrize(
        "area_type", [AggregationAreaType.polygon, AggregationAreaType.h3_grid]
    )
    @pytest.mark.parametrize("group_by", [None, ["category"]])
    def test_result_names_with_spaces_and_quotes_are_kept_exactly(
        self,
        tmp_path: Path,
        area_type: AggregationAreaType,
        group_by: list[str] | None,
    ) -> None:
        areas, points = self._write_inputs(tmp_path)
        output_path = str(tmp_path / "out.parquet")
        on_polygons = area_type == AggregationAreaType.polygon
        params = AggregatePointsParams(
            source_path=points,
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
            group_by_field=group_by,
            output_path=output_path,
        )
        AggregatePointsTool().run(params)
        con = duckdb.connect()
        con.execute("LOAD spatial;")
        df = con.execute(f"SELECT * FROM '{output_path}'").fetchdf()
        con.close()

        assert len(df) == 1
        assert {SUM_NAME, MAX_NAME, COUNT_NAME} <= set(df.columns)
        assert not any(c.startswith('"') for c in df.columns)
        row = df.iloc[0]
        assert row[SUM_NAME] == 70
        assert row[MAX_NAME] == 40
        assert row[COUNT_NAME] == 3
        if group_by:
            assert _as_dict(row[f"{SUM_NAME}_grouped"]) == {"a": 30, "b": 40}
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
        from goatlib.tools.aggregate_points import AggregatePointsToolRunner

        areas, points = self._write_inputs(tmp_path)
        output_path = str(tmp_path / "out.parquet")
        on_polygons = area_type == AggregationAreaType.polygon
        AggregatePointsTool().run(
            AggregatePointsParams(
                source_path=points,
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
        predicted = AggregatePointsToolRunner.predict_output_schema(
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
        """A count statistic's result_name names the count column, in the run
        and in the schema prediction alike; the other statistics keep theirs."""
        from goatlib.tools.aggregate_points import AggregatePointsToolRunner

        areas, points = self._write_inputs(tmp_path)
        output_path = str(tmp_path / "out.parquet")
        statistics = [
            {"operation": "sum", "field": "value"},
            {"operation": "max", "field": "value", "result_name": MAX_NAME},
            {"operation": "count", "result_name": COUNT_NAME},
        ]
        AggregatePointsTool().run(
            AggregatePointsParams(
                source_path=points,
                area_type=AggregationAreaType.polygon,
                area_layer_path=areas,
                column_statistics=[FieldStatistic(**s) for s in statistics],
                output_path=output_path,
            )
        )
        predicted = AggregatePointsToolRunner.predict_output_schema(
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
        assert row[MAX_NAME] == 40
        assert row[COUNT_NAME] == 3

    def test_an_h3_aggregation_predicts_the_cell_column_the_run_writes(
        self, tmp_path: Path
    ) -> None:
        """An H3 aggregation writes each cell's id as ``h3_<resolution>``; the
        schema prediction holds that column, and no polygon area's columns."""
        from goatlib.tools.aggregate_points import AggregatePointsToolRunner

        _, points = self._write_inputs(tmp_path)
        output_path = str(tmp_path / "out.parquet")
        statistics = [
            {"operation": "sum", "field": "value"},
            {"operation": "count", "result_name": COUNT_NAME},
        ]
        AggregatePointsTool().run(
            AggregatePointsParams(
                source_path=points,
                area_type=AggregationAreaType.h3_grid,
                h3_resolution=6,
                column_statistics=[FieldStatistic(**s) for s in statistics],
                output_path=output_path,
            )
        )
        predicted = AggregatePointsToolRunner.predict_output_schema(
            {"source_layer_id": {"value": "INTEGER", "category": "VARCHAR"}},
            {
                "area_type": AggregationAreaType.h3_grid.value,
                "h3_resolution": 6,
                "column_statistics": statistics,
            },
        )
        con = duckdb.connect()
        con.execute("LOAD spatial;")
        rel = con.execute(f"SELECT * FROM '{output_path}'")
        names = [d[0] for d in rel.description]
        con.close()

        assert "h3_6" in names
        assert predicted["h3_6"] == "VARCHAR"
        assert "h3_index" not in predicted
        assert set(names) - {"bbox"} == set(predicted)
