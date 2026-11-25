"""GML files, read by GDAL's GML driver alone.

GDAL picks a driver by a file's content, so a `.gml` is read only through
`ST_Read` with the drivers of its format (`formats.READ_DRIVERS`), like every
other user file. Three things about GML need more than that:

- **Its classes.** A GML holds several feature classes, and `ST_Read_Meta`,
  which lists them, names no drivers. They are taken from the schema file
  (`.gfs`) GDAL's GML driver writes on the first read of a file.
- **That first read runs in a process of its own.** Whether a file has any
  feature class only that read tells, and DuckDB's reader ends the process on
  a file without one instead of raising.
- **Every file is read through a link in a directory of its own.** GDAL takes
  a `.gfs` or `.xsd` beside a GML as its schema; one beside an upload is the
  uploader's. The schema file is written there too, never beside the upload,
  and later reads use it: a file is scanned once however many classes it has.

GDAL hands arcs over as curve geometries, which DuckDB does not parse, so a
class is read with its geometry as WKB and every arc straightened
(`io/curves.py`).

**Numbers with a leading zero stay text.** A municipality key (`05314000`) or
a postal code is digits; the GDAL in DuckDB types such a field a whole number
and the zero is gone. So the fields GDAL typed whole numbers are read as text
(their type changed in the schema file after the first read) and made numbers
again here, unless one of their values has a leading zero.
"""

from __future__ import annotations

import logging
import re
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ElementTree
from pathlib import Path
from types import TracebackType
from typing import TYPE_CHECKING

from goatlib.io.formats import READ_DRIVERS, FileFormat
from goatlib.io.sql import sql_identifier, sql_literal

if TYPE_CHECKING:
    import duckdb
    import pyarrow as pa

logger = logging.getLogger(__name__)

#: The name a file is read under, whatever the upload is saved as (a worker
#: saves one as `<tmp>.zip`, which GDAL would open as an archive).
_LINK = "source.gml"
#: How long the first read of a file may take: GDAL scans all of it.
_SCAN_TIMEOUT_S = 900
#: The column DuckDB adds for GDAL's feature id.
_FID = "OGC_FID"
#: The straightened geometry of a class read by `GmlFile.read`, as WKB.
WKB_COLUMN = "_wkb"

_CRS = re.compile(r"^GEOMETRY\('(.+)'\)$", re.DOTALL)

#: The whole-number types of a GML schema file (type, subtype), and what each
#: is read as: the text type in the schema file, the DuckDB type it becomes
#: again.
_WHOLE_NUMBERS = {
    ("Integer", None): ("String", "INTEGER"),
    ("Integer", "Short"): ("String", "SMALLINT"),
    ("Integer", "Integer64"): ("String", "BIGINT"),
    ("Integer64", None): ("String", "BIGINT"),
    ("IntegerList", None): ("StringList", "INTEGER[]"),
    ("IntegerList", "Integer64"): ("StringList", "BIGINT[]"),
    ("Integer64List", None): ("StringList", "BIGINT[]"),
}
#: A number written with a leading zero: a code, not an amount.
_LEADING_ZERO = r"^\s*[+-]?0[0-9]"

_SCAN = """
import sys
import duckdb
con = duckdb.connect()
con.execute("INSTALL spatial; LOAD spatial;")
con.execute("SELECT 1 FROM ST_Read(?, " + sys.argv[2] + ") LIMIT 0", [sys.argv[1]])
"""


class NotGmlError(ValueError):
    """The file is no GML that can be read: other content, no feature class,
    or not readable at all."""


def _arguments(links: bool, write_schema: bool) -> str:
    """The driver list and open options of every `ST_Read` of a GML: no schema
    is fetched from the address a file points at, and `links` keeps
    `xlink:href` attributes as `<field>_href` columns."""
    options = [
        f"WRITE_GFS={'YES' if write_schema else 'NO'}",
        "DOWNLOAD_SCHEMA=NO",
        f"GML_ATTRIBUTES_TO_OGR_FIELDS={'YES' if links else 'NO'}",
    ]
    return "allowed_drivers=ARRAY[{}], open_options=ARRAY[{}]".format(
        ", ".join(map(sql_literal, READ_DRIVERS[FileFormat.GML])),
        ", ".join(map(sql_literal, options)),
    )


class GmlFile:
    """One GML file, opened for the duration of a `with` block.

    Raises `NotGmlError` on entry for a file the GML driver does not read or
    that holds no feature class.
    """

    def __init__(self, path: str | Path, *, links: bool = False) -> None:
        self._source = Path(path).resolve()
        self._links = links
        self._dir: Path | None = None
        #: The file's feature classes, in the file's order.
        self.classes: list[str] = []
        #: Per class, the fields GDAL typed whole numbers and their DuckDB
        #: type: read as text (see the module).
        self._numbers: dict[str, dict[str, str]] = {}

    def __enter__(self) -> "GmlFile":
        self._dir = Path(tempfile.mkdtemp(prefix="goatlib_gml_"))
        try:
            (self._dir / _LINK).symlink_to(self._source)
            self.classes = self._scan()
        except BaseException:
            self._close()
            raise
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self._close()

    def _close(self) -> None:
        if self._dir is not None:
            shutil.rmtree(self._dir, ignore_errors=True)
            self._dir = None

    @property
    def _path(self) -> Path:
        if self._dir is None:
            raise RuntimeError("GmlFile is used outside its with block.")
        return self._dir / _LINK

    def _scan(self) -> list[str]:
        """The first read: GDAL's GML driver scans the file and writes its
        schema beside the link. In a process of its own (see the module)."""
        try:
            scan = subprocess.run(
                [
                    sys.executable,
                    "-c",
                    _SCAN,
                    str(self._path),
                    _arguments(self._links, write_schema=True),
                ],
                capture_output=True,
                timeout=_SCAN_TIMEOUT_S,
            )
        except subprocess.TimeoutExpired:
            raise NotGmlError("The GML file took too long to read.") from None
        schema = self._path.with_suffix(".gfs")
        classes: list[str] = []
        if scan.returncode == 0 and schema.exists():
            try:
                tree = ElementTree.parse(schema)
            except ElementTree.ParseError:
                tree = None
            if tree is not None:
                for described in tree.getroot().findall("GMLFeatureClass"):
                    name = described.findtext("Name")
                    if name:
                        classes.append(name)
                        self._numbers[name] = _whole_numbers_as_text(described)
                tree.write(schema, encoding="utf-8", xml_declaration=False)
        if not classes:
            logger.info(
                "No GML classes in %s (scan exit %s)", self._source, scan.returncode
            )
            raise NotGmlError(
                "The file is not GML, or it is a GML file without any features."
            )
        return classes

    def _class(self, name: str | None) -> str:
        """The class to read: `name`, the first one without a name. Only a
        class of the file: a read of any other name ends the process."""
        if name is None:
            return self.classes[0]
        if name not in self.classes:
            raise NotGmlError(f"The GML file has no class {name}.")
        return name

    def read(
        self, con: "duckdb.DuckDBPyConnection", name: str | None = None
    ) -> tuple["pa.Table", str | None]:
        """A class's objects and the CRS of its geometry.

        The geometry is the column `_wkb` (`WKB_COLUMN`), every arc
        straightened; a class without geometry has no such column and no CRS.
        A class with several geometry properties keeps the first, as GDAL
        names it the class's geometry. `con` has the spatial extension loaded.
        """
        import pyarrow as pa

        from goatlib.io.curves import linear_wkb

        layer = f"layer={sql_literal(self._class(name))}"
        source = f"ST_Read(?, {layer}, {_arguments(self._links, write_schema=False)}"
        path = [str(self._path)]
        # Described without `keep_wkb`: the geometry columns then say that
        # they are geometries, and of which CRS.
        geometries = [
            (column, column_type)
            for column, column_type, *_ in con.execute(
                f"DESCRIBE SELECT * FROM {source})", path
            ).fetchall()
            if column_type.upper().startswith("GEOMETRY")
        ]
        table = con.execute(
            f"SELECT * FROM {source}, keep_wkb=true)", path
        ).to_arrow_table()
        table = _numbers_again(con, table, self._numbers.get(self._class(name), {}))
        dropped = [c for c, _ in geometries[1:]]
        if _FID in table.column_names:
            dropped.append(_FID)
        table = table.drop_columns(dropped)
        if not geometries:
            return table, None
        geometry, geometry_type = geometries[0]
        wkb = [linear_wkb(value) for value in table.column(geometry).to_pylist()]
        table = table.drop_columns([geometry]).append_column(
            WKB_COLUMN, pa.array(wkb, type=pa.binary())
        )
        crs = _CRS.match(geometry_type)
        return table, crs.group(1) if crs else None


def _whole_numbers_as_text(described: ElementTree.Element) -> dict[str, str]:
    """Change a class's whole-number fields to text in its schema, and return
    them with the DuckDB type each had."""
    numbers: dict[str, str] = {}
    for field in described.findall("PropertyDefn"):
        kind, subtype = field.find("Type"), field.find("Subtype")
        name = field.findtext("Name")
        if kind is None or not name:
            continue
        key = (
            (kind.text or "").strip(),
            (subtype.text or "").strip() if subtype is not None else None,
        )
        as_text = _WHOLE_NUMBERS.get(key)
        if as_text:
            kind.text, numbers[name] = as_text
            if subtype is not None:
                field.remove(subtype)
    return numbers


def _numbers_again(
    con: "duckdb.DuckDBPyConnection", table: "pa.Table", numbers: dict[str, str]
) -> "pa.Table":
    """The fields of `numbers` (read as text) as the number types they had,
    but for a field with a value that has a leading zero or is no number."""
    fields = {f: t for f, t in numbers.items() if f in table.column_names}
    if not fields or table.num_rows == 0:
        return table
    con.register("_gml_numbers", table)
    try:
        checks = []
        for field, number in fields.items():
            column = sql_identifier(field)
            if number.endswith("[]"):
                element = number.removesuffix("[]")
                checks.append(
                    f"coalesce(bool_or(list_bool_or(list_transform({column}, x -> "
                    f"regexp_matches(x, '{_LEADING_ZERO}') "
                    f"OR (x IS NOT NULL AND TRY_CAST(x AS {element}) IS NULL)))), false)"
                )
            else:
                checks.append(
                    f"coalesce(bool_or(regexp_matches({column}, '{_LEADING_ZERO}') "
                    f"OR ({column} IS NOT NULL AND TRY_CAST({column} AS {number}) IS NULL)), "
                    "false)"
                )
        stays_text = con.execute(
            f"SELECT {', '.join(checks)} FROM _gml_numbers"
        ).fetchone()
        casts = [
            f"CAST({sql_identifier(field)} AS {number}) AS {sql_identifier(field)}"
            for (field, number), text in zip(fields.items(), stays_text or ())
            if not text
        ]
        if not casts:
            return table
        return con.execute(
            f"SELECT * REPLACE ({', '.join(casts)}) FROM _gml_numbers"
        ).to_arrow_table()
    finally:
        con.unregister("_gml_numbers")


def gml_classes(path: str | Path) -> list[str]:
    """The feature classes of a GML file. Raises `NotGmlError`."""
    with GmlFile(path) as gml:
        return list(gml.classes)
