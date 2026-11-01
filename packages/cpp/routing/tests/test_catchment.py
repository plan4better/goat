from __future__ import annotations

import json
import math
import os
from pathlib import Path

import pytest

try:
    import routing
except Exception as exc:  # pragma: no cover - import guard for local dev
    routing = None
    ROUTING_IMPORT_ERROR = exc
else:
    ROUTING_IMPORT_ERROR = None

# The street network where the tools read it: the tools' two settings, else
# where goatlib.tasks.sync_base_data installs it under DATA_DIR. Munich's H3
# res-3 cell (8077) is enough.
_DATA_DIR = Path(os.environ.get("DATA_DIR") or "/app/data")
EDGE_DIR = Path(
    os.environ.get("STREET_NETWORK_EDGES_BASE_PATH")
    or _DATA_DIR / "street_network" / "edges"
)
NODE_DIR = Path(
    os.environ.get("STREET_NETWORK_NODES_BASE_PATH")
    or _DATA_DIR / "street_network" / "nodes"
)
PARQUET_FILES = list(EDGE_DIR.glob("**/*.parquet"))
MARIENPLATZ_3857 = (1288578.0, 6130064.0)

# CI installs the street network for these tests, so there a missing one
# fails them instead of skipping them all.
if os.getenv("CI"):
    if routing is None:
        pytest.fail(f"routing is not importable: {ROUTING_IMPORT_ERROR}", pytrace=False)
    if not PARQUET_FILES:
        pytest.fail(f"no street network parquet files under {EDGE_DIR}", pytrace=False)

pytestmark = [
    pytest.mark.skipif(
        routing is None,
        reason=f"routing module is not importable: {ROUTING_IMPORT_ERROR}",
    ),
    pytest.mark.skipif(
        not PARQUET_FILES,
        reason=f"no street network parquet files under {EDGE_DIR}",
    ),
]


def _make_config(**overrides):
    cfg = routing.RequestConfig()
    cfg.starting_points = [routing.Point3857(*MARIENPLATZ_3857)]
    cfg.mode = routing.RoutingMode.Walking
    cfg.cost_type = routing.CostType.Time
    cfg.max_cost = 10.0
    cfg.steps = 10
    cfg.speed_km_h = 5.0
    cfg.edge_dir = str(EDGE_DIR)
    cfg.node_dir = str(NODE_DIR)
    cfg.catchment_type = routing.CatchmentType.Network
    cfg.output_format = routing.OutputFormat.GeoJSON
    cfg.polygon_difference = False

    for key, value in overrides.items():
        setattr(cfg, key, value)
    return cfg


def _features(cfg):
    doc = json.loads(routing.compute_catchment(cfg))
    assert doc["type"] == "FeatureCollection"
    return doc["features"]


def _cell_costs(**overrides):
    """Costs of the H3 cells the catchment reaches. The HexagonalGrid output
    gives each cell the lowest cost of the street nodes and edge points in it,
    so the cell of the snapped starting point costs 0."""
    cfg = _make_config(catchment_type=routing.CatchmentType.HexagonalGrid, **overrides)
    return [feature["properties"]["cost"] for feature in _features(cfg)]


def _reached_edges(**overrides):
    """How many street edges the catchment reaches: the Network output has one
    feature per reached edge."""
    cfg = _make_config(catchment_type=routing.CatchmentType.Network, **overrides)
    return len(_features(cfg))


def _assert_costs_valid(costs, budget):
    assert len(costs) > 0
    assert all(0 <= c <= budget for c in costs)


def _assert_step_bucket(cost: float, step_cost: float, step_size: float) -> None:
    expected = math.ceil(cost / step_size) * step_size
    assert step_cost >= cost
    assert math.isclose(step_cost, expected, rel_tol=1e-9, abs_tol=1e-9)


def _assert_on_step_grid(step_cost: float, step_size: float, steps: int) -> None:
    step = step_cost / step_size
    assert math.isclose(step, round(step), rel_tol=0, abs_tol=1e-9)
    assert 0 <= round(step) <= steps


def test_walking_catchment_basic():
    costs = _cell_costs(mode=routing.RoutingMode.Walking, max_cost=10.0)

    _assert_costs_valid(costs, 10.0)
    assert any(c <= 1e-6 for c in costs)


def test_distance_mode_basic():
    costs = _cell_costs(cost_type=routing.CostType.Distance, max_cost=1200.0)

    _assert_costs_valid(costs, 1200.0)


def test_budget_monotonicity_time():
    short_reachable = _reached_edges(max_cost=8.0)
    long_reachable = _reached_edges(max_cost=15.0)

    assert long_reachable >= short_reachable


def test_speed_monotonicity_time():
    slow_reachable = _reached_edges(speed_km_h=4.0, max_cost=10.0)
    fast_reachable = _reached_edges(speed_km_h=6.0, max_cost=10.0)

    assert fast_reachable >= slow_reachable


def test_bicycle_vs_walking_reachability_smoke():
    walking_reachable = _reached_edges(mode=routing.RoutingMode.Walking, speed_km_h=5.0)
    bicycle_reachable = _reached_edges(
        mode=routing.RoutingMode.Bicycle, speed_km_h=15.0
    )

    assert bicycle_reachable >= walking_reachable


def test_validation_requires_starting_points():
    cfg = _make_config(starting_points=[])

    with pytest.raises(ValueError, match="starting point"):
        routing.compute_catchment(cfg)


def test_validation_requires_positive_max_cost():
    cfg = _make_config(max_cost=0.0)

    with pytest.raises(ValueError, match="max_cost"):
        routing.compute_catchment(cfg)


def test_validation_requires_edge_dir():
    cfg = _make_config(edge_dir="")

    with pytest.raises(ValueError, match="edge_dir"):
        routing.compute_catchment(cfg)


def test_runtime_error_for_disconnected_start_point():
    far_point_cfg = _make_config(starting_points=[routing.Point3857(0.0, 0.0)])

    with pytest.raises(RuntimeError, match="No edges loaded"):
        routing.compute_catchment(far_point_cfg)


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
    assert "step_cost" in first["properties"]


def test_geojson_network_step_costs_are_on_the_step_grid():
    # A network feature carries its step only, not the cost it was rounded
    # from: the rounding itself is checked on the hexagonal grid below.
    cfg = _make_config(catchment_type=routing.CatchmentType.Network, steps=8)
    payload = routing.compute_catchment(cfg)
    doc = json.loads(payload)

    assert len(doc["features"]) > 0
    step_size = cfg.max_cost / cfg.steps

    for feature in doc["features"]:
        _assert_on_step_grid(feature["properties"]["step_cost"], step_size, cfg.steps)


def test_geojson_hexagonal_grid_step_cost_bucket_is_correct():
    cfg = _make_config(catchment_type=routing.CatchmentType.HexagonalGrid, steps=8)
    payload = routing.compute_catchment(cfg)
    doc = json.loads(payload)

    assert len(doc["features"]) > 0
    step_size = cfg.max_cost / cfg.steps

    for feature in doc["features"]:
        props = feature["properties"]
        _assert_step_bucket(props["cost"], props["step_cost"], step_size)


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
