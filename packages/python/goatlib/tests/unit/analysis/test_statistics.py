"""Unit tests for statistics analysis functions.

These tests use an in-memory DuckDB database with test data to verify
the correctness of the statistics calculation functions.
"""

import json
import math

import duckdb
import pytest
from goatlib.analysis.statistics import (
    AreaOperation,
    ClassBreakMethod,
    SortOrder,
    StatisticsOperation,
    calculate_aggregation_stats,
    calculate_area_statistics,
    calculate_class_breaks,
    calculate_extent,
    calculate_feature_count,
    calculate_histogram,
    calculate_unique_values,
)


@pytest.fixture
def duckdb_connection():
    """Create an in-memory DuckDB connection with spatial extension."""
    con = duckdb.connect(":memory:")
    con.execute("INSTALL spatial; LOAD spatial;")
    return con


@pytest.fixture
def sample_data_table(duckdb_connection):
    """Create a sample data table for testing."""
    con = duckdb_connection

    # Create a table with numeric and categorical data
    con.execute("""
        CREATE TABLE test_data (
            id INTEGER,
            category VARCHAR,
            value DOUBLE,
            count INTEGER
        )
    """)

    # Insert test data
    con.execute("""
        INSERT INTO test_data VALUES
            (1, 'A', 10.0, 100),
            (2, 'A', 20.0, 200),
            (3, 'B', 30.0, 150),
            (4, 'B', 40.0, 250),
            (5, 'B', 50.0, 300),
            (6, 'C', 60.0, 175),
            (7, 'C', 70.0, 225),
            (8, 'C', 80.0, 125),
            (9, 'C', 90.0, 275),
            (10, 'D', 100.0, 350)
    """)

    return con


@pytest.fixture
def sample_polygon_table(duckdb_connection):
    """Create a sample polygon table for area statistics testing."""
    con = duckdb_connection

    # Create a table with polygon geometries (simple squares in EPSG:4326)
    con.execute("""
        CREATE TABLE test_polygons (
            id INTEGER,
            name VARCHAR,
            geometry GEOMETRY
        )
    """)

    # Insert simple square polygons (approximately 1 degree x 1 degree at equator)
    con.execute("""
        INSERT INTO test_polygons VALUES
            (1, 'Square 1', ST_GeomFromText('POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))')),
            (2, 'Square 2', ST_GeomFromText('POLYGON((2 0, 3 0, 3 1, 2 1, 2 0))')),
            (3, 'Square 3', ST_GeomFromText('POLYGON((4 0, 5 0, 5 1, 4 1, 4 0))'))
    """)

    return con


class TestFeatureCount:
    """Tests for calculate_feature_count function."""

    def test_count_all_features(self, sample_data_table):
        """Test counting all features without filter."""
        result = calculate_feature_count(sample_data_table, "test_data")

        assert result.count == 10

    def test_count_with_where_clause(self, sample_data_table):
        """Test counting features with a WHERE clause."""
        result = calculate_feature_count(
            sample_data_table, "test_data", where_clause="category = 'A'"
        )

        assert result.count == 2

    def test_count_with_numeric_filter(self, sample_data_table):
        """Test counting features with numeric filter."""
        result = calculate_feature_count(
            sample_data_table, "test_data", where_clause="value > 50"
        )

        assert result.count == 5

    def test_count_with_params(self, sample_data_table):
        """Test counting features with parameterized query."""
        result = calculate_feature_count(
            sample_data_table, "test_data", where_clause="category = ?", params=["B"]
        )

        assert result.count == 3

    def test_count_empty_result(self, sample_data_table):
        """Test counting when no features match."""
        result = calculate_feature_count(
            sample_data_table, "test_data", where_clause="category = 'Z'"
        )

        assert result.count == 0


class TestUniqueValues:
    """Tests for calculate_unique_values function."""

    def test_unique_values_basic(self, sample_data_table):
        """Test getting unique values of a column."""
        result = calculate_unique_values(sample_data_table, "test_data", "category")

        assert result.attribute == "category"
        assert result.total == 4  # A, B, C, D
        assert len(result.values) == 4

    def test_unique_values_descendent_order(self, sample_data_table):
        """Test unique values ordered by count descending."""
        result = calculate_unique_values(
            sample_data_table, "test_data", "category", order=SortOrder.descendent
        )

        # C has 4 entries, B has 3, A has 2, D has 1
        assert result.values[0].value == "C"
        assert result.values[0].count == 4
        assert result.values[-1].value == "D"
        assert result.values[-1].count == 1

    def test_unique_values_ascendent_order(self, sample_data_table):
        """Test unique values ordered by count ascending."""
        result = calculate_unique_values(
            sample_data_table, "test_data", "category", order=SortOrder.ascendent
        )

        # D has 1 entry, should be first
        assert result.values[0].value == "D"
        assert result.values[0].count == 1

    def test_unique_values_with_limit(self, sample_data_table):
        """Test unique values with limit."""
        result = calculate_unique_values(
            sample_data_table, "test_data", "category", limit=2
        )

        assert len(result.values) == 2
        assert result.total == 4  # Total unique values still 4

    def test_unique_values_with_offset(self, sample_data_table):
        """Test unique values with offset for pagination."""
        result = calculate_unique_values(
            sample_data_table, "test_data", "category", limit=2, offset=2
        )

        assert len(result.values) == 2

    def test_unique_values_with_filter(self, sample_data_table):
        """Test unique values with WHERE clause."""
        result = calculate_unique_values(
            sample_data_table, "test_data", "category", where_clause="value >= 30"
        )

        # Only B, C, D have values >= 30
        assert result.total == 3


class TestClassBreaks:
    """Tests for calculate_class_breaks function."""

    def test_equal_interval_breaks(self, sample_data_table):
        """Test equal interval classification."""
        result = calculate_class_breaks(
            sample_data_table,
            "test_data",
            "value",
            method=ClassBreakMethod.equal_interval,
            num_breaks=5,
        )

        assert result.attribute == "value"
        assert result.method == "equal_interval"
        assert len(result.breaks) == 5
        assert result.min == 10.0
        assert result.max == 100.0

        # Equal interval breaks: 5 internal breaks for 6 classes
        # interval = (100 - 10) / (5 + 1) = 15
        # breaks should NOT include min (10) or max (100)
        expected_breaks = [25.0, 40.0, 55.0, 70.0, 85.0]
        for actual, expected in zip(result.breaks, expected_breaks):
            assert abs(actual - expected) < 0.1

    def test_quantile_breaks(self, sample_data_table):
        """Test quantile classification."""
        result = calculate_class_breaks(
            sample_data_table,
            "test_data",
            "value",
            method=ClassBreakMethod.quantile,
            num_breaks=5,
        )

        assert result.method == "quantile"
        assert len(result.breaks) == 5

    def test_standard_deviation_breaks(self, sample_data_table):
        """Test standard deviation classification."""
        result = calculate_class_breaks(
            sample_data_table,
            "test_data",
            "value",
            method=ClassBreakMethod.standard_deviation,
            num_breaks=4,
        )

        assert result.method == "standard_deviation"
        assert result.std_dev is not None
        assert result.mean is not None

    def test_heads_and_tails_breaks(self, sample_data_table):
        """Test heads and tails classification."""
        result = calculate_class_breaks(
            sample_data_table,
            "test_data",
            "value",
            method=ClassBreakMethod.heads_and_tails,
            num_breaks=3,
        )

        assert result.method == "heads_and_tails"
        # Heads and tails returns breaks based on iterative mean splitting
        assert len(result.breaks) <= 3

    def test_class_breaks_with_filter(self, sample_data_table):
        """Test class breaks with WHERE clause."""
        result = calculate_class_breaks(
            sample_data_table,
            "test_data",
            "value",
            method=ClassBreakMethod.equal_interval,
            num_breaks=3,
            where_clause="category IN ('A', 'B')",
        )

        # Only values 10-50 should be included
        assert result.min == 10.0
        assert result.max == 50.0

    def test_class_breaks_strip_zeros(self, duckdb_connection):
        """Test class breaks with strip_zeros option."""
        con = duckdb_connection

        # Create table with zero values
        con.execute("""
            CREATE TABLE test_zeros (value DOUBLE)
        """)
        con.execute("""
            INSERT INTO test_zeros VALUES (0), (0), (10), (20), (30), (40), (50)
        """)

        result = calculate_class_breaks(
            con, "test_zeros", "value", num_breaks=3, strip_zeros=True
        )

        # Zero values should be excluded
        assert result.min == 10.0

    @pytest.mark.parametrize(
        "method",
        [
            ClassBreakMethod.quantile,
            ClassBreakMethod.equal_interval,
            ClassBreakMethod.standard_deviation,
            ClassBreakMethod.heads_and_tails,
        ],
    )
    def test_class_breaks_ignore_infinite_values(self, duckdb_connection, method):
        """Infinity is not a classifiable value and must not leak into the stats."""
        con = duckdb_connection
        con.execute("CREATE TABLE test_inf (value DOUBLE)")
        con.execute(
            "INSERT INTO test_inf VALUES (10), (20), (30), (40), (50),"
            " ('inf'::DOUBLE), ('-inf'::DOUBLE), ('nan'::DOUBLE)"
        )

        result = calculate_class_breaks(
            con, "test_inf", "value", method=method, num_breaks=3
        )

        assert result.min == 10.0
        assert result.max == 50.0
        stats = [result.mean, result.std_dev, *result.breaks]
        assert all(math.isfinite(v) for v in stats)
        # The API returns this model as JSON, which has no Infinity or NaN.
        json.loads(result.model_dump_json())

    def test_class_breaks_empty_result(self, duckdb_connection):
        """Test class breaks with no matching data."""
        con = duckdb_connection

        con.execute("CREATE TABLE empty_table (value DOUBLE)")

        result = calculate_class_breaks(con, "empty_table", "value", num_breaks=5)

        assert result.breaks == []
        assert result.min is None
        assert result.max is None


class TestAreaStatistics:
    """Tests for calculate_area_statistics function."""

    def test_area_sum(self, sample_polygon_table):
        """Test sum of polygon areas."""
        result = calculate_area_statistics(
            sample_polygon_table,
            "test_polygons",
            "geometry",
            operation=AreaOperation.sum,
        )

        assert result.feature_count == 3
        assert result.total_area is not None
        assert result.total_area > 0
        assert result.unit == "m²"

    def test_area_mean(self, sample_polygon_table):
        """Test mean of polygon areas."""
        result = calculate_area_statistics(
            sample_polygon_table,
            "test_polygons",
            "geometry",
            operation=AreaOperation.mean,
        )

        assert result.feature_count == 3
        assert result.result is not None
        # Mean should be approximately total_area / 3
        if result.total_area:
            expected_mean = result.total_area / 3
            assert abs(result.result - expected_mean) < 1.0

    def test_area_min(self, sample_polygon_table):
        """Test minimum polygon area."""
        result = calculate_area_statistics(
            sample_polygon_table,
            "test_polygons",
            "geometry",
            operation=AreaOperation.min,
        )

        assert result.result is not None
        assert result.result > 0

    def test_area_max(self, sample_polygon_table):
        """Test maximum polygon area."""
        result = calculate_area_statistics(
            sample_polygon_table,
            "test_polygons",
            "geometry",
            operation=AreaOperation.max,
        )

        assert result.result is not None
        assert result.result > 0

    def test_area_with_filter(self, sample_polygon_table):
        """Test area statistics with WHERE clause."""
        result = calculate_area_statistics(
            sample_polygon_table,
            "test_polygons",
            "geometry",
            operation=AreaOperation.sum,
            where_clause="id IN (1, 2)",
        )

        assert result.feature_count == 2

    def test_area_empty_result(self, duckdb_connection):
        """Test area statistics with no matching data."""
        con = duckdb_connection

        con.execute("""
            CREATE TABLE empty_polygons (
                id INTEGER,
                geometry GEOMETRY
            )
        """)

        result = calculate_area_statistics(
            con, "empty_polygons", "geometry", operation=AreaOperation.sum
        )

        assert result.feature_count == 0


class TestExtent:
    """Tests for calculate_extent function.

    Note: These tests use geometries without explicit SRID, so the ST_Transform
    in calculate_extent will treat them as WGS84. For production use, geometries
    should have proper SRID set.
    """

    @pytest.fixture
    def extent_polygon_table(self, duckdb_connection):
        """Create a polygon table with known coordinates for extent testing."""
        con = duckdb_connection

        # Create a table with polygon geometries
        con.execute("""
            CREATE TABLE test_extent_polygons (
                id INTEGER,
                name VARCHAR,
                geometry GEOMETRY
            )
        """)

        # Insert polygons with known coordinates
        # Polygon 1: covers (0,0) to (1,1)
        # Polygon 2: covers (2,2) to (4,3)
        # Polygon 3: covers (-1,-1) to (0,0)
        # Overall extent should be (-1, -1) to (4, 3)
        con.execute("""
            INSERT INTO test_extent_polygons VALUES
                (1, 'Polygon 1', ST_GeomFromText('POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))')),
                (2, 'Polygon 2', ST_GeomFromText('POLYGON((2 2, 4 2, 4 3, 2 3, 2 2))')),
                (3, 'Polygon 3', ST_GeomFromText('POLYGON((-1 -1, 0 -1, 0 0, -1 0, -1 -1))'))
        """)

        return con

    def _calculate_extent_no_transform(
        self,
        con,
        table_name,
        geometry_column="geometry",
        where_clause="TRUE",
        params=None,
    ):
        """Calculate extent without CRS transform (for unit testing).

        Uses ST_Extent_Agg which is the correct aggregate function in DuckDB spatial.
        """
        query = f"""
            SELECT
                ST_XMin(extent) as minx,
                ST_YMin(extent) as miny,
                ST_XMax(extent) as maxx,
                ST_YMax(extent) as maxy,
                cnt as feature_count
            FROM (
                SELECT ST_Extent_Agg({geometry_column}) as extent, COUNT(*) as cnt
                FROM {table_name}
                WHERE {where_clause}
            )
        """
        if params:
            result = con.execute(query, params).fetchone()
        else:
            result = con.execute(query).fetchone()

        if not result or result[4] == 0:
            from goatlib.analysis.statistics import ExtentResult

            return ExtentResult(bbox=None, feature_count=0)

        minx, miny, maxx, maxy, feature_count = result

        if minx is None or miny is None or maxx is None or maxy is None:
            from goatlib.analysis.statistics import ExtentResult

            return ExtentResult(bbox=None, feature_count=feature_count)

        from goatlib.analysis.statistics import ExtentResult

        return ExtentResult(
            bbox=[float(minx), float(miny), float(maxx), float(maxy)],
            feature_count=feature_count,
        )

    def test_extent_all_features(self, extent_polygon_table):
        """Test extent calculation for all features."""
        result = calculate_extent(
            extent_polygon_table, "test_extent_polygons", "geometry"
        )

        assert result.feature_count == 3
        assert result.bbox is not None
        assert len(result.bbox) == 4

        minx, miny, maxx, maxy = result.bbox
        assert abs(minx - (-1.0)) < 0.0001
        assert abs(miny - (-1.0)) < 0.0001
        assert abs(maxx - 4.0) < 0.0001
        assert abs(maxy - 3.0) < 0.0001

    def test_extent_with_filter(self, extent_polygon_table):
        """Test extent with WHERE clause filter."""
        result = calculate_extent(
            extent_polygon_table,
            "test_extent_polygons",
            "geometry",
            where_clause="id IN (1, 2)",
        )

        assert result.feature_count == 2
        assert result.bbox is not None

        minx, miny, maxx, maxy = result.bbox
        # Only polygons 1 and 2: extent should be (0, 0) to (4, 3)
        assert abs(minx - 0.0) < 0.0001
        assert abs(miny - 0.0) < 0.0001
        assert abs(maxx - 4.0) < 0.0001
        assert abs(maxy - 3.0) < 0.0001

    def test_extent_single_feature(self, extent_polygon_table):
        """Test extent for a single feature."""
        result = calculate_extent(
            extent_polygon_table,
            "test_extent_polygons",
            "geometry",
            where_clause="id = 1",
        )

        assert result.feature_count == 1
        assert result.bbox is not None

        minx, miny, maxx, maxy = result.bbox
        # Polygon 1: (0, 0) to (1, 1)
        assert abs(minx - 0.0) < 0.0001
        assert abs(miny - 0.0) < 0.0001
        assert abs(maxx - 1.0) < 0.0001
        assert abs(maxy - 1.0) < 0.0001

    def test_extent_with_params(self, extent_polygon_table):
        """Test extent with parameterized query."""
        result = calculate_extent(
            extent_polygon_table,
            "test_extent_polygons",
            "geometry",
            where_clause="name = ?",
            params=["Polygon 2"],
        )

        assert result.feature_count == 1
        assert result.bbox is not None

        minx, miny, maxx, maxy = result.bbox
        # Polygon 2: (2, 2) to (4, 3)
        assert abs(minx - 2.0) < 0.0001
        assert abs(miny - 2.0) < 0.0001
        assert abs(maxx - 4.0) < 0.0001
        assert abs(maxy - 3.0) < 0.0001

    def test_extent_empty_result(self, extent_polygon_table):
        """Test extent when no features match."""
        result = calculate_extent(
            extent_polygon_table,
            "test_extent_polygons",
            "geometry",
            where_clause="id = 999",
        )

        assert result.feature_count == 0
        assert result.bbox is None

    def test_extent_empty_table(self, duckdb_connection):
        """Test extent with empty table."""
        con = duckdb_connection

        con.execute("""
            CREATE TABLE empty_extent_table (
                id INTEGER,
                geometry GEOMETRY
            )
        """)

        result = calculate_extent(con, "empty_extent_table", "geometry")

        assert result.feature_count == 0
        assert result.bbox is None

    def test_extent_point_geometries(self, duckdb_connection):
        """Test extent calculation with point geometries."""
        con = duckdb_connection

        con.execute("""
            CREATE TABLE test_points (
                id INTEGER,
                geometry GEOMETRY
            )
        """)

        con.execute("""
            INSERT INTO test_points VALUES
                (1, ST_GeomFromText('POINT(10 20)')),
                (2, ST_GeomFromText('POINT(30 40)')),
                (3, ST_GeomFromText('POINT(15 25)'))
        """)

        result = calculate_extent(con, "test_points", "geometry")

        assert result.feature_count == 3
        assert result.bbox is not None

        minx, miny, maxx, maxy = result.bbox
        assert abs(minx - 10.0) < 0.0001
        assert abs(miny - 20.0) < 0.0001
        assert abs(maxx - 30.0) < 0.0001
        assert abs(maxy - 40.0) < 0.0001

    def test_extent_line_geometries(self, duckdb_connection):
        """Test extent calculation with line geometries."""
        con = duckdb_connection

        con.execute("""
            CREATE TABLE test_lines (
                id INTEGER,
                geometry GEOMETRY
            )
        """)

        con.execute("""
            INSERT INTO test_lines VALUES
                (1, ST_GeomFromText('LINESTRING(0 0, 5 5)')),
                (2, ST_GeomFromText('LINESTRING(10 10, 15 15)'))
        """)

        result = calculate_extent(con, "test_lines", "geometry")

        assert result.feature_count == 2
        assert result.bbox is not None

        minx, miny, maxx, maxy = result.bbox
        assert abs(minx - 0.0) < 0.0001
        assert abs(miny - 0.0) < 0.0001
        assert abs(maxx - 15.0) < 0.0001
        assert abs(maxy - 15.0) < 0.0001


class TestIntegration:
    """Integration tests combining multiple statistics functions."""

    def test_workflow_filter_then_classify(self, sample_data_table):
        """Test a workflow: count, get unique values, then classify."""
        con = sample_data_table

        # Step 1: Count features in category B
        count_result = calculate_feature_count(
            con, "test_data", where_clause="category = 'B'"
        )
        assert count_result.count == 3

        # Step 2: Get unique values of count column for category B
        unique_result = calculate_unique_values(
            con, "test_data", "count", where_clause="category = 'B'"
        )
        assert unique_result.total == 3  # 150, 250, 300

        # Step 3: Classify values for category B
        breaks_result = calculate_class_breaks(
            con,
            "test_data",
            "value",
            method=ClassBreakMethod.equal_interval,
            num_breaks=3,
            where_clause="category = 'B'",
        )
        assert breaks_result.min == 30.0
        assert breaks_result.max == 50.0


class TestAggregationStats:
    """Tests for calculate_aggregation_stats function."""

    def test_count_all(self, sample_data_table):
        """Test counting all features without grouping."""
        result = calculate_aggregation_stats(
            sample_data_table,
            "test_data",
            operation=StatisticsOperation.count,
        )

        assert len(result.items) == 1
        assert result.items[0].operation_value == 10
        assert result.total_count == 10

    def test_count_grouped(self, sample_data_table):
        """Test counting features grouped by category."""
        result = calculate_aggregation_stats(
            sample_data_table,
            "test_data",
            operation=StatisticsOperation.count,
            group_by_column="category",
            order=SortOrder.descendent,
        )

        assert len(result.items) == 4  # A, B, C, D
        assert result.total_items == 4
        # C has 4 entries, should be first with descendent order
        assert result.items[0].grouped_value == "C"
        assert result.items[0].operation_value == 4

    def test_sum_grouped(self, sample_data_table):
        """Test summing values grouped by category."""
        result = calculate_aggregation_stats(
            sample_data_table,
            "test_data",
            operation=StatisticsOperation.sum,
            operation_column="value",
            group_by_column="category",
        )

        assert len(result.items) == 4
        # Find category A: 10 + 20 = 30
        a_item = next(item for item in result.items if item.grouped_value == "A")
        assert a_item.operation_value == 30.0

    def test_mean_grouped(self, sample_data_table):
        """Test averaging values grouped by category."""
        result = calculate_aggregation_stats(
            sample_data_table,
            "test_data",
            operation=StatisticsOperation.mean,
            operation_column="value",
            group_by_column="category",
        )

        # Category A: (10 + 20) / 2 = 15
        a_item = next(item for item in result.items if item.grouped_value == "A")
        assert a_item.operation_value == 15.0

    def test_min_max_grouped(self, sample_data_table):
        """Test min and max values grouped by category."""
        result_min = calculate_aggregation_stats(
            sample_data_table,
            "test_data",
            operation=StatisticsOperation.min,
            operation_column="value",
            group_by_column="category",
        )

        result_max = calculate_aggregation_stats(
            sample_data_table,
            "test_data",
            operation=StatisticsOperation.max,
            operation_column="value",
            group_by_column="category",
        )

        # Category C: values are 60, 70, 80, 90
        c_min = next(item for item in result_min.items if item.grouped_value == "C")
        c_max = next(item for item in result_max.items if item.grouped_value == "C")
        assert c_min.operation_value == 60.0
        assert c_max.operation_value == 90.0

    def test_with_filter(self, sample_data_table):
        """Test aggregation with WHERE clause filter."""
        result = calculate_aggregation_stats(
            sample_data_table,
            "test_data",
            operation=StatisticsOperation.sum,
            operation_column="value",
            group_by_column="category",
            where_clause="value > 50",
        )

        # Only C and D have values > 50
        assert len(result.items) == 2

    def test_limit(self, sample_data_table):
        """Test aggregation with limit."""
        result = calculate_aggregation_stats(
            sample_data_table,
            "test_data",
            operation=StatisticsOperation.count,
            group_by_column="category",
            limit=2,
        )

        assert len(result.items) == 2
        assert result.total_items == 4  # Still 4 total groups

    def test_ascendent_order(self, sample_data_table):
        """Test aggregation with ascending order."""
        result = calculate_aggregation_stats(
            sample_data_table,
            "test_data",
            operation=StatisticsOperation.count,
            group_by_column="category",
            order=SortOrder.ascendent,
        )

        # D has 1 entry, should be first with ascendent order
        assert result.items[0].grouped_value == "D"
        assert result.items[0].operation_value == 1

    def test_missing_operation_column_raises(self, sample_data_table):
        """Test that sum without operation_column raises error."""
        with pytest.raises(ValueError) as exc_info:
            calculate_aggregation_stats(
                sample_data_table,
                "test_data",
                operation=StatisticsOperation.sum,
                # Missing operation_column
            )
        assert "operation_column is required" in str(exc_info.value)

    def test_expression_operation(self, sample_data_table):
        """Test aggregation with expression operation."""
        result = calculate_aggregation_stats(
            sample_data_table,
            "test_data",
            operation=StatisticsOperation.expression,
            operation_column='SUM("value") / COUNT(*)',
        )

        # Should return a single result with the expression value
        assert len(result.items) == 1
        assert result.items[0].grouped_value is None
        # Average of 10 values: (10+20+30+40+50+60+70+80+90+100) / 10 = 55
        assert result.items[0].operation_value == 55.0
        assert result.total_count == 10

    def test_expression_operation_grouped(self, sample_data_table):
        """Test aggregation with expression operation and grouping."""
        result = calculate_aggregation_stats(
            sample_data_table,
            "test_data",
            operation=StatisticsOperation.expression,
            operation_column='SUM("value")',
            group_by_column="category",
        )

        # Should return grouped results
        assert len(result.items) > 0
        # Each item should have a grouped_value
        for item in result.items:
            assert item.grouped_value is not None


class TestHistogram:
    """Tests for calculate_histogram function."""

    def test_basic_histogram(self, sample_data_table):
        """Test basic histogram calculation."""
        result = calculate_histogram(
            sample_data_table,
            "test_data",
            column="value",
            num_bins=5,
        )

        assert len(result.bins) == 5
        assert result.total_rows == 10
        assert result.missing_count == 0

        # Check that all values are accounted for
        total_in_bins = sum(bin.count for bin in result.bins)
        assert total_in_bins == 10

    def test_histogram_bins_coverage(self, sample_data_table):
        """Test that histogram bins cover the full range."""
        result = calculate_histogram(
            sample_data_table,
            "test_data",
            column="value",
            num_bins=10,
        )

        # First bin should start at or before minimum (10)
        assert result.bins[0].range[0] <= 10.0

        # Last bin should end at or after maximum (100)
        assert result.bins[-1].range[1] >= 100.0

    def test_histogram_with_filter(self, sample_data_table):
        """Test histogram with WHERE clause filter."""
        result = calculate_histogram(
            sample_data_table,
            "test_data",
            column="value",
            num_bins=3,
            where_clause="category = 'C'",
        )

        # C has 4 values: 60, 70, 80, 90
        assert result.total_rows == 4
        total_in_bins = sum(bin.count for bin in result.bins)
        assert total_in_bins == 4

    def test_histogram_quantile_binning(self, sample_data_table):
        """Test histogram with quantile binning method."""
        result = calculate_histogram(
            sample_data_table,
            "test_data",
            column="value",
            num_bins=5,
            method="quantile",
        )

        assert len(result.bins) == 5
        assert result.total_rows == 10
        assert sum(bin.count for bin in result.bins) == 10

    def test_histogram_custom_breaks(self, sample_data_table):
        """Test histogram with custom internal break points."""
        result = calculate_histogram(
            sample_data_table,
            "test_data",
            column="value",
            method="custom_breaks",
            custom_breaks=[25, 55, 85],
        )

        assert len(result.bins) == 4
        counts = [bin.count for bin in result.bins]
        assert counts == [2, 3, 3, 2]
        assert sum(counts) == 10

    def test_histogram_descendent_order(self, sample_data_table):
        """Test histogram with descending bin order."""
        result = calculate_histogram(
            sample_data_table,
            "test_data",
            column="value",
            num_bins=5,
            order=SortOrder.descendent,
        )

        # Bins should be in descending order
        for i in range(len(result.bins) - 1):
            assert result.bins[i].range[0] > result.bins[i + 1].range[0]

    def test_histogram_with_nulls(self, duckdb_connection):
        """Test histogram correctly counts NULL values."""
        con = duckdb_connection

        con.execute("""
            CREATE TABLE data_with_nulls (
                id INTEGER,
                value DOUBLE
            )
        """)
        con.execute("""
            INSERT INTO data_with_nulls VALUES
                (1, 10.0),
                (2, 20.0),
                (3, NULL),
                (4, 30.0),
                (5, NULL)
        """)

        result = calculate_histogram(
            con,
            "data_with_nulls",
            column="value",
            num_bins=3,
        )

        assert result.total_rows == 5
        assert result.missing_count == 2
        total_in_bins = sum(bin.count for bin in result.bins)
        assert total_in_bins == 3

    def test_histogram_single_value(self, duckdb_connection):
        """Test histogram when all values are the same."""
        con = duckdb_connection

        con.execute("""
            CREATE TABLE single_value (
                id INTEGER,
                value DOUBLE
            )
        """)
        con.execute("""
            INSERT INTO single_value VALUES
                (1, 50.0),
                (2, 50.0),
                (3, 50.0)
        """)

        result = calculate_histogram(
            con,
            "single_value",
            column="value",
            num_bins=5,
        )

        # Should return a single bin with all values
        assert len(result.bins) == 1
        assert result.bins[0].count == 3

    def test_histogram_empty_table(self, duckdb_connection):
        """Test histogram on empty table."""
        con = duckdb_connection

        con.execute("""
            CREATE TABLE empty_table (
                id INTEGER,
                value DOUBLE
            )
        """)

        result = calculate_histogram(
            con,
            "empty_table",
            column="value",
            num_bins=5,
        )

        assert len(result.bins) == 0
        assert result.total_rows == 0
        assert result.missing_count == 0

    def test_histogram_time_column_bins_on_seconds_of_day(self, duckdb_connection):
        """TIME columns bin on epoch seconds-of-day (08:00 -> 28800)."""
        con = duckdb_connection
        con.execute("CREATE TABLE t_time (tm TIME)")
        con.execute(
            "INSERT INTO t_time VALUES ('08:00:00'), ('09:30:00'), "
            "('12:00:00'), ('23:00:00')"
        )
        result = calculate_histogram(con, "t_time", column="tm", num_bins=4)
        assert result.total_rows == 4
        assert sum(b.count for b in result.bins) == 4
        assert result.bins[0].range[0] == 28800.0
        assert result.bins[-1].range[1] == 82800.0

    def test_histogram_date_column_bins_on_epoch(self, duckdb_connection):
        """DATE columns bin on unix epoch seconds without error."""
        con = duckdb_connection
        con.execute("CREATE TABLE t_date (d DATE)")
        con.execute(
            "INSERT INTO t_date VALUES ('2026-01-05'), ('2026-02-10'), "
            "('2026-06-20'), ('2026-12-31')"
        )
        result = calculate_histogram(con, "t_date", column="d", num_bins=4)
        assert result.total_rows == 4
        assert sum(b.count for b in result.bins) == 4
        assert result.bins[0].range[0] < result.bins[-1].range[1]


class TestColumnValidation:
    """`attribute`/`column` must name a real column of the table.

    `unique-values`, `class-breaks` and `histogram` are public (unauthenticated)
    processes and splice this value into their SQL, so an unknown or crafted
    name is rejected with a ValueError (a 400 on the HTTP path) instead of
    reaching DuckDB.
    """

    INJECTION = 'value" IS NOT NULL OR (SELECT 1) IS NOT NULL --'

    def test_unique_values_rejects_unknown_column(self, sample_data_table):
        with pytest.raises(ValueError, match="attribute"):
            calculate_unique_values(sample_data_table, "test_data", "nope")

    def test_unique_values_rejects_injection_payload(self, sample_data_table):
        with pytest.raises(ValueError, match="attribute"):
            calculate_unique_values(sample_data_table, "test_data", self.INJECTION)

    def test_unique_values_rejects_empty_column(self, sample_data_table):
        with pytest.raises(ValueError, match="attribute"):
            calculate_unique_values(sample_data_table, "test_data", "")

    def test_class_breaks_rejects_unknown_column(self, sample_data_table):
        with pytest.raises(ValueError, match="attribute"):
            calculate_class_breaks(sample_data_table, "test_data", "nope")

    def test_class_breaks_rejects_injection_payload(self, sample_data_table):
        with pytest.raises(ValueError, match="attribute"):
            calculate_class_breaks(sample_data_table, "test_data", self.INJECTION)

    def test_histogram_rejects_unknown_column(self, sample_data_table):
        with pytest.raises(ValueError, match="column"):
            calculate_histogram(sample_data_table, "test_data", column="nope")

    def test_histogram_rejects_injection_payload(self, sample_data_table):
        with pytest.raises(ValueError, match="column"):
            calculate_histogram(sample_data_table, "test_data", column=self.INJECTION)

    def test_column_with_quotes_in_its_name_is_usable(self, duckdb_connection):
        """A real column keeps working, embedded quote and all."""
        con = duckdb_connection
        con.execute('CREATE TABLE t_quoted ("we""ird" INTEGER)')
        con.execute("INSERT INTO t_quoted VALUES (1), (1), (2)")
        result = calculate_unique_values(con, "t_quoted", 'we"ird')
        assert {v.value for v in result.values} == {"1", "2"}


class TestAggregationColumnValidation:
    """`aggregation-stats` (also public) validates by membership, not by shape.

    A real column name containing a space, a dash or non-ASCII letters — which
    uploaded shapefile/CSV layers routinely carry — must work; an unknown or
    crafted one must still raise (a 400 on the HTTP path).
    """

    @pytest.fixture
    def odd_names_table(self, duckdb_connection):
        con = duckdb_connection
        con.execute('CREATE TABLE t_odd ("Straßen name" VARCHAR, "value-2020" INTEGER)')
        con.execute(
            "INSERT INTO t_odd VALUES ('Hauptstraße', 10), ('Hauptstraße', 20), "
            "('Nebenstraße', 30)"
        )
        return con

    def test_group_by_column_with_a_space_works(self, odd_names_table):
        result = calculate_aggregation_stats(
            odd_names_table,
            "t_odd",
            operation=StatisticsOperation.count,
            group_by_column="Straßen name",
        )
        assert {item.grouped_value for item in result.items} == {
            "Hauptstraße",
            "Nebenstraße",
        }

    def test_operation_column_with_a_dash_works(self, odd_names_table):
        result = calculate_aggregation_stats(
            odd_names_table,
            "t_odd",
            operation=StatisticsOperation.sum,
            operation_column="value-2020",
        )
        assert result.items[0].operation_value == 60.0

    def test_unknown_group_by_column_still_raises(self, sample_data_table):
        with pytest.raises(ValueError, match="group_by_column"):
            calculate_aggregation_stats(
                sample_data_table,
                "test_data",
                operation=StatisticsOperation.count,
                group_by_column="nope",
            )

    def test_injected_operation_column_still_raises(self, sample_data_table):
        with pytest.raises(ValueError, match="operation_column"):
            calculate_aggregation_stats(
                sample_data_table,
                "test_data",
                operation=StatisticsOperation.sum,
                operation_column='value") + (SELECT 1) --',
            )

    def test_unknown_secondary_group_by_column_still_raises(self, sample_data_table):
        with pytest.raises(ValueError, match="group_by_secondary_column"):
            calculate_aggregation_stats(
                sample_data_table,
                "test_data",
                operation=StatisticsOperation.count,
                group_by_column="category",
                group_by_secondary_column="nope",
            )


NORTH_A = "POLYGON((10 53.5, 10.1 53.5, 10.1 53.6, 10 53.6, 10 53.5))"
NORTH_B = "POLYGON((10.2 53.5, 10.3 53.5, 10.3 53.6, 10.2 53.6, 10.2 53.5))"
EQUATOR = "POLYGON((10 0, 10.1 0, 10.1 0.1, 10 0.1, 10 0))"


@pytest.fixture
def zone_boxes(duckdb_connection):
    """Boxes of 0.1 x 0.1 degrees in lon/lat order, two at 53.5 N, one at the equator."""
    con = duckdb_connection
    con.execute(f"""
        CREATE TABLE zone_boxes AS SELECT * FROM (VALUES
            (1, 'north', ST_GeomFromText('{NORTH_A}')),
            (2, 'north', ST_GeomFromText('{NORTH_B}')),
            (3, 'equator', ST_GeomFromText('{EQUATOR}')),
            (4, NULL, ST_GeomFromText('{EQUATOR}'))
        ) AS t(id, zone, geometry)
    """)
    return con


def _utm_area(con, wkt: str) -> float:
    """The box's area in UTM zone 32N (EPSG:32632), whose central meridian is 9 E."""
    return con.execute(
        f"SELECT ST_Area(ST_Transform(ST_GeomFromText('{wkt}'), "
        "'EPSG:4326', 'EPSG:32632', always_xy := true))"
    ).fetchone()[0]


class TestAreaOnTheSpheroid:
    @pytest.mark.parametrize("wkt", [NORTH_A, EQUATOR])
    def test_a_box_measures_its_true_area(self, zone_boxes, wkt):
        result = calculate_area_statistics(
            zone_boxes,
            "zone_boxes",
            "geometry",
            operation=AreaOperation.max,
            where_clause=f"ST_Equals(geometry, ST_GeomFromText('{wkt}')) AND id < 4",
        )
        expected = _utm_area(zone_boxes, wkt)
        assert abs(result.result - expected) / expected < 0.005

    def test_areas_per_group_largest_first(self, zone_boxes):
        result = calculate_area_statistics(
            zone_boxes,
            "zone_boxes",
            "geometry",
            operation=AreaOperation.sum,
            group_by_column="zone",
        )
        assert result.feature_count == 4
        assert result.total_groups == 3
        assert [g.grouped_value for g in result.groups] == ["north", "equator", None]
        north = result.groups[0]
        assert north.feature_count == 2
        expected = _utm_area(zone_boxes, NORTH_A) + _utm_area(zone_boxes, NORTH_B)
        assert abs(north.total_area - expected) / expected < 0.005
        assert north.result == north.total_area

    def test_groups_respect_the_filter_and_limit(self, zone_boxes):
        result = calculate_area_statistics(
            zone_boxes,
            "zone_boxes",
            "geometry",
            group_by_column="zone",
            where_clause="zone = 'north'",
            limit=1,
        )
        assert [g.grouped_value for g in result.groups] == ["north"]
        assert result.total_groups == 1

    def test_no_rows_give_no_groups(self, zone_boxes):
        result = calculate_area_statistics(
            zone_boxes,
            "zone_boxes",
            "geometry",
            group_by_column="zone",
            where_clause="FALSE",
        )
        assert result.feature_count == 0
        assert result.groups == []
        assert result.total_groups == 0

    def test_an_unknown_group_column_is_refused(self, zone_boxes):
        with pytest.raises(ValueError, match="nope"):
            calculate_area_statistics(
                zone_boxes, "zone_boxes", "geometry", group_by_column="nope"
            )
