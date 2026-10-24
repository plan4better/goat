""" "Save as dataset" set to an existing dataset: finalize_layer's
``target_layer_id`` path.

Adds a workflow node's temp result to an existing layer the runner may write.
The layer keeps its id, name, style, field config, sharing and project
entries; only rows are added. Not a tool of its own: ``FinalizeLayerRunner``
mixes this in and takes this path when the export node targets an existing
dataset.

Order: the export's own authorization (project write) has run; then the
target's write right (none: the step fails; the editor warns beforehand);
then, holding the layer's write lock: check the target still exists, append in one
DuckLake transaction, refresh metadata and tiles.
"""

import logging
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import asyncpg
import duckdb

from goatlib.tools.append_rows import (
    AppendError,
    append_rows,
    check_same_geometry,
    input_geometry_types,
    plan_columns,
)
from goatlib.tools.base import _get_or_create_event_loop
from goatlib.utils.generated_fields import SerialCounters, generated_fields
from goatlib.utils.layer import table_path_parts
from goatlib.utils.layer_lock import advance_marks, hold_layer_lock, read_marks

logger = logging.getLogger(__name__)

_APPENDABLE_TYPES = {"feature", "table"}


class ExistingDatasetMixin:
    """finalize_layer's "existing dataset" path. Host: ``FinalizeLayerRunner``
    (``settings``, ``duckdb_con``, ``get_postgres_pool``, LayerReplaceMixin)."""

    settings: Any
    duckdb_con: Any

    async def _existing_target(self, params: Any) -> dict[str, Any] | None:
        """The target layer and whether the runner may write it."""
        if self.settings is None:
            raise RuntimeError("Settings not initialized")
        schema = self.settings.customer_schema
        pool = await self.get_postgres_pool()
        try:
            row = await pool.fetchrow(
                f"""
                SELECT l.id, l.user_id, l.name, l.type,
                       l.feature_layer_geometry_type, l.field_config, l.size,
                       l.deleted_at IS NOT NULL AS deleted,
                       {schema}.layer_write_allowed(l.id, $2) AS write_allowed
                FROM {schema}.layer l
                WHERE l.id = $1
                """,
                uuid.UUID(params.target_layer_id),
                uuid.UUID(str(params.user_id)),
            )
        finally:
            await pool.close()
        if row is None:
            return None
        field_config = row["field_config"]
        if isinstance(field_config, str):
            import json

            field_config = json.loads(field_config)
        return {
            "id": str(row["id"]),
            "user_id": str(row["user_id"]) if row["user_id"] else None,
            "name": row["name"],
            "type": row["type"],
            "geometry_type": row["feature_layer_geometry_type"],
            "field_config": field_config or {},
            "size": row["size"] or 0,
            "deleted": bool(row["deleted"]),
            "write_allowed": bool(row["write_allowed"]),
        }

    def _counter_table(self) -> str:
        return f"{self.settings.customer_schema}.layer_serial_counter"

    async def _read_marks(
        self, conn: Any, layer_id: str, names: list[str]
    ) -> dict[str, int]:
        """The layer's serial high-water marks, read under its lock, the way
        geoapi's feature writes read them (``goatlib.utils.layer_lock``)."""
        if not names or self.settings is None:
            return {}
        return await read_marks(conn, layer_id, names, self._counter_table())

    async def _advance_marks(
        self, conn: Any, layer_id: str, assigned: dict[str, int]
    ) -> None:
        """Store the highest numbers handed out; a mark never moves down."""
        if not assigned or self.settings is None:
            return
        await advance_marks(conn, layer_id, assigned, self._counter_table())

    def _layer_write_lock(self, layer_id: str) -> Iterator[None]:
        """The layer's write lock (see ``goatlib.utils.layer_lock``)."""
        if self.settings is None:
            raise RuntimeError("Settings not initialized")
        settings = self.settings

        async def connect() -> asyncpg.Connection:
            return await asyncpg.connect(**settings.postgres_connect_args())

        return hold_layer_lock(connect, layer_id, _get_or_create_event_loop())

    def _append_rows_into(
        self,
        *,
        table: str,
        parquet_path: Path,
        target: dict[str, Any],
        params: Any,
        counters: SerialCounters | None = None,
    ) -> int:
        """Plan the columns and append, in one DuckLake transaction."""
        con = self.duckdb_con
        source_sql = f"SELECT * FROM read_parquet('{parquet_path}')"
        input_cols = {
            r[0]: r[1] for r in con.execute(f"DESCRIBE {source_sql}").fetchall()
        }
        target_cols = {r[0]: r[1] for r in con.execute(f"DESCRIBE {table}").fetchall()}
        target_geometry = (
            target["geometry_type"] if target["type"] == "feature" else None
        )
        input_geometry = None
        if "geometry" in input_cols:
            # Every row must have the target's geometry type, not only the first.
            types = input_geometry_types(con, source_sql)
            if target_geometry is not None:
                check_same_geometry(types, target_geometry)
            # Rows without geometry only: nothing to tell the type from.
            input_geometry = next(iter(types)) if types else target_geometry
        plan = plan_columns(
            input_cols,
            target_cols=target_cols,
            field_config=target["field_config"],
            input_geometry=input_geometry,
            target_geometry=target_geometry,
        )
        con.execute("BEGIN TRANSACTION")
        try:
            rows = append_rows(
                con,
                table,
                source_sql,
                plan,
                target["field_config"],
                counters,
            )
            con.execute("COMMIT")
        except BaseException:
            try:
                con.execute("ROLLBACK")
            except duckdb.Error:
                pass
            raise
        return rows

    def _refresh_existing(
        self, *, layer_id: str, owner_id: str, table: str, size: int
    ) -> None:
        """Layer metadata and tiles after the rows went in."""
        table_info = self._get_table_info(self.duckdb_con, table)
        self._delete_old_pmtiles(user_id=owner_id, layer_id=layer_id)
        snapshot_id = self._get_ducklake_snapshot_id(*table_path_parts(table))
        self._regenerate_pmtiles(
            user_id=owner_id,
            layer_id=layer_id,
            table_info=table_info,
            snapshot_id=snapshot_id,
        )
        _get_or_create_event_loop().run_until_complete(
            self._update_layer_metadata(
                layer_id=layer_id,
                feature_count=table_info.get("feature_count", 0),
                extent_wkt=table_info.get("extent_wkt"),
                size=size,
                geometry_type=table_info.get("geometry_type"),
            )
        )

    async def _ensure_project_link(self, params: Any, name: str) -> None:
        """Show the target in the project, as ArcGIS shows Append's updated
        target: the export's own helper, an existing entry kept as it is, a
        new one shareable only if the runner may share the layer (D7)."""
        await self._get_or_create_project_link(  # type: ignore[attr-defined]
            layer_id=params.target_layer_id,
            project_id=params.project_id,
            name=name,
            shareable_for=str(params.user_id),
        )

    # -- the run --------------------------------------------------------------

    def _save_into_existing(self, params: Any, parquet_path: Path) -> dict[str, Any]:
        """Add the rows to ``params.target_layer_id``. Returns the output
        fields (layer_id, layer_name, rows_appended)."""
        loop = _get_or_create_event_loop()
        target = loop.run_until_complete(self._existing_target(params))
        if target is None or not target["write_allowed"]:
            # The editor only warns, so this is where it fails, also for
            # rights taken away after the warning. Whether a layer they may not edit
            # was trashed is not theirs to learn, and a layer gone for good
            # cannot be told from one never visible, so both get one message.
            if target is None:
                raise AppendError(
                    "The target dataset was not found, or you have no edit "
                    "rights on it."
                )
            raise AppendError(f"You have no edit rights on {target['name']}.")
        if target["deleted"]:
            raise AppendError("The target layer no longer exists.")

        with self._layer_write_lock(params.target_layer_id) as lock_conn:
            target = loop.run_until_complete(self._existing_target(params))
            if target is None or target["deleted"]:
                raise AppendError("The target layer no longer exists.")
            if target["type"] not in _APPENDABLE_TYPES:
                raise AppendError(
                    "Rows can only be appended to a feature layer or a table."
                )
            table = self.resolve_layer_table_path(params.target_layer_id)
            serials = [
                f.name
                for f in generated_fields(target["field_config"])
                if f.kind == "serial"
            ]
            counters = SerialCounters(
                high_water=loop.run_until_complete(
                    self._read_marks(lock_conn, params.target_layer_id, serials)
                )
            )
            rows = self._append_rows_into(
                table=table,
                parquet_path=parquet_path,
                target=target,
                params=params,
                counters=counters,
            )
            # Only after the rows are committed: a failed append hands out
            # nothing, so it moves no mark. From here on the rows are in, so
            # nothing may fail the step any more: a re-run would add them twice.
            try:
                loop.run_until_complete(
                    self._advance_marks(
                        lock_conn, params.target_layer_id, counters.assigned
                    )
                )
            except Exception:
                # The rows carry their numbers, so max() still covers them.
                logger.warning(
                    "Serial marks of %s not stored",
                    params.target_layer_id,
                    exc_info=True,
                )

        # Outside the lock: hand edits need not wait for a tile build.
        if rows:
            size = int(target["size"]) + (
                parquet_path.stat().st_size if parquet_path.exists() else 0
            )
            try:
                self._refresh_existing(
                    layer_id=params.target_layer_id,
                    owner_id=target["user_id"] or str(params.user_id),
                    table=table,
                    size=size,
                )
            except Exception:
                logger.warning(
                    "Tiles/metadata of %s not refreshed after the append",
                    params.target_layer_id,
                    exc_info=True,
                )

        if params.add_to_project:
            try:
                loop.run_until_complete(
                    self._ensure_project_link(params, target["name"])
                )
            except Exception:
                logger.warning(
                    "Target %s not added to project %s",
                    params.target_layer_id,
                    params.project_id,
                    exc_info=True,
                )

        logger.info("Appended %d row(s) to layer %s", rows, params.target_layer_id)
        return {
            "layer_id": params.target_layer_id,
            "layer_name": target["name"],
            "rows_appended": rows,
        }
