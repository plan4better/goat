from __future__ import annotations

import json
import math
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

try:
    import routing
except Exception as exc:  # pragma: no cover - import guard for local dev
    routing = None
    ROUTING_IMPORT_ERROR = exc
else:
    ROUTING_IMPORT_ERROR = None

CACHE_DIR = Path(__file__).resolve().parents[4] / "apps" / "routing" / "cache"
PARQUET_FILES = list(CACHE_DIR.glob("*.parquet"))
MARIENPLATZ_3857 = (1288578.0, 6130064.0)

pytestmark = [
    pytest.mark.skipif(
        routing is None,
        reason=f"routing module is not importable: {ROUTING_IMPORT_ERROR}",
    ),
]

requires_cache_parquet = pytest.mark.skipif(
    not PARQUET_FILES,
    reason=f"no parquet files found in {CACHE_DIR}",
)


def _make_config(**overrides):
    cfg = routing.RequestConfig()
    cfg.starting_points = [routing.Point3857(*MARIENPLATZ_3857)]
    cfg.mode = routing.RoutingMode.Walking
    cfg.cost_type = routing.CostType.Time
    cfg.max_cost = 10.0
    cfg.steps = 10
    cfg.speed_km_h = 5.0
    cfg.edge_dir = str(CACHE_DIR)
    cfg.node_dir = str(CACHE_DIR)
    cfg.catchment_type = routing.CatchmentType.Network
    cfg.output_format = routing.OutputFormat.GeoJSON
    cfg.polygon_difference = False

    for key, value in overrides.items():
        setattr(cfg, key, value)
    return cfg


def _assert_field_consistent(field):
    assert field.node_count > 0
    assert len(field.costs) == field.node_count
    assert all(c >= 0 for c in field.costs)


def _reachable_count(costs, budget):
    return sum(1 for c in costs if math.isfinite(c) and c <= budget)


def _assert_step_bucket(cost: float, step_cost: float, step_size: float) -> None:
    expected = math.ceil(cost / step_size) * step_size
    assert step_cost >= cost
    assert math.isclose(step_cost, expected, rel_tol=1e-9, abs_tol=1e-9)


@requires_cache_parquet
def test_walking_catchment_basic():
    cfg = _make_config(mode=routing.RoutingMode.Walking, max_cost=10.0)
    field = routing.compute_reachability_field(cfg)

    _assert_field_consistent(field)
    assert any(c <= 1e-6 for c in field.costs)


@requires_cache_parquet
def test_distance_mode_basic():
    cfg = _make_config(cost_type=routing.CostType.Distance, max_cost=1200.0)
    field = routing.compute_reachability_field(cfg)

    _assert_field_consistent(field)
    assert _reachable_count(field.costs, cfg.max_cost) > 0


@requires_cache_parquet
def test_budget_monotonicity_time():
    short_cfg = _make_config(max_cost=8.0)
    long_cfg = _make_config(max_cost=15.0)

    short_field = routing.compute_reachability_field(short_cfg)
    long_field = routing.compute_reachability_field(long_cfg)

    short_reachable = _reachable_count(short_field.costs, short_cfg.max_cost)
    long_reachable = _reachable_count(long_field.costs, long_cfg.max_cost)

    assert long_reachable >= short_reachable


@requires_cache_parquet
def test_speed_monotonicity_time():
    slow_cfg = _make_config(speed_km_h=4.0, max_cost=10.0)
    fast_cfg = _make_config(speed_km_h=6.0, max_cost=10.0)

    slow_field = routing.compute_reachability_field(slow_cfg)
    fast_field = routing.compute_reachability_field(fast_cfg)

    slow_reachable = _reachable_count(slow_field.costs, slow_cfg.max_cost)
    fast_reachable = _reachable_count(fast_field.costs, fast_cfg.max_cost)

    assert fast_reachable >= slow_reachable


@requires_cache_parquet
def test_bicycle_vs_walking_reachability_smoke():
    walking_cfg = _make_config(mode=routing.RoutingMode.Walking, speed_km_h=5.0)
    bicycle_cfg = _make_config(mode=routing.RoutingMode.Bicycle, speed_km_h=15.0)

    walking_field = routing.compute_reachability_field(walking_cfg)
    bicycle_field = routing.compute_reachability_field(bicycle_cfg)

    walking_reachable = _reachable_count(
        walking_field.costs, walking_cfg.max_cost
    )
    bicycle_reachable = _reachable_count(
        bicycle_field.costs, bicycle_cfg.max_cost
    )

    assert bicycle_reachable >= walking_reachable


def test_validation_requires_starting_points():
    cfg = _make_config(starting_points=[])

    with pytest.raises(ValueError, match="starting point"):
        routing.compute_reachability_field(cfg)


def test_validation_requires_positive_max_cost():
    cfg = _make_config(max_cost=0.0)

    with pytest.raises(ValueError, match="max_cost"):
        routing.compute_reachability_field(cfg)


def test_validation_requires_edge_dir():
    cfg = _make_config(edge_dir="")

    with pytest.raises(ValueError, match="edge_dir"):
        routing.compute_reachability_field(cfg)


@requires_cache_parquet
def test_runtime_error_for_disconnected_start_point():
    far_point_cfg = _make_config(starting_points=[routing.Point3857(0.0, 0.0)])

    with pytest.raises(RuntimeError, match="No edges loaded"):
        routing.compute_reachability_field(far_point_cfg)


@requires_cache_parquet
def test_geojson_api_returns_feature_collection():
    cfg = _make_config(catchment_type=routing.CatchmentType.Network)
    payload = routing.compute_catchment(cfg)

    doc = json.loads(payload)
    assert doc["type"] == "FeatureCollection"
    assert isinstance(doc["features"], list)
    assert len(doc["features"]) > 0

    first = doc["features"][0]
    assert first["type"] == "Feature"
    assert first["geometry"]["type"] == "LineString"
    assert "cost" in first["properties"]
    assert "step_cost" in first["properties"]


@requires_cache_parquet
def test_geojson_network_step_cost_bucket_is_correct():
    cfg = _make_config(catchment_type=routing.CatchmentType.Network, steps=8)
    payload = routing.compute_catchment(cfg)
    doc = json.loads(payload)

    assert len(doc["features"]) > 0
    step_size = cfg.max_cost / cfg.steps

    for feature in doc["features"]:
        props = feature["properties"]
        _assert_step_bucket(props["cost"], props["step_cost"], step_size)


@requires_cache_parquet
def test_geojson_network_linestring_coordinates_are_valid():
    cfg = _make_config(catchment_type=routing.CatchmentType.Network)
    payload = routing.compute_catchment(cfg)
    doc = json.loads(payload)

    assert len(doc["features"]) > 0
    for feature in doc["features"]:
        geom = feature["geometry"]
        assert geom["type"] == "LineString"
        coords = geom["coordinates"]
        assert isinstance(coords, list)
        assert len(coords) >= 2
        for point in coords:
            assert isinstance(point, list)
            assert len(point) == 2
            assert all(isinstance(v, (int, float)) for v in point)


@requires_cache_parquet
def test_geojson_h3_grid_returns_point_features():
    cfg = _make_config(catchment_type=routing.CatchmentType.HexagonalGrid)
    payload = routing.compute_catchment(cfg)
    doc = json.loads(payload)

    assert doc["type"] == "FeatureCollection"
    assert isinstance(doc["features"], list)
    assert len(doc["features"]) > 0

    first = doc["features"][0]
    assert first["geometry"]["type"] == "Polygon"
    ring = first["geometry"]["coordinates"][0]
    assert isinstance(ring, list)
    assert len(ring) >= 6
    assert "h3" in first["properties"]
    assert "resolution" in first["properties"]
    assert first["properties"]["resolution"] == 10
    assert "cost" in first["properties"]
    assert "step_cost" in first["properties"]


@requires_cache_parquet
@pytest.mark.parametrize(
    "mode,expected_resolution",
    [
        (routing.RoutingMode.Car, 8),
        (routing.RoutingMode.Bicycle, 9),
        (routing.RoutingMode.Pedelec, 9),
        (routing.RoutingMode.Walking, 10),
    ]
    if routing
    else [],
)
def test_geojson_h3_resolution_depends_on_mode(mode, expected_resolution):
    cfg = _make_config(catchment_type=routing.CatchmentType.HexagonalGrid, mode=mode)
    payload = routing.compute_catchment(cfg)
    doc = json.loads(payload)

    assert len(doc["features"]) > 0
    assert doc["features"][0]["properties"]["resolution"] == expected_resolution


@requires_cache_parquet
@pytest.mark.parametrize(
    "catchment_type",
    [
        routing.CatchmentType.Polygon,
        routing.CatchmentType.Network,
        routing.CatchmentType.HexagonalGrid,
    ]
    if routing
    else [],
)
def test_geojson_api_always_returns_geojson(catchment_type):
    cfg = _make_config(catchment_type=catchment_type)
    payload = routing.compute_catchment(cfg)
    doc = json.loads(payload)

    assert doc["type"] == "FeatureCollection"
    assert isinstance(doc["features"], list)


def test_environmental_walkability_config_defaults():
    cfg = routing.RequestConfig()
    assert cfg.shade_weight == 0.0
    assert cfg.heat_weight == 0.0
    assert cfg.slope_walk_weight == 0.0


def test_environmental_walkability_config_custom_values():
    cfg = routing.RequestConfig()
    cfg.shade_weight = 1.8
    cfg.heat_weight = 2.4
    cfg.slope_walk_weight = 0.7
    assert math.isclose(cfg.shade_weight, 1.8, abs_tol=1e-5)
    assert math.isclose(cfg.heat_weight, 2.4, abs_tol=1e-5)
    assert math.isclose(cfg.slope_walk_weight, 0.7, abs_tol=1e-5)


def test_matrix_and_heatmap_config_environmental_weights():
    mcfg = routing.MatrixConfig()
    assert mcfg.shade_weight == 0.0
    assert mcfg.heat_weight == 0.0
    assert mcfg.slope_walk_weight == 0.0
    mcfg.shade_weight = 1.0
    assert math.isclose(mcfg.shade_weight, 1.0, abs_tol=1e-5)

    hcfg = routing.HeatmapConfig()
    assert hcfg.shade_weight == 0.0
    assert hcfg.heat_weight == 0.0
    assert hcfg.slope_walk_weight == 0.0
    hcfg.heat_weight = 1.5
    assert math.isclose(hcfg.heat_weight, 1.5, abs_tol=1e-5)


@pytest.fixture
def synthetic_environmental_network(tmp_path: Path):
    edges_dir = tmp_path / "edges"
    nodes_dir = tmp_path / "nodes"
    edges_dir.mkdir(parents=True, exist_ok=True)
    nodes_dir.mkdir(parents=True, exist_ok=True)

    nodes_data = {
        "id": [1, 2, 3, 4, 5, 6],
        "x_3857": [MARIENPLATZ_3857[0] + i * 200.0 for i in range(6)],
        "y_3857": [MARIENPLATZ_3857[1]] * 6,
    }
    nodes_table = pa.Table.from_pydict(
        nodes_data,
        schema=pa.schema([
            ("id", pa.int64()),
            ("x_3857", pa.float64()),
            ("y_3857", pa.float64()),
        ]),
    )

    # Distinct impedances per factor so a transposed column or a dead weight
    # is observable: shade (0.8) penalizes ~2.6x at weight 2.0, heat (0.2)
    # only ~1.4x, slope (0.6 fwd / 0.1 rev) asymmetric for direction checks.
    edges_data = {
        "id": [1, 2, 3, 4, 5],
        "source": [1, 2, 3, 4, 5],
        "target": [2, 3, 4, 5, 6],
        "length_m": [200.0] * 5,
        "length_3857": [200.0] * 5,
        "class_": ["residential"] * 5,
        "impedance_slope": [0.6] * 5,
        "impedance_slope_reverse": [0.1] * 5,
        "impedance_surface": [0.0] * 5,
        "maxspeed_forward": [30] * 5,
        "maxspeed_backward": [30] * 5,
        "impedance_shade": [0.8] * 5,
        "impedance_heat": [0.2] * 5,
        "coordinates_3857": [
            [
                [MARIENPLATZ_3857[0] + i * 200.0, MARIENPLATZ_3857[1]],
                [MARIENPLATZ_3857[0] + (i + 1) * 200.0, MARIENPLATZ_3857[1]],
            ]
            for i in range(5)
        ],
    }
    edges_table = pa.Table.from_pydict(
        edges_data,
        schema=pa.schema([
            ("id", pa.int64()),
            ("source", pa.int64()),
            ("target", pa.int64()),
            ("length_m", pa.float64()),
            ("length_3857", pa.float64()),
            ("class_", pa.string()),
            ("impedance_slope", pa.float64()),
            ("impedance_slope_reverse", pa.float64()),
            ("impedance_surface", pa.float32()),
            ("maxspeed_forward", pa.int16()),
            ("maxspeed_backward", pa.int16()),
            ("impedance_shade", pa.float32()),
            ("impedance_heat", pa.float32()),
            ("coordinates_3857", pa.list_(pa.list_(pa.float64()))),
        ]),
    )

    pq.write_table(nodes_table, nodes_dir / "nodes.parquet")
    pq.write_table(edges_table, edges_dir / "edges.parquet")

    return edges_dir, nodes_dir


def test_environmental_routing_monotonicity(synthetic_environmental_network):
    edges_dir, nodes_dir = synthetic_environmental_network
    baseline_cfg = _make_config(
        mode=routing.RoutingMode.Walking,
        catchment_type=routing.CatchmentType.Network,
        edge_dir=str(edges_dir),
        node_dir=str(nodes_dir),
        shade_weight=0.0,
        heat_weight=0.0,
        slope_walk_weight=0.0,
    )
    penalized_cfg = _make_config(
        mode=routing.RoutingMode.Walking,
        catchment_type=routing.CatchmentType.Network,
        edge_dir=str(edges_dir),
        node_dir=str(nodes_dir),
        shade_weight=2.0,
        heat_weight=2.0,
        slope_walk_weight=2.0,
    )

    base_doc = json.loads(routing.compute_catchment(baseline_cfg))
    penalized_doc = json.loads(routing.compute_catchment(penalized_cfg))

    assert len(base_doc["features"]) > 0
    assert len(penalized_doc["features"]) < len(base_doc["features"])


@pytest.mark.parametrize(
    "weight_kwargs",
    [
        {"shade_weight": 2.0, "heat_weight": 0.0, "slope_walk_weight": 0.0},
        {"shade_weight": 0.0, "heat_weight": 2.0, "slope_walk_weight": 0.0},
        {"shade_weight": 0.0, "heat_weight": 0.0, "slope_walk_weight": 2.0},
    ],
)
def test_environmental_routing_monotonicity_per_factor(
    synthetic_environmental_network, weight_kwargs
):
    edges_dir, nodes_dir = synthetic_environmental_network
    baseline_cfg = _make_config(
        mode=routing.RoutingMode.Walking,
        catchment_type=routing.CatchmentType.Network,
        edge_dir=str(edges_dir),
        node_dir=str(nodes_dir),
        shade_weight=0.0,
        heat_weight=0.0,
        slope_walk_weight=0.0,
    )
    penalized_cfg = _make_config(
        mode=routing.RoutingMode.Walking,
        catchment_type=routing.CatchmentType.Network,
        edge_dir=str(edges_dir),
        node_dir=str(nodes_dir),
        **weight_kwargs,
    )

    base_doc = json.loads(routing.compute_catchment(baseline_cfg))
    penalized_doc = json.loads(routing.compute_catchment(penalized_cfg))

    assert len(base_doc["features"]) > 0
    assert len(penalized_doc["features"]) < len(base_doc["features"])


def test_environmental_shade_heat_not_transposed(synthetic_environmental_network):
    # Fixture uses shade=0.8 vs heat=0.2, so a shade-only penalty must shrink
    # the catchment strictly more than a heat-only penalty. A transposed
    # column index would invert this ordering while keeping each
    # single-factor test green.
    edges_dir, nodes_dir = synthetic_environmental_network

    def _feature_count(**weights):
        cfg = _make_config(
            mode=routing.RoutingMode.Walking,
            catchment_type=routing.CatchmentType.Network,
            edge_dir=str(edges_dir),
            node_dir=str(nodes_dir),
            shade_weight=0.0,
            heat_weight=0.0,
            slope_walk_weight=0.0,
            **weights,
        )
        return len(json.loads(routing.compute_catchment(cfg))["features"])

    shade_count = _feature_count(shade_weight=2.0)
    heat_count = _feature_count(heat_weight=2.0)
    assert shade_count < heat_count


def _write_network_without_environmental_columns(tmp_path: Path):
    edges_dir = tmp_path / "edges_noenv"
    nodes_dir = tmp_path / "nodes_noenv"
    edges_dir.mkdir(parents=True, exist_ok=True)
    nodes_dir.mkdir(parents=True, exist_ok=True)
    nodes_table = pa.Table.from_pydict(
        {
            "id": [1, 2, 3],
            "x_3857": [MARIENPLATZ_3857[0] + i * 200.0 for i in range(3)],
            "y_3857": [MARIENPLATZ_3857[1]] * 3,
        },
        schema=pa.schema([
            ("id", pa.int64()),
            ("x_3857", pa.float64()),
            ("y_3857", pa.float64()),
        ]),
    )
    edges_table = pa.Table.from_pydict(
        {
            "id": [1, 2],
            "source": [1, 2],
            "target": [2, 3],
            "length_m": [200.0, 200.0],
            "length_3857": [200.0, 200.0],
            "class_": ["residential", "residential"],
            "impedance_slope": [0.0, 0.0],
            "impedance_slope_reverse": [0.0, 0.0],
            "impedance_surface": pa.array([0.0, 0.0], pa.float32()),
            "maxspeed_forward": pa.array([30, 30], pa.int16()),
            "maxspeed_backward": pa.array([30, 30], pa.int16()),
            "coordinates_3857": [
                [
                    [MARIENPLATZ_3857[0] + i * 200.0, MARIENPLATZ_3857[1]],
                    [MARIENPLATZ_3857[0] + (i + 1) * 200.0, MARIENPLATZ_3857[1]],
                ]
                for i in range(2)
            ],
        },
    )
    pq.write_table(nodes_table, nodes_dir / "nodes.parquet")
    pq.write_table(edges_table, edges_dir / "edges.parquet")
    return edges_dir, nodes_dir


def test_environmental_loader_missing_columns_fallback(tmp_path: Path):
    # Parquet without impedance_shade/heat must not fail; weights fall back
    # to zero impedance (baseline behaviour).
    edges_dir, nodes_dir = _write_network_without_environmental_columns(tmp_path)
    for weights in (
        {"shade_weight": 0.0, "heat_weight": 0.0, "slope_walk_weight": 0.0},
        {"shade_weight": 2.0, "heat_weight": 2.0, "slope_walk_weight": 1.0},
    ):
        cfg = _make_config(
            mode=routing.RoutingMode.Walking,
            catchment_type=routing.CatchmentType.Network,
            edge_dir=str(edges_dir),
            node_dir=str(nodes_dir),
            **weights,
        )
        doc = json.loads(routing.compute_catchment(cfg))
        assert len(doc["features"]) > 0


def _write_network_with_bad_environmental_values(tmp_path: Path):
    edges_dir = tmp_path / "edges_bad"
    nodes_dir = tmp_path / "nodes_bad"
    edges_dir.mkdir(parents=True, exist_ok=True)
    nodes_dir.mkdir(parents=True, exist_ok=True)
    nodes_table = pa.Table.from_pydict(
        {
            "id": [1, 2, 3, 4],
            "x_3857": [MARIENPLATZ_3857[0] + i * 200.0 for i in range(4)],
            "y_3857": [MARIENPLATZ_3857[1]] * 4,
        },
        schema=pa.schema([
            ("id", pa.int64()),
            ("x_3857", pa.float64()),
            ("y_3857", pa.float64()),
        ]),
    )
    edges_table = pa.Table.from_pydict(
        {
            "id": [1, 2, 3],
            "source": [1, 2, 3],
            "target": [2, 3, 4],
            "length_m": [200.0, 200.0, 200.0],
            "length_3857": [200.0, 200.0, 200.0],
            "class_": ["residential"] * 3,
            # NaN, negative, and >1.0 must be clamped to [0, 1], never poison costs.
            "impedance_slope": [float("nan"), -0.5, 5.0],
            "impedance_slope_reverse": [float("inf"), -1.0, 5.0],
            "impedance_surface": pa.array([0.0, 0.0, 0.0], pa.float32()),
            "maxspeed_forward": pa.array([30, 30, 30], pa.int16()),
            "maxspeed_backward": pa.array([30, 30, 30], pa.int16()),
            "impedance_shade": pa.array(
                [float("nan"), -0.5, 5.0], type=pa.float32()
            ),
            "impedance_heat": pa.array(
                [float("inf"), -1.0, 5.0], type=pa.float32()
            ),
            "coordinates_3857": [
                [
                    [MARIENPLATZ_3857[0] + i * 200.0, MARIENPLATZ_3857[1]],
                    [MARIENPLATZ_3857[0] + (i + 1) * 200.0, MARIENPLATZ_3857[1]],
                ]
                for i in range(3)
            ],
        },
    )
    pq.write_table(nodes_table, nodes_dir / "nodes.parquet")
    pq.write_table(edges_table, edges_dir / "edges.parquet")
    return edges_dir, nodes_dir


def test_environmental_loader_clamps_out_of_range(tmp_path: Path):
    edges_dir, nodes_dir = _write_network_with_bad_environmental_values(tmp_path)
    cfg = _make_config(
        mode=routing.RoutingMode.Walking,
        catchment_type=routing.CatchmentType.Network,
        edge_dir=str(edges_dir),
        node_dir=str(nodes_dir),
        shade_weight=2.0,
        heat_weight=2.0,
        slope_walk_weight=2.0,
    )
    field = routing.compute_reachability_field(cfg)
    assert all(math.isfinite(c) or c == float("inf") for c in field.costs)
    doc = json.loads(routing.compute_catchment(cfg))
    assert len(doc["features"]) > 0


def test_matrix_execution_with_environmental_weights(
    synthetic_environmental_network, tmp_path: Path
):
    edges_dir, nodes_dir = synthetic_environmental_network
    origin = routing.Point3857(*MARIENPLATZ_3857)
    dest = routing.Point3857(MARIENPLATZ_3857[0] + 800.0, MARIENPLATZ_3857[1])

    def _run_matrix(output_name: str, orig, dst, **weights):
        cfg = routing.MatrixConfig()
        cfg.origins = [orig]
        cfg.destinations = [dst]
        cfg.mode = routing.RoutingMode.Walking
        cfg.cost_type = routing.CostType.Time
        cfg.max_cost = 60.0
        cfg.speed_km_h = 5.0
        cfg.edge_dir = str(edges_dir)
        cfg.node_dir = str(nodes_dir)
        cfg.output_path = str(tmp_path / output_name)
        for k, v in weights.items():
            setattr(cfg, k, v)
        routing.compute_travel_cost_matrix(cfg)
        return pq.read_table(cfg.output_path).to_pylist()

    base_rows = _run_matrix(
        "matrix_base.parquet",
        origin,
        dest,
        shade_weight=0.0,
        heat_weight=0.0,
        slope_walk_weight=0.0,
    )
    penalized_fwd = _run_matrix(
        "matrix_penalized_fwd.parquet",
        origin,
        dest,
        shade_weight=2.0,
        heat_weight=2.0,
        slope_walk_weight=2.0,
    )
    penalized_rev = _run_matrix(
        "matrix_penalized_rev.parquet",
        dest,
        origin,
        shade_weight=0.0,
        heat_weight=0.0,
        slope_walk_weight=2.0,
    )
    slope_only_fwd = _run_matrix(
        "matrix_slope_fwd.parquet",
        origin,
        dest,
        shade_weight=0.0,
        heat_weight=0.0,
        slope_walk_weight=2.0,
    )

    assert penalized_fwd[0]["travel_cost"] > base_rows[0]["travel_cost"]
    assert slope_only_fwd[0]["travel_cost"] > penalized_rev[0]["travel_cost"]


def test_heatmap_execution_with_environmental_weights(
    synthetic_environmental_network, tmp_path: Path
):
    edges_dir, nodes_dir = synthetic_environmental_network
    far_point = routing.Point3857(
        MARIENPLATZ_3857[0] + 800.0, MARIENPLATZ_3857[1]
    )

    def _run_heatmap(output_name: str, **weights):
        cfg = routing.HeatmapConfig()
        opp = routing.Opportunity([far_point], 1.0, far_point)
        cfg.opportunities = [opp]
        cfg.mode = routing.RoutingMode.Walking
        cfg.cost_type = routing.CostType.Time
        cfg.max_cost = 60.0
        cfg.speed_km_h = 5.0
        cfg.edge_dir = str(edges_dir)
        cfg.node_dir = str(nodes_dir)
        cfg.heatmap_type = routing.HeatmapType.Gravity
        cfg.output_path = str(tmp_path / output_name)
        for k, v in weights.items():
            setattr(cfg, k, v)
        routing.compute_heatmap(cfg)
        return pq.read_table(cfg.output_path).to_pylist()

    base_rows = _run_heatmap(
        "heatmap_base.parquet",
        shade_weight=0.0,
        heat_weight=0.0,
        slope_walk_weight=0.0,
    )
    penalized_rows = _run_heatmap(
        "heatmap_penalized.parquet",
        shade_weight=2.0,
        heat_weight=2.0,
        slope_walk_weight=2.0,
    )
    base_scores = {r["h3_index"]: r["score"] for r in base_rows}
    penalized_scores = {r["h3_index"]: r["score"] for r in penalized_rows}
    assert len(base_scores) > 0
    assert sum(penalized_scores.values()) < sum(base_scores.values())


def test_validation_rejects_shade_weight_out_of_bounds():
    cfg = _make_config(shade_weight=5.5)
    with pytest.raises(ValueError, match="shade_weight"):
        routing.compute_reachability_field(cfg)

    cfg = _make_config(shade_weight=-0.5)
    with pytest.raises(ValueError, match="shade_weight"):
        routing.compute_reachability_field(cfg)


def test_validation_rejects_heat_weight_out_of_bounds():
    cfg = _make_config(heat_weight=5.5)
    with pytest.raises(ValueError, match="heat_weight"):
        routing.compute_reachability_field(cfg)

    cfg = _make_config(heat_weight=-0.5)
    with pytest.raises(ValueError, match="heat_weight"):
        routing.compute_reachability_field(cfg)


def test_validation_rejects_slope_walk_weight_out_of_bounds():
    cfg = _make_config(slope_walk_weight=3.5)
    with pytest.raises(ValueError, match="slope_walk_weight"):
        routing.compute_reachability_field(cfg)

    cfg = _make_config(slope_walk_weight=-0.5)
    with pytest.raises(ValueError, match="slope_walk_weight"):
        routing.compute_reachability_field(cfg)


def test_validation_rejects_environmental_weights_for_non_walking_mode():
    cfg = _make_config(mode=routing.RoutingMode.Bicycle, shade_weight=1.0)
    with pytest.raises(ValueError, match="Walking mode"):
        routing.compute_reachability_field(cfg)


def test_validation_rejects_environmental_weights_for_distance_cost_type():
    cfg = _make_config(
        cost_type=routing.CostType.Distance,
        max_cost=1000.0,
        shade_weight=1.0,
    )
    with pytest.raises(ValueError, match="Time cost type"):
        routing.compute_reachability_field(cfg)
