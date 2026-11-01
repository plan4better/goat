"""The options of every parquet COPY in goatlib.

DuckDB writes a GEOMETRY column of a file without rows as plain BLOB unless the
COPY names a GeoParquet version, and the next tool then finds no geometry
column. `parquet_copy_options` adds the version; a COPY that spells its own
options would leave its empty results without one.
"""

import re
from pathlib import Path

import duckdb
import goatlib
from goatlib.io.config import parquet_copy_options

SRC = Path(goatlib.__file__).parent

#: The files that may spell a parquet COPY's options, and why.
SPELLED_OUT = {
    "io/config.py": "parquet_copy_options itself",
    "tools/layer_export.py": (
        "a download for programs outside GOAT: older Arrow-based readers may "
        "reject Parquet's GEOMETRY type, the GeoParquet metadata they read "
        "is the same"
    ),
}

_FORMAT_PARQUET = re.compile(r"FORMAT\s+'?PARQUET\b", re.IGNORECASE)

#: A COPY's target (`TO '<file>'`, possibly closing one f-string and opening
#: the next) and what follows it.
_COPY_TARGET = re.compile(
    r"\bTO\s+'[^']*'\s*(?:\"\s*f?\"\s*)?(?P<options>.{0,40})", re.S
)

#: What may follow a target: the helper (in the optimized writers, their
#: `_copy_options`, which calls it), or a format other than parquet. DuckDB
#: writes parquet for a `.parquet` target without a FORMAT, so options
#: without one count as parquet.
_HELPER = re.compile(r"\{parquet_copy_options\(")
_OPTIMIZED_WRITER = re.compile(r"\{_copy_options\(")
_OTHER_FORMAT = re.compile(r"(?:WITH\s*)?\(\s*FORMAT\s+'?(?:CSV|GDAL|JSON)\b", re.I)
_OPTIMIZED_WRITERS = {"io/parquet.py", "io/geoparquet.py"}


def unchecked_copies(text: str, rel: str) -> list[int]:
    """The lines of `text` (the file `rel`) with a COPY whose options do
    not come from `parquet_copy_options` and name no format other than
    parquet."""
    lines = []
    for match in _COPY_TARGET.finditer(text):
        options = match.group("options")
        if _HELPER.match(options) or _OTHER_FORMAT.match(options):
            continue
        if rel in _OPTIMIZED_WRITERS and _OPTIMIZED_WRITER.match(options):
            continue
        lines.append(text.count("\n", 0, match.start()) + 1)
    for number, line in enumerate(text.splitlines(), start=1):
        if _FORMAT_PARQUET.search(line) and number not in lines:
            lines.append(number)
    return sorted(lines)


def test_every_parquet_copy_takes_its_options_from_the_helper() -> None:
    unchecked = [
        f"{rel}:{number}"
        for path in sorted(SRC.rglob("*.py"))
        if (rel := str(path.relative_to(SRC))) not in SPELLED_OUT
        for number in unchecked_copies(path.read_text(), rel)
    ]
    assert unchecked == []


def test_the_guard_sees_a_parquet_copy_however_it_is_spelled() -> None:
    spelled = {
        "without a format": "COPY (SELECT 1) TO 'out.parquet' (COMPRESSION ZSTD)",
        "without options": "COPY t TO 'out.parquet'",
        "as parquet": "COPY t TO '{out}' (FORMAT PARQUET)",
        "across f-strings": 'f"COPY t TO \'{out}\' "\n    f"(COMPRESSION ZSTD)"',
    }
    for name, text in spelled.items():
        assert unchecked_copies(text, "tools/x.py") == [1], name
    for text in (
        "COPY t TO '{out}' {parquet_copy_options('COMPRESSION ZSTD')}",
        "COPY t TO '{out}' WITH (FORMAT GDAL, DRIVER 'GeoJSON')",
        "COPY t TO '{out}' (FORMAT CSV, HEADER)",
    ):
        assert unchecked_copies(text, "tools/x.py") == [], text


def test_the_options_keep_the_geometry_column_of_an_empty_file(
    tmp_path: Path,
) -> None:
    out = tmp_path / "empty.parquet"
    con = duckdb.connect()
    try:
        con.execute("INSTALL spatial; LOAD spatial;")
        con.execute(
            "COPY (SELECT 1 AS id, ST_Point(11.5, 48.1)::GEOMETRY('OGC:CRS84') "
            f"AS geometry WHERE false) TO '{out}' "
            f"{parquet_copy_options('COMPRESSION ZSTD')}"
        )
        types = dict(
            (str(r[0]), str(r[1]))
            for r in con.execute(
                f"DESCRIBE SELECT * FROM read_parquet('{out}')"
            ).fetchall()
        )
    finally:
        con.close()
    assert types == {"id": "INTEGER", "geometry": "GEOMETRY('OGC:CRS84')"}


def test_the_options_list_format_options_and_the_version() -> None:
    assert parquet_copy_options("COMPRESSION ZSTD") == (
        "(FORMAT PARQUET, COMPRESSION ZSTD, GEOPARQUET_VERSION 'BOTH')"
    )
    assert re.fullmatch(
        r"\(FORMAT PARQUET, GEOPARQUET_VERSION '\w+'\)", parquet_copy_options()
    )
