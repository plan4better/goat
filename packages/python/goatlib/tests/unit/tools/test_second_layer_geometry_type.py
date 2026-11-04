"""Every layer a tool saves without rows keeps the geometry type of its kind.

Tools with a `run()` of their own save a second layer beside their result
when they run outside a workflow: origin-destination points, ÖV-Güteklassen
stations, a travel cost matrix's destinations, catchment starting points and
the clustering summary. A layer's type comes from its rows' geometries, so a
second layer without rows takes the type the metadata of that layer names
(`_fill_second_layer_geometry_type`), never the first layer's
`output_geometry_type`.

Each test runs the tool's own `run()` with the analysis replaced by empty
files (origin-destination runs its real analysis on a matrix that names no
zone) and records the table info each layer record is made from.
"""

from pathlib import Path
from typing import Any

import duckdb
import pytest
from goatlib.io.config import parquet_copy_options
from goatlib.models.io import DatasetMetadata
from goatlib.tools.base import BaseToolRunner
from goatlib.tools.catchment_area_v2 import (
    CatchmentAreaV2ToolRunner,
    CatchmentAreaV2WindmillParams,
)
from goatlib.tools.oev_gueteklassen import (
    OevGueteklassenToolParams,
    OevGueteklassenToolRunner,
)
from goatlib.tools.origin_destination import (
    OriginDestinationToolParams,
    OriginDestinationToolRunner,
)
from goatlib.tools.spatial_clustering import (
    ClusteringZonesToolParams,
    ZonesClusteringToolRunner,
)
from goatlib.tools.travel_cost_matrix import (
    TravelCostMatrixToolRunner,
    TravelCostMatrixWindmillParams,
)

pytestmark = pytest.mark.usefixtures("runner_event_loop")

U = "00000000-0000-0000-0000-000000000001"
_GEOMETRY = "::GEOMETRY('OGC:CRS84')"


async def _nothing(*_: Any, **__: Any) -> None:
    return None


def _write(path: Path, select: str) -> Path:
    """`select` written the way the analyses write their results."""
    with duckdb.connect() as con:
        con.execute("INSTALL spatial; LOAD spatial;")
        con.execute(f"COPY ({select}) TO '{path}' {parquet_copy_options()}")
    return path


def _empty_points(path: Path) -> Path:
    return _write(
        path, f"SELECT 1 AS id, ST_Point(11.5, 48.1){_GEOMETRY} AS geometry WHERE false"
    )


def _ingested(**kwargs: Any) -> dict[str, Any]:
    """What `_ingest_to_ducklake` reports for the file: its geometry column,
    and the geometry type its rows give, none without rows."""
    path = kwargs["parquet_path"]
    with duckdb.connect() as con:
        con.execute("INSTALL spatial; LOAD spatial;")
        columns = con.execute(
            f"DESCRIBE SELECT * FROM read_parquet('{path}')"
        ).fetchall()
        geometry = next(
            (str(c[0]) for c in columns if str(c[1]).startswith("GEOMETRY")), None
        )
        count = con.execute(f"SELECT count(*) FROM read_parquet('{path}')").fetchone()
        first = (
            con.execute(
                f'SELECT ST_GeometryType("{geometry}") '
                f"FROM read_parquet('{path}') LIMIT 1"
            ).fetchone()
            if geometry
            else None
        )
    return {
        "table_name": f"lake.user_1.t_{kwargs['layer_id'].replace('-', '')}",
        "geometry_column": geometry,
        "geometry_type": str(first[0]) if first else None,
        "feature_count": count[0] if count else 0,
        "extent": None,
    }


def _record_layers(
    runner: BaseToolRunner, monkeypatch: pytest.MonkeyPatch
) -> dict[str, dict[str, Any]]:
    """Stands the database in for `runner`; returns the table info each
    layer record is made from, by layer name, filled as the run goes."""
    saved: dict[str, dict[str, Any]] = {}

    async def create_db_records(**kwargs: Any) -> dict[str, Any]:
        saved[kwargs["output_name"]] = dict(kwargs["table_info"])
        return {"folder_id": U, "layer_project_id": None}

    def no_tiles(**_: Any) -> None:
        pytest.fail("A layer without rows gets no tiles.")

    monkeypatch.setattr(runner, "_init_db_service", _nothing)
    monkeypatch.setattr(runner, "_close_db_service", _nothing)
    monkeypatch.setattr(runner, "_ingest_to_ducklake", _ingested)
    monkeypatch.setattr(runner, "_generate_pmtiles", no_tiles)
    monkeypatch.setattr(runner, "_create_db_records", create_db_records)
    return saved


def test_an_empty_origin_destination_run_saves_lines_and_points(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The analysis runs on a matrix whose rows name no zone of the layer, so
    neither output has rows; the lines are a line layer and the points a
    point layer."""
    zones = _write(
        tmp_path / "zones.parquet",
        f"SELECT 'a' AS zone, ST_Point(11.5, 48.1){_GEOMETRY} AS geometry "
        f"UNION ALL SELECT 'b', ST_Point(11.6, 48.2){_GEOMETRY}",
    )
    matrix = _write(
        tmp_path / "matrix.parquet",
        "SELECT 'x' AS origin, 'y' AS destination, 3 AS weight",
    )
    runner = OriginDestinationToolRunner()
    saved = _record_layers(runner, monkeypatch)
    monkeypatch.setattr(
        runner,
        "export_layer_to_parquet",
        lambda layer_id, user_id, cql_filter=None: str(
            {"zones": zones, "matrix": matrix}[layer_id]
        ),
    )
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    runner._duckdb_con = con
    params = OriginDestinationToolParams(
        user_id=U,
        folder_id=U,
        geometry_layer_id="zones",
        matrix_layer_id="matrix",
        unique_id_column="zone",
        origin_column="origin",
        destination_column="destination",
        weight_column="weight",
        lines_layer_name="Lines",
        points_layer_name="Points",
    )
    try:
        result = runner.run(params)
    finally:
        con.close()
        runner._duckdb_con = None

    assert (saved["Lines"]["geometry_type"], saved["Lines"]["feature_count"]) == (
        "LINESTRING",
        0,
    )
    assert (saved["Points"]["geometry_type"], saved["Points"]["feature_count"]) == (
        "POINT",
        0,
    )
    assert result["geometry_type"] == "LINESTRING"
    points = result["secondary_layers"][0]
    assert (points["type"], points["geometry_type"]) == ("feature", "POINT")


def test_an_empty_oev_gueteklassen_run_saves_its_stations_as_points(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A reference area without stations: no classes and no stations."""
    classes = _write(
        tmp_path / "classes.parquet",
        "SELECT 'A' AS pt_class, "
        f"ST_MakeEnvelope(11.5, 48.1, 11.6, 48.2){_GEOMETRY} AS geometry WHERE false",
    )
    stations = _empty_points(tmp_path / "stations.parquet")
    runner = OevGueteklassenToolRunner()
    saved = _record_layers(runner, monkeypatch)

    def process(params: Any, temp_dir: Path) -> tuple[Path, DatasetMetadata]:
        runner._stations_parquet = stations
        return classes, DatasetMetadata(path=str(classes), source_type="vector")

    monkeypatch.setattr(runner, "process", process)
    params = OevGueteklassenToolParams(
        user_id=U,
        folder_id=U,
        reference_area_layer_id=U,
        result_layer_name="Classes",
        stations_layer_name="Stations",
    )
    result = runner.run(params)

    assert saved["Classes"]["geometry_type"] == "POLYGON"
    assert saved["Stations"]["geometry_type"] == "POINT"
    assert result["stations_layer"]["geometry_type"] == "POINT"


def test_an_empty_destination_layer_is_saved_as_points_beside_the_matrix(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The matrix is a table and stays one; its destinations are points."""
    matrix = _write(
        tmp_path / "matrix.parquet",
        "SELECT 'a' AS origin, 'b' AS destination, 3 AS travel_cost WHERE false",
    )
    destinations = _empty_points(tmp_path / "destinations.parquet")
    runner = TravelCostMatrixToolRunner()
    saved = _record_layers(runner, monkeypatch)

    def process(params: Any, temp_dir: Path) -> tuple[Path, DatasetMetadata]:
        runner._destinations_path = destinations
        return matrix, DatasetMetadata(
            path=str(matrix), source_type="tabular", format="parquet"
        )

    monkeypatch.setattr(runner, "process", process)
    params = TravelCostMatrixWindmillParams(
        user_id=U,
        folder_id=U,
        origin_layer_id=U,
        destination_layer_id=U,
        origin_id_column="id",
        destination_id_column="id",
        routing_mode="walking",
        matrix_layer_name="Matrix",
        destinations_layer_name="Destinations",
    )
    result = runner.run(params)

    assert saved["Matrix"]["geometry_type"] is None
    assert saved["Destinations"]["geometry_type"] == "POINT"
    assert result["secondary_layers"][0]["geometry_type"] == "POINT"


def test_starting_points_without_rows_are_saved_as_points(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The first layer of a network catchment is lines; its starting points
    stay points."""
    bands = _write(
        tmp_path / "bands.parquet",
        "SELECT 300 AS travel_cost, "
        f"ST_Point(11.5, 48.1){_GEOMETRY} AS geometry WHERE false",
    )
    starting_points = _empty_points(tmp_path / "starting_points.parquet")
    runner = CatchmentAreaV2ToolRunner()
    saved = _record_layers(runner, monkeypatch)
    monkeypatch.setattr(runner, "get_layer_properties", lambda *a, **k: None)

    def process(params: Any, temp_dir: Path) -> tuple[Path, DatasetMetadata]:
        runner._starting_points_parquet = starting_points
        return bands, DatasetMetadata(
            path=str(bands), source_type="vector", geometry_type="Polygon"
        )

    monkeypatch.setattr(runner, "process", process)
    params = CatchmentAreaV2WindmillParams(
        user_id=U,
        folder_id=U,
        routing_mode="walking",
        starting_points={"latitude": [48.137], "longitude": [11.576]},
        catchment_area_type="network",
        result_layer_name="Catchment",
        starting_points_layer_name="Starting points",
    )
    result = runner.run(params)

    assert saved["Catchment"]["geometry_type"] == "LINESTRING"
    assert saved["Starting points"]["geometry_type"] == "POINT"
    assert result["starting_points_layer"]["geometry_type"] == "POINT"


def test_a_clustering_summary_without_rows_is_saved_as_points(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The summary's metadata names its multipoints."""
    points = _empty_points(tmp_path / "points.parquet")
    summary = _write(
        tmp_path / "summary.parquet",
        "SELECT 1 AS cluster_id, "
        f"ST_Collect([ST_Point(11.5, 48.1)]){_GEOMETRY} AS geometry WHERE false",
    )
    runner = ZonesClusteringToolRunner()
    saved = _record_layers(runner, monkeypatch)
    monkeypatch.setattr(runner, "get_layer_properties", lambda *a, **k: None)
    monkeypatch.setattr(runner, "_get_summary_style", lambda *a, **k: None)

    def process(params: Any, temp_dir: Path) -> tuple[Path, DatasetMetadata]:
        runner._summary_result = (
            summary,
            DatasetMetadata(
                path=str(summary), source_type="vector", geometry_type="MultiPoint"
            ),
        )
        return points, DatasetMetadata(
            path=str(points), source_type="vector", geometry_type="Point"
        )

    monkeypatch.setattr(runner, "process", process)
    params = ClusteringZonesToolParams(
        user_id=U,
        folder_id=U,
        input_layer_id=U,
        result_layer_name="Clustered",
        summary_layer_name="Summary",
    )
    result = runner.run(params)

    assert saved["Summary"]["geometry_type"] == "POINT"
    assert result["secondary_layers"][0]["geometry_type"] == "POINT"


def test_a_second_layer_whose_metadata_names_no_type_stays_a_table() -> None:
    """The runner's `output_geometry_type` describes its first layer, so a
    second layer whose metadata names no type is not given that one."""
    runner = OriginDestinationToolRunner()
    table_info: dict[str, Any] = {"geometry_column": "geometry", "geometry_type": None}
    runner._fill_second_layer_geometry_type(
        table_info, DatasetMetadata(path="points.parquet", source_type="vector")
    )
    assert table_info["geometry_type"] is None


def test_a_second_layer_with_rows_keeps_the_type_its_rows_give() -> None:
    runner = OriginDestinationToolRunner()
    table_info: dict[str, Any] = {
        "geometry_column": "geometry",
        "geometry_type": "MULTIPOINT",
    }
    runner._fill_second_layer_geometry_type(
        table_info,
        DatasetMetadata(
            path="points.parquet", source_type="vector", geometry_type="Polygon"
        ),
    )
    assert table_info["geometry_type"] == "MULTIPOINT"


def test_a_second_layer_without_a_geometry_column_stays_a_table() -> None:
    runner = TravelCostMatrixToolRunner()
    table_info: dict[str, Any] = {"geometry_column": None, "geometry_type": None}
    runner._fill_second_layer_geometry_type(
        table_info,
        DatasetMetadata(
            path="matrix.parquet", source_type="vector", geometry_type="Point"
        ),
    )
    assert table_info["geometry_type"] is None
