"""XPlanGML files as `xplan` bundles: one member layer per plan object class."""

import logging
import re
import shutil
import tempfile
import zipfile
from contextlib import ExitStack, contextmanager
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Iterator, List

from goatlib.bundles.importers.base import (
    BundleImporter,
    ExtractedLayer,
    ValidationResult,
    bound_duckdb,
    register_importer,
)
from goatlib.bundles.importers.xplan.schema import (
    unsupported,
    version_from_namespace,
)
from goatlib.io.config import parquet_copy_options
from goatlib.io.sql import sql_literal
from goatlib.models.bundle import BundleTypeName

# duckdb, pyarrow and shapely (io.gml, io.curves) are loaded only when a plan
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


#: The plan in a plan's archive (XPlanArchiv): a ZIP that holds the plan
#: under this name, its documents and raster images beside it.
ARCHIVE_PLAN = "xplan.gml"


def _archive_plans(path: str | Path) -> list[str] | None:
    """The members named `xplan.gml` in a ZIP archive's directory, or None for
    a file that is no ZIP. Told by content, since an upload is saved as
    `<tmp>.zip` whatever it is; and before the namespace is looked for, since
    an archive that only stores its members starts like the plan itself."""
    if not zipfile.is_zipfile(path):
        return None
    try:
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
    except (zipfile.BadZipFile, OSError):
        return []
    return [n for n in names if PurePosixPath(n).name.lower() == ARCHIVE_PLAN]


@contextmanager
def plan_file(source_path: str) -> Iterator[str]:
    """The plan's GML file: the upload itself, or the `xplan.gml` of an
    uploaded archive.

    An archive is unpacked by the dataset upload's own handling
    (`io.discover.extract_zip_safely`: its limit on the unpacked size, no
    member outside the archive), and what was unpacked is removed on exit.

    Raises:
        ValueError: the archive is refused, or holds no plan or several
    """
    if _archive_plans(source_path) is None:
        yield source_path
        return
    # Loaded only here: `io.discover` needs the geospatial stack (see above).
    from goatlib.io.discover import DiscoveryError, extract_zip_safely

    with ExitStack() as stack:
        try:
            unpacked = stack.enter_context(extract_zip_safely(Path(source_path)))
        except DiscoveryError as error:
            raise ValueError(str(error)) from error
        stack.callback(shutil.rmtree, unpacked, ignore_errors=True)
        plans = sorted(
            p
            for p in unpacked.rglob("*")
            if p.is_file() and p.name.lower() == ARCHIVE_PLAN
        )
        if not plans:
            raise ValueError(f"The archive holds no {ARCHIVE_PLAN}.")
        if len(plans) > 1:
            raise ValueError(f"The archive holds more than one {ARCHIVE_PLAN}.")
        yield str(plans[0])


def _classes(path: str) -> list[str]:
    """The file's object classes, as GDAL's GML driver reads them (`io/gml.py`).

    Raises:
        ValueError: the file is no GML that can be read
    """
    from goatlib.io.gml import gml_classes

    return gml_classes(path)


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
    accepted_extensions = (".gml", ".zip")

    def matches_filename(self, filename: str) -> bool:
        # Any GML may be XPlan or not, and any ZIP a plan's archive or not;
        # only the content tells.
        return False

    def matches_source(self, source_path: str) -> bool:
        # An archive by its directory alone: this runs in core's request, and
        # `validate` reads the plan in it.
        plans = _archive_plans(source_path)
        if plans is not None:
            return bool(plans)
        return xplan_namespace(source_path) is not None

    def validate(self, source_path: str) -> ValidationResult:
        try:
            with plan_file(source_path) as plan:
                return self._validate_plan(plan)
        except ValueError as error:
            return ValidationResult(valid=False, errors=[str(error)])

    @staticmethod
    def _validate_plan(source_path: str) -> ValidationResult:
        namespace = xplan_namespace(source_path)
        if namespace is None:
            return ValidationResult(valid=False, errors=["The file is not XPlanGML."])
        # Decoding and the styles need the version's code lists.
        refusal = unsupported(version_from_namespace(namespace))
        if refusal:
            return ValidationResult(valid=False, errors=[refusal])
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
    def _read(
        con: "duckdb.DuckDBPyConnection", source_path: str
    ) -> dict[str, tuple["pa.Table", str | None]]:
        """Every class's objects, arcs straightened into a `_wkb` column.

        Returns class to (table, CRS of its geometry or None). Read by
        `io/gml.py` with the GML driver alone; links between objects
        (`xlink:href`) are XML attributes, kept as `<field>_href` columns.
        """
        from goatlib.io.gml import GmlFile

        tables: dict[str, tuple["pa.Table", str | None]] = {}
        with GmlFile(source_path, links=True) as gml:
            for cls in gml.classes:
                if cls in PRESENTATION_CLASSES:
                    continue
                table, crs = gml.read(con, cls)
                if table.num_rows == 0:
                    continue
                # A file declaring xlink on each link (WFS downloads) gets a
                # `<field>_xlink` column per link holding only the namespace.
                noise = [
                    c
                    for c in table.column_names
                    if c in _BOUNDS_COLUMNS or c.endswith("_xlink")
                ]
                tables[cls] = (table.drop_columns(noise), crs)
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
        with plan_file(source_path) as plan:
            layers = self._extract_plan(plan, workdir)
        if not layers:
            raise ValueError("The file holds no plan objects GOAT can read.")
        return layers

    def _extract_plan(self, source_path: str, workdir: str) -> List[ExtractedLayer]:
        import duckdb

        version = version_from_namespace(xplan_namespace(source_path) or "")
        refusal = unsupported(version)
        if refusal:
            raise ValueError(refusal)
        # Bounded, spilling into the work directory: see bound_duckdb.
        con = bound_duckdb(duckdb.connect(), workdir)
        try:
            con.execute("INSTALL spatial; LOAD spatial;")
            return self._layers(con, source_path, Path(workdir), version)
        finally:
            con.close()

    def _layers(
        self,
        con: "duckdb.DuckDBPyConnection",
        source_path: str,
        out: Path,
        version: str | None,
    ) -> List[ExtractedLayer]:
        from goatlib.bundles.importers.xplan.decode import decorate

        copy = out / "source.gml"
        copy_with_root_xlink(source_path, copy)
        read = decorate(self._read(con, str(copy)), version)
        # Class to (table, CRS); the CRS is None for a class without geometry.
        tables: dict[str, tuple[str, str | None]] = {}
        for i, (cls, (arrow, crs)) in enumerate(read.items()):
            source, name = f"src_{i}", f"t_{i}"
            has_geometry = "_wkb" in arrow.column_names
            if has_geometry and crs is None:
                raise ValueError(
                    f"The geometry of {cls} states no coordinate system (srsName)."
                )
            con.register(source, arrow)
            geometry_sql = (
                " EXCLUDE (_wkb), ST_GeomFromWKB(_wkb) AS geometry"
                if has_geometry
                else ""
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
                    f"(FORMAT GDAL, DRIVER 'GPKG', SRS {sql_literal(crs)})"
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
        return layers


register_importer(XPlanImporter())
