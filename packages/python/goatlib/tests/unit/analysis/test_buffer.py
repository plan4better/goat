"""Unit tests for BufferTool to verify buffer analysis functionality."""

from pathlib import Path

import duckdb
import pytest
from goatlib.analysis.geoprocessing.buffer import BufferTool
from goatlib.analysis.schemas.geoprocessing import BufferParams, DistanceType
from pydantic import ValidationError

# Test data and result directories
TEST_DATA_DIR = Path(__file__).parent.parent.parent / "data" / "vector"
RESULT_DIR = Path(__file__).parent.parent.parent / "result"


@pytest.fixture(autouse=True)
def ensure_result_dir():
    """Ensure result directory exists."""
    RESULT_DIR.mkdir(parents=True, exist_ok=True)


class TestBufferTool:
    """Unit tests for BufferTool analysis."""

    def test_buffer_points_single_distance(self) -> None:
        """Test buffering point geometries with a single distance."""
        input_path = str(TEST_DATA_DIR / "overlay_points.parquet")
        output_path = str(RESULT_DIR / "unit_buffer_points_100m.parquet")

        params = BufferParams(
            input_path=input_path,
            output_path=output_path,
            distance_type=DistanceType.constant,
            distances=[100.0],
            units="meters",
            polygon_union=False,
        )

        tool = BufferTool()
        results = tool.run(params)

        # Check that we got results
        assert len(results) == 1
        result_path, metadata = results[0]
        assert Path(result_path).exists()

        # Validate with DuckDB
        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")

        # Check row count matches input (one buffer per point)
        input_count = con.execute(
            f"SELECT COUNT(*) FROM read_parquet('{input_path}')"
        ).fetchone()[0]
        result_count = con.execute(
            f"SELECT COUNT(*) FROM read_parquet('{result_path}')"
        ).fetchone()[0]
        assert result_count == input_count, "Should have one buffer per input point"

        # Check geometry type is polygon
        geom_type = con.execute(
            f"SELECT ST_GeometryType(geometry) FROM read_parquet('{result_path}') LIMIT 1"
        ).fetchone()[0]
        assert "POLYGON" in geom_type.upper(), "Buffer output should be polygons"

        con.close()
        tool.cleanup()

    def test_buffer_points_multiple_distances(self) -> None:
        """Test buffering with multiple distances creates multiple rings."""
        input_path = str(TEST_DATA_DIR / "overlay_points.parquet")
        output_path = str(RESULT_DIR / "unit_buffer_points_multi_distance.parquet")

        params = BufferParams(
            input_path=input_path,
            output_path=output_path,
            distance_type=DistanceType.constant,
            distances=[100.0, 200.0, 500.0],
            units="meters",
            polygon_union=False,
        )

        tool = BufferTool()
        results = tool.run(params)

        assert len(results) == 1
        result_path, metadata = results[0]
        assert Path(result_path).exists()

        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")

        # Check we have 3x the input features (one per distance)
        input_count = con.execute(
            f"SELECT COUNT(*) FROM read_parquet('{input_path}')"
        ).fetchone()[0]
        result_count = con.execute(
            f"SELECT COUNT(*) FROM read_parquet('{result_path}')"
        ).fetchone()[0]
        assert result_count == input_count * 3, "Should have 3 buffers per input point"

        # Check buffer_distance column exists with correct values
        distances = con.execute(
            f"SELECT DISTINCT buffer_distance FROM read_parquet('{result_path}') ORDER BY buffer_distance"
        ).fetchall()
        distance_values = [d[0] for d in distances]
        assert distance_values == [
            100,
            200,
            500,
        ], f"Expected [100, 200, 500], got {distance_values}"

        con.close()
        tool.cleanup()

    def test_buffer_polygons(self) -> None:
        """Test buffering polygon geometries."""
        input_path = str(TEST_DATA_DIR / "overlay_polygons.parquet")
        output_path = str(RESULT_DIR / "unit_buffer_polygons.parquet")

        params = BufferParams(
            input_path=input_path,
            output_path=output_path,
            distance_type=DistanceType.constant,
            distances=[50.0],
            units="meters",
            polygon_union=False,
        )

        tool = BufferTool()
        results = tool.run(params)

        assert len(results) == 1
        result_path, metadata = results[0]
        assert Path(result_path).exists()

        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")

        row_count = con.execute(
            f"SELECT COUNT(*) FROM read_parquet('{result_path}')"
        ).fetchone()[0]
        assert row_count > 0, "Result should have features"

        con.close()
        tool.cleanup()

    def test_buffer_lines(self) -> None:
        """Test buffering line geometries."""
        input_path = str(TEST_DATA_DIR / "overlay_lines.parquet")
        output_path = str(RESULT_DIR / "unit_buffer_lines.parquet")

        params = BufferParams(
            input_path=input_path,
            output_path=output_path,
            distance_type=DistanceType.constant,
            distances=[25.0],
            units="meters",
            polygon_union=False,
        )

        tool = BufferTool()
        results = tool.run(params)

        assert len(results) == 1
        result_path, metadata = results[0]
        assert Path(result_path).exists()

        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")

        row_count = con.execute(
            f"SELECT COUNT(*) FROM read_parquet('{result_path}')"
        ).fetchone()[0]
        assert row_count > 0, "Result should have features"

        # Lines buffered should become polygons
        geom_type = con.execute(
            f"SELECT ST_GeometryType(geometry) FROM read_parquet('{result_path}') LIMIT 1"
        ).fetchone()[0]
        assert "POLYGON" in geom_type.upper(), "Buffered lines should become polygons"

        con.close()
        tool.cleanup()

    def test_buffer_with_polygon_union(self) -> None:
        """Test buffer with polygon_union merges overlapping geometries."""
        input_path = str(TEST_DATA_DIR / "overlay_points.parquet")
        output_path = str(RESULT_DIR / "unit_buffer_unioned.parquet")

        # Use large buffer to ensure overlaps
        params = BufferParams(
            input_path=input_path,
            output_path=output_path,
            distance_type=DistanceType.constant,
            distances=[5000.0],  # 5km - should create overlaps
            units="meters",
            polygon_union=True,
        )

        tool = BufferTool()
        results = tool.run(params)

        assert len(results) == 1
        result_path, metadata = results[0]
        assert Path(result_path).exists()

        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")

        # With polygon_union, we should have fewer features than input
        input_count = con.execute(
            f"SELECT COUNT(*) FROM read_parquet('{input_path}')"
        ).fetchone()[0]
        result_count = con.execute(
            f"SELECT COUNT(*) FROM read_parquet('{result_path}')"
        ).fetchone()[0]

        # Unioned result should have equal or fewer features
        assert (
            result_count <= input_count
        ), "Unioned buffer should merge overlapping features"

        con.close()
        tool.cleanup()

    def test_buffer_different_units(self) -> None:
        """Test buffer with different distance units."""
        input_path = str(TEST_DATA_DIR / "overlay_points.parquet")

        for unit in ["meters", "kilometers", "feet"]:
            output_path = str(RESULT_DIR / f"unit_buffer_{unit}.parquet")

            params = BufferParams(
                input_path=input_path,
                output_path=output_path,
                distance_type=DistanceType.constant,
                distances=[1.0],  # 1 unit
                units=unit,
                polygon_union=False,
            )

            tool = BufferTool()
            results = tool.run(params)

            assert len(results) == 1
            result_path, metadata = results[0]
            assert Path(
                result_path
            ).exists(), f"Buffer with {unit} should produce output"

            tool.cleanup()


class TestBufferParams:
    """Test BufferParams validation."""

    def test_valid_constant_params(self):
        """Valid constant distance parameters should pass validation."""
        params = BufferParams(
            input_path="/tmp/input.parquet",
            output_path="/tmp/output.parquet",
            distance_type=DistanceType.constant,
            distances=[100.0, 200.0],
            units="meters",
            polygon_union=True,
        )
        assert params.distances == [100.0, 200.0]
        assert params.units == "meters"
        assert params.polygon_union is True

    def test_valid_field_params(self):
        """Valid field-based distance parameters should pass validation."""
        params = BufferParams(
            input_path="/tmp/input.parquet",
            output_path="/tmp/output.parquet",
            distance_type=DistanceType.field,
            distance_field="buffer_dist",
            units="meters",
        )
        assert params.distance_type == DistanceType.field
        assert params.distance_field == "buffer_dist"

    def test_default_distance_type_is_constant(self):
        """Default distance_type should be constant."""
        params = BufferParams(
            input_path="/tmp/input.parquet",
            output_path="/tmp/output.parquet",
            distances=[100.0],
        )
        assert params.distance_type == DistanceType.constant


if __name__ == "__main__":
    pytest.main([__file__, "-v"])


def test_a_buffer_distance_given_twice_is_refused() -> None:
    """Each distance is a ring of its own: the same one twice draws the same
    ring twice, which is always a slip."""
    with pytest.raises(ValidationError, match="once"):
        BufferParams(
            input_path="in.parquet", output_path="out.parquet", distances=[500, 500]
        )
    kept = BufferParams(
        input_path="in.parquet", output_path="out.parquet", distances=[500, 1000]
    )
    assert kept.distances == [500, 1000]
