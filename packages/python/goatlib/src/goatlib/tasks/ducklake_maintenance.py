"""DuckLake maintenance task.

DuckLake is snapshot-based: every write (CREATE, DROP, INSERT, layer replace)
creates a new global snapshot, and prior data files remain on disk as long as
ANY snapshot references them. Without periodic maintenance, parquet files
accumulate (verified empirically: 12k+ snapshots, 11k+ parquets in dev over
5 months).

This task runs the canonical DuckLake maintenance flow:
    1. ``ducklake_expire_snapshots`` — removes snapshots older than the
       retention window from the catalog. After this, time-travel queries
       (``AS OF VERSION N``) for those snapshots stop working, but only
       the catalog state changes — no parquet files are deleted yet.
    2. ``ducklake_cleanup_old_files`` — deletes parquet files that are
       no longer referenced by any retained snapshot.
    3. Prune ``ducklake_schema_versions`` — ``ducklake_expire_snapshots``
       never deletes rows from this table (verified on catalog formats 0.3
       and 1.0), so per-table schema-version history accumulates forever:
       at 12k tables that is thousands of unreachable rows per
       schema-changing day. A row applies from its ``begin_snapshot`` until
       the table's next row, so any row older than the table's newest row
       at-or-before the oldest live snapshot can never be resolved by any
       query — those are deleted directly in the Postgres catalog.

Key safety property (worth re-stating because the global retention scares
people the first time): expire + cleanup NEVER deletes the active data of a
live (untouched) layer. A snapshot is a cumulative catalog view, not a diff
— every snapshot from a layer's creation onward references that layer's
current parquet, so the file stays referenced until the layer is explicitly
dropped or replaced. Only superseded versions (from layer_replace /
layer_update) and dropped-layer remnants become orphan-eligible.

Windmill path: f/goat/tasks/ducklake_maintenance
Worker tag: tools
Schedule: daily at 04:00 UTC (registry.py)
"""

import logging
import os
import sys
from typing import Any, Self

from pydantic import BaseModel, Field

from goatlib.config.postgres import TASKS_APPLICATION_NAME
from goatlib.storage import BaseDuckLakeManager
from goatlib.style.fingerprint import advance_data_snapshots_sql
from goatlib.tools.base import ToolSettings
from goatlib.utils.credentials import postgres_attach_target

logger = logging.getLogger(__name__)

# Rows of ducklake_schema_versions that no surviving snapshot can resolve to.
# Schema-version rows are per-table ranges: a row applies from its
# begin_snapshot until the same table's next row, so lookups for any live
# snapshot can only ever land on the table's newest row at-or-before the
# oldest live snapshot, or later. Everything older is unreachable.
_SV_PRUNE_PREDICATE = (
    "FROM pg.ducklake.ducklake_schema_versions sv "
    "WHERE sv.begin_snapshot < ("
    " SELECT max(sv2.begin_snapshot)"
    " FROM pg.ducklake.ducklake_schema_versions sv2"
    " WHERE sv2.table_id = sv.table_id"
    " AND sv2.begin_snapshot <="
    " (SELECT min(snapshot_id) FROM pg.ducklake.ducklake_snapshot))"
)


def _human_bytes(n: int) -> str:
    """Render a byte count in the largest reasonable unit (KiB/MiB/GiB/TiB)."""
    if n < 1024:
        return f"{n} B"
    kib = n / 1024
    if kib < 1024:
        return f"{kib:.1f} KiB"
    mib = kib / 1024
    if mib < 1024:
        return f"{mib:.1f} MiB"
    gib = mib / 1024
    if gib < 1024:
        return f"{gib:.2f} GiB"
    return f"{gib / 1024:.2f} TiB"


class DuckLakeMaintenanceParams(BaseModel):
    """Parameters for the DuckLake maintenance task."""

    retention_days: int = Field(
        default=1,
        ge=0,
        description=(
            "Snapshots older than this are expired (removed from catalog). "
            "Time-travel queries against expired snapshots stop working. "
            "Live-layer data is preserved regardless. Default 1 day = "
            "aggressive reclamation; bump to 7+ via the Windmill UI per "
            "run if you want a longer time-travel window."
        ),
    )
    cleanup_files: bool = Field(
        default=True,
        description=(
            "After expiring snapshots, run ducklake_cleanup_old_files to "
            "physically delete the parquet files those expired snapshots "
            "referenced (catalog-tracked orphans). Set false to do the "
            "catalog cleanup without touching disk (rare)."
        ),
    )
    delete_orphans: bool = Field(
        default=True,
        description=(
            "Also run ducklake_delete_orphaned_files to remove files on "
            "disk that the catalog has no record of at all — typically "
            "leftovers from crashed writes, aborted transactions, or "
            "manual filesystem ops. Different from cleanup_files: those "
            "are catalog-tracked-as-deleted; orphans are catalog-untracked."
        ),
    )
    orphan_age_days: int = Field(
        default=1,
        ge=0,
        description=(
            "Filesystem-orphan files modified within this window are "
            "skipped, to avoid racing concurrent writes that haven't yet "
            "committed to the catalog. Only applies when delete_orphans "
            "is true."
        ),
    )
    orphan_abort_pct: float = Field(
        default=10.0,
        ge=0.0,
        le=100.0,
        description=(
            "Sanity guard against catastrophic catalog-mismatch failures: "
            "if delete_orphaned_files's preview would remove more than "
            "this percentage of all catalog-tracked data files, abort "
            "instead of deleting. Defaults to 10% — normal operation "
            "deletes a handful of crash-leftover files at most, so any "
            "run crossing 10% indicates something is wrong (catalog "
            "wiped, wrong DATA_PATH attached, etc.). Set to 100 to "
            "disable the guard."
        ),
    )
    cleanup_abort_pct: float = Field(
        default=90.0,
        ge=0.0,
        le=100.0,
        description=(
            "Sanity guard against catastrophic catalog-scheduling failures: "
            "if cleanup_old_files's preview would remove more than this "
            "percentage of all catalog-tracked data files, abort. Defaults "
            "to 90% — legitimate scenarios (e.g., a layer_delete batch, "
            "high-frequency syncers) can schedule lots of files at once, "
            "so the threshold is high. Anything crossing 90% means a "
            "bad expire_snapshots (e.g., retention_days=0 expired the "
            "current snapshot too) or catalog corruption. Set to 100 to "
            "disable the guard."
        ),
    )
    prune_schema_versions: bool = Field(
        default=True,
        description=(
            "After expiring snapshots, delete ducklake_schema_versions rows "
            "that no surviving snapshot can resolve to (expire_snapshots "
            "leaves them behind). Runs directly against the Postgres "
            "catalog; removes only provably unreachable history."
        ),
    )
    dry_run: bool = Field(
        default=False,
        description=(
            "Preview what would be expired/deleted without making any changes."
        ),
    )


__all__ = ["DuckLakeMaintenanceParams", "DuckLakeMaintenanceTask", "main"]


class DuckLakeMaintenanceTask:
    """Encapsulates the DuckLake maintenance run."""

    def __init__(self: Self) -> None:
        self.settings: ToolSettings | None = None
        self._manager: BaseDuckLakeManager | None = None

    @staticmethod
    def _configure_logging_for_windmill() -> None:
        root_logger = logging.getLogger()
        root_logger.setLevel(logging.INFO)
        for handler in root_logger.handlers[:]:
            root_logger.removeHandler(handler)
        h = logging.StreamHandler(sys.stdout)
        h.setLevel(logging.INFO)
        h.setFormatter(logging.Formatter("%(name)s - %(levelname)s - %(message)s"))
        root_logger.addHandler(h)

    def init_from_env(self: Self) -> None:
        self._configure_logging_for_windmill()
        self.settings = ToolSettings.from_env()

    def _get_manager(self: Self) -> BaseDuckLakeManager:
        if self._manager is None:
            if not self.settings:
                raise RuntimeError("Call init_from_env() before run()")
            # Read-write: we mutate the catalog (expire) and delete files.
            self._manager = BaseDuckLakeManager(
                read_only=False, application_name=TASKS_APPLICATION_NAME
            )
            self._manager.init_from_params(
                postgres_uri=self.settings.ducklake_postgres_uri,
                storage_path=self.settings.ducklake_data_dir,
                catalog_schema=self.settings.ducklake_catalog_schema,
            )
        return self._manager

    @staticmethod
    def _measure(con: Any) -> dict[str, int]:
        """Snapshot a few catalog metrics for before/after reporting."""
        snap_row = con.execute(
            "SELECT count(*) FROM ducklake_snapshots('lake')"
        ).fetchone()
        # Total bytes the catalog believes are on disk (sum of currently-tracked
        # parquet sizes — includes superseded versions still referenced by
        # historical snapshots).
        bytes_row = con.execute(
            "SELECT COALESCE(sum(file_size_bytes), 0) "
            "FROM ducklake_table_info('lake')"
        ).fetchone()
        return {
            "snapshots": int(snap_row[0]) if snap_row else 0,
            "tracked_bytes": int(bytes_row[0]) if bytes_row else 0,
        }

    def _advance_data_snapshots(self: Self, con: Any) -> None:
        """Moves core's `layer.data_snapshot` past every change in the log before
        expiring snapshots removes it (GOAT Style spec 12). A failure is logged and
        the run goes on: a change that expires unseen makes the tracker recompute
        every layer's classes once, which is safe."""
        sql = advance_data_snapshots_sql(
            self.settings.customer_schema,  # type: ignore[union-attr]
            self.settings.ducklake_catalog_schema,  # type: ignore[union-attr]
        )
        try:
            con.execute("CALL postgres_execute('pg', '" + sql.replace("'", "''") + "')")
        except Exception:
            logger.warning("data snapshot tracker failed", exc_info=True)

    def run(self: Self, params: DuckLakeMaintenanceParams) -> dict[str, Any]:
        manager = self._get_manager()
        with manager.connection() as con:
            before = self._measure(con)
            logger.info(
                "Before: snapshots=%d, tracked_bytes=%.2f MiB",
                before["snapshots"],
                before["tracked_bytes"] / 1024 / 1024,
            )

            # ---- Preview (dry_run path) -----------------------------------
            if params.dry_run:
                would_expire_row = con.execute(
                    "SELECT count(*) FROM ducklake_snapshots('lake') "
                    "WHERE snapshot_time < NOW() - INTERVAL "
                    f"'{params.retention_days} days'"
                ).fetchone()
                would_expire = would_expire_row[0] if would_expire_row else 0
                # cleanup_old_files supports dry_run natively
                preview_paths = (
                    [
                        r[0]
                        for r in con.execute(
                            "CALL ducklake_cleanup_old_files('lake', "
                            "cleanup_all => true, dry_run => true)"
                        ).fetchall()
                    ]
                    if params.cleanup_files
                    else []
                )
                preview_orphans = (
                    [
                        r[0]
                        for r in con.execute(
                            "CALL ducklake_delete_orphaned_files('lake', "
                            "older_than => NOW() - INTERVAL "
                            f"'{params.orphan_age_days} days', "
                            "dry_run => true)"
                        ).fetchall()
                    ]
                    if params.delete_orphans
                    else []
                )
                would_prune = 0
                if params.prune_schema_versions:
                    uri = postgres_attach_target(
                        con,
                        self.settings.ducklake_postgres_uri,  # type: ignore[union-attr]
                    )
                    con.execute(
                        f"ATTACH IF NOT EXISTS 'postgres:{uri}' AS pg (READ_ONLY)"
                    )
                    prune_row = con.execute(
                        f"SELECT count(*) {_SV_PRUNE_PREDICATE}"
                    ).fetchone()
                    would_prune = int(prune_row[0]) if prune_row else 0
                logger.info(
                    "DRY RUN: would expire %d snapshots, "
                    "delete %d catalog-tracked orphans, "
                    "delete %d filesystem orphans, "
                    "prune %d schema-version rows",
                    would_expire,
                    len(preview_paths),
                    len(preview_orphans),
                    would_prune,
                )
                return {
                    "dry_run": True,
                    "retention_days": params.retention_days,
                    "orphan_age_days": params.orphan_age_days,
                    "before": before,
                    "would_expire_snapshots": int(would_expire),
                    "would_delete_files": len(preview_paths),
                    "would_delete_orphans": len(preview_orphans),
                    "would_prune_schema_versions": would_prune,
                }

            # ---- Real run -------------------------------------------------
            # Read-write Postgres: the data snapshot tracker writes core's
            # layers, and the schema-versions prune below deletes catalog rows
            # directly (no DuckLake function exposes this). The cleanup reads
            # the schedule table through it to learn the bytes it frees.
            uri = postgres_attach_target(
                con,
                self.settings.ducklake_postgres_uri,  # type: ignore[union-attr]
            )
            con.execute(f"ATTACH IF NOT EXISTS 'postgres:{uri}' AS pg")
            self._advance_data_snapshots(con)
            con.execute(
                "CALL ducklake_expire_snapshots('lake', older_than => NOW() "
                f"- INTERVAL '{params.retention_days} days')"
            )
            after_expire = self._measure(con)
            expired = before["snapshots"] - after_expire["snapshots"]
            logger.info(
                "Expired %d snapshots (%d remaining)",
                expired,
                after_expire["snapshots"],
            )

            files_deleted = 0
            cleanup_bytes_freed = 0
            if params.cleanup_files:
                # Sanity guard: dry-run preview the cleanup to count
                # scheduled files. Abort if it exceeds cleanup_abort_pct
                # of the catalog's tracked file count — catches bad
                # expire_snapshots calls that mass-scheduled current data.
                preview_cleanup = con.execute(
                    "CALL ducklake_cleanup_old_files('lake', "
                    "cleanup_all => true, dry_run => true)"
                ).fetchall()
                tracked_files_row = con.execute(
                    "SELECT count(*) FROM ducklake_table_info('lake')"
                ).fetchone()
                tracked_file_count = (
                    int(tracked_files_row[0]) if tracked_files_row else 0
                )
                preview_pct = (
                    100.0 * len(preview_cleanup) / tracked_file_count
                    if tracked_file_count
                    else 0.0
                )
                if preview_pct > params.cleanup_abort_pct:
                    msg = (
                        f"ABORT cleanup_old_files: preview would remove "
                        f"{len(preview_cleanup)} files ({preview_pct:.1f}% "
                        f"of {tracked_file_count} catalog-tracked files), "
                        f"exceeding the safety threshold of "
                        f"{params.cleanup_abort_pct}%. This is abnormal — "
                        f"a bad expire_snapshots (retention=0 expiring the "
                        f"current snapshot?) or catalog corruption could "
                        f"cause this. Investigate before re-running."
                    )
                    logger.error(msg)
                    raise RuntimeError(msg)
                # Sum the byte sizes of files about to be deleted. The
                # schedule table's data_file_id refers to either a data
                # file or a delete file — UNION both to catch both.
                bytes_row = con.execute(
                    "SELECT COALESCE(SUM(s), 0) FROM ("
                    " SELECT df.file_size_bytes AS s"
                    " FROM pg.ducklake.ducklake_files_scheduled_for_deletion fsd"
                    " JOIN pg.ducklake.ducklake_data_file df"
                    "   ON fsd.data_file_id = df.data_file_id"
                    " UNION ALL"
                    " SELECT del.file_size_bytes AS s"
                    " FROM pg.ducklake.ducklake_files_scheduled_for_deletion fsd"
                    " JOIN pg.ducklake.ducklake_delete_file del"
                    "   ON fsd.data_file_id = del.delete_file_id"
                    ") t"
                ).fetchone()
                cleanup_bytes_freed = int(bytes_row[0]) if bytes_row else 0
                deleted_rows = con.execute(
                    "CALL ducklake_cleanup_old_files('lake', " "cleanup_all => true)"
                ).fetchall()
                files_deleted = len(deleted_rows)
                logger.info(
                    "Deleted %d catalog-tracked orphan files (%s, "
                    "%.2f%% of %d tracked)",
                    files_deleted,
                    _human_bytes(cleanup_bytes_freed),
                    preview_pct,
                    tracked_file_count,
                )

            orphans_deleted = 0
            orphan_bytes_freed = 0
            if params.delete_orphans:
                # Sanity guard: dry-run preview first to count what WOULD
                # be removed. If the count exceeds orphan_abort_pct of all
                # catalog-tracked files, refuse to proceed — this signals
                # a catastrophic failure (catalog wiped, wrong DATA_PATH,
                # etc.) rather than normal cleanup of crash leftovers.
                preview_orphans = con.execute(
                    "CALL ducklake_delete_orphaned_files('lake', "
                    "older_than => NOW() - INTERVAL "
                    f"'{params.orphan_age_days} days', "
                    "dry_run => true)"
                ).fetchall()
                tracked_files_row = con.execute(
                    "SELECT count(*) FROM ducklake_table_info('lake')"
                ).fetchone()
                tracked_file_count = (
                    int(tracked_files_row[0]) if tracked_files_row else 0
                )
                preview_pct = (
                    100.0 * len(preview_orphans) / tracked_file_count
                    if tracked_file_count
                    else 0.0
                )
                if preview_pct > params.orphan_abort_pct:
                    msg = (
                        f"ABORT delete_orphaned_files: preview would remove "
                        f"{len(preview_orphans)} files "
                        f"({preview_pct:.1f}% of {tracked_file_count} "
                        f"catalog-tracked files), exceeding the safety "
                        f"threshold of {params.orphan_abort_pct}%. This is "
                        f"abnormal — investigate before re-running "
                        f"(catalog corruption? wrong DATA_PATH?)."
                    )
                    logger.error(msg)
                    raise RuntimeError(msg)
                # Stat each orphan path on disk to learn its size before
                # deletion. delete_orphaned_files returns ABSOLUTE paths,
                # so os.path.getsize works directly. Missing/already-gone
                # files are ignored (treated as 0 bytes).
                for row in preview_orphans:
                    path = row[0] if isinstance(row, tuple) else row
                    try:
                        orphan_bytes_freed += os.path.getsize(path)
                    except OSError:
                        pass
                # Safe to delete: re-run without dry_run to actually remove.
                # No cleanup_all here: only files older than the mtime window
                # are eligible, to avoid racing concurrent writes that haven't
                # yet committed to the catalog.
                orphan_rows = con.execute(
                    "CALL ducklake_delete_orphaned_files('lake', "
                    "older_than => NOW() - INTERVAL "
                    f"'{params.orphan_age_days} days')"
                ).fetchall()
                orphans_deleted = len(orphan_rows)
                logger.info(
                    "Deleted %d filesystem-orphan files (%s, "
                    "catalog-untracked, %.2f%% of %d tracked)",
                    orphans_deleted,
                    _human_bytes(orphan_bytes_freed),
                    preview_pct,
                    tracked_file_count,
                )

            sv_rows_pruned = 0
            if params.prune_schema_versions:
                prune_row = con.execute(f"DELETE {_SV_PRUNE_PREDICATE}").fetchone()
                sv_rows_pruned = int(prune_row[0]) if prune_row else 0
                logger.info(
                    "Pruned %d unreachable schema-version rows "
                    "(expire_snapshots leaves them behind)",
                    sv_rows_pruned,
                )

            after = self._measure(con)
            tracked_bytes_change = before["tracked_bytes"] - after["tracked_bytes"]
            total_bytes_freed = cleanup_bytes_freed + orphan_bytes_freed
            logger.info(
                "After: snapshots=%d, tracked_bytes=%s " "(actually freed %s on disk)",
                after["snapshots"],
                _human_bytes(after["tracked_bytes"]),
                _human_bytes(total_bytes_freed),
            )

            return {
                "dry_run": False,
                "retention_days": params.retention_days,
                "orphan_age_days": params.orphan_age_days,
                "before": before,
                "after": after,
                "snapshots_expired": int(expired),
                "files_deleted": int(files_deleted),
                "orphans_deleted": int(orphans_deleted),
                "schema_versions_pruned": sv_rows_pruned,
                # Actual disk space reclaimed (sum of deleted-file sizes),
                # both raw and human-readable. This is the number most
                # operators want; tracked_bytes_change reports the change
                # in catalog-tracked size and is usually 0 because
                # superseded files were never counted there.
                "bytes_freed": int(total_bytes_freed),
                "bytes_freed_human": _human_bytes(total_bytes_freed),
                "cleanup_bytes_freed": int(cleanup_bytes_freed),
                "orphan_bytes_freed": int(orphan_bytes_freed),
                "tracked_bytes_change": int(tracked_bytes_change),
            }

    def close(self: Self) -> None:
        if self._manager is not None:
            self._manager.close()


def main(
    params: DuckLakeMaintenanceParams = DuckLakeMaintenanceParams(),
) -> dict[str, Any]:
    """Windmill entry point for DuckLake maintenance."""
    task = DuckLakeMaintenanceTask()
    task.init_from_env()
    try:
        return task.run(params)
    finally:
        task.close()
