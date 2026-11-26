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

A layer without links can still be read: an update to a newer version moves
the project entries, while a published map's snapshot, a workflow or a
template keeps naming the old layer. Such a layer stays until nothing names
it. Catalog bundles (plans) follow the same rules: a bundle goes once no
project group holds it and nothing names it or one of its member layers.
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


def _documents(schema: str) -> str:
    """The saved documents that can name a catalog layer or bundle after its
    project entries moved: workflows, published maps' snapshots and templates.
    Their configs are free-form JSON (tool settings hold layer ids as plain
    values), so any string value equal to the id counts."""
    return f"""(
        SELECT config AS doc FROM {schema}.workflow
        UNION ALL SELECT config FROM {schema}.project_public
        UNION ALL SELECT config FROM {schema}.template
        UNION ALL SELECT inputs FROM {schema}.template
    )"""


#: Rows deleted per statement; each statement reads the documents once.
DELETE_BATCH = 500


def _named(schema: str, ids: str) -> str:
    """A `WITH` entry `named`: those of the ids `ids` (a query of text ids) that
    a saved document names, in one pass over the documents however many ids
    there are."""
    return f"""named AS (
        SELECT DISTINCT v #>> '{{}}' AS id
        FROM {_documents(schema)} d, jsonb_path_query(d.doc, 'strict $.**') v
        WHERE jsonb_typeof(v) = 'string' AND (v #>> '{{}}') IN ({ids})
    )"""


async def _named_ids(conn: Any, schema: str, ids: list[str]) -> set[str]:
    """Which of `ids` a saved document names."""
    if not ids:
        return set()
    rows = await conn.fetch(
        f"WITH {_named(schema, 'SELECT unnest($1::text[])')} SELECT id FROM named",
        ids,
    )
    return {row["id"] for row in rows}


def _batches(ids: list[Any]) -> list[list[Any]]:
    return [ids[i : i + DELETE_BATCH] for i in range(0, len(ids), DELETE_BATCH)]


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
    bundles_deleted: int = 0
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

    async def _delete_rows(
        self: Self, conn: Any, ids: list[Any], grace_hours: int
    ) -> list[Any]:
        """Delete the layer rows `ids` that are still deletable; the ids deleted.

        The rows go before their files: once a row is gone nothing can resolve its
        files, so a crash between the two steps leaves only
        unreferenced files for the next sweep — never a row
        whose data has vanished.

        Re-check "unreferenced" inside the DELETE: a project link
        created after the candidate SELECT (a concurrent re-add of
        a layer) must survive. Without the guard the layer's
        ON DELETE CASCADE would take that fresh link — and the
        layer's files — with it. So must a layer a document saved
        since names. A spared layer is missing from RETURNING.
        """
        assert self.settings is not None
        schema = self.settings.customer_schema
        rows = await conn.fetch(
            f"""
            WITH {_named(schema, "SELECT unnest($1::uuid[])::text")}
            DELETE FROM {schema}.layer l
            WHERE l.id = ANY($1::uuid[])
              AND NOT EXISTS (
                  SELECT 1 FROM {schema}.layer_project lp
                  WHERE lp.layer_id = l.id
              )
              AND l.id::text NOT IN (SELECT id FROM named)
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
            ids,
            grace_hours,
        )
        return [row["id"] for row in rows]

    async def _run(self: Self, params: CatalogGCParams) -> CatalogGCOutput:
        assert self.settings is not None
        out = CatalogGCOutput(dry_run=params.dry_run)
        schema = self.settings.customer_schema

        conn = await asyncpg.connect(
            **self.settings.postgres_connect_args(TASKS_APPLICATION_NAME),
        )
        try:
            bundles = f"""
                {schema}.bundle b
                WHERE b.catalog_external_uid IS NOT NULL
                  AND b.updated_at < NOW() - make_interval(hours => $1)
                  AND NOT EXISTS (
                      SELECT 1 FROM {schema}.layer_project_group g
                      WHERE g.bundle_id = b.id
                  )
            """
            # A bundle stays while a document names it or one of its members.
            unheld = await conn.fetch(
                f"""
                SELECT b.id::text AS id, ARRAY(
                    SELECT bl.layer_id::text FROM {schema}.bundle_layer bl
                    WHERE bl.bundle_id = b.id
                ) AS members
                FROM {bundles}
                """,
                params.grace_hours,
            )
            named = await _named_ids(
                conn,
                schema,
                [i for row in unheld for i in (row["id"], *row["members"])],
            )
            unused = [
                row["id"]
                for row in unheld
                if named.isdisjoint((row["id"], *row["members"]))
            ]
            if params.dry_run:
                out.bundles_deleted = len(unused)
            # Checked again in the DELETE, for a group or a document saved
            # since: the bundles and their members as they are now.
            with_members = (
                "SELECT unnest($2::uuid[])::text UNION "
                f"SELECT bl.layer_id::text FROM {schema}.bundle_layer bl "
                "WHERE bl.bundle_id = ANY($2::uuid[])"
            )
            for batch in [] if params.dry_run else _batches(unused):
                deleted = await conn.fetch(
                    f"""
                    WITH {_named(schema, with_members)}
                    DELETE FROM {bundles}
                      AND b.id = ANY($2::uuid[])
                      AND b.id::text NOT IN (SELECT id FROM named)
                      AND NOT EXISTS (
                          SELECT 1 FROM {schema}.bundle_layer bl
                          WHERE bl.bundle_id = b.id
                            AND bl.layer_id::text IN (SELECT id FROM named)
                      )
                    RETURNING b.id
                    """,
                    params.grace_hours,
                    batch,
                )
                out.bundles_deleted += len(deleted)
            logger.info("Catalog GC: %d unused catalog bundle(s)", out.bundles_deleted)

            unlinked = await conn.fetch(
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
                """,
                params.grace_hours,
            )
            # Left out before the limit, so layers that stay named never
            # fill it night after night.
            named = await _named_ids(conn, schema, [str(r["id"]) for r in unlinked])
            rows = [r for r in unlinked if str(r["id"]) not in named][
                : params.limit or None
            ]
            out.candidates = len(rows)
            logger.info(
                "Catalog GC: %d unreferenced promoted layer(s)%s",
                out.candidates,
                " (dry run)" if params.dry_run else "",
            )

            if params.dry_run:
                for row in rows:
                    layer_id = str(row["id"])
                    logger.info(
                        "  would delete %s (+%d files)",
                        layer_id,
                        len(self._artifact_paths(layer_id)),
                    )
            for batch in [] if params.dry_run else _batches([r["id"] for r in rows]):
                try:
                    deleted = await self._delete_rows(conn, batch, params.grace_hours)
                except Exception as e:  # noqa: BLE001 - keep sweeping
                    # One bad row costs that row only: the batch row by row.
                    logger.warning(
                        "  failed to delete %d layer(s) at once: %s", len(batch), e
                    )
                    deleted = []
                    for layer in batch:
                        try:
                            deleted += await self._delete_rows(
                                conn, [layer], params.grace_hours
                            )
                        except Exception as e:  # noqa: BLE001 - keep sweeping
                            out.errors.append(f"{layer}: {e}")
                            logger.warning("  failed to delete %s: %s", layer, e)
                gone = set(deleted)
                for layer in batch:
                    if layer not in gone:
                        logger.info(
                            "  skipped %s (relinked, named, reused or running meanwhile)",
                            layer,
                        )
                for layer in gone:
                    layer_id = str(layer)
                    try:
                        for p in self._artifact_paths(layer_id):
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
