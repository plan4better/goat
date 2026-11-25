"""Polygon, network, hexagon and point grid catchments of the same request
reach the same streets in each band.

They draw different things: lines follow the streets, the polygon also covers
the ground a short walk off them, a hexagon is a whole H3 cell around its
cheapest point, and a grid point takes the cost of the nearest street point
plus the walk to it. What they must share is where each band ends along the
streets. The polygon is contoured from a grid, so its edge may sit up to about
a grid cell off; anything further is a bug in one of them.

Geometry is compared in EPSG:3857 with shapely; grid points are written with
pyarrow, not Python's duckdb (see test_snapping.py).
"""

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

# The street network where the tools read it, as test_catchment.py reads it
# (test modules load in isolation, so the setup is repeated, not imported).
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

shapely = pytest.importorskip("shapely")
pa = pytest.importorskip("pyarrow")
pq = pytest.importorskip("pyarrow.parquet")
from shapely.geometry import shape  # noqa: E402
from shapely.ops import transform, unary_union  # noqa: E402

R = 6378137.0
# The polygon grid's cell size (EPSG:3857 units) by zoom: 13 walking, 11 else.
CELL = {13: 19.109, 11: 76.437}
# Walking reach: the polygon's smallest snap radius (200 EPSG:3857 units) in
# ground metres at Marienplatz, for the point grid to match it.
WALK_SNAP_GROUND_M = 200.0 / math.cosh(MARIENPLATZ_3857[1] / R)


def _to_3857(lon, lat, *_):
    return (
        math.radians(lon) * R,
        math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * R,
    )


def _make_config(**overrides):
    cfg = routing.RequestConfig()
    cfg.starting_points = [routing.Point3857(*MARIENPLATZ_3857)]
    cfg.mode = routing.RoutingMode.Walking
    cfg.cost_type = routing.CostType.Time
    cfg.speed_km_h = 5.0
    cfg.edge_dir = str(EDGE_DIR)
    cfg.node_dir = str(NODE_DIR)
    cfg.output_format = routing.OutputFormat.GeoJSON
    cfg.polygon_difference = False
    for key, value in overrides.items():
        setattr(cfg, key, value)
    return cfg


def _features(cfg):
    doc = json.loads(routing.compute_catchment(cfg))
    return [
        (f["properties"]["step_cost"], transform(_to_3857, shape(f["geometry"])))
        for f in doc["features"]
    ]


def _cases():
    if routing is None:
        return []
    return [
        pytest.param(
            dict(mode=routing.RoutingMode.Walking, max_cost=10.0, steps=2),
            CELL[13],
            id="walking-time",
        ),
        pytest.param(
            dict(
                mode=routing.RoutingMode.Walking,
                cost_type=routing.CostType.Distance,
                max_cost=800.0,
                steps=2,
            ),
            CELL[13],
            id="walking-distance",
        ),
        pytest.param(
            dict(
                mode=routing.RoutingMode.Bicycle, max_cost=6.0, steps=2, speed_km_h=15.0
            ),
            CELL[11],
            id="bicycle-time",
        ),
    ]


@pytest.fixture
def grid_points(tmp_path):
    """A 40 m lattice over 2 km around Marienplatz."""
    x0, y0 = MARIENPLATZ_3857
    xs, ys, ids = [], [], []
    n = 0
    for i in range(-50, 51):
        for j in range(-50, 51):
            ids.append(n)
            xs.append(x0 + 40.0 * i)
            ys.append(y0 + 40.0 * j)
            n += 1
    path = tmp_path / "grid.parquet"
    pq.write_table(pa.table({"id": ids, "x_3857": xs, "y_3857": ys}), path)
    return path


@pytest.mark.parametrize("overrides,cell", _cases())
def test_outputs_agree_band_by_band(overrides, cell, grid_points):
    def run(kind, **extra):
        cfg = _make_config(catchment_type=kind, **overrides, **extra)
        return _features(cfg)

    polygon = run(routing.CatchmentType.Polygon)
    lines = run(routing.CatchmentType.Network)
    hexagons = run(routing.CatchmentType.HexagonalGrid)
    points = run(
        routing.CatchmentType.PointGrid,
        grid_points_path=str(grid_points),
        # The point grid reaches as far off the street as the polygon.
        grid_snap_distance=WALK_SNAP_GROUND_M
        if overrides["mode"] == routing.RoutingMode.Walking
        else 8 * cell / math.cosh(MARIENPLATZ_3857[1] / R),
    )
    # Up to about a grid cell, either way.
    tolerance = 2 * cell

    bands = sorted({step for step, _ in polygon})
    assert len(bands) == overrides["steps"]
    for band in bands:
        area = unary_union([g for s, g in polygon if s == band])
        streets = unary_union([g for s, g in lines if s <= band + 1e-9])
        cells = [g for s, g in hexagons if s <= band + 1e-9]
        reached = [g for s, g in points if s <= band + 1e-9]
        not_reached = [g for s, g in points if s > band + 1e-9]

        outside = streets.difference(area.buffer(tolerance))
        assert outside.length == pytest.approx(
            0.0, abs=1e-6
        ), f"band {band}: {outside.length:.0f} m of street outside the polygon"
        assert all(
            c.intersects(streets) for c in cells
        ), f"band {band}: a hexagon without a street of its band"
        assert all(
            c.intersects(area) for c in cells
        ), f"band {band}: a hexagon off the polygon"
        assert all(
            area.buffer(tolerance).contains(p) for p in reached
        ), f"band {band}: a grid point of the band outside the polygon"
        inner = area.buffer(-tolerance)
        assert not any(
            inner.contains(p) for p in not_reached
        ), f"band {band}: a grid point of a later band well inside the polygon"


def test_the_start_point_is_in_the_first_band():
    """Cost 0 belongs to the first band, as every other cost up to it does:
    there is no band 0."""
    for kind in (routing.CatchmentType.Network, routing.CatchmentType.HexagonalGrid):
        cfg = _make_config(catchment_type=kind, max_cost=10.0, steps=2)
        steps = {s for s, _ in _features(cfg)}
        assert steps <= {5.0, 10.0}, (kind, steps)
