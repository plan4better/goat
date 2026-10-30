"""Store existing GTFS bundles typed: a one-off migration.

GTFS bundles imported before typing hold every column as text. New imports
store the fields the GTFS reference types — times, dates, numbers, enums — as
those types (``goatlib.bundles.importers.pt_network.gtfs_schema``). This task
brings the older bundles in line, parsing with the same rules as the import.

Per bundle, per member table the schema describes: the columns still stored
as text are parsed and the table is rewritten in place. One DuckLake
transaction per bundle, so a bundle is converted whole or not at all, and each
table's row count is checked before the commit.

A bundle with a value that does not parse in a field the reference requires
is skipped and listed: such a feed would be refused at upload today, and is
re-uploaded instead. A value that does not parse in an optional field is
dropped, as the import drops it, and counted in the report.

``layers_revision`` is not bumped: the values are the same, only their type
changes, so the bundle's artifacts (built from the same values) stay valid.
geoapi picks up the new snapshot within seconds; the column types it caches
per layer refresh within five minutes.

Defaults to a dry run, which reports what would change and touches nothing.

Windmill path: f/goat/tasks/gtfs_typed_storage
Worker tag: tools
Schedule: none (run manually)
"""

import logging
import sys
import tempfile
from typing import Any, Dict, List, Self

from pydantic import BaseModel, Field

from goatlib.bundles.importers.base import bound_duckdb
from goatlib.bundles.importers.pt_network.gtfs_schema import (
    SCHEMA,
    find_failures,
    typed_select,
)
from goatlib.config.postgres import TASKS_APPLICATION_NAME
from goatlib.storage import BaseDuckLakeManager
from goatlib.tools.base import ToolSettings
from goatlib.utils.credentials import postgres_attach_target
from goatlib.utils.layer import layer_id_to_table_name, resolve_layer_schema

logger = logging.getLogger(__name__)

__all__ = ["GtfsTypedStorageParams", "GtfsTypedStorageTask", "main"]


class GtfsTypedStorageParams(BaseModel):
    """Parameters for the GTFS typed-storage migration."""

    dry_run: bool = Field(
        default=True,
        description=(
            "Report what would be converted and which bundles would be "
            "skipped, without changing anything. Set to false to convert."
        ),
    )
    bundle_ids: List[str] | None = Field(
        default=None,
        description="Only these bundles. None = every GTFS bundle.",
    )


def _gtfs_file(role: str) -> str:
    """A role's GTFS file name, for messages (every typed role is its file)."""
    return f"{role}.txt"


def _quote(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


class GtfsTypedStorageTask:
    """Encapsulates the migration run."""

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
            self._manager = BaseDuckLakeManager(
                read_only=False, application_name=TASKS_APPLICATION_NAME
            )
            self._manager.init_from_params(
                postgres_uri=self.settings.ducklake_postgres_uri,
                storage_path=self.settings.ducklake_data_dir,
                catalog_schema=self.settings.ducklake_catalog_schema,
            )
        return self._manager

    def _members(
        self: Self, con: Any, bundle_ids: List[str] | None
    ) -> Dict[str, List[tuple[str, str]]]:
        """bundle id -> [(layer id, role)] for the GTFS bundles' typed roles."""
        assert self.settings is not None
        # As every Postgres ATTACH on a lake connection: the password in the
        # connection's Postgres secret, which DuckDB merges into a libpq
        # string only (a bare URI fails with 'missing "="').
        target = postgres_attach_target(con, self.settings.ducklake_postgres_uri)
        schema = self.settings.customer_schema
        con.execute(f"ATTACH IF NOT EXISTS 'postgres:{target}' AS pg (READ_ONLY)")
        rows = con.execute(
            f"""
            SELECT CAST(b.id AS VARCHAR), CAST(bl.layer_id AS VARCHAR), bl.role
            FROM pg.{schema}.bundle b
            JOIN pg.{schema}.bundle_layer bl ON bl.bundle_id = b.id
            WHERE b.bundle_type = 'pt_network_gtfs' AND b.deleted_at IS NULL
            ORDER BY 1, 3
            """
        ).fetchall()
        wanted = set(bundle_ids) if bundle_ids else None
        members: Dict[str, List[tuple[str, str]]] = {}
        for bundle_id, layer_id, role in rows:
            if wanted is not None and bundle_id not in wanted:
                continue
            if role in SCHEMA:
                members.setdefault(bundle_id, []).append((layer_id, role))
        return members

    def _plan_table(
        self: Self, con: Any, layer_id: str, role: str
    ) -> Dict[str, Any] | None:
        """What converting one member table involves; None if nothing does."""
        assert self.settings is not None
        schema = resolve_layer_schema(
            con,
            layer_id,
            self.settings.ducklake_catalog_schema,
            self.settings.ducklake_postgres_uri,
        )
        if schema is None:
            logger.warning("Layer %s (%s) has no table; skipped", layer_id, role)
            return None
        table = f"lake.{_quote(schema)}.{_quote(layer_id_to_table_name(layer_id))}"
        described = con.execute(f"DESCRIBE {table}").fetchall()
        columns = [str(row[0]) for row in described]
        text = {str(row[0]) for row in described if str(row[1]) == "VARCHAR"}
        pending = [c for c in columns if c in SCHEMA[role] and c in text]
        if not pending:
            return None
        failures = find_failures(con, role, table, pending)
        return {
            "layer_id": layer_id,
            "role": role,
            "table": table,
            "columns": columns,
            "pending": pending,
            "failures": failures,
        }

    def run(self: Self, params: GtfsTypedStorageParams) -> Dict[str, Any]:
        manager = self._get_manager()
        report: List[Dict[str, Any]] = []
        with manager.connection() as con, tempfile.TemporaryDirectory() as spill:
            # The import's bound (see bound_duckdb): a table of 16 M stop
            # times is rewritten within the tools worker's memory, spilling
            # to disk, rather than at DuckDB's default of 80 % of the machine.
            bound_duckdb(con, spill)
            for bundle_id, members in self._members(con, params.bundle_ids).items():
                plans = [
                    plan
                    for layer_id, role in members
                    if (plan := self._plan_table(con, layer_id, role)) is not None
                ]
                refused = [
                    f"{_gtfs_file(plan['role'])}: {f.describe()}"
                    for plan in plans
                    for f in plan["failures"]
                    if f.required
                ]
                entry: Dict[str, Any] = {
                    "bundle_id": bundle_id,
                    "tables": [
                        {
                            "role": plan["role"],
                            "columns": plan["pending"],
                            "dropped": {
                                f.column: f.count
                                for f in plan["failures"]
                                if not f.required
                            },
                        }
                        for plan in plans
                    ],
                }
                if not plans:
                    entry["status"] = "already_typed"
                elif refused:
                    entry["status"] = "skipped"
                    entry["reason"] = refused
                    logger.warning(
                        "Bundle %s skipped, re-upload it: %s",
                        bundle_id,
                        "; ".join(refused),
                    )
                elif params.dry_run:
                    entry["status"] = "would_convert"
                else:
                    self._convert(con, bundle_id, plans)
                    entry["status"] = "converted"
                report.append(entry)

        counts: Dict[str, int] = {}
        for entry in report:
            counts[entry["status"]] = counts.get(entry["status"], 0) + 1
        logger.info(
            "GTFS typed storage%s: %s", " (dry run)" if params.dry_run else "", counts
        )
        return {"dry_run": params.dry_run, "summary": counts, "bundles": report}

    @staticmethod
    def _convert(con: Any, bundle_id: str, plans: List[Dict[str, Any]]) -> None:
        """Rewrite a bundle's tables typed, in one transaction."""
        con.execute("BEGIN")
        try:
            for plan in plans:
                table = plan["table"]
                before = con.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
                select = typed_select(plan["role"], plan["columns"], plan["pending"])
                con.execute(
                    f"CREATE OR REPLACE TABLE {table} AS SELECT {select} FROM {table}"
                )
                after = con.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
                if after != before:
                    raise RuntimeError(
                        f"{table}: {after} rows after conversion, {before} before"
                    )
                for failure in plan["failures"]:
                    logger.warning(
                        "Bundle %s, %s: %s; dropped",
                        bundle_id,
                        _gtfs_file(plan["role"]),
                        failure.describe(),
                    )
            con.execute("COMMIT")
        except Exception:
            con.execute("ROLLBACK")
            raise
        logger.info("Bundle %s converted (%d table(s))", bundle_id, len(plans))

    def close(self: Self) -> None:
        if self._manager is not None:
            self._manager.close()


def main(
    params: GtfsTypedStorageParams = GtfsTypedStorageParams(),
) -> Dict[str, Any]:
    """Windmill entry point for the GTFS typed-storage migration."""
    task = GtfsTypedStorageTask()
    task.init_from_env()
    try:
        return task.run(params)
    finally:
        task.close()
