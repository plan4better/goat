"""A user file is opened only by the GDAL drivers of its format.

GDAL picks a driver by a file's content, not its name. Every read of a user
file therefore names the drivers of its format, so content of another format
is not read, and a format without any is refused before a reader is built.

No test here needs the network: the assertions run on the SQL the converter
sends to DuckDB (`recorded`), read with DuckDB's own tokenizer, and the
refusals come before any reader.
"""

import dataclasses
import json
import sys
import zipfile
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

import duckdb
import goatlib.io.ingest
import pytest
from goatlib.io import discover
from goatlib.io.converter import IOConverter, SourceInfo
from goatlib.io.formats import (
    ALL_EXTS,
    NON_GDAL_EXTS,
    RASTER_EXTS,
    READ_DRIVERS,
    refuse_unsupported_format,
)
from goatlib.io.ingest import convert_all, convert_any
from goatlib.io.sql import sql_literal
from goatlib.io.utils import get_metadata

DATA = Path(__file__).parents[2] / "data" / "io"


def _feature_collection(**properties: Any) -> str:
    return json.dumps(
        {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": properties,
                    "geometry": {"type": "Point", "coordinates": [1.0, 2.0]},
                }
            ],
        }
    )


# Content of another format: a KML document with one placemark.
KML_DOCUMENT = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark>'
    "<name>a</name><Point><coordinates>1,2</coordinates></Point>"
    "</Placemark></Document></kml>"
)


GEOJSON_DRIVERS = ("GeoJSON", "GeoJSONSeq")
JSON_DRIVERS = ("GeoJSON", "GeoJSONSeq", "ESRIJSON", "TopoJSON")
GPKG_DRIVERS = ("GPKG",)
XLSX_DRIVERS = ("XLSX",)


def _tokens(sql: str) -> list[tuple[str, Any]]:
    """`sql` as DuckDB's tokenizer reads it, as (text, type) pairs: a comment
    gives no token, a string literal exactly one."""
    found = duckdb.tokenize(sql)
    ends = [pos for pos, _ in found[1:]] + [len(sql)]
    return [(sql[pos:end].strip(), kind) for (pos, kind), end in zip(found, ends)]


def _st_read_calls(sql: str) -> list[tuple[str, tuple[str, ...] | None]]:
    """Each `ST_Read...` call in `sql`, with the driver list passed in its own
    argument list (None when it passes none)."""
    tokens = _tokens(sql)
    calls = []
    for i, (name, kind) in enumerate(tokens):
        if kind != duckdb.token_type.identifier or not name.lower().startswith(
            "st_read"
        ):
            continue
        drivers, depth, j = None, 0, i + 1
        while j < len(tokens):
            text, kind = tokens[j]
            if kind == duckdb.token_type.operator and text == "(":
                depth += 1
            elif kind == duckdb.token_type.operator and text == ")":
                depth -= 1
                if depth == 0:
                    break
            elif depth == 1 and text.lower() == "allowed_drivers":
                assert [t.upper() for t, _ in tokens[j + 1 : j + 4]] == [
                    "=",
                    "ARRAY",
                    "[",
                ], sql
                names, j = [], j + 4
                while tokens[j][0] != "]":
                    if tokens[j][1] == duckdb.token_type.string_const:
                        names.append(tokens[j][0][1:-1].replace("''", "'"))
                    j += 1
                drivers = tuple(names)
            j += 1
        calls.append((name, drivers))
    return calls


def _reads(statements: list[str]) -> list[str]:
    return [s for s in statements if _st_read_calls(s)]


def _assert_every_read_names(statements: list[str], drivers: tuple[str, ...]) -> None:
    """Every `ST_Read` call DuckDB finds in the statements passes exactly
    `drivers`. A list in a comment or inside a string (a file name) is no
    argument, and an `ST_Read_Meta`, which takes no list, fails the check."""
    calls = [call for statement in statements for call in _st_read_calls(statement)]
    assert calls, "nothing was read with ST_Read"
    for name, passed in calls:
        assert (name.lower(), passed) == ("st_read", drivers), (name, passed)


def test_the_check_is_not_satisfied_by_a_comment_or_a_string():
    list_after_a_comment_marker = (
        "SELECT * FROM ST_Read('/tmp/x/a.geojson') "
        "-- allowed_drivers=ARRAY['GeoJSON', 'GeoJSONSeq']"
    )
    list_inside_a_path = (
        "SELECT * FROM ST_Read('/tmp/x/allowed_drivers=ARRAY[''GPKG''].gpkg')"
    )
    passed = "SELECT * FROM ST_Read('/tmp/it''s.gpkg', layer='a', " + (
        "allowed_drivers=ARRAY['GPKG'])"
    )

    assert _st_read_calls(list_after_a_comment_marker) == [("ST_Read", None)]
    assert _st_read_calls(list_inside_a_path) == [("ST_Read", None)]
    assert _st_read_calls(passed) == [("ST_Read", ("GPKG",))]
    assert _st_read_calls("SELECT * FROM ST_Read_Meta('/tmp/a.gpkg')") == [
        ("ST_Read_Meta", None)
    ]


def test_an_xml_document_is_refused(tmp_path: Path, recorded: list[str]):
    source = tmp_path / "data.xml"
    source.write_text(KML_DOCUMENT)

    with pytest.raises(ValueError, match=r"^Unsupported file format: \.xml$"):
        IOConverter().to_parquet(str(source), tmp_path / "out.parquet")

    assert _reads(recorded) == []


def test_content_of_another_format_named_geojson_is_not_read(
    tmp_path: Path, recorded: list[str]
):
    source = tmp_path / "data.geojson"
    source.write_text(KML_DOCUMENT)

    with pytest.raises(ValueError):
        IOConverter().to_parquet(str(source), tmp_path / "out.parquet")

    _assert_every_read_names(recorded, GEOJSON_DRIVERS)


def test_content_of_another_format_named_gpkg_is_not_read(
    tmp_path: Path, recorded: list[str]
):
    source = tmp_path / "data.gpkg"
    source.write_text(KML_DOCUMENT)

    with pytest.raises(ValueError):
        IOConverter().to_parquet(str(source), tmp_path / "out.parquet")

    _assert_every_read_names(recorded, GPKG_DRIVERS)


def test_a_geojson_whose_name_holds_other_text_is_read_as_geojson(
    tmp_path: Path, recorded: list[str]
):
    """Only the GeoJSON drivers read it, whatever text it holds; its schema
    comes from that reader, not from `ST_Read_Meta`, which takes no driver
    list."""
    source = tmp_path / "data.geojson"
    source.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "name": KML_DOCUMENT,
                "features": [
                    {
                        "type": "Feature",
                        "properties": {"a": 1},
                        "geometry": {"type": "Point", "coordinates": [1.0, 2.0]},
                    }
                ],
            }
        )
    )

    meta = IOConverter().to_parquet(str(source), tmp_path / "out.parquet")

    assert meta.feature_count == 1
    assert meta.crs == "EPSG:4326"
    _assert_every_read_names(recorded, GEOJSON_DRIVERS)


def test_crs_stripped_copy_is_read_with_the_geojson_drivers(
    tmp_path: Path, recorded: list[str]
):
    """The copy without an unresolvable `crs` member is the user's file all
    the same, so its extent read names the drivers too."""
    source = tmp_path / "data.geojson"
    source.write_text(
        KML_DOCUMENT + '<!-- "crs": {"properties": {"name": "no-such-crs"}} -->'
    )

    with pytest.raises(duckdb.IOException):
        IOConverter().to_parquet(str(source), tmp_path / "out.parquet")

    _assert_every_read_names(recorded, GEOJSON_DRIVERS)


def _unresolvable_crs_geojson(tmp_path: Path) -> Path:
    path = tmp_path / "typo.geojson"
    path.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "crs": {
                    "type": "name",
                    "properties": {"name": "urn:ogc:def:crs:OGC:1.3/CRS84"},
                },
                "features": [
                    {
                        "type": "Feature",
                        "properties": {"name": "a"},
                        "geometry": {"type": "Point", "coordinates": [16.34, 48.21]},
                    }
                ],
            }
        )
    )
    return path


_SOURCES = [
    ("vector/valid/geojson/points.geojson", {}, GEOJSON_DRIVERS),
    ("vector/valid/geojson/line.geojson", {}, GEOJSON_DRIVERS),
    ("vector/valid/geojson/polygon.geojson", {}, GEOJSON_DRIVERS),
    ("crs-stripped", {}, GEOJSON_DRIVERS),
    ("vector/valid/gpkg/point.gpkg", {}, GPKG_DRIVERS),
    ("vector/valid/gpkg/multiple_layers.gpkg::boundary_epsg_3857", {}, GPKG_DRIVERS),
    ("vector/valid/kml/polygon.kml", {}, ("KML",)),
    ("vector/valid/kmz/point.kmz", {}, ("KML",)),
    ("vector/valid/gpx/point.gpx", {}, ("GPX",)),
    (
        "vector/valid/shapefile/polygon.zip",
        {},
        ("ESRI Shapefile",),
    ),
    ("tabular/valid/table.xlsx", {}, XLSX_DRIVERS),
    ("tabular/valid/multi_sheet.xlsx", {"has_header": True}, XLSX_DRIVERS),
    ("tabular/valid/no_header.xlsx", {"has_header": False}, XLSX_DRIVERS),
]


@pytest.mark.parametrize(
    ("source", "kwargs", "drivers"),
    _SOURCES,
    ids=[Path(source).name for source, _, _ in _SOURCES],
)
def test_every_source_st_read_has_allowed_drivers(
    tmp_path: Path,
    recorded: list[str],
    source: str,
    kwargs: dict,
    drivers: tuple[str, ...],
):
    src = (
        str(_unresolvable_crs_geojson(tmp_path))
        if source == "crs-stripped"
        else str(DATA / source)
    )

    meta = IOConverter().to_parquet(
        src, tmp_path / "out.parquet", target_crs="EPSG:4326", **kwargs
    )

    assert meta.feature_count
    assert not [s for s in recorded if "ST_Read_Meta" in s]
    # The geometry type comes from the output, not from a second source read.
    assert not [s for s in recorded if "ST_GeometryType" in s and _st_read_calls(s)]
    _assert_every_read_names(recorded, drivers)


@pytest.mark.parametrize(
    ("source", "rows"),
    [
        ("tabular/valid/table.csv", 430),
        ("tabular/valid/table.tsv", 366),
        ("tabular/valid/example.txt", 13),
        ("vector/valid/geojson/polygon.parquet", 5),
    ],
)
def test_formats_read_without_gdal_still_convert(
    tmp_path: Path, recorded: list[str], source: str, rows: int
):
    meta = IOConverter().to_parquet(str(DATA / source), tmp_path / "out.parquet")

    assert meta.feature_count == rows
    assert _reads(recorded) == []


def test_wfs_datasource_handling_is_gone():
    assert "is_wfs_xml" not in {f.name for f in dataclasses.fields(SourceInfo)}
    assert not hasattr(IOConverter, "_is_wfs_xml_datasource")
    assert not hasattr(goatlib.io.ingest, "_is_wfs_xml_datasource")


def test_read_drivers_are_drivers_of_the_bundled_gdal():
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    drivers = con.execute("SELECT short_name FROM ST_Drivers()").fetchall()
    available = {row[0] for row in drivers}

    assert set(READ_DRIVERS) <= ALL_EXTS
    for suffix, drivers in READ_DRIVERS.items():
        assert drivers and set(drivers) <= available, suffix


def test_metadata_reads_name_the_drivers_of_the_input(
    tmp_path: Path, recorded: list[str]
):
    source = tmp_path / "data.geojson"
    source.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "name": KML_DOCUMENT,
                "features": [
                    {
                        "type": "Feature",
                        "properties": {"a": 1},
                        "geometry": {"type": "Point", "coordinates": [1.0, 2.0]},
                    }
                ],
            }
        )
    )

    meta = get_metadata(IOConverter().con, str(source))

    assert meta.geometry_column == "geom"
    assert meta.crs is not None and meta.crs.to_epsg() == 4326
    assert (meta.geometry_type or "").upper() == "POINT"
    _assert_every_read_names(recorded, GEOJSON_DRIVERS)


def test_metadata_refuses_a_format_without_drivers(tmp_path: Path):
    source = tmp_path / "data.xml"
    source.write_text(KML_DOCUMENT)
    con = duckdb.connect()

    with pytest.raises(ValueError, match=r"^Unsupported file format: \.xml$"):
        get_metadata(con, str(source))


def test_gpkg_that_is_not_sqlite_is_not_opened_for_its_layers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, recorded: list[str]
):
    """Listing a GeoPackage's layers takes `ST_Read_Meta`, which names no
    drivers: only a file that is an SQLite database gets that far."""
    source = tmp_path / "data.gpkg"
    source.write_text(KML_DOCUMENT)
    connects: list[str] = []

    def connect(*args: Any, **kwargs: Any) -> None:
        connects.append("connect")
        raise AssertionError("ST_Read_Meta must not run on this file")

    monkeypatch.setattr(discover, "duckdb", SimpleNamespace(connect=connect))

    assert discover.discover_inputs(str(source)) == [str(source)]
    assert connects == []
    with pytest.raises(ValueError):
        convert_any(str(source), tmp_path / "out")
    _assert_every_read_names(recorded, GPKG_DRIVERS)


def test_gpkg_layers_are_still_listed():
    source = DATA / "vector/valid/gpkg/multiple_layers.gpkg"

    assert discover.discover_inputs(str(source)) == [
        f"{source}::{layer}"
        for layer in (
            "test_geopackage",
            "centroid",
            "boundary",
            "boundary_epsg_3857",
            "layer_styles",
        )
    ]


# Content that is not a GeoTIFF (only the faked `osgeo.gdal` sees it).
NOT_A_GEOTIFF = "not a GeoTIFF"


class _FakeGdal(ModuleType):
    """The part of `osgeo.gdal` that `to_cog` uses, recording how it opens."""

    OF_RASTER = 0x02

    def __init__(self, dataset: Any) -> None:
        super().__init__("osgeo.gdal")
        self.dataset = dataset
        self.opened: list[tuple[str, int, Any]] = []
        self.written: list[str] = []

    def Open(self, *args: Any, **kwargs: Any) -> Any:  # noqa: N802
        raise AssertionError("gdal.Open lets the file's content pick the driver")

    def OpenEx(self, path: str, flags: int = 0, **kwargs: Any) -> Any:  # noqa: N802
        self.opened.append((path, flags, kwargs.get("allowed_drivers")))
        return self.dataset

    def TranslateOptions(self, **kwargs: Any) -> dict:  # noqa: N802
        return kwargs

    def Translate(self, dest: str, src: Any, options: Any = None) -> None:  # noqa: N802
        self.written.append(dest)


@pytest.fixture
def fake_gdal(monkeypatch: pytest.MonkeyPatch):
    def install(dataset: Any) -> _FakeGdal:
        gdal = _FakeGdal(dataset)
        osgeo = ModuleType("osgeo")
        osgeo.gdal = gdal  # type: ignore[attr-defined]
        monkeypatch.setitem(sys.modules, "osgeo", osgeo)
        monkeypatch.setitem(sys.modules, "osgeo.gdal", gdal)
        return gdal

    return install


def test_raster_content_of_another_format_is_not_read(tmp_path: Path, fake_gdal):
    source = tmp_path / "data.tif"
    source.write_text(NOT_A_GEOTIFF)
    # The GeoTIFF drivers cannot open it.
    gdal = fake_gdal(None)

    with pytest.raises(FileNotFoundError, match="Cannot open raster"):
        IOConverter().to_cog(str(source), tmp_path / "out.tif")

    assert gdal.opened == [(str(source), gdal.OF_RASTER, ["GTiff", "COG"])]


def test_a_geotiff_is_opened_with_the_geotiff_drivers(tmp_path: Path, fake_gdal):
    dataset = SimpleNamespace(GetProjectionRef=lambda: "", GetProjection=lambda: "")
    gdal = fake_gdal(dataset)
    source = DATA / "raster" / "imagery.tif"

    meta = IOConverter().to_cog(str(source), tmp_path / "out.tif")

    assert gdal.opened == [(str(source), gdal.OF_RASTER, ["GTiff", "COG"])]
    assert gdal.written == [str(tmp_path / "out.tif")]
    assert meta.source_type == "raster"


def test_esri_json_still_converts(tmp_path: Path, recorded: list[str]):
    """A `.json` may also be ESRI JSON or TopoJSON, which their drivers read
    from the file alone."""
    source = tmp_path / "features.json"
    source.write_text(
        json.dumps(
            {
                "geometryType": "esriGeometryPoint",
                "spatialReference": {"wkid": 4326},
                "fields": [{"name": "id", "type": "esriFieldTypeInteger"}],
                "features": [
                    {"attributes": {"id": 1}, "geometry": {"x": 16.34, "y": 48.21}}
                ],
            }
        )
    )

    meta = IOConverter().to_parquet(str(source), tmp_path / "out.parquet")

    assert meta.feature_count == 1
    assert meta.crs == "EPSG:4326"
    _assert_every_read_names(recorded, JSON_DRIVERS)


def test_topojson_still_converts(tmp_path: Path, recorded: list[str]):
    source = tmp_path / "topology.json"
    source.write_text(
        json.dumps(
            {
                "type": "Topology",
                "objects": {
                    "places": {
                        "type": "GeometryCollection",
                        "geometries": [
                            {
                                "type": "Point",
                                "coordinates": [16.34, 48.21],
                                "properties": {"id": 1},
                            }
                        ],
                    }
                },
                "arcs": [],
            }
        )
    )

    meta = IOConverter().to_parquet(str(source), tmp_path / "out.parquet")

    assert meta.feature_count == 1
    _assert_every_read_names(recorded, JSON_DRIVERS)


# ---------------------------------------------------------------------------
# A file's name and its column names are data, never SQL
# ---------------------------------------------------------------------------


def _archive(path: Path, members: dict[str, str]) -> Path:
    with zipfile.ZipFile(path, "w") as zf:
        for name, content in members.items():
            zf.writestr(name, content)
    return path


def _column(parquet: str, column: str) -> list[Any]:
    con = duckdb.connect()
    rows = con.execute(f"SELECT {column} FROM read_parquet(?)", [parquet]).fetchall()
    return [row[0] for row in rows]


# A name with a quote, a double quote, a semicolon and a comment marker, which
# converts unchanged.
ODD_MEMBER = 'it\'s -- "x"; y'


def test_a_member_name_with_quotes_and_comment_markers_is_read_as_itself(
    tmp_path: Path, recorded: list[str]
):
    """The member is read with the drivers of its format and keeps its own
    data and name, beside another member."""
    archive = _archive(
        tmp_path / "upload.zip",
        {
            f"{ODD_MEMBER}.geojson": _feature_collection(via="member"),
            "other.geojson": _feature_collection(via="other"),
        },
    )

    report = convert_all(str(archive), tmp_path / "out")

    assert report.failures == []
    outputs = {o.name: o.path for o in report.outputs}
    assert sorted(outputs) == sorted(["other", ODD_MEMBER])
    assert _column(outputs[ODD_MEMBER], "via") == ["member"]
    assert _column(outputs["other"], "via") == ["other"]
    _assert_every_read_names(recorded, GEOJSON_DRIVERS)


def test_member_names_with_semicolons_convert_and_leave_no_table(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    connections: list[Any] = []
    original_init = IOConverter.__init__

    def keep_connection(self: IOConverter) -> None:
        original_init(self)
        connections.append(self.con)

    monkeypatch.setattr(IOConverter, "__init__", keep_connection)
    name = "Bäume 'alt'; Stand 2024"
    archive = _archive(
        tmp_path / "upload.zip",
        {
            f"{name}.geojson": _feature_collection(a=1),
            "ok.geojson": _feature_collection(a=2),
        },
    )

    report = convert_all(str(archive), tmp_path / "out")

    assert report.failures == []
    assert sorted(o.name for o in report.outputs) == sorted(["ok", name])
    assert connections
    for con in connections:
        assert con.execute("SELECT count(*) FROM duckdb_tables()").fetchone() == (0,)


def test_a_member_name_with_quotes_and_dashes_converts(tmp_path: Path):
    name = """it's "quoted" -- here"""
    archive = _archive(
        tmp_path / "upload.zip", {f"{name}.geojson": _feature_collection(a=1)}
    )

    report = convert_all(str(archive), tmp_path / "out")

    assert report.failures == []
    assert [o.name for o in report.outputs] == [name]
    assert report.outputs[0].metadata.feature_count == 1
    assert Path(report.outputs[0].path).name == f"{name}.parquet"


def test_a_quoted_geometry_column_keeps_its_type(tmp_path: Path):
    source = tmp_path / "quoted.gpkg"
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute(
        "COPY (SELECT 1 AS id, ST_Point(16.34, 48.21) AS geom) TO "
        f"'{source}' WITH (FORMAT GDAL, DRIVER 'GPKG', SRS 'EPSG:4326', "
        "LAYER_CREATION_OPTIONS 'GEOMETRY_NAME=g\"x')"
    )

    meta = IOConverter().to_parquet(
        str(source), tmp_path / "out.parquet", target_crs="EPSG:4326"
    )

    assert meta.feature_count == 1
    assert meta.geometry_type == "POINT"
    assert meta.crs == "EPSG:4326"


def test_a_column_mapping_renames_a_quoted_column(tmp_path: Path):
    source = tmp_path / "data.geojson"
    source.write_text(_feature_collection(**{'na"me': "a", "other": 1}))

    IOConverter().to_parquet(
        str(source),
        tmp_path / "out.parquet",
        target_crs="EPSG:4326",
        column_mapping={'na"me': "label"},
    )

    con = duckdb.connect()
    columns = [
        row[0]
        for row in con.execute(
            "DESCRIBE SELECT * FROM read_parquet(?)", [str(tmp_path / "out.parquet")]
        ).fetchall()
    ]
    assert "label" in columns and "other" in columns and "geometry" in columns
    assert 'na"me' not in columns and "geom" not in columns
    assert _column(str(tmp_path / "out.parquet"), "label") == ["a"]


@pytest.mark.parametrize("target_crs", [None, "EPSG:4326"])
def test_the_geometry_type_is_the_selected_columns(tmp_path: Path, target_crs):
    """With two geometry columns in the output, the type reported is that of
    the column the converter took as the geometry (the WKT `geometry`), not
    of the first one (`area`, a polygon the file already held as geometry)."""
    source = tmp_path / "two.parquet"
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute(
        "COPY (SELECT ST_GeomFromText('POLYGON((0 0, 1 0, 1 1, 0 0))') AS area, "
        f"'POINT (1 2)' AS geometry) TO {sql_literal(source)}"
    )

    meta = IOConverter().to_parquet(
        str(source), tmp_path / "out.parquet", target_crs=target_crs
    )

    assert meta.geometry_type == "POINT"


def test_a_wkt_table_reports_its_geometry_type(tmp_path: Path):
    meta = IOConverter().to_parquet(
        str(DATA / "tabular/valid/wkt_geometry_wgs84.csv"), tmp_path / "out.parquet"
    )

    assert meta.source_type == "vector"
    assert meta.geometry_type


# ---------------------------------------------------------------------------
# One set of accepted formats
# ---------------------------------------------------------------------------


def test_every_accepted_format_has_a_reader():
    """What core presigns and the import accepts (`ALL_EXTS`) is exactly what
    the converter reads: with GDAL drivers, a reader of its own, or as a
    raster."""
    assert ALL_EXTS == set(READ_DRIVERS) | NON_GDAL_EXTS | RASTER_EXTS


def test_a_dsv_table_converts(tmp_path: Path, recorded: list[str]):
    source = tmp_path / "table.dsv"
    source.write_text("id|name\n1|a\n2|b\n")

    meta = IOConverter().to_parquet(str(source), tmp_path / "out.parquet")

    assert meta.feature_count == 2
    assert _reads(recorded) == []


def test_a_name_without_extension_is_refused_clearly(tmp_path: Path):
    source = tmp_path / "data"
    source.write_text(_feature_collection(a=1))
    message = r"^Unsupported file format: no file extension$"

    with pytest.raises(ValueError, match=message):
        refuse_unsupported_format("users/u/imports/uploads/data")
    with pytest.raises(ValueError, match=message):
        IOConverter().to_parquet(str(source), tmp_path / "out.parquet")
