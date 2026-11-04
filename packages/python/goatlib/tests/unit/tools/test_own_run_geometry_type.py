"""Tools with a `run()` of their own save an empty result with its type.

Catchment areas, origin-destination lines, ÖV-Güteklassen and zone clustering
write their temp result through `_write_temp_result` from their own `run()`,
which passes no geometry type. The writer works it out itself
(`result_geometry_type`), so an empty catchment area is a layer of its kind:
polygons, or lines for a network catchment.
"""

from pathlib import Path
from typing import Any

import duckdb
import pytest
from goatlib.io.config import parquet_copy_options
from goatlib.models.io import DatasetMetadata
from goatlib.tools import temp_writer
from goatlib.tools.catchment_area_v2 import (
    CatchmentAreaV2ToolRunner,
    CatchmentAreaV2WindmillParams,
)

pytestmark = pytest.mark.usefixtures("runner_event_loop")

U = "00000000-0000-0000-0000-000000000001"


async def _nothing(*_: Any, **__: Any) -> None:
    return None


@pytest.mark.parametrize(
    ("catchment_area_type", "geometry_type"),
    [
        ("polygon", "POLYGON"),
        ("hexagonal_grid", "POLYGON"),
        ("network", "LINESTRING"),
        ("point_grid", "POINT"),
    ],
)
def test_an_empty_catchment_area_has_the_geometry_of_its_kind(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    catchment_area_type: str,
    geometry_type: str,
) -> None:
    monkeypatch.setattr(temp_writer, "TEMP_DATA_ROOT", tmp_path / "temporary")
    bands = tmp_path / "bands.parquet"
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute(
        "COPY (SELECT 300 AS travel_cost, "
        "ST_Point(11.5, 48.1)::GEOMETRY('OGC:CRS84') AS geometry WHERE false) "
        f"TO '{bands}' {parquet_copy_options()}"
    )

    runner = CatchmentAreaV2ToolRunner()
    runner._duckdb_con = con
    monkeypatch.setattr(runner, "_init_db_service", _nothing)
    monkeypatch.setattr(runner, "_close_db_service", _nothing)
    monkeypatch.setattr(runner, "get_layer_properties", lambda *a, **k: None)
    monkeypatch.setattr(
        runner,
        "process",
        lambda params, temp_dir: (
            bands,
            DatasetMetadata(path=str(bands), source_type="vector"),
        ),
    )
    params = CatchmentAreaV2WindmillParams(
        user_id=U,
        folder_id=U,
        routing_mode="walking",
        starting_points={"latitude": [48.137], "longitude": [11.576]},
        catchment_area_type=catchment_area_type,
        point_grid_layer_id=U if catchment_area_type == "point_grid" else None,
        temp_mode=True,
        workflow_id="00000000-0000-0000-0000-0000000000aa",
        node_id="reach",
    )
    try:
        result = runner.run(params)
    finally:
        con.close()
        runner._duckdb_con = None
    assert (result["type"], result["geometry_type"], result["feature_count"]) == (
        "feature",
        geometry_type,
        0,
    )


@pytest.mark.parametrize(
    ("catchment_area_type", "geometry_type"),
    [("polygon", "POLYGON"), ("network", "LINESTRING")],
)
def test_an_empty_catchment_area_is_saved_as_a_layer_of_its_kind(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    catchment_area_type: str,
    geometry_type: str,
) -> None:
    """Outside a workflow the result is saved at once. The analysis reports
    "Polygon" for every kind of catchment, so the kind decides."""
    runner = CatchmentAreaV2ToolRunner()
    saved: dict[str, Any] = {}

    async def create_db_records(**kwargs: Any) -> dict[str, Any]:
        saved.update(kwargs["table_info"])
        return {"folder_id": U, "layer_project_id": None}

    monkeypatch.setattr(runner, "_init_db_service", _nothing)
    monkeypatch.setattr(runner, "_close_db_service", _nothing)
    monkeypatch.setattr(runner, "get_layer_properties", lambda *a, **k: None)
    monkeypatch.setattr(
        runner,
        "process",
        lambda params, temp_dir: (
            tmp_path / "bands.parquet",
            # What the catchment analysis reports, whatever the kind.
            DatasetMetadata(
                path="bands.parquet", source_type="vector", geometry_type="Polygon"
            ),
        ),
    )
    monkeypatch.setattr(
        runner,
        "_ingest_to_ducklake",
        lambda **kwargs: {
            "table_name": "lake.user_1.t_1",
            "geometry_column": "geometry",
            "geometry_type": None,
            "feature_count": 0,
        },
    )
    monkeypatch.setattr(runner, "_create_db_records", create_db_records)
    params = CatchmentAreaV2WindmillParams(
        user_id=U,
        folder_id=U,
        routing_mode="walking",
        starting_points={"latitude": [48.137], "longitude": [11.576]},
        catchment_area_type=catchment_area_type,
    )
    result = runner.run(params)
    assert saved["geometry_type"] == geometry_type
    assert (result["type"], result["geometry_type"]) == ("feature", geometry_type)
