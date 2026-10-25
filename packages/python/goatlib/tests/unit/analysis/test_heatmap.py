import math
from pathlib import Path

import pytest
from goatlib.analysis.accessibility.closest_average import HeatmapClosestAverageTool
from goatlib.analysis.accessibility.connectivity import HeatmapConnectivityTool
from goatlib.analysis.accessibility.gravity import HeatmapGravityTool
from goatlib.analysis.schemas.heatmap import (
    HeatmapClosestAverageParams,
    HeatmapConnectivityParams,
    HeatmapGravityParams,
    ImpedanceFunction,
    OpportunityClosestAverage,
    OpportunityGravity,
)


@pytest.mark.parametrize(
    "imp_func, expected_fn",
    [
        (
            ImpedanceFunction.linear,
            lambda cost, max_cost, sens, max_sens: (1 - cost / max_cost),
        ),
        (
            ImpedanceFunction.exponential,
            lambda cost, max_cost, sens, max_sens: math.exp(
                -(sens / max_sens) * (cost / max_cost)
            ),
        ),
        (
            ImpedanceFunction.gaussian,
            lambda cost, max_cost, sens, max_sens: math.exp(
                -((cost / max_cost) ** 2) / (sens / max_sens)
            ),
        ),
        (
            ImpedanceFunction.power,
            lambda cost, max_cost, sens, max_sens: (cost / max_cost)
            ** (-(sens / max_sens)),
        ),
    ],
)
def test_impedance_formulas(imp_func: ImpedanceFunction, expected_fn: callable) -> None:
    tool = HeatmapGravityTool()

    # Define OD matrix   (orig -> dest)
    tool.con.execute("""
        CREATE TABLE filtered_matrix AS
        SELECT 1 AS orig_id, 100 AS dest_id, 10 AS cost
        UNION ALL SELECT 2, 100, 20
        UNION ALL SELECT 1, 200, 15
        UNION ALL SELECT 2, 200, 25
    """)

    # Two opportunity destinations
    tool.con.execute("""
        CREATE TABLE opportunity_potentials_unified AS
        SELECT 100 AS dest_id, 30 AS test_max_cost, 1.0 AS test_potential, 300000.0 AS test_sens
        UNION ALL SELECT 200, 30, 2.0, 300000.0
    """)

    result_table = tool._compute_gravity_accessibility(
        "filtered_matrix",
        "opportunity_potentials_unified",
        [("fake", "test")],
        imp_func,
        300000.0,
    )

    df = tool.con.execute(f"SELECT * FROM {result_table}").fetchdf()

    # Compute expected accessibility for both destinations
    expected_dest_100 = (
        expected_fn(10, 30, 300000, 300000) * 1.0
        + expected_fn(20, 30, 300000, 300000) * 1.0
    )
    expected_dest_200 = (
        expected_fn(15, 30, 300000, 300000) * 2.0
        + expected_fn(25, 30, 300000, 300000) * 2.0
    )

    total_expected = expected_dest_100 + expected_dest_200

    assert "total_accessibility" in df.columns
    assert pytest.approx(df["total_accessibility"].sum(), rel=1e-3) == total_expected


def test_closest_average_computation() -> None:
    """Test the closest average computation logic in isolation."""
    tool = HeatmapClosestAverageTool()

    # OD matrix (orig_id, dest_id, cost)
    tool.con.execute("""
        CREATE TABLE filtered_matrix AS
        SELECT 1 AS orig_id, 100 AS dest_id, 10 AS cost
        UNION ALL SELECT 1, 200, 20
        UNION ALL SELECT 2, 100, 15
        UNION ALL SELECT 2, 200, 25
    """)

    # Unified opportunities: both have max_cost = 30, n_destinations = 1
    tool.con.execute("""
        CREATE TABLE opportunity_closest_avg_unified AS
        SELECT 100 AS dest_id, 30 AS test_max_cost, 1 AS test_n_dest
        UNION ALL SELECT 200, 30, 1
    """)

    std_tables = [("dummy", "test")]

    result_table = tool._compute_closest_average(
        "filtered_matrix", "opportunity_closest_avg_unified", std_tables
    )

    df = tool.con.execute(f"SELECT * FROM {result_table}").fetchdf()

    # Expected: average of closest 1 destination
    # Origin 1: closest = 10 → accessibility = 10
    # Origin 2: closest = 15 → accessibility = 15
    assert pytest.approx(df.loc[df.h3_index == 1, "test_accessibility"].iloc[0]) == 10
    assert pytest.approx(df.loc[df.h3_index == 2, "test_accessibility"].iloc[0]) == 15
    assert "total_accessibility" in df.columns


def test_connectivity_computation() -> None:
    tool = HeatmapConnectivityTool()

    # OD matrix: two origins, two destinations
    tool.con.execute("""
        CREATE TABLE filtered_matrix AS
        SELECT 1 AS orig_id, 10 AS dest_id, 5 AS cost
        UNION ALL SELECT 2, 10, 15
        UNION ALL SELECT 1, 20, 25
        UNION ALL SELECT 2, 20, 35
    """)

    # We’ll patch h3_cell_area to a constant to simplify verification
    tool.con.execute("CREATE OR REPLACE MACRO h3_cell_area(x, unit) AS 1000.0;")

    result_table = tool._compute_connectivity_scores(
        "filtered_matrix", 30, "connectivity_test"
    )

    df = tool.con.execute(f"SELECT * FROM {result_table}").fetchdf()

    # Expect: only destinations with cost <= 30 counted
    # reachable rows: (1,10), (2,10), (1,20)
    # So each dest_id (10, 20) → sum(area) per dest
    # dest 10: 2 * 1000 = 2000
    # dest 20: 1 * 1000 = 1000
    expected = {10: 2000, 20: 1000}
    for _, row in df.iterrows():
        assert pytest.approx(row.accessibility, rel=1e-6) == expected[row.h3_index]


@pytest.mark.parametrize(
    "imp_func",
    [
        ImpedanceFunction.linear,
        ImpedanceFunction.exponential,
        ImpedanceFunction.gaussian,
        ImpedanceFunction.power,
    ],
)
def test_gravity_tool_computes_expected_values(imp_func: ImpedanceFunction) -> None:
    tool = HeatmapGravityTool()

    # Create OD matrix: two origins (1, 2), two destinations (10, 20)
    tool.con.execute("""
        CREATE TABLE filtered_matrix AS
        SELECT 1 AS orig_id, 10 AS dest_id, 10 AS cost
        UNION ALL SELECT 2, 10, 20
        UNION ALL SELECT 1, 20, 15
        UNION ALL SELECT 2, 20, 25
    """)

    # Create opportunity table with known potentials
    tool.con.execute("""
        CREATE TABLE opportunity_potentials_unified AS
        SELECT 10 AS dest_id, 30 AS test_max_cost, 1.0 AS test_potential, 300000.0 AS test_sens
        UNION ALL SELECT 20, 30, 2.0, 300000.0
    """)

    # Compute accessibility
    result_table = tool._compute_gravity_accessibility(
        "filtered_matrix",
        "opportunity_potentials_unified",
        [("fake", "test")],
        imp_func,
        300000.0,
    )

    df = tool.con.execute(f"SELECT * FROM {result_table}").fetchdf()

    # Compute expected by hand for origin 1 and 2
    def impedance(
        cost: float,
        max_cost: float,
        sens: float,
        max_sens: float,
        imp_func: ImpedanceFunction,
    ) -> float:
        if imp_func == ImpedanceFunction.linear:
            return 1 - cost / max_cost
        elif imp_func == ImpedanceFunction.exponential:
            return math.exp(-(sens / max_sens) * (cost / max_cost))
        elif imp_func == ImpedanceFunction.gaussian:
            return math.exp(-((cost / max_cost) ** 2) / (sens / max_sens))
        elif imp_func == ImpedanceFunction.power:
            return (cost / max_cost) ** (-(sens / max_sens))
        else:
            raise ValueError(imp_func)

    def accessibility(orig_id: int) -> list[tuple[int, float, float]]:
        rows = [
            (10, 10 if orig_id == 1 else 20, 1.0),
            (20, 15 if orig_id == 1 else 25, 2.0),
        ]
        return sum(
            impedance(cost, 30, 300000, 300000, imp_func) * pot
            for dest, cost, pot in rows
        )

    expected1 = accessibility(1)
    expected2 = accessibility(2)

    assert (
        pytest.approx(df.loc[df.h3_index == 1, "total_accessibility"].iloc[0], rel=1e-6)
        == expected1
    )
    assert (
        pytest.approx(df.loc[df.h3_index == 2, "total_accessibility"].iloc[0], rel=1e-6)
        == expected2
    )


def test_heatmap_gravity_tool(data_root: Path, walking_matrix_dir: Path) -> None:
    """Test HeatmapGravityTool"""

    result_dir = Path(__file__).parent.parent.parent / "result"
    result_dir.mkdir(parents=True, exist_ok=True)

    params = HeatmapGravityParams(
        routing_mode="walking",
        od_matrix_path=str(walking_matrix_dir),
        od_column_map={
            "cost": "traveltime",
            "orig_id": "orig_id",
            "dest_id": "dest_id",
        },
        output_path=str(result_dir / "unit_heatmap_gravity.parquet"),
        impedance="linear",
        opportunities=[
            OpportunityGravity(
                input_path=str(data_root / "analysis" / "de_weihnachsmaerkte_25.gpkg"),
                name="weihnachsmaerkte_25",
                potential_constant=1.0,
                sensitivity=300000.0,
                max_cost=30,
            ),
        ],
    )

    # Run the heatmap gravity analysis tool
    tool = HeatmapGravityTool()
    results = tool.run(params)

    # Basic assertions on output
    assert len(results) == 1
    path, metadata = results[0]
    assert path.exists()
    assert metadata.source_type == "vector"
    # Note: properties are added by tool wrappers, not the analysis layer


def test_heatmap_closest_average_tool(
    data_root: Path, walking_matrix_dir: Path
) -> None:
    """Test HeatmapClosestAverageTool"""

    result_dir = Path(__file__).parent.parent.parent / "result"
    result_dir.mkdir(parents=True, exist_ok=True)

    params = HeatmapClosestAverageParams(
        routing_mode="walking",
        od_matrix_path=str(walking_matrix_dir),
        od_column_map={
            "cost": "traveltime",
            "orig_id": "orig_id",
            "dest_id": "dest_id",
        },
        output_path=str(result_dir / "unit_heatmap_closest_average.parquet"),
        opportunities=[
            OpportunityClosestAverage(
                input_path=str(data_root / "analysis" / "de_weihnachsmaerkte_25.gpkg"),
                name="weihnachsmaerkte_25",
                max_cost=20,
                n_destinations=3,
            ),
        ],
    )

    # Run the heatmap closest average analysis tool
    tool = HeatmapClosestAverageTool()
    results = tool.run(params)

    # Basic assertions on output
    assert len(results) == 1
    path, metadata = results[0]
    assert path.exists()
    assert metadata.source_type == "vector"


def test_heatmap_connectivity_tool(data_root: Path, walking_matrix_dir: Path) -> None:
    """Test HeatmapConnectivityTool"""

    result_dir = Path(__file__).parent.parent.parent / "result"
    result_dir.mkdir(parents=True, exist_ok=True)

    params = HeatmapConnectivityParams(
        routing_mode="walking",
        od_matrix_path=str(walking_matrix_dir),
        od_column_map={
            "cost": "traveltime",
            "orig_id": "orig_id",
            "dest_id": "dest_id",
        },
        output_path=str(result_dir / "unit_heatmap_connectivity.parquet"),
        max_cost=20,
        reference_area_path=str(data_root / "analysis" / "munich_districts.geojson"),
    )

    # Run the heatmap connectivity analysis tool
    tool = HeatmapConnectivityTool()
    results = tool.run(params)

    # Basic assertions on output
    assert len(results) == 1
    path, metadata = results[0]
    assert path.exists()
    assert metadata.source_type == "vector"


def test_heatmap_config_needs_only_the_decay_in_use(monkeypatch) -> None:
    """A routing build without one decay type still builds heatmaps with the others."""
    from types import SimpleNamespace

    from goatlib.analysis.accessibility.heatmap_v2 import HeatmapV2Tool
    from goatlib.analysis.schemas.heatmap_v2 import GravityDecay, HeatmapV2Params

    class Config:
        pass

    fake = SimpleNamespace(
        RoutingMode=SimpleNamespace(
            Walking="w", Bicycle="b", Pedelec="p", Car="c", PublicTransport="pt"
        ),
        HeatmapType=SimpleNamespace(
            Gravity="g", ClosestAverage="ca", Connectivity="co", TwoSFCA="2"
        ),
        # No Cumulative: an older routing build.
        GravityDecay=SimpleNamespace(
            Gaussian="gauss", Exponential="exp", Linear="lin", Power="pow"
        ),
        CostType=SimpleNamespace(Distance="d", Time="t"),
        HeatmapConfig=Config,
        Point3857=lambda x, y: (x, y),
        Opportunity=lambda seeds, weight, ref: (seeds, weight, ref),
    )
    monkeypatch.setattr(
        HeatmapV2Tool, "_get_routing_module", staticmethod(lambda: fake)
    )
    tool = HeatmapV2Tool()
    params = HeatmapV2Params.model_construct(
        **{
            **HeatmapV2Params.model_construct().__dict__,
            "decay": GravityDecay.gaussian,
        }
    )
    cfg = tool._build_heatmap_cfg(params, [], 300000.0, "out.parquet")
    assert cfg.decay == "gauss"


@pytest.mark.parametrize("heatmap_type", ["gravity", "closest_average"])
def test_a_layer_label_with_a_leading_digit_names_its_score_column(
    monkeypatch, tmp_path: Path, heatmap_type: str
) -> None:
    """A layer named "1 Grundschulen" scores into `1_grundschulen_accessibility`,
    an identifier that only parses quoted."""
    from types import SimpleNamespace

    import duckdb
    from goatlib.analysis.accessibility.heatmap_v2 import HeatmapV2Tool
    from goatlib.analysis.schemas.heatmap_v2 import HeatmapType

    def compute_heatmap(cfg: SimpleNamespace) -> None:
        duckdb.connect().execute(
            "COPY (SELECT 1::UBIGINT AS h3_index, 0.5::DOUBLE AS score) "
            f"TO '{cfg.output_path}' (FORMAT PARQUET)"
        )

    monkeypatch.setattr(
        HeatmapV2Tool,
        "_get_routing_module",
        staticmethod(lambda: SimpleNamespace(compute_heatmap=compute_heatmap)),
    )
    tool = HeatmapV2Tool()
    monkeypatch.setattr(
        tool,
        "_build_heatmap_cfg",
        lambda params, opp_groups, **kw: SimpleNamespace(output_path=kw["output_path"]),
    )
    col = tool._opportunity_label(
        SimpleNamespace(name="1 Grundschulen", input_path="schools.parquet"), 0
    )
    assert col == "1_grundschulen"
    htype = HeatmapType(heatmap_type)

    table = tool._compute_layer_scores(
        0,
        1,
        col,
        [],
        300000.0,
        30.0,
        1,
        SimpleNamespace(heatmap_type=htype),
        tmp_path,
    )
    results = tool._join_layer_scores([(col, table)], htype)

    rel = tool.con.execute(f"SELECT * FROM {results}")
    names = [d[0] for d in rel.description]
    row = dict(zip(names, rel.fetchone()))
    assert row["1_grundschulen_accessibility"] == 0.5
    assert row["total_accessibility"] == 0.5
