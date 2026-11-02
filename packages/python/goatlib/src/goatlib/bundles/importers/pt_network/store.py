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
route. Left out: files the GTFS reference does not name, as a cut cannot know
what they refer to, and the drawn ``shape_lines``, which every cut draws again
from its own trips (for a feed without shapes, drawing the whole network's
lines through the stops is also what outgrows the import's memory bound).

``info.json`` lists the tables with their role, kind and row count, and where
they came from. It is written last, so its presence means the tables are
complete.

Built where a ``public_transport`` base data version is built, then published
with it (``python -m goatlib.tasks.sync_base_data publish``)::

    python -m goatlib.bundles.importers.pt_network.store gtfs.zip \\
        <version>/pt_network/gtfs_tables
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

logger = logging.getLogger(__name__)

#: The folder next to the timetable that holds the tables.
TABLES_DIRNAME = "gtfs_tables"
INFO_FILENAME = "info.json"
#: Bumped when the tables' layout or meaning changes; a reader refuses others.
STORE_SCHEMA = 1

#: The order a table is written in, where the cut reads it by a key.
_SORT: Dict[str, str] = {
    "stop_times": "trip_id, stop_sequence",
    "trips": "route_id, trip_id",
}


def tables_dir(pt_network_base_path: str) -> Path:
    """Where the tables lie: next to the timetable (``pt_network_base_path``)."""
    return Path(pt_network_base_path).parent / TABLES_DIRNAME


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
                        f"TO '{dst}' (FORMAT parquet)"
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
    return info


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
    if info.get("schema") != STORE_SCHEMA:
        raise ValueError(
            f"This server's public transport tables follow schema "
            f"{info.get('schema')}, not {STORE_SCHEMA}. Its base data needs "
            "updating (sync_base_data)."
        )
    for table in info["tables"]:
        table["path"] = str(directory / table["file"])
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
        description="Convert GOAT's combined GTFS feed into the tables it is cut from.",
    )
    parser.add_argument("gtfs_zip", help="the combined feed")
    parser.add_argument(
        "out_dir", help="an empty folder, e.g. <version>/pt_network/gtfs_tables"
    )
    parser.add_argument("--lineage", help="where the feed comes from")
    parser.add_argument("--license", help="the feed's licence, e.g. CC-BY-4.0")
    parser.add_argument("--attribution", help="the attribution it requires")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
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
