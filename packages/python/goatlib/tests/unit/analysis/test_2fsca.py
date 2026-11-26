from pathlib import Path

import pytest
from fixtures.tool_style import U, check_tool_style, tool_params
from goatlib.analysis.accessibility.two_step_catchment_area import Heatmap2SFCATool
from goatlib.analysis.schemas.heatmap import (
    Heatmap2SFCAParams,
    ImpedanceFunction,
    Opportunity2SFCA,
    TwoSFCAType,
)
from goatlib.tools.heatmap_2sfca import Heatmap2SFCAToolParams, Heatmap2SFCAToolRunner
from goatlib.tools.style_contract import Expectation


def test_2sfca_schema_validation():
    """Test 2SFCA parameter schema validation."""
    # Valid standard 2SFCA parameters
    opportunity = Opportunity2SFCA(
        input_path="opportunities.gpkg",
        capacity_type="field",
        capacity_field="beds",
        max_cost=20,
    )

    valid_params = Heatmap2SFCAParams(
        routing_mode="walking",
        od_matrix_path="matrix.parquet",
        output_path="result.parquet",
        two_sfca_type=TwoSFCAType.twosfca,
        demand_path="demand.gpkg",
        demand_field="population",
        opportunities=[opportunity],
    )
    assert valid_params.two_sfca_type == TwoSFCAType.twosfca
    assert len(valid_params.opportunities) == 1
    assert valid_params.impedance == ImpedanceFunction.gaussian  # default

    # Valid Enhanced 2SFCA parameters
    enhanced_opportunity = Opportunity2SFCA(
        input_path="hospitals.gpkg",
        capacity_type="field",
        capacity_field="beds",
        max_cost=30,
        sensitivity=500000,  # Only visible when e2sfca/m2sfca
    )

    enhanced_params = Heatmap2SFCAParams(
        routing_mode="car",
        od_matrix_path="car_matrix.parquet",
        output_path="e2sfca_result.parquet",
        two_sfca_type=TwoSFCAType.e2sfca,
        impedance=ImpedanceFunction.exponential,
        demand_path="census.gpkg",
        demand_field="pop_total",
        opportunities=[enhanced_opportunity],
    )
    assert enhanced_params.two_sfca_type == TwoSFCAType.e2sfca
    assert enhanced_params.impedance == ImpedanceFunction.exponential
    assert enhanced_params.opportunities[0].sensitivity == 500000


def test_2sfca_tool_initialization():
    """Test 2SFCA tool initialization and basic structure."""
    tool = Heatmap2SFCATool()

    # Verify tool has expected methods
    assert hasattr(tool, "_run_implementation")
    assert hasattr(tool, "_compute_capacity_ratios")
    assert hasattr(tool, "_compute_cumulative_accessibility")

    # Verify tool inherits from HeatmapToolBase
    from goatlib.analysis.accessibility.base import HeatmapToolBase

    assert isinstance(tool, HeatmapToolBase)

    print("✓ 2SFCA tool initialization successful")


def test_2sfca_opportunity_standardization():
    """Test opportunity data standardization structure."""
    tool = Heatmap2SFCATool()

    # Create synthetic opportunity data
    tool.con.execute("""
        CREATE TEMP TABLE test_opportunities AS
        SELECT
            101 as id,
            ST_Point(10.0, 48.0) as geometry,
            50 as capacity
        UNION ALL
        SELECT
            102,
            ST_Point(10.1, 48.1),
            30
    """)

    # Test opportunity processing components
    opportunity = Opportunity2SFCA(
        input_path="test_opportunities",
        capacity_type="field",
        capacity_field="capacity",
        max_cost=20,
    )

    # Verify opportunity configuration
    assert opportunity.capacity_field == "capacity"
    assert opportunity.max_cost == 20
    assert opportunity.input_path == "test_opportunities"

    print("✓ 2SFCA opportunity structure validation successful")


def test_2sfca_basic_computation():
    """Test 2SFCA computation with synthetic data and expected values."""
    tool = Heatmap2SFCATool()

    # OD matrix: orig_id = demand locations, dest_id = opportunity locations.
    # Both 2SFCA steps consume this same orientation.
    tool.con.execute("""
        CREATE TABLE filtered_matrix_step1 AS
        SELECT 1 AS orig_id, 101 AS dest_id, 10 AS cost
        UNION ALL SELECT 1, 102, 20
        UNION ALL SELECT 2, 101, 15
        UNION ALL SELECT 2, 102, 8
    """)

    tool.con.execute("""
        CREATE TABLE filtered_matrix_step2 AS
        SELECT * FROM filtered_matrix_step1
    """)

    # Create demand data (schema: orig_id, demand_value)
    tool.con.execute("""
        CREATE TABLE demand AS
        SELECT 1 AS orig_id, 1000.0 AS demand_value
        UNION ALL SELECT 2, 1500.0
    """)

    # Create unified opportunities table (standardized via PIVOT)
    tool.con.execute("""
        CREATE TABLE opportunities_unified AS
        SELECT 101 AS dest_id, 25 AS test_max_cost, 50 AS test_capacity, 300000.0 AS test_sens
        UNION ALL SELECT 102, 25, 30, 300000.0
    """)

    std_tables = [("opportunities", "test")]

    # Run 2SFCA Step 1: compute capacity ratios
    result_table, safe_names = tool._compute_capacity_ratios(
        "filtered_matrix_step1",
        "opportunities_unified",
        std_tables,
        "demand",
        TwoSFCAType.twosfca,
    )

    # Run 2SFCA Step 2: compute cumulative accessibility
    final_table = tool._compute_cumulative_accessibility(
        "filtered_matrix_step2", result_table, safe_names, TwoSFCAType.twosfca
    )

    df = tool.con.execute(f"""
        SELECT h3_index, total_accessibility
        FROM {final_table}
        ORDER BY h3_index
    """).fetchdf()

    # Expected 2SFCA values:
    # Step 1: Capacity ratios per opportunity
    # Opp 101 (orig_id=101): demand at dest 1 (cost=10, pop=1000) + dest 2 (cost=15, pop=1500) = 2500
    #   Ratio = 50/2500 = 0.02
    # Opp 102 (orig_id=102): demand at dest 1 (cost=20, pop=1000) + dest 2 (cost=8, pop=1500) = 2500
    #   Ratio = 30/2500 = 0.012

    # Step 2: Accessibility per demand location (h3_index = orig_id from step2 matrix)
    # Origin 1: accesses opp 101 (cost=10, ratio=0.02) + opp 102 (cost=20, ratio=0.012) = 0.032
    # Origin 2: accesses opp 101 (cost=15, ratio=0.02) + opp 102 (cost=8, ratio=0.012) = 0.032
    expected1 = 0.032
    expected2 = 0.032

    assert "total_accessibility" in df.columns
    assert len(df) == 2
    assert (
        pytest.approx(df.loc[df.h3_index == 1, "total_accessibility"].iloc[0], rel=1e-2)
        == expected1
    )
    assert (
        pytest.approx(df.loc[df.h3_index == 2, "total_accessibility"].iloc[0], rel=1e-2)
        == expected2
    )

    print(
        f"✓ 2SFCA computation: accessibility values {df['total_accessibility'].values}"
    )


def test_2sfca_workflow(data_root: Path, walking_matrix_dir: Path) -> None:
    """Test the standard 2SFCA workflow"""
    result_dir = Path(__file__).parent.parent.parent / "result"
    result_dir.mkdir(parents=True, exist_ok=True)

    # Create synthetic opportunity layers
    opportunity1 = Opportunity2SFCA(
        name="kita",
        input_path=str(data_root / "analysis" / "kita_part_munich.gpkg"),
        capacity="capacity_int",
        max_cost=30,
    )
    # Create synthetic demand layer
    demand_path = str(data_root / "analysis" / "census_part_munich.parquet")
    demand_field = "einwohner"

    params = Heatmap2SFCAParams(
        routing_mode="walking",
        od_matrix_path=str(walking_matrix_dir),
        output_path=str(result_dir / "unit_heatmap_2sfca.parquet"),
        two_sfca_type=TwoSFCAType.twosfca,
        opportunities=[opportunity1],
        demand_path=demand_path,
        demand_field=demand_field,
    )

    tool = Heatmap2SFCATool()
    results = tool.run(params)

    # Assertions to make it a proper test
    assert results is not None
    assert len(results) == 1
    assert Path(results[0][1].path).exists()
    check_tool_style(
        Heatmap2SFCAToolRunner,
        tool_params(Heatmap2SFCAToolParams, params, demand_layer_id=U),
        results[0][1].path,
        expect=Expectation(field="total_accessibility"),
    )


def test_e2sfca_workflow(data_root: Path, walking_matrix_dir: Path) -> None:
    """Test the Enhanced 2SFCA workflow with impedance weighting"""
    result_dir = Path(__file__).parent.parent.parent / "result"
    result_dir.mkdir(parents=True, exist_ok=True)

    # Create synthetic opportunity layers
    opportunity1 = Opportunity2SFCA(
        name="kita",
        input_path=str(data_root / "analysis" / "kita_part_munich.gpkg"),
        capacity="capacity_int",
        max_cost=30,
    )

    # Create synthetic demand layer
    demand_path = str(data_root / "analysis" / "census_part_munich.parquet")
    demand_field = "einwohner"

    params = Heatmap2SFCAParams(
        routing_mode="walking",
        od_matrix_path=str(walking_matrix_dir),
        output_path=str(result_dir / "unit_heatmap_e2sfca.parquet"),
        two_sfca_type=TwoSFCAType.e2sfca,
        impedance=ImpedanceFunction.gaussian,
        opportunities=[opportunity1],
        demand_path=demand_path,
        demand_field=demand_field,
    )

    tool = Heatmap2SFCATool()
    results = tool.run(params)

    # Assertions to make it a proper test
    assert results is not None
    assert len(results) == 1
    assert Path(results[0][1].path).exists()


def test_m2sfca_workflow(data_root: Path, walking_matrix_dir: Path) -> None:
    """Test the Enhanced 2SFCA workflow with impedance weighting"""
    result_dir = Path(__file__).parent.parent.parent / "result"
    result_dir.mkdir(parents=True, exist_ok=True)

    # Create synthetic opportunity layers
    opportunity1 = Opportunity2SFCA(
        name="kita",
        input_path=str(data_root / "analysis" / "kita_part_munich.gpkg"),
        capacity="capacity_int",
        max_cost=30,
    )

    # Create synthetic demand layer
    demand_path = str(data_root / "analysis" / "census_part_munich.parquet")
    demand_field = "einwohner"

    params = Heatmap2SFCAParams(
        routing_mode="walking",
        od_matrix_path=str(walking_matrix_dir),
        output_path=str(result_dir / "unit_heatmap_m2sfca.parquet"),
        two_sfca_type=TwoSFCAType.m2sfca,
        impedance=ImpedanceFunction.gaussian,
        opportunities=[opportunity1],
        demand_path=demand_path,
        demand_field=demand_field,
    )

    tool = Heatmap2SFCATool()
    results = tool.run(params)

    # Assertions to make it a proper test
    assert results is not None
    assert len(results) == 1
    assert Path(results[0][1].path).exists()
