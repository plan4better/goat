#!/usr/bin/env python
"""Move DuckLake layer tables and PMTiles to a flat, owner-free layout.

    DATA_DIR/ducklake/user_<uid>/t_<layer>/*.parquet  ->  DATA_DIR/ducklake/t_<layer>/*.parquet
    DATA_DIR/tiles/user_<uid>/t_<layer>.pmtiles       ->  DATA_DIR/tiles/t_<layer>.pmtiles

Nothing is rewritten. A layer's parquet files keep their names and contents;
only the directory holding them changes, and DuckLake is told where they went.
That is possible because DuckLake composes a file's location from three stored,
relative columns:

    DATA_PATH + ducklake_schema.path + ducklake_table.path + ducklake_data_file.path

so pointing a table at a schema whose path is empty puts it directly under
DATA_PATH. The alternative — CREATE TABLE AS SELECT into a new schema — would
rewrite every byte in the lake and mint a snapshot per table.

Ownership is not carried by any of this: it lives in `customer.layer.user_id`,
which is NOT NULL. The schema name was only ever a derived copy. The one
exception is an *orphan* table (in DuckLake, no layer row), where the directory
name is the last surviving record of who owned it — the inventory written by
--archive preserves that before anything moves.

Safety:
  * --dry-run reports every intended move and touches nothing.
  * --archive writes an inventory JSON, a pg_dump of the DuckLake catalog, and
    a hard-linked copy of the data (no extra disk; the originals are moved, not
    modified, so the links keep pointing at the same bytes). --archive-mode=copy
    takes a real copy instead. --skip-catalog-dump drops only the pg_dump, for
    a run whose catalog is already covered by a database backup taken outside
    this script; the inventory, the snapshot id and the file archive still
    happen, and pg_dump then need not exist on this host at all.
  * Each table moves in its own transaction: files first, then metadata. A
    failure rolls the metadata back and moves the files back.
  * Row counts are captured before and compared after.

MUST run with no other writer active (core, workers) — it edits catalog rows
outside DuckLake's snapshot machinery. geoapi readers pinned to an older
snapshot will keep resolving old paths until they refresh, so drain or restart
them too.

Usage:
    python scripts/flatten_layer_storage.py --dry-run
    python scripts/flatten_layer_storage.py --archive /backup/pre-flatten
    python scripts/flatten_layer_storage.py --archive /backup/pre-flatten --apply
"""

from __future__ import annotations

import argparse
import json
import logging
import shlex
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import duckdb

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s | %(levelname)-7s | %(message)s"
)
logger = logging.getLogger("flatten")

FLAT_SCHEMA = "main"


@dataclass
class TableMove:
    """One layer table's journey from a schema directory to the root."""

    table_id: int
    table_name: str
    schema_id: int
    schema_name: str
    row_count: int | None = None
    src: Path | None = None
    dst: Path | None = None
    moved: bool = False
    error: str | None = None


@dataclass
class Plan:
    tables: list[TableMove] = field(default_factory=list)
    pmtiles: list[tuple[Path, Path]] = field(default_factory=list)
    orphans: list[str] = field(default_factory=list)
    already_flat: int = 0


def connect(settings: Any, data_dir: Path) -> duckdb.DuckDBPyConnection:
    """Attach the DuckLake catalog, reading through `data_dir`.

    The catalog records its own `data_path` — the root as the *cluster* sees it
    (`/app/data/ducklake/`), which is rarely where this script's filesystem has
    the files. The two are deliberately separate: `data_dir` is where files get
    moved, while the catalog's own root is never touched, because the paths
    this migration rewrites (`ducklake_schema.path`) are relative to it.
    """
    con = duckdb.connect()
    con.execute("INSTALL ducklake; LOAD ducklake; INSTALL postgres; LOAD postgres;")
    con.execute(f"ATTACH 'postgres:{settings.ducklake_postgres_uri}' AS pgmeta")

    catalog_root = con.execute(
        f"SELECT value FROM pgmeta.{settings.ducklake_catalog_schema}.ducklake_metadata "
        f"WHERE key = 'data_path'"
    ).fetchone()
    catalog_root = catalog_root[0] if catalog_root else None

    override = ""
    if catalog_root and catalog_root.rstrip("/") != str(data_dir).rstrip("/"):
        logger.info(
            "Catalog data_path is %r but this host has the files at %s; "
            "reading through the local path (the catalog's own root is left alone)",
            catalog_root,
            data_dir,
        )
        override = ", OVERRIDE_DATA_PATH true"

    con.execute(
        f"ATTACH 'ducklake:postgres:{settings.ducklake_postgres_uri}' AS lake "
        f"(DATA_PATH '{data_dir}/', "
        f"METADATA_SCHEMA '{settings.ducklake_catalog_schema}'{override})"
    )
    return con


def _flat_schema_path(con: duckdb.DuckDBPyConnection, catalog: str) -> str:
    """The flat schema's current path, '' once it points at the DATA_PATH root."""
    row = con.execute(
        f"SELECT path FROM pgmeta.{catalog}.ducklake_schema "
        f"WHERE schema_name = ? AND end_snapshot IS NULL",
        [FLAT_SCHEMA],
    ).fetchone()
    return (row[0] if row else "").rstrip("/")


def build_plan(
    con: duckdb.DuckDBPyConnection,
    catalog: str,
    data_dir: Path,
    tiles_dir: Path,
    count_rows: bool,
) -> Plan:
    """Inventory what would move, without moving anything."""
    plan = Plan()
    meta = f"pgmeta.{catalog}"

    rows = con.execute(
        f"""
        SELECT t.table_id, t.table_name, t.schema_id, s.schema_name
        FROM {meta}.ducklake_table t
        JOIN {meta}.ducklake_schema s ON s.schema_id = t.schema_id
        WHERE t.end_snapshot IS NULL AND s.end_snapshot IS NULL
        ORDER BY s.schema_name, t.table_name
        """
    ).fetchall()

    flat_path = _flat_schema_path(con, catalog)

    for table_id, table_name, schema_id, schema_name in rows:
        # A table already in the flat schema still moves when that schema's
        # path is about to be repointed to the DATA_PATH root: its files sit
        # under the old path and would stop resolving. Only a flat schema
        # already at the root can be skipped.
        if schema_name == FLAT_SCHEMA and flat_path == "":
            plan.already_flat += 1
            continue

        move = TableMove(table_id, table_name, schema_id, schema_name)
        move.src = (
            data_dir
            / (flat_path if schema_name == FLAT_SCHEMA else schema_name)
            / table_name
        )
        move.dst = data_dir / table_name

        if count_rows:
            try:
                move.row_count = con.execute(
                    f'SELECT count(*) FROM lake."{schema_name}"."{table_name}"'
                ).fetchone()[0]
            except Exception as e:  # noqa: BLE001 - reported, not raised
                move.error = f"could not count rows: {e}"

        plan.tables.append(move)

    # Orphans: a DuckLake table with no layer row. Their directory name is the
    # only surviving record of ownership, so they are listed explicitly.
    layer_ids = {
        "t_" + str(r[0]).replace("-", "")
        for r in con.execute("SELECT id FROM pgmeta.customer.layer").fetchall()
    }
    plan.orphans = [m.table_name for m in plan.tables if m.table_name not in layer_ids]

    if tiles_dir.exists():
        for legacy in sorted(tiles_dir.glob("*/t_*.pmtiles")):
            plan.pmtiles.append((legacy, tiles_dir / legacy.name))
        for legacy in sorted(tiles_dir.glob("*/t_*.pmtiles.meta.json")):
            plan.pmtiles.append((legacy, tiles_dir / legacy.name))

    return plan


def tree_size(path: Path) -> int:
    """Bytes occupied by a directory tree, following no symlinks."""
    total = 0
    for entry in path.rglob("*"):
        if entry.is_file() and not entry.is_symlink():
            try:
                total += entry.stat().st_size
            except OSError:
                pass
    return total


def check_archive_space(
    archive: Path, data_dir: Path, tiles_dir: Path, mode: str, margin_bytes: int
) -> None:
    """Refuse to start unless the archive can actually fit.

    Running out of disk halfway through leaves a partial archive standing in
    for a complete one, which is worse than not starting: the recovery path
    would look present and be incomplete.

    A hard-linked archive stores no file data, so it needs only room for the
    catalog dump and the directory entries. A copy needs the whole tree.
    """
    probe = archive if archive.exists() else archive.parent
    free = shutil.disk_usage(probe).free

    if mode == "copy":
        needed = tree_size(data_dir) + tree_size(tiles_dir) + margin_bytes
        what = "a full copy of the lake and tiles"
    else:
        needed = margin_bytes
        what = "the catalog dump and directory entries"

    logger.info(
        "Archive space on %s: %.1f GB free, need ~%.1f GB for %s",
        probe,
        free / 1e9,
        needed / 1e9,
        what,
    )
    if free < needed:
        raise RuntimeError(
            f"Not enough space for the archive on {probe}: {free / 1e9:.1f} GB "
            f"free, need ~{needed / 1e9:.1f} GB for {what}. Point --archive at "
            f"a bigger filesystem, or use --archive-mode=link (which stores no "
            f"file data but must be on the same filesystem as the lake)."
        )


def dump_catalog(
    archive: Path, settings: Any, catalog: str, pg_dump_cmd: list[str]
) -> Path:
    """Dump the DuckLake metadata catalog before anything else happens.

    This is the only artifact that can undo a bad run: the parquet files are
    moved rather than rewritten, so recovery is putting them back and
    restoring these rows. Runs first, and refuses to continue unless the dump
    is present, non-trivial, and contains the tables a restore would need.

    Restore with:
        psql "$URI" -c 'DROP SCHEMA <catalog> CASCADE'
        psql "$URI" -f ducklake_catalog.sql
    """
    archive.mkdir(parents=True, exist_ok=True)
    dump = archive / "ducklake_catalog.sql"
    if dump.exists():
        raise RuntimeError(
            f"{dump} already exists; point --archive at a fresh directory so an "
            f"earlier run's dump is never overwritten"
        )

    # Written to stdout and captured here rather than via --file, so the
    # binary can live anywhere: on PATH, at an absolute path, or inside a
    # container (--pg-dump "docker exec -i goat-db pg_dump").
    argv = [*pg_dump_cmd, "--schema", catalog, settings.ducklake_postgres_uri]
    try:
        result = subprocess.run(argv, capture_output=True)
    except FileNotFoundError as e:
        raise RuntimeError(
            f"{pg_dump_cmd[0]} not found. Install postgresql-client, point "
            f"--pg-dump at one (e.g. 'docker exec -i goat-db18 pg_dump'), or "
            f"pass --skip-catalog-dump if a database backup taken outside this "
            f"script already covers the {catalog} schema."
        ) from e
    if result.returncode != 0:
        raise RuntimeError(
            f"pg_dump of the DuckLake catalog failed: "
            f"{result.stderr.decode(errors='replace')[:500]}"
        )

    dump.write_bytes(result.stdout)
    if dump.stat().st_size == 0:
        raise RuntimeError(f"pg_dump reported success but {dump} is empty")

    body = dump.read_text(errors="replace")
    required = ("ducklake_schema", "ducklake_table", "ducklake_data_file")
    missing = [t for t in required if t not in body]
    if missing:
        raise RuntimeError(
            f"{dump} is missing {', '.join(missing)} — refusing to proceed on a "
            f"dump that could not restore the catalog"
        )

    logger.info(
        "Dumped DuckLake catalog to %s (%.1f MB); verified it contains %s",
        dump,
        dump.stat().st_size / 1e6,
        ", ".join(required),
    )
    return dump


def preflight(plan: Plan, data_dir: Path, apply: bool, force: bool) -> bool:
    """Check the catalog and this host's files actually describe each other.

    Pointing --data-dir at the wrong tree is the easy mistake, and without
    this it surfaces as one failure line per table after the archive has
    already been written. A low overlap means the lake being read is not the
    lake the catalog describes.
    """
    present = sum(1 for m in plan.tables if m.src and m.src.exists())
    total = len(plan.tables)
    if total == 0:
        logger.info("Preflight: nothing to move")
        return True

    ratio = present / total
    logger.info(
        "Preflight: %d/%d catalog tables (%.1f%%) have files under %s "
        "(%d already flat)",
        present,
        total,
        ratio * 100,
        data_dir,
        plan.already_flat,
    )
    if ratio >= 0.5 or not apply:
        return True

    # Tables already in the flat schema prove this is the right tree, so a low
    # ratio here is a finished migration whose remaining rows have no files —
    # not a --data-dir pointing somewhere else.
    if plan.already_flat > total:
        logger.info(
            "Preflight: %d tables are already flat, so this lake is the one the "
            "catalog describes; the %d remaining have no files and will be "
            "reported individually",
            plan.already_flat,
            total - present,
        )
        return True

    if force:
        logger.warning("Preflight failed but --force given; continuing")
        return True

    logger.error(
        "Only %.1f%% of catalog tables have files under %s. That usually means "
        "--data-dir points at a different lake than the catalog describes. "
        "Check it, or pass --force to proceed anyway.",
        ratio * 100,
        data_dir,
    )
    return False


def write_archive(
    archive: Path,
    plan: Plan,
    settings: Any,
    mode: str,
    data_dir: Path,
    tiles_dir: Path,
) -> None:
    """Inventory + catalog dump + a copy of the data, before anything moves."""
    archive.mkdir(parents=True, exist_ok=True)

    # The inventory is the map back: every table's original schema and path,
    # and the only surviving record of who owned an orphan directory. A second
    # run against the same archive finds nothing left to move and would
    # overwrite it with an empty one, so refuse instead.
    if (archive / "inventory.json").exists():
        raise RuntimeError(
            f"{archive / 'inventory.json'} already exists; point --archive at a "
            f"fresh directory so an earlier run's inventory is never overwritten"
        )

    inventory = {
        "flat_schema": FLAT_SCHEMA,
        "ducklake_data_dir": str(data_dir),
        "tiles_data_dir": str(tiles_dir),
        "tables": [
            {
                "table_id": m.table_id,
                "table_name": m.table_name,
                "schema_id": m.schema_id,
                "schema_name": m.schema_name,
                "row_count": m.row_count,
                "src": str(m.src),
                "dst": str(m.dst),
            }
            for m in plan.tables
        ],
        "orphan_tables": plan.orphans,
        "pmtiles": [[str(a), str(b)] for a, b in plan.pmtiles],
    }
    (archive / "inventory.json").write_text(json.dumps(inventory, indent=2))
    logger.info("Wrote inventory for %d tables", len(plan.tables))

    for label, src in (("ducklake", data_dir), ("tiles", tiles_dir)):
        if not src.exists():
            continue
        dst = archive / label
        if dst.exists():
            logger.info("Archive for %s already present, skipping", label)
            continue
        if mode == "link":
            # Hard links cost no space and survive the move, because files are
            # relocated rather than rewritten — but they cannot cross a
            # filesystem boundary, so the archive has to sit on the same device.
            if src.stat().st_dev != archive.stat().st_dev:
                raise RuntimeError(
                    f"--archive {archive} is on a different filesystem than "
                    f"{src}, so hard links are impossible. Either point "
                    f"--archive at a directory on the same device, or pass "
                    f"--archive-mode=copy to take a full copy instead."
                )
            subprocess.run(["cp", "-al", str(src), str(dst)], check=True)
        else:
            shutil.copytree(src, dst)
        logger.info("Archived %s (%s) -> %s", label, mode, dst)


def ensure_flat_schema(con: duckdb.DuckDBPyConnection, catalog: str) -> int:
    """Return the id of the schema whose path is the DATA_PATH root."""
    meta = f"pgmeta.{catalog}"
    row = con.execute(
        f"SELECT schema_id, path FROM {meta}.ducklake_schema "
        f"WHERE schema_name = ? AND end_snapshot IS NULL",
        [FLAT_SCHEMA],
    ).fetchone()
    if row is None:
        raise RuntimeError(
            f"No '{FLAT_SCHEMA}' schema in the DuckLake catalog; create it first."
        )
    schema_id, path = row
    if path != "":
        con.execute(
            f"UPDATE {meta}.ducklake_schema SET path = '' WHERE schema_id = ?",
            [schema_id],
        )
        logger.info(
            "Set schema '%s' path to the DATA_PATH root (was %r)", FLAT_SCHEMA, path
        )
    return schema_id


def move_table(
    con: duckdb.DuckDBPyConnection, catalog: str, move: TableMove, flat_schema_id: int
) -> None:
    """Move one table's directory, then re-point every catalog row for it."""
    meta = f"pgmeta.{catalog}"

    if move.dst.exists():
        raise RuntimeError(f"destination already exists: {move.dst}")
    if not move.src.exists():
        raise RuntimeError(f"source directory missing: {move.src}")

    shutil.move(str(move.src), str(move.dst))
    try:
        # Every row for this table, live and historical — a snapshot that still
        # references it must resolve to the same place.
        con.execute("BEGIN TRANSACTION")
        con.execute(
            f"UPDATE {meta}.ducklake_table SET schema_id = ? WHERE table_id = ?",
            [flat_schema_id, move.table_id],
        )
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        shutil.move(str(move.dst), str(move.src))
        raise

    move.moved = True


def verify(con: duckdb.DuckDBPyConnection, plan: Plan) -> list[str]:
    """Re-count every moved table and compare against the pre-move inventory."""
    problems = []
    for m in plan.tables:
        if not m.moved or m.row_count is None:
            continue
        try:
            # count(*) alone is answered from ducklake_data_file.record_count
            # without opening a file, so it stays green on a table whose data
            # has been left behind. Force an actual read of every file.
            after = con.execute(
                f'SELECT count(*) FROM (SELECT * FROM lake."{FLAT_SCHEMA}"."{m.table_name}")'
            ).fetchone()[0]
        except Exception as e:  # noqa: BLE001
            problems.append(f"{m.table_name}: unreadable after move ({e})")
            continue
        if after != m.row_count:
            problems.append(f"{m.table_name}: {m.row_count} rows before, {after} after")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply", action="store_true", help="perform the move (default is a dry run)"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="report the plan and touch nothing (the default; accept it explicitly)",
    )
    parser.add_argument(
        "--archive", type=Path, help="directory for the pre-move backup"
    )
    parser.add_argument("--archive-mode", choices=["link", "copy"], default="link")
    parser.add_argument(
        "--skip-row-counts", action="store_true", help="faster plan, no verification"
    )
    parser.add_argument(
        "--limit", type=int, help="move at most N tables (for a staged rollout)"
    )
    parser.add_argument(
        "--data-dir",
        type=Path,
        help="filesystem location of the lake on THIS host (defaults to the "
        "configured ducklake data dir; the catalog's own data_path is separate "
        "and is never modified)",
    )
    parser.add_argument(
        "--tiles-dir", type=Path, help="filesystem location of the PMTiles tree"
    )
    parser.add_argument(
        "--force", action="store_true", help="proceed even if preflight fails"
    )
    parser.add_argument(
        "--archive-margin",
        type=float,
        default=2.0,
        help="GB to require free beyond the archive's own size (default 2)",
    )
    parser.add_argument(
        "--skip-catalog-dump",
        action="store_true",
        help="do not pg_dump the DuckLake catalog; only for a run whose "
        "catalog is already in a database backup taken outside this script",
    )
    parser.add_argument(
        "--pg-dump",
        default="pg_dump",
        help="pg_dump command; may include arguments, e.g. "
        '"docker exec -i goat-db18 pg_dump"',
    )
    args = parser.parse_args()

    if args.dry_run and args.apply:
        logger.error("--dry-run and --apply are mutually exclusive")
        return 2

    sys.path.insert(
        0, str(Path(__file__).resolve().parent.parent / "packages/python/goatlib/src")
    )
    from goatlib.tools.base import ToolSettings

    settings = ToolSettings.from_env()
    catalog = settings.ducklake_catalog_schema
    data_dir = args.data_dir or Path(settings.ducklake_data_dir)
    tiles_dir = args.tiles_dir or Path(settings.tiles_data_dir)
    if not data_dir.exists():
        logger.error(
            "Lake directory does not exist on this host: %s " "(pass --data-dir)",
            data_dir,
        )
        return 2

    if args.apply and not args.archive:
        logger.error("--apply requires --archive; refusing to move data with no backup")
        return 2

    con = connect(settings, data_dir)

    if args.apply:
        # Before the plan, before row counts, before anything reads the lake.
        check_archive_space(
            args.archive,
            data_dir,
            tiles_dir,
            args.archive_mode,
            int(args.archive_margin * 1e9),
        )
        if args.skip_catalog_dump:
            args.archive.mkdir(parents=True, exist_ok=True)
            logger.warning(
                "Skipping the DuckLake catalog dump: recovery depends on a "
                "database backup taken outside this script covering the %s "
                "schema",
                catalog,
            )
        else:
            dump_catalog(args.archive, settings, catalog, shlex.split(args.pg_dump))
        snapshot = con.execute(
            f"SELECT max(snapshot_id) FROM pgmeta.{catalog}.ducklake_snapshot"
        ).fetchone()[0]
        logger.info("Catalog dumped at snapshot_id=%s", snapshot)
        (args.archive / "snapshot_id.txt").write_text(str(snapshot))

    plan = build_plan(
        con, catalog, data_dir, tiles_dir, count_rows=not args.skip_row_counts
    )

    logger.info(
        "%d tables to flatten, %d already flat, %d PMTiles files, %d orphans",
        len(plan.tables),
        plan.already_flat,
        len(plan.pmtiles),
        len(plan.orphans),
    )
    if plan.orphans:
        logger.warning(
            "%d tables have no layer row; their schema name is the only record "
            "of ownership and is preserved in the inventory: %s",
            len(plan.orphans),
            ", ".join(plan.orphans[:5]) + ("..." if len(plan.orphans) > 5 else ""),
        )

    if not preflight(plan, data_dir, args.apply, args.force):
        return 2

    if not args.apply:
        for m in plan.tables[:20]:
            logger.info("  would move %s -> %s (%s rows)", m.src, m.dst, m.row_count)
        if len(plan.tables) > 20:
            logger.info("  ... and %d more", len(plan.tables) - 20)
        for src, dst in plan.pmtiles[:10]:
            logger.info("  would move %s -> %s", src, dst)
        logger.info("Dry run only. Re-run with --archive DIR --apply to perform it.")
        return 0

    write_archive(args.archive, plan, settings, args.archive_mode, data_dir, tiles_dir)

    flat_schema_id = ensure_flat_schema(con, catalog)
    targets = plan.tables[: args.limit] if args.limit else plan.tables

    failures = 0
    for i, m in enumerate(targets, 1):
        try:
            move_table(con, catalog, m, flat_schema_id)
            logger.info("[%d/%d] moved %s", i, len(targets), m.table_name)
        except Exception as e:  # noqa: BLE001 - one bad table must not stop the rest
            m.error = str(e)
            failures += 1
            logger.error("[%d/%d] FAILED %s: %s", i, len(targets), m.table_name, e)

    for src, dst in plan.pmtiles:
        try:
            if dst.exists():
                logger.warning("PMTiles destination exists, leaving %s in place", src)
                continue
            shutil.move(str(src), str(dst))
        except Exception as e:  # noqa: BLE001
            failures += 1
            logger.error("FAILED PMTiles %s: %s", src, e)

    for schema_dir in sorted(data_dir.glob("user_*")) + sorted(
        tiles_dir.glob("user_*")
    ):
        if schema_dir.is_dir() and not any(schema_dir.iterdir()):
            schema_dir.rmdir()

    problems = verify(con, plan)
    for p in problems:
        logger.error("VERIFY: %s", p)

    moved = sum(1 for m in plan.tables if m.moved)
    logger.info(
        "Done: %d moved, %d failed, %d verification problems. Archive: %s",
        moved,
        failures,
        len(problems),
        args.archive,
    )
    return 1 if (failures or problems) else 0


if __name__ == "__main__":
    raise SystemExit(main())
