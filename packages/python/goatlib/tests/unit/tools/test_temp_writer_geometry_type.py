"""The geometry type a step's temp result is saved with.

The rows of a result decide its geometry type. A result without rows has
none to read, so the writer takes the type the tool says its result has: an
export of it is then a layer of that type, which the map draws once a later
run gives it rows. A result without a geometry column stays a table.
"""

import json
import subprocess
from pathlib import Path
from typing import Any

import duckdb
import manby
import pytest
from goatlib.io.config import parquet_copy_options
from goatlib.io.pmtiles import MANBY_MARKER, PMTilesConfig, PMTilesGenerator
from goatlib.tools.temp_writer import TempLayerWriter, temp_step_folder
from pmtiles.reader import MmapSource, Reader

POINTS = "SELECT 1 AS id, ST_Point(11.5, 48.1)::GEOMETRY('OGC:CRS84') AS geometry"


def _write(path: Path, query: str) -> Path:
    con = duckdb.connect()
    try:
        con.execute("INSTALL spatial; LOAD spatial;")
        con.execute(f"COPY ({query}) TO '{path}' {parquet_copy_options()}")
    finally:
        con.close()
    return path


@pytest.fixture
def tiles_made(monkeypatch: pytest.MonkeyPatch) -> list[Any]:
    """The tile runs a write starts, without building tiles."""
    made: list[Any] = []
    monkeypatch.setattr(
        TempLayerWriter, "_generate_pmtiles", lambda self, con=None: made.append(1)
    )
    return made


def _writer(tmp_path: Path) -> TempLayerWriter:
    return TempLayerWriter(
        user_id="u-1", workflow_id="w-1", node_id="ring", temp_data_root=tmp_path
    )


def test_an_empty_result_takes_the_type_the_tool_gives(
    tmp_path: Path, tiles_made: list[Any]
) -> None:
    source = _write(tmp_path / "out.parquet", f"{POINTS} WHERE false")
    result = _writer(tmp_path).write_from_parquet(
        source, layer_name="Ringe", geometry_type="POLYGON"
    )
    assert (result.metadata.geometry_type, result.metadata.feature_count) == (
        "POLYGON",
        0,
    )
    assert tiles_made == [], "no tiles for a layer without rows"


def test_the_rows_decide_when_there_are_rows(
    tmp_path: Path, tiles_made: list[Any]
) -> None:
    source = _write(tmp_path / "out.parquet", POINTS)
    result = _writer(tmp_path).write_from_parquet(
        source, layer_name="Punkte", geometry_type="POLYGON"
    )
    assert result.metadata.geometry_type == "POINT"
    assert tiles_made == [1]


def test_a_result_without_a_geometry_column_stays_a_table(
    tmp_path: Path, tiles_made: list[Any]
) -> None:
    source = _write(tmp_path / "out.parquet", "SELECT 1 AS id WHERE false")
    result = _writer(tmp_path).write_from_parquet(
        source, layer_name="Tabelle", geometry_type="POINT"
    )
    assert result.metadata.geometry_type is None


def test_the_step_folder_is_where_the_writer_writes(tmp_path: Path) -> None:
    writer = _writer(tmp_path)
    assert temp_step_folder("u-1", "w-1", "ring", tmp_path) == writer.base_path


# The second row has no geometry: it has no feature in the tiles, and its
# number is not given to the next row.
LINES = """
    SELECT * FROM (VALUES
        ('Hauptstraße', ST_GeomFromText('LINESTRING(11.5 48.1, 11.6 48.2)')),
        ('ohne Geometrie', NULL),
        ('Nebenweg', ST_GeomFromText('LINESTRING(11.6 48.1, 11.7 48.15)'))
    ) AS v(name, geom)
"""


def _features(path: Path) -> dict[int, dict]:
    """Feature properties by id, as the deepest tile holding each feature has them."""
    decoded = subprocess.run(
        [manby.binary(), "decode", str(path)],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    tiles = sorted(
        json.loads(decoded)["features"], key=lambda t: t["properties"]["zoom"]
    )
    return {
        feature["id"]: feature["properties"]
        for tile in tiles
        for layer in tile["features"]
        for feature in layer["features"]
    }


def _recipe(flags: tuple[str, ...]) -> list[str]:
    """manby's flags without the build's own: its description (a timestamp)
    and its temporary directory."""
    kept = list(flags)
    at = kept.index("-t")
    del kept[at : at + 2]
    return [flag for flag in kept if not flag.startswith("--description=")]


def test_preview_uses_manby_recipe_with_ids(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A preview's tiles come from the builder of the layers' tiles: the
    recipe of its geometry type up to the writer's max zoom, and feature ids
    file_row_number + 1, as geoapi numbers the preview's features."""
    calls: list[tuple[str, ...]] = []
    real_run = PMTilesGenerator._run_manby

    def run(input_path: Path, output_path: Path, flags: list[str]) -> None:
        calls.append(tuple(flags))
        real_run(input_path, output_path, flags)

    monkeypatch.setattr(PMTilesGenerator, "_run_manby", staticmethod(run))
    source = _write(tmp_path / "out.parquet", LINES)
    writer = TempLayerWriter(
        user_id="u-1",
        workflow_id="w-1",
        node_id="lines",
        temp_data_root=tmp_path,
        pmtiles_max_zoom=12,
    )

    # A tool passes its own connection, which keeps no view of the preview
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")

    result = writer.write_from_parquet(source, layer_name="Linien", duckdb_con=con)

    assert con.execute(
        "SELECT count(*) FROM duckdb_views() WHERE temporary AND NOT internal"
    ).fetchone() == (0,)
    con.close()
    assert result.pmtiles_path == writer.pmtiles_path
    with open(writer.pmtiles_path, "rb") as f:
        description = json.loads(Reader(MmapSource(f)).metadata()["description"])
    assert MANBY_MARKER.items() <= description.items()
    recipe = PMTilesGenerator(
        tiles_data_dir=tmp_path / "recipe", config=PMTilesConfig(max_zoom=12)
    ).manby_flags("LINESTRING", None, False, None)
    assert [_recipe(flags) for flags in calls] == [_recipe((*recipe, "-t", "x"))]
    assert "-z12" in recipe
    features = _features(writer.pmtiles_path)
    assert {id_: f["name"] for id_, f in features.items()} == {
        1: "Hauptstraße",
        3: "Nebenweg",
    }


@pytest.mark.parametrize("failure", ["no tiler", "build failed"])
def test_a_failed_tile_build_leaves_the_preview_without_tiles(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    """The step's result is written either way: a tile build never fails a
    workflow."""
    if failure == "no tiler":

        def no_tiler(self: PMTilesGenerator) -> bool:
            raise RuntimeError("manby is required")

        monkeypatch.setattr(PMTilesGenerator, "_check_dependencies", no_tiler)
    else:
        monkeypatch.setattr(
            PMTilesGenerator, "generate_from_table", lambda self, **kwargs: None
        )
    source = _write(tmp_path / "out.parquet", LINES)
    writer = _writer(tmp_path)

    result = writer.write_from_parquet(source, layer_name="Linien")

    assert result.pmtiles_path is None
    assert not writer.pmtiles_path.exists()
    assert result.metadata.feature_count == 3
    assert writer.metadata_path.exists()
