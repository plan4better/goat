"""PMTiles built by manby: recipes per geometry type, from a DuckDB query.

The builder writes the query's features to a GeoParquet file, runs manby on it
once DuckDB is done, and records MANBY_MARKER in the tileset's description;
geoapi filters stored tiles only when it finds the marker. A failed manby
build returns None: a tile build never fails the tool.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import duckdb
import goatlib.io.pmtiles as pmtiles
import manby
import pytest
from goatlib.io.pmtiles import MANBY_MARKER, PMTilesConfig, PMTilesGenerator
from pmtiles.reader import MmapSource, Reader


@pytest.fixture()
def con() -> duckdb.DuckDBPyConnection:
    connection = duckdb.connect()
    connection.execute("INSTALL spatial; LOAD spatial;")
    return connection


@pytest.fixture()
def generator(tmp_path: Path) -> PMTilesGenerator:
    return PMTilesGenerator(tiles_data_dir=tmp_path / "tiles", config=PMTilesConfig())


def _has(flags: list[str], *sequence: str) -> bool:
    """`sequence` appears in `flags` as consecutive items."""
    n = len(sequence)
    return any(tuple(flags[i : i + n]) == sequence for i in range(len(flags)))


def _description(flags: list[str]) -> dict:
    (value,) = [f for f in flags if f.startswith("--description=")]
    return json.loads(value.removeprefix("--description="))


def _decoded(path: Path) -> dict[int, dict]:
    """GeoJSON features by id, as the deepest tile holding each feature has them."""
    decoded = subprocess.run(
        [manby.binary(), "decode", str(path)],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    tiles = sorted(
        json.loads(decoded)["features"], key=lambda t: t["properties"]["zoom"]
    )
    features: dict[int, dict] = {}
    for tile in tiles:
        for layer in tile["features"]:
            for feature in layer["features"]:
                features[feature["id"]] = feature
    return features


def _features(path: Path) -> dict[int, dict]:
    """Feature properties by id, as the deepest tile holding each feature has them."""
    return {id_: f["properties"] for id_, f in _decoded(path).items()}


def _layers(path: Path) -> set[str]:
    with open(path, "rb") as f:
        metadata = Reader(MmapSource(f)).metadata()
    return {layer["id"] for layer in metadata["vector_layers"]}


# =====================================================================
#  Recipes
# =====================================================================

COMMON = (
    "--preserve-input-order",
    "--use-attribute-for-id=_rowid",
    "--exclude=_rowid",
    "--generate-variable-depth-tile-pyramid",
)


def test_flags_per_geometry_type(generator: PMTilesGenerator) -> None:
    points = generator.manby_flags("POINT", 42, False, 1000)
    for flag in (
        "--full-detail=12",
        "--extra-detail=16",
        "--drop-densest-as-needed",
        "--extend-zooms-if-still-dropping",
        "--low-detail=10",
        "--preserve-point-density-threshold=64",
    ):
        assert flag in points
    # nothing reads point_count from tiles, and it would overwrite a layer's own
    assert not any("point_count" in flag for flag in points)
    assert _has(points, "-zg", "-rp")
    assert _has(points, "-M", "2000000")
    assert _has(points, "-O", "200000")

    # -zg cannot guess a max zoom from a single location
    one_location = generator.manby_flags("POINT", 42, False, 1)
    assert _has(one_location, "-z14", "-r1")
    assert "-zg" not in one_location
    assert "-rp" not in one_location

    lines = generator.manby_flags("MULTILINESTRING", 42, False, None)
    for flag in (
        "-z14",
        "--full-detail=16",
        "--drop-densest-as-needed",
        "--extend-zooms-if-still-dropping",
        "--simplify-only-low-zooms",
        "--low-detail=10",
    ):
        assert flag in lines
    assert _has(lines, "-M", "2000000")
    assert _has(lines, "-O", "200000")

    polygons = generator.manby_flags("POLYGON", 42, False, None)
    for flag in (
        "-z14",
        "--full-detail=16",
        "--drop-densest-as-needed",
        "--extend-zooms-if-still-dropping",
        "--simplify-only-low-zooms",
        "--no-simplification-of-shared-nodes",
        "--tiny-polygon-size=1",
        "--low-detail=10",
    ):
        assert flag in polygons
    assert _has(polygons, "-M", "2000000")
    assert _has(polygons, "-O", "200000")
    # a coalesced polygon keeps one feature's attributes: a filter would draw
    # shapes that do not match it
    assert "--coalesce-densest-as-needed" not in polygons

    anchors = generator.manby_flags("POLYGON", 42, True, None)
    for flag in (
        "--convert-polygons-to-label-points",
        "-r1",
        "--drop-densest-as-needed",
        "--extend-zooms-if-still-dropping",
    ):
        assert flag in anchors
    assert _has(anchors, "-l", "default_anchor")

    for flags in (points, one_location, lines, polygons, anchors):
        assert all(flag in flags for flag in COMMON)
        assert "-Z0" in flags
        assert "-q" in flags
        assert "-o" not in flags  # manby.tile passes the output itself
        description = _description(flags)
        assert MANBY_MARKER.items() <= description.items()
        assert description["snapshot_id"] == 42
    for flags in (points, one_location, lines, polygons):
        assert _has(flags, "-l", "default")


def test_the_marker_is_recorded_without_a_snapshot(
    generator: PMTilesGenerator,
) -> None:
    description = _description(generator.manby_flags("POLYGON", None, False, None))
    assert MANBY_MARKER.items() <= description.items()
    assert "snapshot_id" not in description


def test_max_zoom_follows_the_config(tmp_path: Path) -> None:
    generator = PMTilesGenerator(
        tiles_data_dir=tmp_path, config=PMTilesConfig(min_zoom=2, max_zoom=12)
    )
    flags = generator.manby_flags("LINESTRING", None, False, None)
    assert "-z12" in flags
    assert "-Z2" in flags


def test_memory_budget_is_a_share_of_the_container(
    generator: PMTilesGenerator, monkeypatch: pytest.MonkeyPatch
) -> None:
    import goatlib.io.pmtiles as pmtiles

    monkeypatch.setattr(pmtiles, "container_memory_limit", lambda: 4 * 1024**3)
    flags = generator.manby_flags("POLYGON", None, False, None)
    assert "--memory-budget=2048M" in flags  # half of 4 GiB

    # without a container limit manby keeps its own default
    monkeypatch.setattr(pmtiles, "container_memory_limit", lambda: None)
    flags = generator.manby_flags("POLYGON", None, False, None)
    assert not any(f.startswith("--memory-budget") for f in flags)


# =====================================================================
#  Input query
# =====================================================================


def test_tile_query_columns(
    generator: PMTilesGenerator, con: duckdb.DuckDBPyConnection
) -> None:
    con.execute(
        """
        CREATE TABLE layer AS SELECT
            1 AS id,
            'Hauptstraße' AS "Straße Name",
            {'a': 1} AS a_struct,
            MAP {'k': 'v'} AS a_map,
            [1, 2] AS a_list,
            union_value(num := 2) AS a_union,
            [1, 2]::INTEGER[2] AS an_array,
            {'xmin': 0.0, 'ymin': 0.0, 'xmax': 1.0, 'ymax': 1.0} AS bbox,
            0.0 AS "$minx", 0.0 AS "$miny", 1.0 AS "$maxx", 1.0 AS "$maxy",
            'x' AS secret,
            ST_Point(7.6, 47.5) AS geometry
        """
    )

    query = generator.tile_query(
        con, "layer", "geometry", ["secret"], geometry_type="POINT"
    )

    assert '"Straße Name"' in query
    assert '"id"' in query
    for absent in (
        "a_struct",
        "a_map",
        "a_list",
        "a_union",
        "an_array",
        "bbox",
        "$minx",
        "$miny",
        "$maxx",
        "$maxy",
        "secret",
    ):
        assert absent not in query
    assert "rowid + 1 AS _rowid" in query
    assert "ORDER BY _rowid" in query
    # the points of a geometry collection, other geometries as they are
    assert (
        "CASE WHEN ST_GeometryType(\"geometry\") = 'GEOMETRYCOLLECTION' "
        'THEN ST_CollectionExtract("geometry", 1) ELSE "geometry" END AS geometry'
    ) in query
    assert "WHERE geometry IS NOT NULL AND NOT ST_IsEmpty(geometry)" in query

    # the query runs, and gives the columns in table order
    columns = [c[0] for c in con.sql(query).description]
    assert columns == ["_rowid", "id", "Straße Name", "geometry"]


def test_tile_query_takes_another_id(
    generator: PMTilesGenerator, con: duckdb.DuckDBPyConnection
) -> None:
    con.execute("CREATE TABLE layer AS SELECT 7 AS n, ST_Point(7.6, 47.5) AS geometry")

    query = generator.tile_query(con, "layer", "geometry", [], id_expression="n * 2")

    assert con.sql(query).fetchone()[0] == 14


def test_temporal_columns_keep_their_text_format(
    generator: PMTilesGenerator, con: duckdb.DuckDBPyConnection, tmp_path: Path
) -> None:
    """The strings the tiles built before manby carry, whatever the session's
    time zone (decoded from a tile the worker image built through GDAL's
    GeoJSON on 2026-11-08, in UTC as the workers run)."""
    con.execute("SET TimeZone = 'Europe/Berlin'")
    con.execute(
        """
        CREATE TABLE layer AS SELECT * FROM (VALUES
            (DATE '2024-03-05', TIMESTAMP '2024-03-05 07:08:09',
             TIMESTAMPTZ '2024-03-05 07:08:09+02', TIMESTAMP '2024-03-05 07:08:09.123',
             TIMESTAMPTZ '2024-03-05 07:08:09.5+00', DATE '1919-01-03',
             TIMESTAMP '1943-06-01 08:30:00', ST_Point(7.6, 47.5)),
            (DATE '2024-03-06', TIMESTAMP '2024-03-06 00:00:00',
             TIMESTAMPTZ '2024-03-06 23:30:00-05', TIMESTAMP '2024-03-06 00:00:00',
             TIMESTAMPTZ '2024-03-06 00:00:00+00', DATE '1969-12-31',
             TIMESTAMP '1969-12-31 23:59:59', ST_Point(7.7, 47.6))
        ) AS v(d, ts, tstz, ts_frac, tstz_frac, d_old, ts_old, geometry)
        """
    )

    path = generator.generate_from_table(con, "layer", "layer1")

    assert path is not None
    assert generator.read_marker(path)["tiler"] == "manby"
    features = _features(path)
    assert {k: features[1][k] for k in ("d", "ts", "tstz", "ts_frac")} == {
        "d": "2024-03-05",
        "ts": "2024-03-05T07:08:09",
        "tstz": "2024-03-05T05:08:09Z",
        "ts_frac": "2024-03-05T07:08:09.123",
    }
    assert {k: features[1][k] for k in ("tstz_frac", "d_old", "ts_old")} == {
        "tstz_frac": "2024-03-05T07:08:09.500Z",
        "d_old": "1919-01-03",
        "ts_old": "1943-06-01T08:30:00",
    }
    assert {k: features[2][k] for k in ("d", "ts", "tstz", "ts_frac")} == {
        "d": "2024-03-06",
        "ts": "2024-03-06T00:00:00",
        "tstz": "2024-03-07T04:30:00Z",
        "ts_frac": "2024-03-06T00:00:00",
    }
    assert {k: features[2][k] for k in ("tstz_frac", "d_old", "ts_old")} == {
        "tstz_frac": "2024-03-06T00:00:00Z",
        "d_old": "1969-12-31",
        "ts_old": "1969-12-31T23:59:59",
    }


# =====================================================================
#  Builds
# =====================================================================

GEOMETRIES = {
    "points": (
        "ST_Point(7.6, 47.5)",
        "ST_Point(7.7, 47.6)",
        "ST_GeomFromText('POINT EMPTY')",
    ),
    "lines": (
        "ST_GeomFromText('LINESTRING(7.6 47.5, 7.65 47.55)')",
        "ST_GeomFromText('LINESTRING(7.7 47.6, 7.75 47.65)')",
        "ST_GeomFromText('LINESTRING EMPTY')",
    ),
    "polygons": (
        "ST_GeomFromText('POLYGON((7.6 47.5, 7.65 47.5, 7.65 47.55, 7.6 47.5))')",
        "ST_GeomFromText('POLYGON((7.7 47.6, 7.75 47.6, 7.75 47.65, 7.7 47.6))')",
        "ST_GeomFromText('POLYGON EMPTY')",
    ),
}


@pytest.mark.parametrize("kind", GEOMETRIES)
def test_build_points_lines_polygons(
    kind: str, generator: PMTilesGenerator, con: duckdb.DuckDBPyConnection
) -> None:
    first, second, empty = GEOMETRIES[kind]
    con.execute(
        f"""
        CREATE TABLE layer AS SELECT * FROM (VALUES
            (7, 2.5, true, 'Hauptstraße', 0.0, {first}),
            (8, 3.5, false, 'Nebenweg', 0.0, NULL),
            (9, 4.5, false, 'Leer', 0.0, {empty}),
            (10, 5.5, false, 'Bahnhof', 0.0, {second})
        ) AS v(i, d, b, "Straße Name", "$minx", geom)
        """
    )

    path = generator.generate_from_table(
        con,
        "layer",
        "layer1",
        geometry_column="geom",
        snapshot_id=17,
    )

    assert path == generator.get_pmtiles_path("layer1")
    assert path.exists()
    marker = generator.read_marker(path)
    assert MANBY_MARKER.items() <= marker.items()
    assert marker["snapshot_id"] == 17
    assert generator.get_pmtiles_snapshot_id(path) == 17
    assert _layers(path) == {"default"}

    features = _features(path)
    # ids are rowid + 1; the NULL and the empty geometry are skipped
    assert set(features) == {1, 4}
    first_feature = features[1]
    assert first_feature["i"] == 7 and type(first_feature["i"]) is int
    assert first_feature["d"] == 2.5 and type(first_feature["d"]) is float
    assert first_feature["b"] is True
    assert first_feature["Straße Name"] == "Hauptstraße"
    assert "$minx" not in first_feature
    assert features[4]["Straße Name"] == "Bahnhof"

    anchor_path = generator.get_anchor_pmtiles_path("layer1")
    if kind == "polygons":
        assert MANBY_MARKER.items() <= generator.read_marker(anchor_path).items()
        assert _layers(anchor_path) == {"default_anchor"}
        assert set(_features(anchor_path)) == {1, 4}
    else:
        assert not anchor_path.exists()


def test_a_point_count_column_keeps_its_values(
    generator: PMTilesGenerator, con: duckdb.DuckDBPyConnection
) -> None:
    """The point recipe adds no point_count, so a layer's own column of that
    name reaches the tiles unchanged."""
    con.execute(
        f"""
        CREATE TABLE layer AS SELECT * FROM (VALUES
            (41, {GEOMETRIES['points'][0]}),
            (42, {GEOMETRIES['points'][1]})
        ) AS v(point_count, geometry)
        """
    )

    path = generator.generate_from_table(con, "layer", "layer1")

    assert path is not None
    assert generator.read_marker(path)["tiler"] == "manby"
    features = _features(path)
    assert {id_: f["point_count"] for id_, f in features.items()} == {1: 41, 2: 42}


def test_points_at_one_location_still_build(
    generator: PMTilesGenerator, con: duckdb.DuckDBPyConnection
) -> None:
    con.execute(
        "CREATE TABLE layer AS SELECT i, ST_Point(7.6, 47.5) AS geometry "
        "FROM range(3) r(i)"
    )

    path = generator.generate_from_table(con, "layer", "layer1")

    assert path is not None
    assert generator.read_marker(path)["tiler"] == "manby"
    assert set(_features(path)) == {1, 2, 3}


def _spy_manby(
    generator: PMTilesGenerator,
    monkeypatch: pytest.MonkeyPatch,
    zg_exit: int | None = None,
) -> list[list[str]]:
    """Record the flags of each manby run; with `zg_exit` a -zg build fails
    with that exit status (110: no two locations to guess a max zoom from)."""
    real_run = generator._run_manby
    calls: list[list[str]] = []

    def run(input_path: Path, output_path: Path, flags: list[str]) -> None:
        calls.append(flags)
        if zg_exit is not None and "-zg" in flags:
            raise manby.ManbyError(zg_exit, ["-zg"])
        real_run(input_path, output_path, flags)

    monkeypatch.setattr(generator, "_run_manby", run)
    return calls


def test_points_on_one_grid_cell_build_with_manby(
    generator: PMTilesGenerator,
    con: duckdb.DuckDBPyConnection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Distinct points closer than manby's grid (360 / 2**32 degrees) are one
    location to it: -zg would fail, so they get the fixed max zoom."""
    con.execute(
        "CREATE TABLE layer AS SELECT i, "
        "ST_Point(7.6 + i * 5e-12, 47.5 + i * 5e-12) AS geometry FROM range(200) r(i)"
    )
    calls = _spy_manby(generator, monkeypatch)

    path = generator.generate_from_table(con, "layer", "layer1")

    assert path is not None
    assert generator.read_marker(path)["tiler"] == "manby"
    assert len(calls) == 1
    assert _has(calls[0], "-z14", "-r1")
    assert "-zg" not in calls[0]
    assert len(_features(path)) == 200


def test_a_failed_zg_build_is_retried_at_the_max_zoom(
    generator: PMTilesGenerator,
    con: duckdb.DuckDBPyConnection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    con.execute(
        "CREATE TABLE layer AS SELECT * FROM (VALUES "
        f"(1, {GEOMETRIES['points'][0]}), (2, {GEOMETRIES['points'][1]})"
        ") AS v(n, geometry)"
    )
    calls = _spy_manby(generator, monkeypatch, zg_exit=110)

    path = generator.generate_from_table(con, "layer", "layer1")

    assert path is not None
    assert generator.read_marker(path)["tiler"] == "manby"
    assert len(calls) == 2
    assert _has(calls[0], "-zg", "-rp")
    assert _has(calls[1], "-z14", "-r1")
    assert set(_features(path)) == {1, 2}


def test_a_zg_build_that_failed_otherwise_is_not_retried(
    generator: PMTilesGenerator,
    con: duckdb.DuckDBPyConnection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Only exit 110 says -zg found no max zoom; a build killed for its memory
    (-9) would fail again at the max zoom, with more points kept."""
    con.execute(
        "CREATE TABLE layer AS SELECT * FROM (VALUES "
        f"(1, {GEOMETRIES['points'][0]}), (2, {GEOMETRIES['points'][1]})"
        ") AS v(n, geometry)"
    )
    calls = _spy_manby(generator, monkeypatch, zg_exit=-9)

    assert generator.generate_from_table(con, "layer", "layer1") is None
    assert len(calls) == 1 and _has(calls[0], "-zg", "-rp")
    assert not generator.get_pmtiles_path("layer1").exists()


def test_manby_builds_from_a_geoparquet_written_first(
    generator: PMTilesGenerator,
    con: duckdb.DuckDBPyConnection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """DuckDB writes the sorted features to a file before manby starts, so the
    two never hold memory at once; a polygon layer's two files share it, and it
    goes with the build's temporary directory."""
    con.execute(
        "CREATE TABLE layer AS SELECT i AS n, "
        f"{GEOMETRIES['polygons'][0]} AS geometry FROM range(3) r(i)"
    )
    real_run = generator._run_manby
    inputs: list[Path] = []

    def run(input_path: Path, output_path: Path, flags: list[str]) -> None:
        inputs.append(input_path)
        assert input_path.suffix == ".parquet"
        assert input_path.parent == output_path.parent  # the work directory
        geo = con.execute(
            f"SELECT value FROM parquet_kv_metadata('{input_path}') WHERE key = 'geo'"
        ).fetchone()
        assert json.loads(geo[0])["primary_column"] == "geometry"
        assert con.execute(f"SELECT list(_rowid) FROM '{input_path}'").fetchone()[
            0
        ] == [1, 2, 3]
        real_run(input_path, output_path, flags)

    monkeypatch.setattr(generator, "_run_manby", run)

    path = generator.generate_from_table(con, "layer", "layer1")

    assert generator.read_marker(path)["tiler"] == "manby"
    assert len(inputs) == 2 and inputs[0] == inputs[1]  # layer and label points
    assert not inputs[0].parent.exists()


def test_the_connection_hands_back_its_memory_before_manby_runs(
    generator: PMTilesGenerator, con: duckdb.DuckDBPyConnection
) -> None:
    """Without its allocator's background threads, DuckDB keeps the memory of
    the sort that wrote the input until the connection closes, next to
    manby's budget. The setting holds for the connection's DuckDB instance."""
    con.execute(
        "CREATE TABLE layer AS SELECT 1 AS n, " f"{GEOMETRIES['lines'][0]} AS geometry"
    )
    setting = "SELECT current_setting('allocator_background_threads')"
    assert con.execute(setting).fetchone()[0] is False

    path = generator.generate_from_table(con, "layer", "layer1")

    assert generator.read_marker(path)["tiler"] == "manby"
    assert con.execute(setting).fetchone()[0] is True


def test_the_input_file_goes_when_the_build_fails(
    generator: PMTilesGenerator,
    con: duckdb.DuckDBPyConnection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    con.execute(
        "CREATE TABLE layer AS SELECT 1 AS n, " f"{GEOMETRIES['lines'][0]} AS geometry"
    )
    inputs: list[Path] = []

    def run(input_path: Path, _output_path: Path, _flags: list[str]) -> None:
        inputs.append(input_path)
        raise manby.ManbyError(1, ["-o", "out.pmtiles"])

    monkeypatch.setattr(generator, "_run_manby", run)

    assert generator.generate_from_table(con, "layer", "layer1") is None
    assert inputs and not inputs[0].exists()


def test_manby_runs_with_the_container_cpu_count(
    generator: PMTilesGenerator,
    con: duckdb.DuckDBPyConnection,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """manby sizes its threads by the host's cores unless TIPPECANOE_MAX_THREADS
    says otherwise; the variable goes to manby's process only."""
    con.execute(
        "CREATE TABLE layer AS SELECT 1 AS n, " f"{GEOMETRIES['lines'][0]} AS geometry"
    )
    seen = tmp_path / "threads"
    fake = tmp_path / "manby"
    fake.write_text(
        "#!/bin/sh\n"
        f'printf "%s" "$TIPPECANOE_MAX_THREADS" > "{seen}"\n'
        f'exec "{manby.binary()}" "$@"\n'
    )
    fake.chmod(0o755)
    monkeypatch.setattr(manby, "binary", lambda: str(fake))
    monkeypatch.setattr(pmtiles, "container_cpu_count", lambda: 3)
    monkeypatch.delenv("TIPPECANOE_MAX_THREADS", raising=False)

    path = generator.generate_from_table(con, "layer", "layer1")

    assert generator.read_marker(path)["tiler"] == "manby"
    assert seen.read_text() == "3"
    assert "TIPPECANOE_MAX_THREADS" not in os.environ


def test_uuid_columns_are_text(
    generator: PMTilesGenerator, con: duckdb.DuckDBPyConnection
) -> None:
    """GeoParquet stores a UUID as 16 bytes, which manby leaves out."""
    con.execute(
        "CREATE TABLE layer AS SELECT "
        "'8584b3f2-e1ce-457c-be76-180b0f362f90'::UUID AS uid, "
        f"{GEOMETRIES['lines'][0]} AS geometry"
    )

    path = generator.generate_from_table(con, "layer", "layer1")

    assert _features(path)[1]["uid"] == "8584b3f2-e1ce-457c-be76-180b0f362f90"


# Per layer kind: the tile geometry types its parts may have, and a
# collection without a part of that kind.
COLLECTION_PARTS = {
    "points": ({"Point", "MultiPoint"}, "LINESTRING(7.6 47.5, 7.7 47.6)"),
    "lines": ({"LineString", "MultiLineString"}, "POINT(7.65 47.55)"),
    "polygons": ({"Polygon", "MultiPolygon"}, "POINT(7.65 47.55)"),
}


@pytest.mark.parametrize("kind", GEOMETRIES)
def test_geometry_collections_keep_the_parts_of_the_layer_type(
    kind: str, generator: PMTilesGenerator, con: duckdb.DuckDBPyConnection
) -> None:
    """manby skips geometry collections, so the query hands it the parts of
    the layer's type (overlay and clip results hold collections)."""
    tile_types, other = COLLECTION_PARTS[kind]
    con.execute(
        f"""
        CREATE TABLE layer AS SELECT * FROM (VALUES
            (1, {GEOMETRIES[kind][0]}),
            (2, ST_GeomFromText('GEOMETRYCOLLECTION(POINT(7.8 47.7), '
                'LINESTRING(7.8 47.7, 7.85 47.75), '
                'POLYGON((7.8 47.7, 7.85 47.7, 7.85 47.75, 7.8 47.7)))')),
            (3, ST_GeomFromText('GEOMETRYCOLLECTION({other})')),
            (4, NULL)
        ) AS v(n, geometry)
        """
    )

    path = generator.generate_from_table(con, "layer", "layer1")

    assert path is not None
    assert generator.read_marker(path)["tiler"] == "manby"
    features = _decoded(path)
    # the collection with nothing of the layer's type is dropped
    assert set(features) == {1, 2}
    assert features[2]["properties"] == {"n": 2}
    assert features[2]["geometry"]["type"] in tile_types
    if kind == "polygons":
        anchors = _decoded(generator.get_anchor_pmtiles_path("layer1"))
        assert set(anchors) == {1, 2}


def test_anchor_only_build(
    generator: PMTilesGenerator, con: duckdb.DuckDBPyConnection
) -> None:
    con.execute(
        "CREATE TABLE layer AS SELECT 1 AS n, "
        f"{GEOMETRIES['polygons'][0]} AS geometry"
    )

    path = generator.generate_anchor_from_table(con, "layer", "layer1", snapshot_id=3)

    assert path == generator.get_anchor_pmtiles_path("layer1")
    marker = generator.read_marker(path)
    assert MANBY_MARKER.items() <= marker.items()
    assert marker["snapshot_id"] == 3
    assert _layers(path) == {"default_anchor"}
    assert not generator.get_pmtiles_path("layer1").exists()


def test_read_marker_without_a_description(
    generator: PMTilesGenerator, tmp_path: Path
) -> None:
    assert generator.read_marker(tmp_path / "missing.pmtiles") == {}
    archive = tmp_path / "plain.pmtiles"
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    manby.tile(con.sql("SELECT ST_Point(7.6, 47.5) AS geometry"), archive, "-z5")
    assert generator.read_marker(archive) == {}


def test_anchors_are_published_before_the_main_file(
    generator: PMTilesGenerator,
    con: duckdb.DuckDBPyConnection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A main file in sync then has its anchors: a build stopped in between
    leaves a main file that is stale itself, which sync_pmtiles rebuilds."""
    con.execute(
        "CREATE TABLE layer AS SELECT 1 AS n, "
        f"{GEOMETRIES['polygons'][0]} AS geometry"
    )
    published: list[str] = []
    real_publish = pmtiles.publish_tiles

    def publish(built: Path, final: Path) -> None:
        published.append(final.name)
        real_publish(built, final)

    monkeypatch.setattr(pmtiles, "publish_tiles", publish)

    assert generator.generate_from_table(con, "layer", "layer1") is not None

    assert published == ["t_layer1_anchor.pmtiles", "t_layer1.pmtiles"]


def test_label_tiles_take_the_tile_size_limit_of_the_other_recipes(
    generator: PMTilesGenerator,
) -> None:
    assert _has(generator.manby_flags("POLYGON", 42, True, None), "-M", "2000000")


def test_a_polygon_with_large_attributes_gets_its_label_tiles(
    generator: PMTilesGenerator, con: duckdb.DuckDBPyConnection
) -> None:
    """Its one label carries more than manby's default tile size limit,
    compressed (hex text, as a WKT copy of a large geometry is)."""
    con.execute(
        "CREATE TABLE layer AS SELECT "
        "(SELECT string_agg(md5(i::VARCHAR), '') FROM range(50000) t(i)) AS wkt, "
        f"{GEOMETRIES['polygons'][0]} AS geometry"
    )

    assert generator.generate_from_table(con, "layer", "layer1") is not None

    anchors = generator.get_anchor_pmtiles_path("layer1")
    assert anchors.exists()
    assert generator.read_marker(anchors)["tiler"] == "manby"


def test_failed_label_tiles_keep_the_main_tiles(
    generator: PMTilesGenerator,
    con: duckdb.DuckDBPyConnection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The main tiles still draw the layer, and anchors from an older build
    go: next to the new main file they would leave the layer stale on every
    sync."""
    con.execute(
        "CREATE TABLE layer AS SELECT 1 AS n, "
        f"{GEOMETRIES['polygons'][0]} AS geometry"
    )
    older_anchors = generator.get_anchor_pmtiles_path("layer1")
    older_anchors.parent.mkdir(parents=True, exist_ok=True)
    older_anchors.write_bytes(b"anchors of an older build")
    real_build = generator._build

    def build(*args: object, label_anchor: bool = False, **kwargs: object) -> None:
        if label_anchor:
            raise manby.ManbyError(100, ["--convert-polygons-to-label-points"])
        real_build(*args, label_anchor=label_anchor, **kwargs)

    monkeypatch.setattr(generator, "_build", build)

    path = generator.generate_from_table(con, "layer", "layer1")

    assert path is not None and path.exists()
    assert generator.read_marker(path)["tiler"] == "manby"
    assert not older_anchors.exists()


# =====================================================================
#  In sync
# =====================================================================


def _tileset(path: Path, description: dict | None) -> Path:
    """A one-point tileset whose description is `description`, as JSON."""
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    flags = ["-z5"]
    if description is not None:
        flags.append(f"--description={json.dumps(description)}")
    manby.tile(con.sql("SELECT ST_Point(7.6, 47.5) AS geometry"), path, *flags)
    return path


@pytest.mark.parametrize(
    ("description", "snapshot_id", "in_sync"),
    [
        # Built before manby: no description at all, or only the snapshot,
        # which is current
        (None, 7, False),
        ({"snapshot_id": 7, "generated_at": "2026-01-01T00:00:00"}, 7, False),
        # Built by manby with an older recipe
        ({"snapshot_id": 7, "tiler": "manby", "recipe": 0}, 7, False),
        # The current marker, from the current snapshot or another one
        ({"snapshot_id": 7, **MANBY_MARKER}, 7, True),
        ({"snapshot_id": 6, **MANBY_MARKER}, 7, False),
        # No snapshot recorded, as for a catalog layer's tiles
        (MANBY_MARKER, None, True),
        (MANBY_MARKER, 7, False),
    ],
)
def test_in_sync_needs_the_snapshot_and_the_current_marker(
    generator: PMTilesGenerator,
    tmp_path: Path,
    description: dict | None,
    snapshot_id: int | None,
    in_sync: bool,
) -> None:
    """Old tiles are stale whatever their snapshot, so a plain sync after a
    deploy rebuilds them, and a recipe bump rolls out the same way."""
    path = _tileset(tmp_path / "t.pmtiles", description)

    assert generator.is_pmtiles_in_sync(path, snapshot_id) is in_sync
    assert (generator.stale_reason(path, snapshot_id) is None) is in_sync


def test_stale_reasons_name_what_differs(
    generator: PMTilesGenerator, tmp_path: Path
) -> None:
    old = _tileset(tmp_path / "old.pmtiles", {"snapshot_id": 7})
    recipe = _tileset(
        tmp_path / "recipe.pmtiles", {"snapshot_id": 7, "tiler": "manby", "recipe": 0}
    )
    snapshot = _tileset(
        tmp_path / "snapshot.pmtiles", {"snapshot_id": 6, **MANBY_MARKER}
    )

    current = MANBY_MARKER["recipe"]
    assert generator.stale_reason(old, 7) == "tiler None, current manby"
    assert generator.stale_reason(recipe, 7) == f"recipe 0, current {current}"
    assert generator.stale_reason(snapshot, 7) == "snapshot 6, current 7"


def test_a_sidecar_snapshot_does_not_make_old_tiles_in_sync(
    generator: PMTilesGenerator, tmp_path: Path
) -> None:
    """Only builds from before manby wrote the sidecar file."""
    path = _tileset(tmp_path / "t.pmtiles", None)
    path.with_suffix(".pmtiles.meta.json").write_text('{"snapshot_id": 7}')

    assert not generator.is_pmtiles_in_sync(path, 7)


# =====================================================================
#  Failed builds
# =====================================================================


def test_a_failed_manby_run_fails_the_build(
    generator: PMTilesGenerator,
    con: duckdb.DuckDBPyConnection,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """No other program takes over: the build raises manby's error, and the
    builder's callers get None, as from any failed tile build."""
    con.execute(
        "CREATE TABLE layer AS SELECT 1 AS n, "
        f"{GEOMETRIES['polygons'][0]} AS geometry"
    )
    failing = tmp_path / "manby"
    failing.write_text("#!/bin/sh\nexit 1\n")
    failing.chmod(0o755)
    monkeypatch.setattr(manby, "binary", lambda: str(failing))
    real_run = subprocess.run
    programs: list[str] = []

    def run(argv: list[str], *args: object, **kwargs: object) -> object:
        programs.append(argv[0])
        return real_run(argv, *args, **kwargs)

    monkeypatch.setattr(pmtiles.subprocess, "run", run)
    work = tmp_path / "work"
    work.mkdir()

    with pytest.raises(manby.ManbyError) as failed:
        generator._build(
            duckdb_con=con,
            table_name="layer",
            layer_id="layer1",
            geometry_column="geometry",
            exclude_columns=[],
            geometry_type="POLYGON",
            snapshot_id=None,
            output_path=work / "t_layer1.pmtiles",
        )
    assert failed.value.returncode == 1
    assert programs == [str(failing)]

    programs.clear()
    assert generator.generate_from_table(con, "layer", "layer1") is None
    assert generator.generate_anchor_from_table(con, "layer", "layer1") is None
    # one run each: the layer's tiles failed, so its label points never ran
    assert programs == [str(failing), str(failing)]
    assert not generator.get_pmtiles_path("layer1").exists()
    assert not generator.get_anchor_pmtiles_path("layer1").exists()


# =====================================================================
#  Several builds in one process
# =====================================================================

_TWO_BUILDS = """
import sys
from pathlib import Path

import duckdb

from goatlib.io.pmtiles import PMTilesGenerator

generator = PMTilesGenerator(tiles_data_dir=sys.argv[1])
con = duckdb.connect()
con.execute("INSTALL spatial; LOAD spatial;")
con.execute(
    "CREATE TABLE layer AS SELECT 1 AS n, ST_GeomFromText("
    "'POLYGON((7.6 47.5, 7.7 47.5, 7.7 47.6, 7.6 47.5))') AS geometry"
)
for layer_id in ("first", "second"):
    path = generator.generate_from_table(con, "layer", layer_id)
    anchor = generator.get_anchor_pmtiles_path(layer_id)
    assert path is not None, layer_id
    assert generator.read_marker(path).get("tiler") == "manby", layer_id
    assert generator.read_marker(anchor).get("tiler") == "manby", layer_id
print("ok")
"""


def test_builds_in_a_fresh_process(tmp_path: Path) -> None:
    """A polygon build runs manby twice (layer and label points), so two builds
    are four runs. Streamed through manby.tile's feeder thread, the second run
    crashed a fresh interpreter unless pyarrow had been imported on the main
    thread first (tests/unit/io/test_manby_repeat_calls.py). The builder passes
    manby a file instead and does not import pyarrow; this keeps it working.
    pytest has imported pyarrow in this process, which would hide the crash,
    so the builds run in a new one."""
    # the memory pool decides whether it crashes: test pyarrow's default
    env = {k: v for k, v in os.environ.items() if k != "ARROW_DEFAULT_MEMORY_POOL"}
    result = subprocess.run(
        [sys.executable, "-c", _TWO_BUILDS, str(tmp_path)],
        capture_output=True,
        text=True,
        timeout=120,
        env=env,
    )

    assert result.returncode == 0, (result.returncode, result.stderr[-2000:])
    assert result.stdout.strip() == "ok"
