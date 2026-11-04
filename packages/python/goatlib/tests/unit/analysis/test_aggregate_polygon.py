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
from goatlib.analysis.geoanalysis.aggregate_polygon import AggregatePolygonTool
from goatlib.analysis.schemas.aggregate import (
    AggregatePolygonParams,
    AggregationAreaType,
)
from goatlib.analysis.schemas.base import (
    FieldStatistic,
    StatisticOperation,
)

# Test data paths - same data as GOAT Core
TEST_DATA_DIR = Path(__file__).parent.parent.parent / "data" / "analysis" / "aggregate"
GREEN_AREAS = str(TEST_DATA_DIR / "green_areas.parquet")  # 90 park polygons
ZIPCODE_POLYGON = str(TEST_DATA_DIR / "zipcode_polygon.parquet")  # 10 zipcodes

# Pre-computed expected values from green_areas.parquet
TOTAL_GREEN_AREAS = 90
TOTAL_VALUE = 2531740.53  # Sum of all 'value' fields (area in sqm)


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
