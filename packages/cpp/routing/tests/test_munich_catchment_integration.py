"""Integration tests for the C++ routing engine using Munich parquet data.

These tests exercise the pybind11 bindings for compute_catchment() against
Munich's street network as goatlib.tasks.sync_base_data installs it (H3
res-3 cell 8077), read where the tools read it. They validate:
  - Basic catchment computation for all routing modes
  - Time and distance cost modes
  - Budget monotonicity (more time → more reached street edges)
  - Speed monotonicity (faster speed → more reached street edges)
  - Relative reachability across modes (bicycle > walking, car > bicycle)
  - All output type variants, and the parquet output's columns
  - Polygon difference mode
  - Gravity heatmap scores against their decay formulas
  - Input validation error handling
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path

import pytest

try:
    import routing
except Exception as exc:
    routing = None
    ROUTING_IMPORT_ERROR = exc
else:
    ROUTING_IMPORT_ERROR = None

# The street network where the tools read it: the tools' two settings, else
# where goatlib.tasks.sync_base_data installs it under DATA_DIR.
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

# Marienplatz, Munich in EPSG:3857
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
    pytest.mark.integration,
]


def _make_config(**overrides):
    """Build a RequestConfig for Marienplatz with sensible defaults."""
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
    """The features of a catchment's GeoJSON output."""
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
    """Assert that the catchment reaches something, at costs within its budget."""
    assert len(costs) > 0, "the catchment should reach at least one cell"
    assert all(0 <= c <= budget for c in costs), "costs must lie within the budget"


def _assert_step_bucket(cost: float, step_cost: float, step_size: float) -> None:
    expected = math.ceil(cost / step_size) * step_size
    assert step_cost >= cost
    assert math.isclose(step_cost, expected, rel_tol=1e-9, abs_tol=1e-9)


def _assert_on_step_grid(step_cost: float, step_size: float, steps: int) -> None:
    step = step_cost / step_size
    assert math.isclose(step, round(step), rel_tol=0, abs_tol=1e-9)
    assert 0 <= round(step) <= steps


def _pyarrow():
    """pyarrow and pyarrow.parquet. CI installs them, so there a missing one
    fails the test instead of skipping it."""
    if os.getenv("CI"):
        import pyarrow as pa
        import pyarrow.parquet as pq

        return pa, pq
    return pytest.importorskip("pyarrow"), pytest.importorskip("pyarrow.parquet")


def _write_grid_points(path, half_width_m):
    """Points every 100 m in a square around Marienplatz, in the columns the
    PointGrid output reads (id, x_3857, y_3857)."""
    pa, pq = _pyarrow()
    x0, y0 = MARIENPLATZ_3857
    offsets = range(-half_width_m, half_width_m + 1, 100)
    points = [(x0 + dx, y0 + dy) for dx in offsets for dy in offsets]
    pq.write_table(
        pa.table(
            {
                "id": pa.array(range(len(points)), pa.int64()),
                "x_3857": [x for x, _ in points],
                "y_3857": [y for _, y in points],
            }
        ),
        path,
    )
    return path


# ── Smoke tests ──────────────────────────────────────────────────────────


class TestSmoke:
    """Basic smoke tests: each mode produces a valid catchment."""

    def test_walking(self):
        costs = _cell_costs(mode=routing.RoutingMode.Walking, max_cost=10.0)
        _assert_costs_valid(costs, 10.0)

    def test_bicycle(self):
        costs = _cell_costs(
            mode=routing.RoutingMode.Bicycle, speed_km_h=15.0, max_cost=10.0
        )
        _assert_costs_valid(costs, 10.0)

    def test_pedelec(self):
        costs = _cell_costs(
            mode=routing.RoutingMode.Pedelec, speed_km_h=20.0, max_cost=10.0
        )
        _assert_costs_valid(costs, 10.0)

    def test_car(self):
        costs = _cell_costs(
            mode=routing.RoutingMode.Car, speed_km_h=30.0, max_cost=10.0
        )
        _assert_costs_valid(costs, 10.0)

    def test_origin_has_zero_cost(self):
        """The starting point should have cost ~0."""
        costs = _cell_costs(max_cost=10.0)
        assert min(costs) < 0.01


# ── Cost mode tests ─────────────────────────────────────────────────────


class TestCostModes:
    """Test time vs. distance cost modes."""

    def test_distance_mode_produces_results(self):
        costs = _cell_costs(cost_type=routing.CostType.Distance, max_cost=1200.0)
        _assert_costs_valid(costs, 1200.0)

    def test_time_mode_produces_results(self):
        costs = _cell_costs(cost_type=routing.CostType.Time, max_cost=10.0)
        _assert_costs_valid(costs, 10.0)


# ── Monotonicity tests ──────────────────────────────────────────────────


class TestMonotonicity:
    """Increasing budget or speed should reach more street edges."""

    def test_time_budget_monotonicity(self):
        short = _reached_edges(max_cost=5.0)
        long = _reached_edges(max_cost=15.0)
        assert long > short

    def test_speed_monotonicity(self):
        slow = _reached_edges(speed_km_h=3.0)
        fast = _reached_edges(speed_km_h=7.0)
        assert fast >= slow

    def test_distance_budget_monotonicity(self):
        short = _reached_edges(cost_type=routing.CostType.Distance, max_cost=500.0)
        long = _reached_edges(cost_type=routing.CostType.Distance, max_cost=2000.0)
        assert long > short


# ── Mode comparison tests ───────────────────────────────────────────────


class TestModeComparison:
    """Compare reachability across transport modes."""

    def test_bicycle_reaches_more_than_walking(self):
        walk = _reached_edges(mode=routing.RoutingMode.Walking, speed_km_h=5.0)
        bike = _reached_edges(mode=routing.RoutingMode.Bicycle, speed_km_h=15.0)
        assert bike > walk

    def test_car_reaches_more_than_bicycle(self):
        bike = _reached_edges(mode=routing.RoutingMode.Bicycle, speed_km_h=15.0)
        car = _reached_edges(mode=routing.RoutingMode.Car, speed_km_h=50.0)
        assert car > bike


# ── Output type tests ───────────────────────────────────────────────────


class TestOutputTypes:
    """All OutputType variants should produce valid results."""

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
    def test_output_type_reaches_within_budget(self, catchment_type):
        cfg = _make_config(catchment_type=catchment_type)
        features = _features(cfg)
        assert len(features) > 0
        for feature in features:
            assert 0 <= feature["properties"]["step_cost"] <= cfg.max_cost

    def test_polygon_difference_mode(self):
        cfg = _make_config(
            catchment_type=routing.CatchmentType.Polygon, polygon_difference=True
        )
        features = _features(cfg)
        assert len(features) > 0
        for feature in features:
            assert feature["geometry"]["type"] in ("Polygon", "MultiPolygon")
            assert 0 < feature["properties"]["step_cost"] <= cfg.max_cost
        # Difference mode cuts each step's polygon by the one below it, so its
        # geometries are not the cumulative polygons of the same request.
        cumulative = _features(
            _make_config(
                catchment_type=routing.CatchmentType.Polygon, polygon_difference=False
            )
        )
        assert [f["geometry"] for f in features] != [f["geometry"] for f in cumulative]

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
    def test_geojson_api_returns_feature_collection(self, catchment_type):
        cfg = _make_config(catchment_type=catchment_type)
        payload = routing.compute_catchment(cfg)

        doc = json.loads(payload)
        assert doc["type"] == "FeatureCollection"
        assert isinstance(doc["features"], list)

    def test_geojson_network_contains_linestrings(self):
        cfg = _make_config(catchment_type=routing.CatchmentType.Network)
        payload = routing.compute_catchment(cfg)
        doc = json.loads(payload)

        assert len(doc["features"]) > 0
        first = doc["features"][0]
        assert first["type"] == "Feature"
        assert first["geometry"]["type"] == "LineString"
        assert "step_cost" in first["properties"]

    def test_geojson_network_coordinates_are_wgs84(self):
        cfg = _make_config(catchment_type=routing.CatchmentType.Network)
        payload = routing.compute_catchment(cfg)
        doc = json.loads(payload)

        assert len(doc["features"]) > 0
        first = doc["features"][0]
        coords = first["geometry"]["coordinates"]
        assert len(coords) >= 2

        for lon, lat in coords[:10]:
            assert -180.0 <= lon <= 180.0
            assert -90.0 <= lat <= 90.0

    def test_geojson_network_feature_properties_are_numeric(self):
        cfg = _make_config(catchment_type=routing.CatchmentType.Network)
        payload = routing.compute_catchment(cfg)
        doc = json.loads(payload)

        assert len(doc["features"]) > 0
        for feature in doc["features"]:
            assert isinstance(feature["properties"]["step_cost"], (int, float))

    def test_geojson_network_step_costs_are_on_the_step_grid(self):
        # A network feature carries its step only, not the cost it was rounded
        # from: the rounding itself is checked on the hexagonal grid below.
        cfg = _make_config(catchment_type=routing.CatchmentType.Network, steps=6)
        payload = routing.compute_catchment(cfg)
        doc = json.loads(payload)

        assert len(doc["features"]) > 0
        step_size = cfg.max_cost / cfg.steps
        for feature in doc["features"]:
            _assert_on_step_grid(
                feature["properties"]["step_cost"], step_size, cfg.steps
            )

    def test_geojson_hexagonal_grid_step_cost_bucket_is_correct(self):
        cfg = _make_config(catchment_type=routing.CatchmentType.HexagonalGrid, steps=6)
        payload = routing.compute_catchment(cfg)
        doc = json.loads(payload)

        assert len(doc["features"]) > 0
        step_size = cfg.max_cost / cfg.steps
        for feature in doc["features"]:
            props = feature["properties"]
            _assert_step_bucket(props["cost"], props["step_cost"], step_size)

    def test_network_parquet_carries_id_and_cost_step(self, tmp_path):
        """The parquet output, the catchment tool's default, numbers the edges
        the GeoJSON output holds and gives each its step in whole cost units."""
        pa, pq = _pyarrow()
        geojson = _features(_make_config(catchment_type=routing.CatchmentType.Network))
        cfg = _make_config(
            catchment_type=routing.CatchmentType.Network,
            output_format=routing.OutputFormat.Parquet,
            output_path=str(tmp_path / "network.parquet"),
        )
        routing.compute_catchment(cfg)

        table = pq.read_table(cfg.output_path, columns=["id", "cost_step"])
        assert pa.types.is_integer(table.schema.field("id").type)
        assert pa.types.is_integer(table.schema.field("cost_step").type)
        assert sorted(table.column("id").to_pylist()) == list(
            range(1, len(geojson) + 1)
        )
        # One step per cost unit here (max_cost 10, 10 steps), so rounding the
        # GeoJSON's steps gives the parquet's exactly.
        assert sorted(table.column("cost_step").to_pylist()) == sorted(
            round(feature["properties"]["step_cost"]) for feature in geojson
        )

    def test_geojson_hexagonal_grid_contains_h3_points(self):
        cfg = _make_config(catchment_type=routing.CatchmentType.HexagonalGrid)
        payload = routing.compute_catchment(cfg)
        doc = json.loads(payload)

        assert len(doc["features"]) > 0
        first = doc["features"][0]
        assert first["geometry"]["type"] == "Polygon"
        ring = first["geometry"]["coordinates"][0]
        assert isinstance(ring, list)
        assert len(ring) >= 6
        props = first["properties"]
        assert "h3" in props
        assert "resolution" in props
        assert "cost" in props
        assert "step_cost" in props

    def test_geojson_point_grid_matches_its_parquet(self, tmp_path):
        """The PointGrid GeoJSON output carries each grid point's id, cost and
        step, the step as `step_cost` like the other GeoJSON outputs: the same
        rows its parquet output carries, with the step there as `cost_step`."""
        _, pq = _pyarrow()
        grid_path = _write_grid_points(tmp_path / "grid_points.parquet", 400)

        def config(**overrides):
            return _make_config(
                catchment_type=routing.CatchmentType.PointGrid,
                grid_points_path=str(grid_path),
                **overrides,
            )

        features = _features(config())
        cfg = config(
            output_format=routing.OutputFormat.Parquet,
            output_path=str(tmp_path / "point_grid.parquet"),
        )
        routing.compute_catchment(cfg)
        rows = pq.read_table(cfg.output_path, columns=["id", "cost", "cost_step"])

        assert len(features) > 0
        for feature in features:
            assert feature["geometry"]["type"] == "Point"
            assert 0 <= feature["properties"]["step_cost"] <= cfg.max_cost
        assert sorted(
            (
                f["properties"]["id"],
                f["properties"]["cost"],
                f["properties"]["step_cost"],
            )
            for f in features
        ) == sorted((r["id"], r["cost"], r["cost_step"]) for r in rows.to_pylist())

    def test_point_grid_cost_step_follows_its_steps(self, tmp_path):
        """The PointGrid output rounds each point's cost to a whole number, so
        costs land on step boundaries: in 12 steps of a 10 minute budget, 5
        minutes is exactly 6 steps, and the grid reaches it. Each `cost_step`
        is the cost rounded up to the next step, then cast to a whole number
        as DuckDB casts a DOUBLE (halves to even, as Python's round does), and
        never above the budget."""
        _, pq = _pyarrow()
        grid_path = _write_grid_points(tmp_path / "grid_points.parquet", 600)
        cfg = _make_config(
            catchment_type=routing.CatchmentType.PointGrid,
            steps=12,
            grid_points_path=str(grid_path),
            output_format=routing.OutputFormat.Parquet,
            output_path=str(tmp_path / "point_grid.parquet"),
        )
        routing.compute_catchment(cfg)
        rows = pq.read_table(cfg.output_path, columns=["cost", "cost_step"]).to_pylist()

        assert 5.0 in {row["cost"] for row in rows}
        step_size = cfg.max_cost / cfg.steps
        for row in rows:
            expected = round(math.ceil(row["cost"] / step_size) * step_size)
            assert row["cost_step"] == expected, row
            assert row["cost_step"] <= cfg.max_cost

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
    def test_geojson_hexagonal_grid_resolution_depends_on_mode(
        self, mode, expected_resolution
    ):
        cfg = _make_config(
            catchment_type=routing.CatchmentType.HexagonalGrid, mode=mode
        )
        payload = routing.compute_catchment(cfg)
        doc = json.loads(payload)

        assert len(doc["features"]) > 0
        assert doc["features"][0]["properties"]["resolution"] == expected_resolution


# ── Heatmap tests ───────────────────────────────────────────────────────


def _heatmap_scores(tmp_path, heatmap_type, decay=None):
    """The config and score per H3 cell of a walking heatmap with one
    opportunity at Marienplatz, at the router's default sensitivities."""
    _, pq = _pyarrow()
    point = routing.Point3857(*MARIENPLATZ_3857)
    cfg = routing.HeatmapConfig()
    cfg.mode = routing.RoutingMode.Walking
    cfg.cost_type = routing.CostType.Time
    cfg.max_cost = 15.0
    cfg.speed_km_h = 5.0
    cfg.edge_dir = str(EDGE_DIR)
    cfg.node_dir = str(NODE_DIR)
    cfg.opportunities = [routing.Opportunity([point], 1.0, point)]
    cfg.heatmap_type = getattr(routing.HeatmapType, heatmap_type)
    if decay is not None:
        cfg.decay = getattr(routing.GravityDecay, decay)
    cfg.sensitivity = 300000.0
    cfg.max_sensitivity = 1000000.0
    cfg.closest_k = 1
    cfg.output_path = str(tmp_path / f"{heatmap_type}_{decay}.parquet")
    routing.compute_heatmap(cfg)
    rows = pq.read_table(cfg.output_path, columns=["h3_index", "score"]).to_pylist()
    return cfg, {row["h3_index"]: row["score"] for row in rows}


class TestHeatmap:
    """Gravity scores follow their decay formulas."""

    @pytest.mark.parametrize("decay", ["Gaussian", "Exponential", "Power"])
    def test_gravity_score_follows_its_decay(self, tmp_path, decay):
        # With one opportunity, ClosestAverage at k = 1 reports each cell's
        # cost to it: the cost the gravity decay weighs.
        _, costs = _heatmap_scores(tmp_path, "ClosestAverage")
        cfg, scores = _heatmap_scores(tmp_path, "Gravity", decay)
        ratio = cfg.max_sensitivity / max(cfg.sensitivity, 1.0)
        decays = {
            "Gaussian": lambda x: math.exp(-1.0 * x**2 * ratio),
            "Exponential": lambda x: math.exp(-1.0 * (1.0 / ratio) * x),
            "Power": lambda x: max(x, 1e-9) ** (-1.0 * (1.0 / ratio)),
        }

        assert len(scores) > 0
        assert scores.keys() == costs.keys()
        for cell, cost in costs.items():
            expected = decays[decay](cost / cfg.max_cost)
            assert math.isclose(scores[cell], expected, rel_tol=1e-12), (cell, cost)


# ── Validation tests ────────────────────────────────────────────────────


class TestValidation:
    """Input validation should reject invalid configs."""

    def test_empty_starting_points_raises(self):
        cfg = _make_config(starting_points=[])
        with pytest.raises((ValueError, RuntimeError)):
            routing.compute_catchment(cfg)

    def test_zero_traveltime_raises(self):
        cfg = _make_config(max_cost=0.0)
        with pytest.raises((ValueError, RuntimeError)):
            routing.compute_catchment(cfg)

    def test_empty_edge_dir_raises(self):
        cfg = _make_config(edge_dir="")
        with pytest.raises((ValueError, RuntimeError)):
            routing.compute_catchment(cfg)

    def test_far_start_point_snaps_to_network(self):
        """A far point outside cached H3 coverage should fail with no loaded edges."""
        far_point = routing.Point3857(0.0, 0.0)
        cfg = _make_config(starting_points=[far_point])
        with pytest.raises(RuntimeError, match="No edges loaded"):
            routing.compute_catchment(cfg)
