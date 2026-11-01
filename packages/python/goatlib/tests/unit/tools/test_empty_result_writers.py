"""The routing tools' own result writers, on a result without rows.

The routing engine is not needed for what is tested here: each writer gets
the table or file it would get after the engine ran, with no rows, and must
write a file whose geometry column is still a GEOMETRY, so the step after it
finds one (`goatlib.io.config.parquet_copy_options`).
"""

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import duckdb
import pytest
from goatlib.analysis.accessibility import CatchmentAreaToolV2
from goatlib.analysis.accessibility.trip_count import TripCountStationTool
from goatlib.analysis.schemas.catchment_area import StartingPointsLayer
from goatlib.analysis.schemas.catchment_area_v2 import CatchmentType, ShapeStyle
from goatlib.io.config import parquet_copy_options
from goatlib.tools.catchment_area import (
    CatchmentAreaRoutingMode,
    CatchmentAreaToolRunner,
)
from goatlib.tools.catchment_area_v2 import (
    CatchmentAreaV2ToolRunner,
    CatchmentAreaV2WindmillParams,
)
from goatlib.tools.travel_cost_matrix import TravelCostMatrixToolRunner
from goatlib.tools.trip_count import TripCountToolRunner

POINT = "ST_Point(11.5, 48.1)::GEOMETRY('OGC:CRS84')"
U = "00000000-0000-0000-0000-000000000001"
# A starting-points filter that matches none of the layer's points.
NO_POINT = {"op": "=", "args": [{"property": "name"}, "Stop B"]}


def _types(path: Path) -> dict[str, str]:
    con = duckdb.connect()
    try:
        con.execute("INSTALL spatial; LOAD spatial;")
        rows = con.execute(f"DESCRIBE SELECT * FROM read_parquet('{path}')").fetchall()
        count = con.execute(f"SELECT count(*) FROM read_parquet('{path}')").fetchone()
    finally:
        con.close()
    assert count == (0,)
    return {str(r[0]): str(r[1]) for r in rows}


def _write(path: Path, query: str) -> Path:
    """A file without rows, written as the step before writes its result."""
    con = duckdb.connect()
    try:
        con.execute("INSTALL spatial; LOAD spatial;")
        con.execute(f"COPY ({query}) TO '{path}' {parquet_copy_options()}")
    finally:
        con.close()
    return path


def test_trip_count_with_no_station_in_service(tmp_path: Path) -> None:
    tool = TripCountStationTool()
    try:
        tool.con.execute(f"""
            CREATE TABLE station_mode_counts AS
            SELECT 's1' AS stop_id, 'Halt' AS stop_name, NULL::VARCHAR AS parent_station,
                   0 AS bus, 0 AS tram, 0 AS metro, 0 AS rail, 0 AS other,
                   0 AS total, 0.0 AS frequency, {POINT} AS geom
        """)
        tool.con.execute("CREATE TABLE stations_in_area AS SELECT 's1' AS stop_id")
        out = tmp_path / "trips.parquet"
        tool._export_results(str(out))
    finally:
        tool.cleanup()
    types = _types(out)
    assert types["geom"].startswith("GEOMETRY")
    # The schema prediction holds the columns the run writes; it names the
    # geometry column `geometry`, as every prediction does.
    predicted = TripCountToolRunner.predict_output_schema({}, {})
    assert set(predicted) - {"geometry"} == set(types) - {"geom"}


def test_travel_cost_matrix_destinations_without_rows(tmp_path: Path) -> None:
    destinations = _write(
        tmp_path / "destinations.parquet",
        f"SELECT 1 AS id, {POINT} AS geometry WHERE false",
    )
    matrix = _write(
        tmp_path / "matrix.parquet",
        "SELECT 'a' AS origin, 'b' AS destination, 1 AS travel_cost WHERE false",
    )
    out = tmp_path / "out.parquet"
    TravelCostMatrixToolRunner()._build_destination_points_parquet(
        matrix, destinations, out
    )
    assert _types(out)["geometry"].startswith("GEOMETRY")


@pytest.mark.parametrize("shape_style", [ShapeStyle.combined, ShapeStyle.separated])
def test_catchment_area_bands_without_rows(
    tmp_path: Path, shape_style: ShapeStyle
) -> None:
    """Both ways the engine's origin index leaves the result: dropped for
    combined shapes, turned into an origin for separated ones."""
    engine_result = _write(
        tmp_path / "engine.parquet",
        f"SELECT 0 AS origin_idx, 300 AS travel_cost, {POINT} AS geometry WHERE false",
    )
    runner = CatchmentAreaV2ToolRunner()
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    runner._duckdb_con = con
    runner._starting_point_references = []
    try:
        out = runner._resolve_origins(engine_result, shape_style, tmp_path)
    finally:
        con.close()
        runner._duckdb_con = None
    assert out != engine_result
    assert _types(out)["geometry"].startswith("GEOMETRY")


def _empty_params(
    kind: CatchmentType, shape: ShapeStyle, mode: str = "walking"
) -> SimpleNamespace:
    """The runner's params as process reads them; only the fields the empty
    writer reads matter."""
    return SimpleNamespace(
        catchment_area_type=kind,
        shape_style=shape,
        routing_mode=CatchmentAreaRoutingMode(mode),
        reference_field=None,
    )


@pytest.mark.parametrize(
    ("kind", "shape", "mode", "columns"),
    [
        (
            CatchmentType.polygon,
            ShapeStyle.combined,
            "walking",
            {"id", "cost_step", "geometry"},
        ),
        (
            CatchmentType.polygon,
            ShapeStyle.separated,
            "walking",
            {"id", "cost_step", "geometry", "origin"},
        ),
        (
            CatchmentType.polygon,
            ShapeStyle.combined,
            "car",
            {"id", "cost_step", "geometry"},
        ),
        (
            CatchmentType.network,
            ShapeStyle.combined,
            "walking",
            {"id", "cost_step", "geometry"},
        ),
        (
            CatchmentType.hexagonal_grid,
            ShapeStyle.combined,
            "walking",
            {"id", "cost_step", "geometry"},
        ),
        (
            CatchmentType.point_grid,
            ShapeStyle.combined,
            "walking",
            {"id", "cost", "cost_step", "geometry"},
        ),
    ],
)
def test_catchment_without_start_points(
    tmp_path: Path,
    kind: CatchmentType,
    shape: ShapeStyle,
    mode: str,
    columns: set[str],
) -> None:
    runner = CatchmentAreaV2ToolRunner()
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    runner._duckdb_con = con
    runner._starting_point_references = None
    try:
        out, metadata = runner._write_empty_result(
            _empty_params(kind, shape, mode), tmp_path
        )
    finally:
        con.close()
        runner._duckdb_con = None
    types = _types(out)
    assert set(types) == columns
    assert types["geometry"].startswith("GEOMETRY")
    assert (metadata.path, metadata.geometry_type) == (str(out), "Polygon")
    # The schema prediction holds the columns the run writes.
    predicted = CatchmentAreaV2ToolRunner.predict_output_schema(
        {},
        {
            "catchment_area_type": kind.value,
            "shape_style": shape.value,
            "routing_mode": mode,
        },
    )
    assert set(predicted) == columns


def _read_points_layer(
    runner: CatchmentAreaToolRunner, monkeypatch: pytest.MonkeyPatch
) -> duckdb.DuckDBPyConnection:
    """The runner reads its starting-points layer from a table with one point,
    on its own connection, in place of the lake."""
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute(
        f"CREATE TABLE points AS SELECT 1 AS id, 'Stop A' AS name, {POINT} AS geometry"
    )
    runner._duckdb_con = con
    monkeypatch.setattr(runner, "get_layer_owner_id_sync", lambda layer_id: U)
    monkeypatch.setattr(runner, "resolve_layer_table_path", lambda layer_id: "points")
    return con


@pytest.mark.parametrize(
    ("shape", "reference_field", "origin_type"),
    [(ShapeStyle.separated, "name", "VARCHAR"), (ShapeStyle.combined, None, None)],
    ids=["one polygon per point", "one polygon for all"],
)
def test_an_empty_layer_finishes_without_routing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    shape: ShapeStyle,
    reference_field: str | None,
    origin_type: str | None,
) -> None:
    """The starting points' filter matches none: the result has no rows and
    the columns of a run with points, its origin in the reference field's
    type, and the router is not asked."""

    def route(*_: Any, **__: Any) -> None:
        raise AssertionError("the router was asked to route no starting point")

    monkeypatch.setattr(CatchmentAreaToolV2, "run", route)
    runner = CatchmentAreaV2ToolRunner()
    con = _read_points_layer(runner, monkeypatch)
    params = CatchmentAreaV2WindmillParams(
        user_id=U,
        folder_id=U,
        routing_mode="walking",
        starting_points={"layer_id": U, "layer_filter": NO_POINT},
        shape_style=shape,
        reference_field=reference_field,
    )
    try:
        out, metadata = runner.process(params, tmp_path)
    finally:
        con.close()
        runner._duckdb_con = None
    types = _types(out)
    assert types["geometry"].startswith("GEOMETRY")
    assert (metadata.path, metadata.geometry_type) == (str(out), "Polygon")
    assert types.get("origin") == origin_type
    assert set(types) - {"origin"} == {"id", "cost_step", "geometry"}
    # The schema prediction holds the same columns, the origin in the
    # reference field's type on the starting points layer.
    predicted = CatchmentAreaV2ToolRunner.predict_output_schema(
        {
            "starting_points": {
                "id": "INTEGER",
                "name": "VARCHAR",
                "geometry": "GEOMETRY",
            }
        },
        params.model_dump(mode="json"),
    )
    assert set(predicted) == set(types)
    assert predicted.get("origin") == origin_type


def test_separated_shapes_without_a_reference_field_number_their_points(
    tmp_path: Path,
) -> None:
    """Map clicks have no field to reference: the run numbers the points from
    1, and the schema prediction types the origin as that number."""
    engine_result = _write(
        tmp_path / "engine.parquet",
        "SELECT 0::INTEGER AS id, 0::INTEGER AS cost_step, "
        f"0::INTEGER AS origin_idx, {POINT} AS geometry",
    )
    runner = CatchmentAreaV2ToolRunner()
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    runner._duckdb_con = con
    runner._starting_point_references = None
    runner._starting_point_reference_type = None
    try:
        out = runner._resolve_origins(engine_result, ShapeStyle.separated, tmp_path)
        rows = con.execute(f"DESCRIBE SELECT * FROM read_parquet('{out}')").fetchall()
    finally:
        con.close()
        runner._duckdb_con = None
    written = {str(r[0]): str(r[1]) for r in rows}
    predicted = CatchmentAreaV2ToolRunner.predict_output_schema(
        {}, {"shape_style": "separated", "routing_mode": "walking"}
    )
    assert set(predicted) == set(written)
    assert predicted["origin"] == written["origin"]


def test_catchment_v1_still_refuses_an_empty_layer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner = CatchmentAreaToolRunner()
    con = _read_points_layer(runner, monkeypatch)
    params = SimpleNamespace(
        starting_points=StartingPointsLayer(layer_id=U, layer_filter=NO_POINT),
        user_id=U,
        routing_mode=CatchmentAreaRoutingMode.walking,
    )
    try:
        with pytest.raises(ValueError) as refused:
            runner.process(params, tmp_path)
    finally:
        con.close()
        runner._duckdb_con = None
    assert str(refused.value) == (
        "No valid geometries found in the starting points layer"
    )
