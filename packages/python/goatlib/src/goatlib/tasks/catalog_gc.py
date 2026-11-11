"""Garbage-collect promoted catalog layers nobody uses any more.

A promoted layer is a shared cache entry: its refcount is the number of
``layer_project`` links pointing at it. At zero the entry is deletable —
the parquet under ``{DATA_DIR}/catalog/layers``, its PMTiles, and the layer
row. Everything it held is re-derivable: the next add of the same catalog
item simply promotes and materializes again.

A grace period keeps a just-unlinked layer around for a while, so
remove-then-readd (and the promote→link window itself) never races the
sweep. Layers are matched by ``catalog_external_uid IS NOT NULL`` — user
layers are never candidates, whatever their link count.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any, Self

import asyncpg
from pydantic import BaseModel, Field

from goatlib.config.postgres import TASKS_APPLICATION_NAME
from goatlib.tools.base import ToolSettings
from goatlib.utils.layer import (
    catalog_layers_dir,
    catalog_tiles_dir,
    layer_id_to_table_name,
    stored_raster_file,
)

logger = logging.getLogger(__name__)


class CatalogGCParams(BaseModel):
    """Parameters for the catalog GC sweep."""

    grace_hours: int = Field(
        default=24,
        description=(
            "Only collect layers whose last update is older than this — "
            "covers the promote→link window and remove-then-readd."
        ),
    )
    dry_run: bool = Field(
        default=False,
        description="Report what would be deleted without deleting",
    )
    limit: int | None = Field(
        default=None, description="Collect at most this many layers"
    )


class CatalogGCOutput(BaseModel):
    """Result of one sweep."""

    candidates: int = 0
    deleted: int = 0
    files_removed: int = 0
    errors: list[str] = Field(default_factory=list)
    dry_run: bool = False


class CatalogGCTask:
    """Sweep unreferenced promoted layers."""

    def __init__(self: Self) -> None:
        self.settings: ToolSettings | None = None

    def init_from_env(self: Self) -> None:
        self.settings = ToolSettings.from_env()

    def _artifact_paths(self: Self, layer_id: str) -> list[Path]:
        """Every file a materialized catalog layer leaves behind.

        Tiles have their own directory under the catalog tree; the user tiles
        directory is listed too, because a layer materialized before the move
        still has its tiles there and deleting the row would otherwise orphan
        them.
        """
        table = layer_id_to_table_name(layer_id)
        catalog_dir = catalog_layers_dir()
        catalog_tiles = catalog_tiles_dir()
        tiles_dir = Path(
            self.settings.tiles_data_dir if self.settings else "/app/data/tiles"
        )
        names = [
            f"{table}.pmtiles",
            f"{table}_anchor.pmtiles",
            f"{table}.pmtiles.meta.json",
        ]
        return [
            catalog_dir / f"{table}.parquet",
            stored_raster_file(layer_id),
            *(catalog_tiles / name for name in names),
            *(tiles_dir / name for name in names),
        ]

    async def _run(self: Self, params: CatalogGCParams) -> CatalogGCOutput:
        assert self.settings is not None
        out = CatalogGCOutput(dry_run=params.dry_run)
        schema = self.settings.customer_schema

        conn = await asyncpg.connect(
            **self.settings.postgres_connect_args(TASKS_APPLICATION_NAME),
        )
        try:
            rows = await conn.fetch(
                f"""
                SELECT l.id
                FROM {schema}.layer l
                WHERE l.catalog_external_uid IS NOT NULL
                  AND l.updated_at < NOW() - make_interval(hours => $1)
                  AND NOT EXISTS (
                      SELECT 1 FROM {schema}.layer_project lp
                      WHERE lp.layer_id = l.id
                  )
                ORDER BY l.updated_at
                {"LIMIT " + str(int(params.limit)) if params.limit else ""}
                """,
                params.grace_hours,
            )
            out.candidates = len(rows)
            logger.info(
                "Catalog GC: %d unreferenced promoted layer(s)%s",
                out.candidates,
                " (dry run)" if params.dry_run else "",
            )

            for row in rows:
                layer_id = str(row["id"])
                paths = self._artifact_paths(layer_id)
                if params.dry_run:
                    logger.info("  would delete %s (+%d files)", layer_id, len(paths))
                    continue
                try:
                    # Row first: once it is gone nothing can resolve the
                    # files, so a crash between the two steps leaves only
                    # unreferenced files for the next sweep — never a row
                    # whose data has vanished.
                    #
                    # Re-check "unreferenced" inside the DELETE: a project link
                    # created after the candidate SELECT (a concurrent re-add of
                    # this layer) must survive. Without the guard the layer's
                    # ON DELETE CASCADE would take that fresh link — and the
                    # layer's files — with it. deleted_row is None when the
                    # guard spared a now-referenced layer.
                    deleted_row = await conn.fetchval(
                        f"""
                        DELETE FROM {schema}.layer l
                        WHERE l.id = $1
                          AND NOT EXISTS (
                              SELECT 1 FROM {schema}.layer_project lp
                              WHERE lp.layer_id = l.id
                          )
                          -- Promote protects a reused layer by bumping
                          -- updated_at; honour that here too, or a re-add that
                          -- lands between the candidate SELECT and this DELETE
                          -- loses its layer and then FK-fails on the link.
                          AND l.updated_at < NOW() - make_interval(hours => $2)
                          -- A job mid-flight would write its file after the row
                          -- is gone and leave it orphaned forever.
                          AND COALESCE(
                              l.other_properties->'catalog_materialize'->>'status', ''
                          ) <> 'running'
                        RETURNING l.id
                        """,
                        row["id"],
                        params.grace_hours,
                    )
                    if deleted_row is None:
                        logger.info(
                            "  skipped %s (relinked, reused or running meanwhile)",
                            layer_id,
                        )
                        continue
                    for p in paths:
                        if p.exists():
                            p.unlink()
                            out.files_removed += 1
                    out.deleted += 1
                    logger.info("  deleted %s", layer_id)
                except Exception as e:  # noqa: BLE001 - keep sweeping
                    out.errors.append(f"{layer_id}: {e}")
                    logger.warning("  failed to delete %s: %s", layer_id, e)
        finally:
            await conn.close()
        return out

    def run(self: Self, params: CatalogGCParams) -> CatalogGCOutput:
        if self.settings is None:
            raise RuntimeError("Call init_from_env() before running task")
        return asyncio.new_event_loop().run_until_complete(self._run(params))


def main(params: CatalogGCParams) -> dict[str, Any]:
    """Windmill entry point."""
    task = CatalogGCTask()
    task.init_from_env()
    return task.run(params).model_dump()
