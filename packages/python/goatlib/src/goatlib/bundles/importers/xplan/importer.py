"""XPlanGML files as `xplan` bundles: one member layer per plan object class."""

import logging
import re
import shutil
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, List

from goatlib.bundles.importers.base import (
    BundleImporter,
    ExtractedLayer,
    ValidationResult,
    register_importer,
)
from goatlib.bundles.importers.xplan.schema import version_from_namespace
from goatlib.io.config import parquet_copy_options
from goatlib.models.bundle import BundleTypeName

# duckdb, pyarrow, pyogrio and shapely (io.curves) are loaded only when a plan
# is read: core imports the importers but installs goatlib without them.
if TYPE_CHECKING:
    import duckdb
    import pyarrow as pa

logger = logging.getLogger(__name__)

#: How much of a file is read to tell XPlanGML from other GML: the namespace
#: is declared on the root element, in the first lines.
SNIFF_BYTES = 65536

#: The XPlanGML namespace as a file declares it. A declaration, not the bare
#: address, which another GML may mention in a comment or a value. With or
#: without a prefix, in either quotes.
_XPLAN_NS = re.compile(
    rb"xmlns(?::[\w.-]+)?\s*=\s*[\"'](http://www\.xplanung\.de/xplangml/\d+/\d+)[\"']"
)

#: Objects that only place labels and symbols on the printed plan. GOAT labels
#: from attributes, so they are not imported.
PRESENTATION_CLASSES = frozenset(
    {
        "XP_PPO",
        "XP_PTO",
        "XP_LPO",
        "XP_LTO",
        "XP_FPO",
        "XP_Praesentationsobjekt",
        "XP_Nutzungsschablone",
    }
)

#: Role of the plan's text clauses, of whichever classes they come.
TEXT_ROLE = "text"

#: GDAL's GML driver: no `.gfs` schema cache beside the upload (a stale one
#: breaks later reads), and no fetching of the schema a file points at.
OPEN_OPTIONS = {"WRITE_GFS": "NO", "DOWNLOAD_SCHEMA": "NO"}

_FAMILIES = {
    "POINT": "point",
    "MULTIPOINT": "point",
    "LINESTRING": "line",
    "MULTILINESTRING": "line",
    "POLYGON": "polygon",
    "MULTIPOLYGON": "polygon",
}


def xplan_namespace(path: str | Path) -> str | None:
    """The XPlanGML namespace the file declares, or None for any other file."""
    try:
        with open(path, "rb") as f:
            head = f.read(SNIFF_BYTES)
    except OSError:
        return None
    match = _XPLAN_NS.search(head)
    return match.group(1).decode() if match else None


def _classes(path: str) -> list[str]:
    """The file's object classes. `list_layers` takes no open options, so it
    writes GDAL's `.gfs` cache; one it created is removed again."""
    import pyogrio

    gfs = Path(path).with_suffix(".gfs")
    existed = gfs.exists()
    try:
        return [name for name, _ in pyogrio.list_layers(path)]
    finally:
        if not existed:
            gfs.unlink(missing_ok=True)


_XLINK = b'xmlns:xlink="http://www.w3.org/1999/xlink"'
_ROOT = re.compile(rb"<(?![?!])[\w:.-]+")
_XLINK_DECLARED = re.compile(rb"xmlns:xlink\s*=")

#: Columns GDAL makes from each object's own `gml:boundedBy`: not plan data.
_BOUNDS_COLUMNS = ("Envelope_srsName", "lowerCorner", "upperCorner")


def copy_with_root_xlink(source: str | Path, target: Path) -> None:
    """Copy the file to `target` (a `.gml`), the xlink namespace declared on
    its root element.

    The copy also gives GDAL a `.gml` name to read: the worker saves an upload
    as `<tmp>.zip`, which GDAL would open as an archive. WFS downloads
    (Hamburg's) declare xlink on each link instead of the root, and for some of
    those files GDAL then reads no `<field>_href` column at all, which loses
    every link between objects. Only the start of the file is changed; the rest
    is streamed.
    """
    with open(source, "rb") as src, open(target, "wb") as dst:
        head = src.read(SNIFF_BYTES)
        root = _ROOT.search(head)
        end = head.find(b">", root.end()) if root else -1
        if root and end != -1 and not _XLINK_DECLARED.search(head[root.start() : end]):
            head = head[: root.end()] + b" " + _XLINK + head[root.end() :]
        dst.write(head)
        shutil.copyfileobj(src, dst)


def _is_text(cls: str) -> bool:
    return cls.endswith("TextAbschnitt") or cls.endswith("BegruendungAbschnitt")


def _sql_name(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


class XPlanImporter(BundleImporter):
    bundle_type = BundleTypeName.xplan
    accepted_extensions = (".gml",)

    def matches_filename(self, filename: str) -> bool:
        # Any GML may be XPlan or not; only the content tells.
        return False

    def matches_source(self, source_path: str) -> bool:
        return xplan_namespace(source_path) is not None

    def validate(self, source_path: str) -> ValidationResult:
        if xplan_namespace(source_path) is None:
            return ValidationResult(valid=False, errors=["The file is not XPlanGML."])
        # A file without a plan object (one class from an XPlan WFS) still
        # imports; its plan columns stay empty.
        try:
            with tempfile.TemporaryDirectory() as tmp:
                copy = Path(tmp) / "source.gml"
                copy_with_root_xlink(source_path, copy)
                classes = [
                    c for c in _classes(str(copy)) if c not in PRESENTATION_CLASSES
                ]
        except Exception as e:
            return ValidationResult(
                valid=False, errors=[f"The file cannot be read: {e}"]
            )
        if not classes:
            return ValidationResult(
                valid=False, errors=["The file holds no plan objects."]
            )
        return ValidationResult(valid=True, detected_roles=sorted(classes))

    @staticmethod
    def _read(source_path: str) -> dict[str, tuple["pa.Table", str | None]]:
        """Every class's objects, arcs straightened into a `_wkb` column.

        Returns class to (table, CRS of its geometry or None). Links between
        objects (`xlink:href`) are XML attributes, which GDAL keeps as
        `<field>_href` columns only when told to; the setting is process wide,
        so it is set for these reads alone.
        """
        import pyarrow as pa
        import pyogrio

        from goatlib.io.curves import linear_wkb

        tables: dict[str, tuple["pa.Table", str | None]] = {}
        pyogrio.set_gdal_config_options({"GML_ATTRIBUTES_TO_OGR_FIELDS": "YES"})
        try:
            for cls in _classes(source_path):
                if cls in PRESENTATION_CLASSES:
                    continue
                meta, table = pyogrio.read_arrow(source_path, layer=cls, **OPEN_OPTIONS)
                if table.num_rows == 0:
                    continue
                geometry = meta.get("geometry_name") or "wkb_geometry"
                has_geometry = geometry in table.column_names
                # A class with several geometry properties repeats the others
                # as raw binary columns, which nothing reads.
                binary = [
                    f.name
                    for f in table.schema
                    if pa.types.is_binary(f.type) and f.name != geometry
                ]
                # A file declaring xlink on each link (WFS downloads) gets a
                # `<field>_xlink` column per link holding only the namespace.
                noise = [
                    c
                    for c in table.column_names
                    if c in _BOUNDS_COLUMNS or c.endswith("_xlink")
                ]
                table = table.drop_columns(binary + noise)
                if has_geometry:
                    wkb = [linear_wkb(v) for v in table.column(geometry).to_pylist()]
                    table = table.drop_columns([geometry]).append_column(
                        "_wkb", pa.array(wkb, type=pa.binary())
                    )
                tables[cls] = (table, meta.get("crs") if has_geometry else None)
        finally:
            pyogrio.set_gdal_config_options({"GML_ATTRIBUTES_TO_OGR_FIELDS": None})
        return tables

    @staticmethod
    def _lists_to_text(con: "duckdb.DuckDBPyConnection", table: str) -> None:
        """Multi-valued fields as one text value each: GeoPackage stores no lists."""
        for column, column_type, *_ in con.execute(f"DESCRIBE {table}").fetchall():
            if column_type.endswith("[]"):
                con.execute(
                    f"ALTER TABLE {table} ALTER {_sql_name(column)} TYPE VARCHAR "
                    f"USING array_to_string({_sql_name(column)}, '; ')"
                )

    def extract_layers(self, source_path: str, workdir: str) -> List[ExtractedLayer]:
        import duckdb

        from goatlib.bundles.importers.xplan.decode import decorate

        out = Path(workdir)
        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        version = version_from_namespace(xplan_namespace(source_path) or "")
        copy = out / "source.gml"
        copy_with_root_xlink(source_path, copy)
        read = decorate(self._read(str(copy)), version)
        tables: dict[str, tuple[str, str | None]] = {}
        for i, (cls, (arrow, crs)) in enumerate(read.items()):
            source, name = f"src_{i}", f"t_{i}"
            con.register(source, arrow)
            geometry_sql = (
                " EXCLUDE (_wkb), ST_GeomFromWKB(_wkb) AS geometry" if crs else ""
            )
            con.execute(f"CREATE TABLE {name} AS SELECT *{geometry_sql} FROM {source}")
            con.unregister(source)
            self._lists_to_text(con, name)
            tables[cls] = (name, crs)

        layers: List[ExtractedLayer] = []
        texts = [table for cls, (table, _) in tables.items() if _is_text(cls)]
        if texts:
            path = out / "text.parquet"
            union = " UNION ALL BY NAME ".join(f"SELECT * FROM {t}" for t in texts)
            con.execute(f"COPY ({union}) TO '{path}' {parquet_copy_options()}")
            layers.append(
                ExtractedLayer(
                    role=TEXT_ROLE,
                    name="Textliche Festsetzungen",
                    layer_type="table",
                    file_path=str(path),
                )
            )

        for i, (cls, (table, crs)) in enumerate(sorted(tables.items())):
            if _is_text(cls):
                continue
            if crs is None:
                path = out / f"{i}.parquet"
                con.execute(f"COPY {table} TO '{path}' {parquet_copy_options()}")
                layers.append(
                    ExtractedLayer(
                        role=cls, name=cls, layer_type="table", file_path=str(path)
                    )
                )
                continue
            counts = con.execute(
                f"SELECT ST_GeometryType(geometry)::VARCHAR, count(*) FROM {table} "
                "WHERE geometry IS NOT NULL GROUP BY 1"
            ).fetchall()
            families: dict[str, int] = {}
            for geometry_type, n in counts:
                family = _FAMILIES.get(geometry_type)
                if family:
                    families[family] = families.get(family, 0) + n
            if not families:
                continue
            # Objects without a position stay with the class's main geometry.
            main = max(families, key=families.get)
            for family in sorted(families):
                types = [t for t, f in _FAMILIES.items() if f == family]
                where = "ST_GeometryType(geometry)::VARCHAR IN ({})".format(
                    ", ".join(f"'{t}'" for t in types)
                )
                if family == main:
                    where += " OR geometry IS NULL"
                role = cls if len(families) == 1 else f"{cls}:{family}"
                path = out / f"{i}_{family}.gpkg"
                con.execute(
                    f"COPY (SELECT * FROM {table} WHERE {where}) TO '{path}' "
                    f"(FORMAT GDAL, DRIVER 'GPKG', SRS '{crs}')"
                )
                layers.append(
                    ExtractedLayer(
                        role=role,
                        name=cls if len(families) == 1 else f"{cls} ({family})",
                        layer_type="feature",
                        geometry_type=family,
                        file_path=str(path),
                    )
                )
        con.close()
        if not layers:
            raise ValueError("The file holds no plan objects GOAT can read.")
        return layers


register_importer(XPlanImporter())
