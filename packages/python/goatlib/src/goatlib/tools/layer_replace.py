"""Shared in-place layer replacement helpers.

These helpers DROP + recreate a DuckLake table, swap PMTiles, and update the
PostgreSQL layer record while preserving the layer_id, name, style, and all
project attachments.

Used by:
- ``layer_update`` — refresh layer data from S3 or WFS
- ``finalize_layer`` — overwrite a previously exported workflow result

The mixin expects the host class to provide ``duckdb_con``, ``settings``, and
``get_postgres_pool()`` — which ``BaseToolRunner`` / ``SimpleToolRunner``
already do.
"""

import logging
import uuid as uuid_module
from pathlib import Path
from typing import Any, Protocol

import asyncpg
import duckdb

from goatlib.io.bbox_columns import star_excluding, stray_bbox_columns

logger = logging.getLogger(__name__)


class _HasReplaceDeps(Protocol):
    """Protocol describing what LayerReplaceMixin needs from its host."""

    settings: Any

    @property
    def duckdb_con(self) -> duckdb.DuckDBPyConnection: ...

    async def get_postgres_pool(self) -> asyncpg.Pool: ...

    def _get_table_info(self, con: Any, table_name: str) -> dict[str, Any]: ...

    def resolve_layer_table_path(self, layer_id: str) -> str: ...


class LayerReplaceMixin:
    """Mixin providing in-place table/PMTiles/metadata replacement.

    Host class must provide ``duckdb_con``, ``settings``, and
    ``get_postgres_pool()``.
    """

    async def _get_layer_full_info(
        self: _HasReplaceDeps,
        layer_id: str,
        user_id: str,
        *,
        require_owner: bool = True,
    ) -> dict[str, Any]:
        """Get full layer info and, unless ``require_owner`` is False, verify
        the user owns the layer. A workflow export passes False: its result
        belongs to the workflow, and the caller authorized the project.

        Raises:
            PermissionError: If user doesn't own the layer.
            ValueError: If layer not found.
        """
        pool = await self.get_postgres_pool()

        try:
            row = await pool.fetchrow(
                f"""
                SELECT id, user_id, folder_id, name, type, data_type,
                       feature_layer_type, feature_layer_geometry_type,
                       other_properties
                FROM {self.settings.customer_schema}.layer
                WHERE id = $1
                """,
                uuid_module.UUID(layer_id),
            )

            if not row:
                raise ValueError(f"Layer not found: {layer_id}")

            # NULL owner = a catalog layer, which is nobody's to change.
            owner_id = str(row["user_id"]) if row["user_id"] else None
            if require_owner and owner_id != user_id:
                raise PermissionError(
                    f"User {user_id} cannot update layer {layer_id} owned by {owner_id}"
                )

            return {
                "id": str(row["id"]),
                "user_id": owner_id,
                "folder_id": str(row["folder_id"]),
                "name": row["name"],
                "type": row["type"],
                "data_type": row["data_type"],
                "feature_layer_type": row["feature_layer_type"],
                "geometry_type": row["feature_layer_geometry_type"],
                "other_properties": row["other_properties"] or {},
            }
        finally:
            await pool.close()

    def _replace_ducklake_table(
        self: _HasReplaceDeps,
        layer_id: str,
        owner_id: str,
        parquet_path: Path,
    ) -> dict[str, Any]:
        """DROP + recreate the DuckLake table from a parquet file.

        Preserves the layer_id (and therefore the table path).
        """
        full_table = self.resolve_layer_table_path(layer_id)
        schema = full_table.split(".")[1]

        file_size = parquet_path.stat().st_size if parquet_path.exists() else 0

        con = self.duckdb_con

        # One transaction: a failure after the DROP (unreadable file, killed
        # worker) must leave the old table, not a layer without data.
        con.execute("BEGIN TRANSACTION")
        try:
            logger.info("Replacing DuckLake table: %s", full_table)
            con.execute(f"DROP TABLE IF EXISTS {full_table}")

            # Ensure user schema exists (first export into this schema otherwise fails)
            con.execute(f"CREATE SCHEMA IF NOT EXISTS lake.{schema}")

            cols = con.execute(
                f"DESCRIBE SELECT * FROM read_parquet('{parquet_path}')"
            ).fetchall()
            geom_col = None
            for col_name, col_type, *_ in cols:
                if "GEOMETRY" in col_type.upper():
                    geom_col = col_name
                    break
            # Stray bounding-box copies stay out of the layer
            # (goatlib.io.bbox_columns).
            columns = star_excluding(stray_bbox_columns(cols))

            if geom_col:
                con.execute(f"""
                    CREATE TABLE {full_table} AS
                    SELECT {columns} FROM read_parquet('{parquet_path}')
                    ORDER BY ST_Hilbert({geom_col})
                """)
            else:
                con.execute(f"""
                    CREATE TABLE {full_table} AS
                    SELECT {columns} FROM read_parquet('{parquet_path}')
                """)
            con.execute("COMMIT")
        except BaseException:
            # A failed COMMIT has already ended the transaction; the ROLLBACK
            # then fails too, and must not replace the error that matters.
            try:
                con.execute("ROLLBACK")
            except duckdb.Error:
                pass
            raise
        logger.info(
            "Created DuckLake table: %s%s",
            full_table,
            f" (Hilbert-sorted by {geom_col})" if geom_col else "",
        )

        table_info = self._get_table_info(con, full_table)
        table_info["table_name"] = full_table
        table_info["size"] = file_size
        table_info["geometry_column"] = geom_col or "geometry"

        return table_info

    def _get_table_info(
        self: _HasReplaceDeps, con: Any, table_name: str
    ) -> dict[str, Any]:
        """Extract metadata from a DuckLake table: columns, count, extent, geom type."""
        cols = con.execute(f"DESCRIBE {table_name}").fetchall()
        columns = {row[0]: row[1] for row in cols}

        count_result = con.execute(f"SELECT COUNT(*) FROM {table_name}").fetchone()
        feature_count = count_result[0] if count_result else 0

        geometry_type = None
        extent = None
        extent_wkt = None

        for col_name, col_type in columns.items():
            if "GEOMETRY" in col_type.upper():
                type_result = con.execute(f"""
                    SELECT ST_GeometryType({col_name})
                    FROM {table_name}
                    WHERE {col_name} IS NOT NULL
                    LIMIT 1
                """).fetchone()
                if type_result:
                    geometry_type = type_result[0]

                extent_result = con.execute(f"""
                    SELECT ST_Extent({col_name})::VARCHAR
                    FROM {table_name}
                """).fetchone()
                if extent_result and extent_result[0]:
                    extent = extent_result[0]
                    try:
                        box_str = extent_result[0]
                        if box_str.startswith("BOX("):
                            coords = box_str[4:-1].split(", ")
                            min_coords = coords[0].split(" ")
                            max_coords = coords[1].split(" ")
                            min_x, min_y = float(min_coords[0]), float(min_coords[1])
                            max_x, max_y = float(max_coords[0]), float(max_coords[1])
                            extent_wkt = (
                                f"POLYGON(({min_x} {min_y}, {max_x} {min_y}, "
                                f"{max_x} {max_y}, {min_x} {max_y}, {min_x} {min_y}))"
                            )
                    except (ValueError, IndexError) as e:
                        logger.warning("Failed to parse extent: %s", e)

                break

        return {
            "columns": columns,
            "feature_count": feature_count,
            "extent": extent,
            "extent_wkt": extent_wkt,
            "geometry_type": geometry_type,
        }

    def _delete_old_pmtiles(self: _HasReplaceDeps, user_id: str, layer_id: str) -> bool:
        """Delete existing PMTiles file for a layer before regenerating."""
        if self.settings is None:
            return False

        try:
            from goatlib.io.pmtiles import PMTilesGenerator

            generator = PMTilesGenerator(tiles_data_dir=self.settings.tiles_data_dir)
            deleted = generator.delete_pmtiles(layer_id)
            if deleted:
                logger.info("Deleted old PMTiles for layer: %s", layer_id)
            return deleted
        except Exception as e:
            logger.warning("Error deleting old PMTiles for layer %s: %s", layer_id, e)
            return False

    def _regenerate_pmtiles(
        self: _HasReplaceDeps,
        user_id: str,
        layer_id: str,
        table_info: dict[str, Any],
        snapshot_id: int | None = None,
    ) -> None:
        """Generate fresh PMTiles from an updated DuckLake table."""
        if self.settings is None or not getattr(
            self.settings, "pmtiles_enabled", False
        ):
            return

        geom_col = table_info.get("geometry_column") or "geometry"
        if geom_col == "geometry":
            for col_name, col_type in table_info.get("columns", {}).items():
                if "GEOMETRY" in col_type.upper():
                    geom_col = col_name
                    break

        try:
            from goatlib.io.pmtiles import PMTilesConfig, PMTilesGenerator

            config = PMTilesConfig(
                enabled=True,
                min_zoom=self.settings.pmtiles_min_zoom,
                max_zoom=self.settings.pmtiles_max_zoom,
            )
            generator = PMTilesGenerator(
                tiles_data_dir=self.settings.tiles_data_dir,
                config=config,
            )
            pmtiles_path = generator.generate_from_table(
                duckdb_con=self.duckdb_con,
                table_name=table_info["table_name"],
                geometry_column=geom_col,
                layer_id=layer_id,
                snapshot_id=snapshot_id,
            )
            if pmtiles_path:
                logger.info(
                    "Generated PMTiles for layer %s: %s", layer_id, pmtiles_path
                )
        except Exception as e:
            logger.warning("PMTiles generation failed for layer %s: %s", layer_id, e)

    async def _update_layer_metadata(
        self: _HasReplaceDeps,
        layer_id: str,
        feature_count: int,
        extent_wkt: str | None,
        size: int,
        geometry_type: str | None,
    ) -> None:
        """UPDATE customer.layer with data-derived fields only.

        Preserves user-set metadata: name, description, tags, style, project links.
        """
        from goatlib.tools.db import normalize_geometry_type

        pool = await self.get_postgres_pool()

        try:
            normalized_geom = normalize_geometry_type(geometry_type)

            updates = ["updated_at = NOW()"]
            params: list[Any] = [uuid_module.UUID(layer_id)]
            param_idx = 2

            updates.append(f"size = ${param_idx}")
            params.append(size)
            param_idx += 1

            if extent_wkt:
                updates.append(
                    f"extent = ST_Multi(ST_GeomFromText(${param_idx}, 4326))"
                )
                params.append(extent_wkt)
                param_idx += 1

            if normalized_geom:
                updates.append(f"feature_layer_geometry_type = ${param_idx}")
                params.append(normalized_geom)
                param_idx += 1

            await pool.execute(
                f"""
                UPDATE {self.settings.customer_schema}.layer
                SET {", ".join(updates)}
                WHERE id = $1
                """,
                *params,
            )
            logger.info(
                "Updated layer metadata: %s (features=%d, size=%d)",
                layer_id,
                feature_count or 0,
                size,
            )
        finally:
            await pool.close()
