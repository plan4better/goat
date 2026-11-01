"""Unit tests for ClusteringTool to verify clustering functionality."""

from pathlib import Path

import duckdb
import numpy as np
import pytest
from goatlib.analysis.geoanalysis.spatial_clustering import (
    ClusteringZones,
)
from goatlib.analysis.schemas.clustering import ClusteringParams, ClusterType

# Test data and result directories
TEST_DATA_DIR = Path(__file__).parent.parent.parent / "data" / "analysis"
RESULT_DIR = Path(__file__).parent.parent.parent / "result"


@pytest.fixture(autouse=True)
def ensure_result_dir():
    """Ensure result directory exists."""
    RESULT_DIR.mkdir(parents=True, exist_ok=True)


def test_clustering_schema_validation():
    """Test clustering parameter schema validation."""
    # Valid parameters
    valid_params = ClusteringParams(
        input_path="test.gpkg",
        output_path="result.parquet",
        output_summary_path="result_summary.parquet",
        nb_cluster=3,
        cluster_type=ClusterType.kmean,
    )
    assert valid_params.nb_cluster == 3
    assert valid_params.cluster_type == ClusterType.kmean
    assert valid_params.size_method == "count"  # default

    # Valid balanced clustering with field weighting
    balanced_params = ClusteringParams(
        input_path="test.gpkg",
        output_path="result.parquet",
        output_summary_path="result_summary.parquet",
        nb_cluster=5,
        cluster_type=ClusterType.equal_size,
        size_method="field",
        size_field="population",
        use_compactness=True,
        max_distance=1000.0,
        compactness_weight=0.3,
        equal_size_weight=1.0,
    )
    assert balanced_params.size_method == "field"
    assert balanced_params.size_field == "population"
    assert balanced_params.use_compactness is True
    assert balanced_params.compactness_weight == 0.3


def test_clustering_basic_workflow():
    """Test basic clustering workflow with synthetic data."""
    # Create a temporary in-memory test
    tool = ClusteringZones()

    # Create simple test points in a grid pattern
    # Valid lon/lat grid (~1 km spacing): the tool transforms 4326 -> 3857,
    # so coordinates must be real geographic positions.
    tool.con.execute("""
        CREATE TEMP TABLE test_points AS
        SELECT
            row_number() OVER () as id,
            ST_Point(x * 0.01, y * 0.01) as geometry,
            x * y as weight_field
        FROM (
            SELECT unnest([1, 2, 3, 4, 5, 6]) as x
        ) CROSS JOIN (
            SELECT unnest([1, 2, 3]) as y
        )
    """)

    # Test K-means clustering
    temp_dir = RESULT_DIR / "test_clustering_basic"
    temp_dir.mkdir(exist_ok=True)

    params = ClusteringParams(
        input_path="test_points",
        output_path=str(temp_dir / "kmeans_result.parquet"),
        output_summary_path=str(temp_dir / "kmeans_summary.parquet"),
        nb_cluster=3,
        cluster_type=ClusterType.kmean,
    )

    # Mock the import_input method for this test
    def mock_import(path, view_name):
        tool.con.execute(f"CREATE OR REPLACE VIEW {view_name} AS SELECT * FROM {path}")
        metadata = type(
            "obj", (object,), {"geometry_column": "geometry", "crs": None}
        )()
        return metadata, view_name

    tool.import_input = mock_import

    # Run clustering
    results = tool._run_implementation(params)

    # Verify basic structure
    assert len(results) == 2
    output_path, metadata = results[0]
    summary_path, summary_metadata = results[1]

    # Verify files were created
    assert Path(output_path).exists()
    assert Path(summary_path).exists()

    # Read and verify results
    points_df = tool.con.execute(f"SELECT * FROM '{output_path}'").df()
    summary_df = tool.con.execute(f"SELECT * FROM '{summary_path}'").df()

    # Basic validation
    assert "cluster_id" in points_df.columns
    assert len(points_df) == 18  # 6x3 grid
    assert len(summary_df) == 3  # 3 clusters
    assert "cluster_size" in summary_df.columns
    assert "max_distance" in summary_df.columns

    # All points should be assigned to a cluster
    assert points_df["cluster_id"].isna().sum() == 0

    # Cluster IDs should be 0, 1, 2
    unique_clusters = sorted(points_df["cluster_id"].unique())
    assert unique_clusters == [0, 1, 2]

    print(f"✓ K-means clustering: {len(points_df)} points → {len(summary_df)} clusters")
    print(f"  Cluster sizes: {sorted(summary_df['cluster_size'].values)}")


class TestZonesClustering:
    """Unit tests for Balanced Zones clustering (iterative boundary refinement)."""

    def test_balanced_zones_kita_data(self) -> None:
        """Test balanced zones clustering with kita (kindergarten) data."""
        input_path = str(TEST_DATA_DIR / "kita.gpkg")
        result_dir = Path(__file__).parent.parent.parent / "result"
        result_dir.mkdir(parents=True, exist_ok=True)

        # Verify test data exists
        if not Path(input_path).exists():
            pytest.skip(f"Test data not in repo: {input_path}")

        # Initialize clustering tool
        clustering_tool = ClusteringZones()

        # Set up clustering parameters
        params = ClusteringParams(
            input_path=input_path,
            output_path=str(result_dir / "cluster_kita_balanced.parquet"),
            output_summary_path=str(
                result_dir / "cluster_kita_balanced_summary.parquet"
            ),
            nb_cluster=4,
            cluster_type=ClusterType.equal_size,
        )

        # Run clustering analysis
        results = clustering_tool._run_implementation(params)

        # Verify results
        assert len(results) == 2  # Main points output + summary output
        output_path, metadata = results[0]  # Main points output
        summary_path, summary_metadata = results[1]  # Summary output
        assert output_path.exists()
        assert summary_path.exists()

        # Read output and verify cluster assignments
        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        df = con.execute(f"SELECT * FROM '{summary_path}'").df()
        con.close()

        assert "cluster_id" in df.columns
        unique_clusters = df["cluster_id"].unique()
        assert len(unique_clusters) == 4

        # Check zone sizes are more balanced than K-means would typically produce
        zone_sizes = df["cluster_size"].values
        size_std = np.std(zone_sizes)
        size_mean = np.mean(zone_sizes)
        cv = size_std / size_mean
        assert cv < 0.5, f"Zones are not well balanced: CV = {cv:.3f}"

    def test_kmeans_kita_data(self) -> None:
        """Test K-means clustering with kita (kindergarten) data."""
        input_path = str(TEST_DATA_DIR / "kita_part_munich.gpkg")
        result_dir = Path(__file__).parent.parent.parent / "result"
        result_dir.mkdir(parents=True, exist_ok=True)

        # Verify test data exists
        if not Path(input_path).exists():
            pytest.skip(f"Test data not in repo: {input_path}")

        # Initialize clustering tool
        clustering_tool = ClusteringZones()

        # Set up K-means parameters
        params = ClusteringParams(
            input_path=input_path,
            output_path=str(result_dir / "cluster_kita_kmeans.parquet"),
            output_summary_path=str(result_dir / "cluster_kita_kmeans_summary.parquet"),
            nb_cluster=4,
            cluster_type=ClusterType.kmean,
        )

        # Run clustering analysis
        results = clustering_tool._run_implementation(params)

        # Verify results
        assert len(results) == 2  # Main points output + summary output
        output_path, metadata = results[0]  # Main points output
        summary_path, summary_metadata = results[1]  # Summary output
        assert output_path.exists()
        assert summary_path.exists()

        # Read output and verify cluster assignments
        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        df = con.execute(f"SELECT * FROM '{summary_path}'").df()
        con.close()

        assert "cluster_id" in df.columns
        unique_clusters = df["cluster_id"].unique()
        assert len(unique_clusters) == 4

        print("\nK-means cluster distribution:")
        print(f"  Cluster sizes: {sorted(df['cluster_size'].values)}")

    def test_balanced_zones_kita_field_weight(self) -> None:
        """Test balanced zones clustering with field-based weighting (capacity_int)."""
        input_path = str(TEST_DATA_DIR / "kita.gpkg")
        result_dir = Path(__file__).parent.parent.parent / "result"
        result_dir.mkdir(parents=True, exist_ok=True)

        # Verify test data exists
        if not Path(input_path).exists():
            pytest.skip(f"Test data not in repo: {input_path}")

        # Initialize clustering tool
        clustering_tool = ClusteringZones()

        # Set up clustering parameters with field-based weighting
        params = ClusteringParams(
            input_path=input_path,
            output_path=str(result_dir / "cluster_kita_field.parquet"),
            output_summary_path=str(result_dir / "cluster_kita_field_summary.parquet"),
            nb_cluster=4,
            cluster_type=ClusterType.equal_size,
            size_method="field",
            size_field="capacity_int",
        )

        # Run clustering analysis
        results = clustering_tool._run_implementation(params)

        # Verify results
        assert len(results) == 2  # Main points output + summary output
        output_path, metadata = results[0]  # Main points output
        summary_path, summary_metadata = results[1]  # Summary output
        assert output_path.exists()
        assert summary_path.exists()

        # Read output and verify cluster assignments
        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        df = con.execute(f"SELECT * FROM '{summary_path}'").df()
        con.close()

        assert "cluster_id" in df.columns
        unique_clusters = df["cluster_id"].unique()
        assert len(unique_clusters) == 4

        # Check that cluster_size reflects the weighted sum (capacity_int), not just point count
        print("\nBalanced zones (field: capacity_int) distribution:")
        print(f"  Cluster sizes (weighted): {sorted(df['cluster_size'].values)}")

        # Verify balance on the weighted sizes
        zone_sizes = df["cluster_size"].values
        size_std = np.std(zone_sizes)
        size_mean = np.mean(zone_sizes)
        cv = size_std / size_mean

        print(f"  Mean: {size_mean:.1f}, Std: {size_std:.1f}, CV: {cv:.3f}")
        assert cv < 0.5, f"Weighted zones are not well balanced: CV = {cv:.3f}"


def test_metric_coordinates_keep_east_as_x():
    """A point at 10 E, 53.5 N lies 10 degrees of longitude east of Greenwich in Web Mercator."""
    tool = ClusteringZones()
    tool.con.execute("""
        CREATE TEMP TABLE axis_points AS
        SELECT row_number() OVER () AS id, ST_Point(10 + i * 0.01, 53.5) AS geometry
        FROM range(4) t(i)
    """)
    temp_dir = RESULT_DIR / "test_clustering_axes"
    temp_dir.mkdir(exist_ok=True)
    params = ClusteringParams(
        input_path="axis_points",
        output_path=str(temp_dir / "result.parquet"),
        output_summary_path=str(temp_dir / "summary.parquet"),
        nb_cluster=2,
        cluster_type=ClusterType.kmean,
    )

    def mock_import(path, view_name):
        tool.con.execute(f"CREATE OR REPLACE VIEW {view_name} AS SELECT * FROM {path}")
        metadata = type(
            "obj", (object,), {"geometry_column": "geometry", "crs": None}
        )()
        return metadata, view_name

    tool.import_input = mock_import
    tool._run_implementation(params)
    x, y = tool.con.execute(
        "SELECT x, y FROM features_metric ORDER BY lon LIMIT 1"
    ).fetchone()
    assert abs(x - 1_113_194.9) < 1.0
    assert abs(y - 7_076_025.3) < 50.0
