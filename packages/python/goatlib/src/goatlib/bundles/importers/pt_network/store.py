"""GOAT's own public transport network as GTFS tables, for cutting to an area.

GOAT ships a default network: one GTFS feed combining several countries, too
large to be a bundle. Its timetable lies on the workers' shared volume
(``pt_network/gtfs.bin``, see ``tasks/sync_base_data``); these tables lie next
to it (``pt_network/gtfs_tables/``), so a cut of the network becomes a bundle
like any uploaded feed (``goatlib.io.fetch.pt_network``).

The tables are the GTFS importer's own output — one typed Parquet per GTFS
file — so a cut is ingested exactly as an import is, and nothing here decides
how a GTFS value is stored. Two tables are re-sorted for the cut, which reads
them by trip and by line: ``stop_times`` by trip and sequence, ``trips`` by
route. Then they are indexed for the cut (``index_store``), which reorders
``stop_times`` and ``shapes`` by line. Left out: files the GTFS reference does not name, as a cut cannot know
what they refer to, and the drawn ``shape_lines``, which every cut draws again
from its own trips (for a feed without shapes, drawing the whole network's
lines through the stops is also what outgrows the import's memory bound).

``info.json`` lists the tables with their role, kind and row count, where
they came from, and the cut's index. It is written last, so its presence means
the tables are complete.

Indexed for the cut
-------------------
A cut keeps whole lines, and finding them, their stops and their rows read
every stop time and shape point of the network: tens of seconds on a worker's
one CPU, whatever the area. So the tables carry an index (``index_store``):

- ``stop_lines``: which line serves which stop, the lines of an area without
  reading a stop time;
- ``line_numbers``: a number for every line, in the order of a Hilbert curve
  through the centres of their stops, so nearby lines get nearby numbers;
- ``shape_numbers``: a shape's number, the lowest of the lines using it;
- ``stop_times`` and ``shapes`` with that number as a column (``line_no``),
  sorted by it, so an area's rows lie together and DuckDB reads only the row
  groups whose numbers it asks for.

The number is a column, not a row range, as DuckDB skips row groups by a
column's statistics and not by row position. It is not part of GTFS, so the
cut leaves it out of what it writes, and the tables' schema is 2: a reader of
schema 1 would pass it on into every bundle. Schema 1 tables, without the
index, are still read, the slow way.

Built where a ``public_transport`` base data version is built, and published
with it::

    python -m goatlib.bundles.importers.pt_network.store gtfs.zip \\
        <version>/pt_network/gtfs_tables

Tables written another way are indexed on their own, before the version's
manifest is made, since this rewrites ``stop_times`` and ``shapes``::

    python -m goatlib.bundles.importers.pt_network.store \\
        --index <version>/pt_network/gtfs_tables
"""

import argparse
import hashlib
import json
import logging
import os
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from goatlib.bundles.importers.base import ExtractedLayer, bound_duckdb
from goatlib.bundles.importers.pt_network.gtfs import GtfsImporter
from goatlib.io.config import parquet_copy_options
from goatlib.io.sql import sql_literal

logger = logging.getLogger(__name__)

#: The folder next to the timetable that holds the tables.
TABLES_DIRNAME = "gtfs_tables"
INFO_FILENAME = "info.json"
#: Bumped when the tables' layout or meaning changes; a reader refuses others.
#: 2: indexed for the cut (``index_store``).
STORE_SCHEMA = 2
#: Schemas this reader reads: 1 without the index.
READABLE_SCHEMAS = (1, 2)

#: The cut's index (see "Indexed for the cut" above), by role and file.
INDEX_FILES: Dict[str, str] = {
    "stop_lines": "stop_lines.parquet",
    "line_numbers": "line_numbers.parquet",
    "shape_numbers": "shape_numbers.parquet",
}
#: The column ``stop_times`` and ``shapes`` are sorted by once indexed.
LINE_NO = "line_no"
#: Rows sorted at once while indexing: the sort goes in slices of lines, so it
#: never spills a whole table (Europe's stop times would need 22 GB of disk).
_INDEX_SLICE_ROWS = 20_000_000
_INDEX_MEMORY_LIMIT = "4GB"

#: The order a table is written in, where the cut reads it by a key.
_SORT: Dict[str, str] = {
    "stop_times": "trip_id, stop_sequence",
    "trips": "route_id, trip_id",
}


def tables_dir(pt_network_base_path: str) -> Path:
    """Where the tables lie: next to the timetable (``pt_network_base_path``)."""
    return Path(pt_network_base_path).parent / TABLES_DIRNAME


#: The network's coverage as a mask: one polygon over the world with the areas
#: the network serves cut out of it, at the root of its base data version, next
#: to ``pt_network/``. Written by the network build; a version may lack one.
COVERAGE_MASK_FILENAME = "pt_geofence_mask.geojson"


def coverage_mask_path(pt_network_base_path: str) -> Path:
    """Where the network's coverage mask lies: at the root of the version that
    holds the timetable (``pt_network_base_path``). The timetable path is
    resolved first, as an installed version is reached through a link
    (``pt_network -> .base/public_transport/<version>/pt_network``, see
    ``tasks/sync_base_data``)."""
    return Path(pt_network_base_path).resolve().parent.parent / COVERAGE_MASK_FILENAME


def _sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def build_store(
    gtfs_zip: str,
    out_dir: str,
    *,
    lineage: Optional[str] = None,
    license: Optional[str] = None,
    attribution: Optional[str] = None,
) -> Dict[str, Any]:
    """Convert ``gtfs_zip`` into the tables in ``out_dir``; return ``info.json``.

    ``out_dir`` must not hold tables already. ``lineage``, ``license`` and
    ``attribution`` describe the feed for the bundles cut from it; GTFS states
    none of them, so they are given here or left out.
    """
    import duckdb

    out = Path(out_dir)
    if out.exists() and any(out.iterdir()):
        raise ValueError(f"{out} is not empty")
    importer = GtfsImporter()
    validation = importer.validate(gtfs_zip)
    if not validation.valid:
        raise ValueError("Not a usable GTFS feed: " + "; ".join(validation.errors))

    # The files the GTFS reference names: not the extras, not the drawn lines.
    known = set(importer.spec.role_keys()) - {"shape_lines"}
    out.mkdir(parents=True, exist_ok=True)
    tables: List[Dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="goat_pt_store_") as workdir:
        layers = importer.extract_layers(gtfs_zip, workdir)
        con = bound_duckdb(duckdb.connect(), workdir)
        try:
            for layer in layers:
                if layer.role not in known:
                    logger.info("Leaving out %s: a cut cannot use it", layer.role)
                    continue
                target = out / f"{layer.role}.parquet"
                order = _SORT.get(layer.role)
                if order:
                    src = layer.file_path.replace("'", "''")
                    dst = str(target).replace("'", "''")
                    con.execute(
                        f"COPY (SELECT * FROM read_parquet('{src}') ORDER BY {order}) "
                        f"TO '{dst}' {parquet_copy_options()}"
                    )
                else:
                    shutil.move(layer.file_path, target)
                (rows,) = con.execute(
                    "SELECT count(*) FROM read_parquet(?)", [str(target)]
                ).fetchone()
                tables.append(
                    {
                        "role": layer.role,
                        "name": layer.name,
                        "layer_type": layer.layer_type,
                        "geometry_type": layer.geometry_type,
                        "file": target.name,
                        "rows": int(rows),
                    }
                )
                logger.info("%s: %d row(s)", layer.role, rows)
        finally:
            con.close()

    info = {
        "schema": STORE_SCHEMA,
        "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": {"file": os.path.basename(gtfs_zip), "sha256": _sha256(gtfs_zip)},
        "lineage": lineage,
        "license": license,
        "attribution": attribution,
        "tables": tables,
    }
    (out / INFO_FILENAME).write_text(json.dumps(info, indent=1) + "\n")
    return index_store(out)


def index_store(directory: "str | Path") -> Dict[str, Any]:
    """Index the tables in ``directory`` for the cut, in place; return ``info.json``.

    For tables built by ``build_store`` (which calls this) or written another
    way in the same shape: schema 1, or 2 to index again. Everything is
    written aside first and moved in at the end, with ``info.json`` removed
    meanwhile and written again last: tables half reordered are never read as
    complete, and a failure leaves them as they were. Needs ``stop_times``,
    ``trips`` and ``stops``; ``shapes`` are reordered where there are any.
    """
    import duckdb

    directory = Path(directory)
    info_path = directory / INFO_FILENAME
    info = read_store(directory)
    paths = {t["role"]: t["path"] for t in info["tables"]}
    missing = {"stop_times", "trips", "stops"} - paths.keys()
    if missing:
        raise ValueError(f"Cannot index tables without {', '.join(sorted(missing))}.")
    stated = info_path.read_text()
    info_path.unlink()
    try:
        with tempfile.TemporaryDirectory(prefix=".index-", dir=directory) as workdir:
            con = bound_duckdb(duckdb.connect(), workdir)
            # Where a network version is built, not in a tools worker: room
            # for a slice's sort and the per-trip counts.
            con.execute(f"SET memory_limit='{_INDEX_MEMORY_LIMIT}'")
            try:
                index, staged = _write_index(con, info, paths, workdir)
            finally:
                con.close()
            for name, path in staged.items():
                os.replace(path, directory / name)
    except BaseException:
        info_path.write_text(stated)
        raise
    tables = [{k: v for k, v in t.items() if k != "path"} for t in info["tables"]]
    info_path.write_text(
        json.dumps(
            {**info, "schema": STORE_SCHEMA, "index": index, "tables": tables}, indent=1
        )
        + "\n"
    )
    return read_store(directory)


def _write_index(
    con: Any, info: Dict[str, Any], paths: Dict[str, str], workdir: str
) -> "tuple[Dict[str, str], Dict[str, str]]":
    """Write the index and the reordered tables into ``workdir``; return the
    index (role -> file name) and the files to move in (file name -> path)."""
    indexed_before = bool(info.get("index"))

    def rel(role: str) -> str:
        path = paths[role].replace("'", "''")
        if indexed_before and role in ("stop_times", "shapes"):
            # Indexed already: read without the number, which is written again.
            return f"(SELECT * EXCLUDE ({LINE_NO}) FROM read_parquet('{path}'))"
        return f"read_parquet('{path}')"

    staged: Dict[str, str] = {}

    def out(name: str) -> str:
        staged[name] = os.path.join(workdir, name)
        return staged[name].replace("'", "''")

    con.execute("INSTALL spatial; LOAD spatial;")
    stop_lines = out(INDEX_FILES["stop_lines"])
    con.execute(f"""
        COPY (SELECT DISTINCT st.stop_id, t.route_id
              FROM {rel("stop_times")} st JOIN {rel("trips")} t USING (trip_id)
              ORDER BY stop_id, route_id)
        TO '{stop_lines}' {parquet_copy_options('COMPRESSION ZSTD')}
    """)
    # The curve runs through the network's own extent, so any network spreads
    # over its whole length.
    extent = con.execute(f"""
        SELECT min(stop_lon), min(stop_lat), max(stop_lon), max(stop_lat)
        FROM {rel("stops")} WHERE stop_lon IS NOT NULL AND stop_lat IS NOT NULL
    """).fetchone()
    box = "{{'min_x': {}, 'min_y': {}, 'max_x': {}, 'max_y': {}}}::BOX_2D".format(
        *(v if v is not None else 0 for v in extent)
    )
    line_numbers = out(INDEX_FILES["line_numbers"])
    con.execute(f"""
        COPY (
            SELECT route_id,
                   CAST(row_number() OVER (
                       ORDER BY ST_Hilbert(lon, lat, {box}) NULLS LAST, route_id
                   ) AS INTEGER) AS {LINE_NO}
            FROM (SELECT sl.route_id, avg(s.stop_lon) AS lon, avg(s.stop_lat) AS lat
                  FROM read_parquet('{stop_lines}') sl
                  LEFT JOIN {rel("stops")} s USING (stop_id)
                  GROUP BY 1)
            ORDER BY {LINE_NO}
        ) TO '{line_numbers}' {parquet_copy_options('COMPRESSION ZSTD')}
    """)
    trip_columns = {
        r[0] for r in con.execute(f"DESCRIBE SELECT * FROM {rel('trips')}").fetchall()
    }
    shape_id = "t.shape_id" if "shape_id" in trip_columns else "CAST(NULL AS VARCHAR)"
    con.execute(f"""
        CREATE TEMP TABLE trip_line AS
        SELECT t.trip_id, {shape_id} AS shape_id, n.{LINE_NO}
        FROM {rel("trips")} t JOIN read_parquet('{line_numbers}') n USING (route_id)
    """)
    index = {k: v for k, v in INDEX_FILES.items() if k != "shape_numbers"}
    sorts = [("stop_times", "trip_line", "trip_id", "trip_id, stop_sequence")]
    if "shapes" in paths:
        shape_numbers = out(INDEX_FILES["shape_numbers"])
        con.execute(f"""
            COPY (SELECT shape_id, min({LINE_NO}) AS {LINE_NO} FROM trip_line
                  WHERE shape_id IS NOT NULL GROUP BY 1 ORDER BY 1)
            TO '{shape_numbers}' {parquet_copy_options('COMPRESSION ZSTD')}
        """)
        con.execute(
            f"CREATE TEMP TABLE shape_line AS SELECT * FROM read_parquet('{shape_numbers}')"
        )
        index["shape_numbers"] = INDEX_FILES["shape_numbers"]
        sorts.append(
            ("shapes", "shape_line", "shape_id", "shape_id, shape_pt_sequence")
        )
    rows_of = {t["role"]: int(t["rows"]) for t in info["tables"]}
    for role, lookup, key, order in sorts:
        # Slices of about _INDEX_SLICE_ROWS rows, by the lines' own row counts
        # (lines differ by orders of magnitude, so equal numbers of lines do
        # not make equal slices). Counted per key first: joining every row to
        # the lookup would spill the whole table.
        con.execute(f"""
            CREATE OR REPLACE TEMP TABLE key_rows AS
            SELECT {key}, count(*) AS n FROM {rel(role)} GROUP BY 1
        """)
        counts = con.execute(f"""
            SELECT l.{LINE_NO}, sum(k.n) FROM key_rows k JOIN {lookup} l USING ({key})
            GROUP BY 1 ORDER BY 1
        """).fetchall()
        ranges, low, rows = [], None, 0
        for number, n in counts:
            low = number if low is None else low
            rows += n
            if rows >= _INDEX_SLICE_ROWS:
                ranges.append((low, number))
                low, rows = None, 0
        if low is not None:
            ranges.append((low, counts[-1][0]))
        parts = []
        for i, (low, high) in enumerate(ranges):
            part = os.path.join(workdir, f"{role}_{i:04d}.parquet")
            # Joined to this slice's keys only, which stay in memory.
            con.execute(f"""
                COPY (SELECT l.{LINE_NO}, x.* FROM {rel(role)} x
                      JOIN (SELECT {key}, {LINE_NO} FROM {lookup}
                            WHERE {LINE_NO} BETWEEN {low} AND {high}) l
                      USING ({key})
                      ORDER BY l.{LINE_NO}, {order})
                TO {sql_literal(part)} {parquet_copy_options('COMPRESSION ZSTD')}
            """)
            parts.append(part)
        # The rows of no line (a shape no trip uses, a stop time of a trip
        # no line has), last and without a number: no cut asks for them, and
        # none is lost.
        con.execute(f"""
            CREATE OR REPLACE TEMP TABLE no_line AS
            SELECT {key} FROM key_rows ANTI JOIN {lookup} USING ({key})
        """)
        if con.execute("SELECT count(*) FROM no_line").fetchone()[0]:
            part = os.path.join(workdir, f"{role}_none.parquet")
            con.execute(f"""
                COPY (SELECT CAST(NULL AS INTEGER) AS {LINE_NO}, x.* FROM {rel(role)} x
                      SEMI JOIN no_line USING ({key})
                      ORDER BY {order})
                TO {sql_literal(part)} {parquet_copy_options('COMPRESSION ZSTD')}
            """)
            parts.append(part)
        # One file again, the slices in order: read in insertion order, so
        # nothing is sorted twice.
        name = os.path.basename(paths[role])
        listed = ", ".join("'" + p.replace("'", "''") + "'" for p in parts)
        con.execute("SET preserve_insertion_order = true")
        con.execute(
            f"COPY (SELECT * FROM read_parquet([{listed}])) TO '{out(name)}' {parquet_copy_options('COMPRESSION ZSTD')}"
        )
        (kept,) = con.execute(
            "SELECT count(*) FROM read_parquet(?)", [staged[name]]
        ).fetchone()
        if kept != rows_of[role]:
            raise ValueError(f"{role}: {kept} row(s) reordered of {rows_of[role]}.")
        for part in parts:
            os.remove(part)
        logger.info("%s: reordered by line in %d slice(s)", role, len(parts))
    return index, staged


def read_store(directory: "str | Path") -> Dict[str, Any]:
    """The tables' ``info.json``, with each table's path; refuses a missing or
    other-schema store with a reason a user can pass on."""
    directory = Path(directory)
    info_path = directory / INFO_FILENAME
    if not info_path.is_file():
        raise ValueError(
            "This server's public transport network has no tables to cut from. "
            "Its base data needs updating (sync_base_data)."
        )
    info = json.loads(info_path.read_text())
    if info.get("schema") not in READABLE_SCHEMAS:
        raise ValueError(
            f"This server's public transport tables follow schema "
            f"{info.get('schema')}, not {STORE_SCHEMA}. Its base data needs "
            "updating (sync_base_data)."
        )
    for table in info["tables"]:
        table["path"] = str(directory / table["file"])
    # The cut's index, by role and path (schema 2; none in schema 1).
    info["index"] = {
        role: str(directory / name) for role, name in (info.get("index") or {}).items()
    }
    return info


def store_layers(info: Dict[str, Any], paths: Dict[str, str]) -> List[ExtractedLayer]:
    """The tables written to ``paths`` (role -> file), as layers to ingest."""
    return [
        ExtractedLayer(
            role=t["role"],
            name=t["name"],
            layer_type=t["layer_type"],
            geometry_type=t["geometry_type"],
            file_path=paths[t["role"]],
        )
        for t in info["tables"]
        if t["role"] in paths
    ]


def _cli(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m goatlib.bundles.importers.pt_network.store",
        description=(
            "Convert GOAT's combined GTFS feed into the tables it is cut from, "
            "or index existing tables for the cut (--index)."
        ),
    )
    parser.add_argument("gtfs_zip", nargs="?", help="the combined feed")
    parser.add_argument(
        "out_dir",
        nargs="?",
        help="an empty folder, e.g. <version>/pt_network/gtfs_tables",
    )
    parser.add_argument(
        "--index",
        metavar="TABLES_DIR",
        help="index the tables in this folder in place, instead of converting a feed",
    )
    parser.add_argument("--lineage", help="where the feed comes from")
    parser.add_argument("--license", help="the feed's licence, e.g. CC-BY-4.0")
    parser.add_argument("--attribution", help="the attribution it requires")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    if args.index:
        if args.gtfs_zip or args.out_dir:
            parser.error("--index takes no feed")
        info = index_store(args.index)
        logger.info("Indexed %d table(s) in %s", len(info["tables"]), args.index)
        return 0
    if not (args.gtfs_zip and args.out_dir):
        parser.error("a feed and a folder, or --index")
    info = build_store(
        args.gtfs_zip,
        args.out_dir,
        lineage=args.lineage,
        license=args.license,
        attribution=args.attribution,
    )
    logger.info("%d table(s) in %s", len(info["tables"]), args.out_dir)
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
